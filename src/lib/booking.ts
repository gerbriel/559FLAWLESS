/**
 * Server-side booking engine — the ONLY path that creates an appointment from
 * a public request.
 *
 * Nothing here trusts the caller:
 *   • Duration, price, buffer, deposit and every booking gate are read from the
 *     database by id. The browser sends WHICH service, never WHAT it costs or
 *     how long it takes.
 *   • The requested instant is re-derived from the provider's schedule in the
 *     PROVIDER's timezone and re-checked against blocks, closures, existing
 *     appointments and cached external calendar busy time. The browser's chosen
 *     start is only ever matched against that, never believed.
 *   • The GiST exclusion constraint on appointments(provider_id, slot) is the
 *     last line of defence. Two requests that both pass validation race into
 *     the insert; exactly one commits and the loser gets 23P01, which becomes
 *     a 409 `slot_taken`.
 *
 * Deliberately not an edge function: `appointments` has no anon INSERT policy,
 * so this module plus the service-role client is the single implementation of
 * the double-booking guard. Two copies of this logic in two runtimes is how
 * that guard drifts and breaks.
 */

import 'server-only'
import { logError } from '@/lib/log-error'
import { createAdminClient } from '@/lib/supabase/admin'
import { syncAppointmentToCalendar } from '@/lib/calendar-push'
import { applyMembershipBenefit } from '@/lib/memberships'
import { generateSlots, type AvailabilityInput } from '@/lib/availability'
import { bestPairDiscount, pairDiscountCents } from '@/lib/pair-discounts'
import {
  bestSaleForService,
  newClientPromo,
  referralPromo,
  secondServicePromo,
  type PromotionRule,
} from '@/lib/promotions'
import { dateKeyInTimeZone, isValidTimeZone, MINUTE_MS } from '@/lib/time'

export const MAX_ADDONS = 6
/** The UI offers slots with the full lead time; this absorbs page-load-to-submit
 *  latency so a valid booking isn't rejected for being seconds too late. */
const LEAD_SLACK_MINUTES = 30
const RATE_LIMIT_WINDOW_MIN = 10
const RATE_LIMIT_MAX = 4

export type BookingError =
  | 'client_banned'
  | 'invalid_request'
  | 'unknown_provider'
  | 'provider_not_bookable'
  | 'provider_timezone_invalid'
  | 'unknown_service'
  | 'service_not_offered_by_provider'
  | 'consultation_required'
  | 'age_verification_required'
  | 'unknown_addon'
  | 'addon_not_available_for_service'
  | 'slot_unavailable'
  | 'slot_taken'
  | 'rate_limited'
  | 'booking_failed'
  /** The availability picture could not be read at all — an outage, not a fact
   *  about the provider or the slot. 503; the client should simply retry. */
  | 'service_unavailable'

export interface BookingRequest {
  providerId: string
  /** One or more services, booked as a single continuous appointment. */
  serviceIds: number[]
  addonIds: number[]
  startsAt: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  notes: string | null
  ageAttested: boolean
  clientId: string | null
  /** A friend's referral code, typed by a new client. Validated server-side. */
  referralCode?: string | null
}

export interface BookingResult {
  id: string
  startsAt: string
  endsAt: string
  /**
   * What the DATABASE decided, not what this module asked for. Approval routing
   * lives in triggers (036), so `'confirmed'` here can come back `'pending'`.
   * The confirmation screen reads this to know which of those two it happened.
   */
  status: string
  depositCents: number
  totalCents: number
  timezone: string
}

export type BookingOutcome =
  | { ok: true; booking: BookingResult }
  | { ok: false; error: BookingError; status: number }

const failure = (error: BookingError, status: number): BookingOutcome => ({
  ok: false,
  error,
  status,
})

/**
 * Resolve the availability picture for a provider + service combination.
 * Shared by the slot listing endpoint and by createBooking, so the times the
 * client is shown and the times the server will accept come from one place.
 */
export async function loadAvailability(opts: {
  providerId: string
  durationMinutes: number
  bufferMinutes: number
  fromDateKey: string
  days: number
  /**
   * What is being booked. Used to find the rooms and equipment those services
   * need, so a slot with a free provider but no free wax warmer is not offered.
   * Omitting it simply skips the resource check.
   */
  serviceIds?: number[]
  now?: Date
}): Promise<AvailabilityInput | null | 'unavailable'> {
  /*
   * Three answers, and the difference between the last two is the difference
   * between a fact and an outage:
   *   AvailabilityInput  — here is the picture
   *   null               — this provider is genuinely not bookable
   *   'unavailable'      — the database did not answer; nothing is known.
   * Callers must not translate 'unavailable' into anything that sounds like a
   * fact about the provider or the slot.
   */
  const supabase = createAdminClient()
  const now = opts.now ?? new Date()

  const { data: provider, error: providerError } = await supabase
    .from('profiles')
    .select('timezone, accepts_online_booking, suspended_at, role')
    .eq('id', opts.providerId)
    .maybeSingle()

  if (providerError) {
    void logError('availability', providerError.message, { provider_id: opts.providerId })
    return 'unavailable'
  }
  // Any non-client staff member who takes bookings — see migration 020.
  if (!provider || provider.role === 'client') return null
  if (provider.suspended_at || !provider.accepts_online_booking) return null
  if (!isValidTimeZone(provider.timezone)) return null

  // Widen the busy window a day either side so a late slot that runs past
  // midnight still sees the appointments it could collide with.
  const busyFrom = new Date(
    new Date(`${opts.fromDateKey}T00:00:00Z`).getTime() - 2 * 86_400_000
  ).toISOString()
  const busyTo = new Date(
    new Date(`${opts.fromDateKey}T00:00:00Z`).getTime() + (opts.days + 2) * 86_400_000
  ).toISOString()

  const [
    settingsRes,
    schedulesRes,
    blocksRes,
    closuresRes,
    apptsRes,
    calBusyRes,
    resourceBusyRes,
  ] = await Promise.all([
    supabase
      .from('booking_settings')
      .select('min_lead_minutes, max_advance_days')
      .eq('id', 1)
      .maybeSingle(),
    supabase
      .from('provider_schedules')
      .select('day_of_week, start_time, end_time, slot_interval_minutes')
      .eq('provider_id', opts.providerId)
      .eq('is_active', true),
    supabase
      .from('availability_blocks')
      .select('block_date, start_time, end_time')
      .eq('provider_id', opts.providerId)
      .gte('block_date', opts.fromDateKey),
    supabase.from('closures').select('closure_date').gte('closure_date', opts.fromDateKey),
    supabase
      .from('appointments')
      .select('starts_at, ends_at, buffer_minutes')
      .eq('provider_id', opts.providerId)
      .neq('status', 'cancelled')
      .gte('starts_at', busyFrom)
      .lte('starts_at', busyTo),
    supabase
      .from('calendar_busy')
      .select('starts_at, ends_at')
      .eq('provider_id', opts.providerId)
      .gte('ends_at', busyFrom)
      .lte('starts_at', busyTo),
    // A slot with a free provider but no free room is not a slot. Returns
    // { starts_at, ends_at } — the shape `busy` already takes — and zero rows
    // until a service is actually attached to a resource, so this is inert
    // until the studio configures one. See migration 037.
    supabase.rpc('resource_busy_intervals', {
      p_location_id: null,
      p_from: busyFrom,
      p_to: busyTo,
      p_service_ids: opts.serviceIds ?? [],
    }),
  ])

  // A failed read here must not become an empty calendar. Coalescing a
  // transient database error to zero rows produced the worst kind of outage:
  // no schedule meant "no open slots" — indistinguishable from fully booked —
  // and no existing appointments meant every colliding client passed the check
  // and was bounced by the exclusion constraint with "slot taken" on a slot
  // that looked free. An outage should look like an outage: refuse loudly and
  // let the route say "try again", while the durable record keeps the reason.
  const failed = [
    ['booking_settings', settingsRes.error],
    ['provider_schedules', schedulesRes.error],
    ['availability_blocks', blocksRes.error],
    ['closures', closuresRes.error],
    ['appointments', apptsRes.error],
    ['calendar_busy', calBusyRes.error],
    ['resource_busy_intervals', resourceBusyRes.error],
  ].filter(([, e]) => e)
  if (failed.length > 0) {
    void logError('availability', failed.map(([t, e]) => `${t}: ${(e as { message: string }).message}`).join('; '), {
      provider_id: opts.providerId,
      from: opts.fromDateKey,
    })
    return 'unavailable'
  }

  const settings = settingsRes.data
  const schedules = schedulesRes.data
  const blocks = blocksRes.data
  const closureRows = closuresRes.data
  const appts = apptsRes.data
  const calBusy = calBusyRes.data
  const resourceBusy = resourceBusyRes.data

  // An existing appointment occupies its window PLUS its own turnover buffer.
  const busy = [
    ...(appts ?? []).map((a) => ({
      starts_at: a.starts_at,
      ends_at: new Date(
        new Date(a.ends_at).getTime() + (a.buffer_minutes ?? 0) * MINUTE_MS
      ).toISOString(),
    })),
    ...(calBusy ?? []),
    ...(resourceBusy ?? []),
  ]

  return {
    timeZone: provider.timezone,
    schedules: schedules ?? [],
    blocks: blocks ?? [],
    closures: (closureRows ?? []).map((c) => c.closure_date),
    busy,
    durationMinutes: opts.durationMinutes,
    bufferMinutes: opts.bufferMinutes,
    minLeadMinutes: Math.max(0, (settings?.min_lead_minutes ?? 120) - LEAD_SLACK_MINUTES),
    maxAdvanceDays: settings?.max_advance_days ?? 90,
    now,
  }
}

export interface PricedLine {
  id: number
  name: string
  price_cents: number
  duration_minutes: number
  /** Set when a pair deal (067) or promotion (068) cut this line — the list price before the cut. */
  full_price_cents?: number
  /** Which pair deal cut it. */
  pair_discount_id?: number
  /** Which promotion cut it — never set alongside pair_discount_id. */
  promotion_id?: number
  /** The promotion's name, snapshotted into the redemption record. */
  promotion_name?: string
}

export interface PricedService {
  /**
   * Every service in the booking, in the order chosen. A client can book a
   * facial and a wax in one visit, which is one appointment occupying one
   * continuous block — not two bookings that happen to be adjacent.
   */
  services: PricedLine[]
  addons: PricedLine[]
  durationMinutes: number
  bufferMinutes: number
  totalCents: number
  depositCents: number
  /** True if ANY service needs it — the strictest service sets the rule. */
  requiresAgeVerification: boolean
  requiresConsultation: boolean
}

export type PriceOutcome =
  | { ok: true; priced: PricedService }
  | { ok: false; error: BookingError }

/**
 * Server-authoritative duration/price for a service as performed by a specific
 * provider, including add-ons. This is where the numbers come from — never the
 * request body.
 */
/**
 * Price one or more services for a provider, plus any add-ons.
 *
 * Prices and durations are read here and never taken from the client — the
 * booking request names WHICH services, never what they cost. A per-provider
 * override on `provider_services` wins over the catalogue price.
 *
 * Combining services is additive in time and money, but the gates are not:
 * age verification and consultation apply if ANY service requires them, and the
 * turnaround buffer is the largest any of them needs rather than the sum, since
 * the room is reset once at the end.
 */
export async function priceService(
  providerId: string,
  serviceIds: number[],
  addonIds: number[]
): Promise<PriceOutcome> {
  const supabase = createAdminClient()

  // De-duplicate: booking the same service twice is a mis-click, not an intent
  // to sit through it twice, and it would silently double the price.
  const wanted = [...new Set(serviceIds)]
  if (wanted.length === 0) return { ok: false, error: 'unknown_service' }

  const [{ data: services }, { data: links }, { data: pairRules }, { data: promoRows }] =
    await Promise.all([
    supabase
      // One string literal: postgrest-js parses the select at the type level,
      // and `'a' + 'b'` widens to `string`, collapsing the result type.
      .from('services')
      .select(
        'id, name, price_cents, duration_minutes, buffer_minutes, deposit_cents, is_active, requires_age_verification, requires_consultation'
      )
      .in('id', wanted),
    supabase
      .from('provider_services')
      .select('service_id, price_cents, duration_minutes, is_active')
      .eq('provider_id', providerId)
      .in('service_id', wanted),
    // The pair deal (067): a service booked alongside its trigger is cheaper.
    supabase
      .from('service_pair_discounts')
      .select('id, trigger_service_id, discounted_service_id, percent_off, label')
      .eq('is_active', true)
      .in('discounted_service_id', wanted),
    // The deal board (068): sales and mix-and-match. Windows checked in code.
    supabase
      .from('promotions')
      .select(
        'id, name, kind, percent_off, amount_cents, sale_price_cents, min_items, service_ids, starts_at, ends_at, is_active'
      )
      .eq('is_active', true)
      .in('kind', ['service_sale', 'second_service']),
  ])

  const active = (services ?? []).filter((s) => s.is_active)
  if (active.length !== wanted.length) return { ok: false, error: 'unknown_service' }

  const linkFor = new Map((links ?? []).filter((l) => l.is_active).map((l) => [l.service_id, l]))
  if (linkFor.size !== wanted.length) {
    return { ok: false, error: 'service_not_offered_by_provider' }
  }

  // Keep the caller's order so the appointment reads the way it was booked.
  const ordered = wanted.map((id) => active.find((s) => s.id === id)!)

  const priced: PricedLine[] = ordered.map((svc) => {
    const link = linkFor.get(svc.id)!
    return {
      id: svc.id,
      name: svc.name,
      price_cents: link.price_cents ?? svc.price_cents,
      duration_minutes: link.duration_minutes ?? svc.duration_minutes,
    }
  })

  // Discounts come off here — the same place every other price is decided,
  // after the per-provider override so half off means half of what this
  // provider actually charges. The line keeps its list price in
  // full_price_cents, so the receipt can say what the deal was worth.
  //
  // No stacking, ever: each line takes the single best cut between its pair
  // deal (067) and any live sale (068), and the mix-and-match pass below only
  // touches lines nothing else has touched.
  const promoRules = (promoRows ?? []) as PromotionRule[]
  const nowMs = Date.now()

  for (const line of priced) {
    const pair = bestPairDiscount(pairRules ?? [], wanted, line.id)
    const pairOff = pair ? pairDiscountCents(line.price_cents, pair.percent_off) : 0
    const sale = bestSaleForService(promoRules, line.id, line.price_cents, nowMs)

    if (sale && sale.off > pairOff) {
      line.full_price_cents = line.price_cents
      line.price_cents -= sale.off
      line.promotion_id = sale.rule.id
      line.promotion_name = sale.rule.name
    } else if (pair && pairOff > 0) {
      line.full_price_cents = line.price_cents
      line.price_cents -= pairOff
      line.pair_discount_id = pair.id
    }
  }

  // Mix and match: two or more services in one visit, and the cheapest line
  // that no other deal has already cut gets the percent off.
  const secondService = secondServicePromo(promoRules, nowMs)
  if (secondService && priced.length >= 2) {
    const untouched = priced.filter((l) => l.full_price_cents === undefined)
    if (untouched.length > 0) {
      const cheapest = untouched.reduce((low, l) => (l.price_cents < low.price_cents ? l : low))
      const off = pairDiscountCents(cheapest.price_cents, secondService.percent_off!)
      if (off > 0) {
        cheapest.full_price_cents = cheapest.price_cents
        cheapest.price_cents -= off
        cheapest.promotion_id = secondService.id
        cheapest.promotion_name = secondService.name
      }
    }
  }

  let addons: PricedLine[] = []

  if (addonIds.length > 0) {
    const [{ data: addonRows }, { data: allowed }] = await Promise.all([
      supabase
        .from('service_addons')
        .select('id, name, price_cents, duration_minutes')
        .in('id', addonIds)
        .eq('is_active', true),
      // An add-on has to be offered by at least one of the booked services.
      supabase
        .from('service_addon_links')
        .select('addon_id')
        .in('service_id', wanted)
        .in('addon_id', addonIds),
    ])

    addons = addonRows ?? []
    if (addons.length !== addonIds.length) return { ok: false, error: 'unknown_addon' }

    const permitted = new Set((allowed ?? []).map((a) => a.addon_id))
    if (addonIds.some((id) => !permitted.has(id))) {
      return { ok: false, error: 'addon_not_available_for_service' }
    }
  }

  const sum = (rows: PricedLine[], key: 'price_cents' | 'duration_minutes') =>
    rows.reduce((n, r) => n + r[key], 0)

  return {
    ok: true,
    priced: {
      services: priced,
      addons,
      durationMinutes:
        sum(priced, 'duration_minutes') + sum(addons, 'duration_minutes'),
      // One reset at the end of the visit, not one per service.
      bufferMinutes: Math.max(...ordered.map((s) => s.buffer_minutes)),
      totalCents: sum(priced, 'price_cents') + sum(addons, 'price_cents'),
      depositCents: ordered.reduce((n, s) => n + s.deposit_cents, 0),
      requiresAgeVerification: ordered.some((s) => s.requires_age_verification),
      requiresConsultation: ordered.some((s) => s.requires_consultation),
    },
  }
}

/**
 * Visit-level promotions (068), applied once the appointment and its lines
 * exist: the new-client percent, the referral hand-off, and the redemption
 * records for every line a deal cut. Best-effort by design — a committed
 * booking must never fail over a discount, so the worst case is a full-price
 * visit and a log line, never a lost appointment.
 *
 * Returns what was written to `promo_discount_cents`.
 */
async function applyVisitPromotions(opts: {
  supabase: ReturnType<typeof createAdminClient>
  appointmentId: string
  clientId: string | null
  /** What a visit-level percent applies to: lines after their own cuts, less any membership benefit. */
  baseCents: number
  lines: PricedLine[]
  referralCode?: string | null
  now: Date
}): Promise<number> {
  const { supabase, appointmentId, clientId, baseCents, lines, referralCode, now } = opts
  let visitDiscount = 0

  const redemptions: {
    promotion_id: number | null
    promotion_name: string
    client_id: string | null
    appointment_id: string
    discount_cents: number
  }[] = []

  // The lines a sale or mix-and-match already cut — priced in priceService,
  // recorded here where the appointment id exists. Pair deals (067) keep
  // their own columns and are deliberately not duplicated into this table.
  for (const l of lines) {
    if (l.promotion_id && l.full_price_cents !== undefined) {
      redemptions.push({
        promotion_id: l.promotion_id,
        promotion_name: l.promotion_name ?? 'Promotion',
        client_id: clientId,
        appointment_id: appointmentId,
        discount_cents: l.full_price_cents - l.price_cents,
      })
    }
  }

  try {
    const { data: promoRows } = await supabase
      .from('promotions')
      .select(
        'id, name, kind, percent_off, amount_cents, sale_price_cents, min_items, service_ids, starts_at, ends_at, is_active'
      )
      .eq('is_active', true)
      .in('kind', ['new_client', 'referral'])
    const rules = (promoRows ?? []) as PromotionRule[]
    const nowMs = now.getTime()

    // ── The new-client percent ─────────────────────────────
    // "New" means no other live or finished appointment — a cancellation or
    // no-show does not spend somebody's first-visit welcome. The redemption
    // check keeps it to once even if that first booking is later cancelled.
    const nc = newClientPromo(rules, nowMs)
    if (nc && clientId && baseCents > 0) {
      const [{ count: prior }, { count: used }] = await Promise.all([
        supabase
          .from('appointments')
          .select('id', { count: 'exact', head: true })
          .eq('client_id', clientId)
          .neq('id', appointmentId)
          .not('status', 'in', '(cancelled,no_show)'),
        supabase
          .from('promotion_redemptions')
          .select('id', { count: 'exact', head: true })
          .eq('client_id', clientId)
          .eq('promotion_id', nc.id),
      ])

      if ((prior ?? 0) === 0 && (used ?? 0) === 0) {
        const off = pairDiscountCents(baseCents, nc.percent_off!)
        if (off > 0) {
          const { error } = await supabase
            .from('appointments')
            .update({ promo_discount_cents: off })
            .eq('id', appointmentId)
          if (!error) {
            visitDiscount = off
            redemptions.push({
              promotion_id: nc.id,
              promotion_name: nc.name,
              client_id: clientId,
              appointment_id: appointmentId,
              discount_cents: off,
            })
          }
        }
      }
    }

    // ── The friend code ────────────────────────────────────
    // Recording who sent them; the reward belongs to the REFERRER and is
    // taken off one of their visits at the desk. The unique constraint on
    // referred_client_id is what makes a code's count honest — a person is
    // referred into the studio once, so a duplicate insert failing is the
    // rule working, not an error worth surfacing.
    const code = referralCode?.trim().toUpperCase()
    if (code && clientId) {
      const { data: ref } = await supabase
        .from('referral_codes')
        .select('code, client_id')
        .eq('code', code)
        .maybeSingle()

      if (ref && ref.client_id !== clientId) {
        const reward = referralPromo(rules, nowMs)
        const { error: refError } = await supabase.from('referral_redemptions').insert({
          code: ref.code,
          referrer_id: ref.client_id,
          referred_client_id: clientId,
          appointment_id: appointmentId,
          reward_cents: reward?.amount_cents ?? null,
          reward_percent: reward?.amount_cents ? null : (reward?.percent_off ?? null),
          // Pending until the friend's visit completes fully paid — the
          // referral_settle triggers (069) decide that, not this code.
          reward_status: 'pending',
        })

        if (!refError) {
          await supabase.from('notifications').insert({
            user_id: ref.client_id,
            type: 'system',
            title: 'Your referral code was used',
            body: 'A friend booked their first visit with your code. Your reward unlocks once their visit is complete and paid.',
            link: '/account/rewards',
          })
        }
      }
    }

    if (redemptions.length > 0) {
      await supabase.from('promotion_redemptions').insert(redemptions)
    }
  } catch (err) {
    console.error('visit promotions failed for', appointmentId, err)
  }

  return visitDiscount
}

export async function createBooking(req: BookingRequest): Promise<BookingOutcome> {
  const supabase = createAdminClient()
  const now = new Date()

  const requested = new Date(req.startsAt)
  if (Number.isNaN(requested.getTime())) return failure('invalid_request', 400)
  if (req.addonIds.length > MAX_ADDONS) return failure('invalid_request', 400)

  // ── Rate limit by email ────────────────────────────────────
  const { count } = await supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('guest_email', req.email)
    .gte('created_at', new Date(now.getTime() - RATE_LIMIT_WINDOW_MIN * 60_000).toISOString())

  if ((count ?? 0) >= RATE_LIMIT_MAX) return failure('rate_limited', 429)

  // ── Price and duration, from the database ──────────────────
  const outcome = await priceService(req.providerId, req.serviceIds, req.addonIds)
  if (!outcome.ok) {
    return failure(outcome.error, outcome.error === 'unknown_service' ? 404 : 409)
  }

  const priced = outcome.priced
  const { services, addons, durationMinutes, bufferMinutes } = priced

  if (priced.requiresConsultation) return failure('consultation_required', 409)

  // The client's attestation is necessary but never sufficient — the service's
  // own flag is what makes it required, and one gated service gates the visit.
  if (priced.requiresAgeVerification && !req.ageAttested) {
    return failure('age_verification_required', 403)
  }

  // ── Re-derive availability ─────────────────────────────────
  const { data: provider } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', req.providerId)
    .maybeSingle()

  if (!provider) return failure('unknown_provider', 404)

  const dateKey = dateKeyInTimeZone(requested, provider.timezone)

  const availability = await loadAvailability({
    providerId: req.providerId,
    serviceIds: req.serviceIds,
    durationMinutes,
    bufferMinutes,
    fromDateKey: dateKey,
    days: 1,
    now,
  })

  if (availability === 'unavailable') {
    // Nothing is known — "not bookable" or "slot taken" would be a fabricated
    // fact. 503 with retry semantics is the honest answer.
    return failure('service_unavailable', 503)
  }
  if (!availability) return failure('provider_not_bookable', 409)

  const [day] = generateSlots(availability, dateKey, 1)
  const offered = day?.slots.some((s) => s.getTime() === requested.getTime()) ?? false
  if (!offered) return failure('slot_unavailable', 409)

  // ── Insert ─────────────────────────────────────────────────
  const { data: settings } = await supabase
    .from('booking_settings')
    .select('auto_confirm, default_deposit_cents')
    .eq('id', 1)
    .maybeSingle()

  // Deposits add up across services; the studio-wide default only applies when
  // none of the booked services set one of their own.
  const depositCents = priced.depositCents || settings?.default_deposit_cents || 0
  const endsAt = new Date(requested.getTime() + durationMinutes * MINUTE_MS)

  const { data: appointment, error: insertError } = await supabase
    .from('appointments')
    .insert({
      provider_id: req.providerId,
      client_id: req.clientId,
      guest_first_name: req.firstName,
      guest_last_name: req.lastName,
      guest_email: req.email,
      guest_phone: req.phone,
      starts_at: requested.toISOString(),
      ends_at: endsAt.toISOString(),
      buffer_minutes: bufferMinutes,
      // What we ASK for, always. appointment_route_approval (036) is a BEFORE
      // INSERT trigger and holds it for review when a rule says so; the
      // RETURNING below reflects its decision, not this one.
      //
      // Do NOT pre-empt it by reading booking_settings.auto_confirm and writing
      // 'pending' here. That trigger's first line is `if new.source <> 'online'
      // or new.status <> 'confirmed' then return new`, so asking for 'pending'
      // makes it return early: the booking is still held, but
      // booking_review_reason() never runs and `approval_reason` is left null.
      // The queue and the bell then read the fallback 'Held for review' instead
      // of 'Every online booking is held for review', and the one reason the
      // studio-wide switch exists to record is the one reason never recorded.
      // One decision, in one place — the trigger.
      status: 'confirmed',
      source: 'online',
      deposit_cents: depositCents,
      deposit_status: depositCents > 0 ? 'pending' : 'none',
      client_notes: req.notes,
      age_attested_at: req.ageAttested ? now.toISOString() : null,
    })
    .select('id, starts_at, ends_at, status, deposit_cents')
    .single()

  if (insertError) {
    // 23P01 = exclusion_violation: someone took this slot mid-flight.
    if (insertError.code === '23P01') return failure('slot_taken', 409)
    // 23P02 comes from appointments_refuse_banned_client (039).
    if (insertError.code === '23P02') return failure('client_banned', 403)
    void logError('api/book', insertError.message, {
      provider_id: req.providerId,
      starts_at: req.startsAt,
      guest_email: req.email ?? null,
    })
    return failure('booking_failed', 500)
  }

  const lines = [
    ...services.map((svc, i) => ({
      appointment_id: appointment.id,
      service_id: svc.id,
      name_snapshot: svc.name,
      price_cents: svc.price_cents,
      duration_minutes: svc.duration_minutes,
      // The pair deal or promotion, frozen with the price it cut (067/068).
      full_price_cents: svc.full_price_cents ?? null,
      pair_discount_id: svc.pair_discount_id ?? null,
      promotion_id: svc.promotion_id ?? null,
      sort_order: i,
    })),
    // Add-ons sort after every service, so the receipt reads services first.
    ...addons.map((a, i) => ({
      appointment_id: appointment.id,
      addon_id: a.id,
      name_snapshot: a.name,
      price_cents: a.price_cents,
      duration_minutes: a.duration_minutes,
      sort_order: services.length + i,
    })),
  ]

  const { error: lineError } = await supabase.from('appointment_services').insert(lines)
  if (lineError) {
    // Roll back rather than leave a zero-total appointment on the calendar.
    await supabase.from('appointments').delete().eq('id', appointment.id)
    console.error('line item insert failed', lineError)
    return failure('booking_failed', 500)
  }

  // Half of approval routing cannot run until the line items exist:
  // appointment_services_route_approval (036) is an AFTER INSERT trigger on
  // appointment_services, and it is what holds a booking whose service carries
  // requires_booking_approval. That fires after the RETURNING above, so the
  // status we read with the row is already stale for that one reason.
  //
  // Read it back rather than re-deriving it here. The trigger is the authority
  // on what this row is, and a second copy of that decision in application code
  // is how the two drift apart. If the read fails, the insert's own value is
  // still the truth for every other reason.
  //
  // `client_id` comes back for the same reason: `appointment_match_client`
  // (004) backfills it when a guest booking's email or phone matches an
  // existing account, so the person entitled to a member discount is sometimes
  // one the request never named.
  const { data: routed } = await supabase
    .from('appointments')
    .select('status, client_id')
    .eq('id', appointment.id)
    .maybeSingle()

  // A membership is applied after the lines exist, because an included session
  // is claimed from the database rather than decided here. See
  // src/lib/memberships.ts. Nothing about this can fail the booking: a client
  // who loses the race for the last included facial is still booked, and pays
  // the ordinary price.
  const applied = await applyMembershipBenefit({
    appointmentId: appointment.id,
    clientId: routed?.client_id ?? req.clientId,
    lines: services.map((s) => ({ serviceId: s.id, priceCents: s.price_cents })),
    subtotalCents: priced.totalCents,
    now,
  })

  // Visit-level promotions (068) ride after the membership: the new-client
  // percent applies to what the client would otherwise pay, and the referral
  // hand-off is recorded against a booking that now fully exists.
  const membershipCut = applied ? applied.coveredCents + applied.discountCents : 0
  const visitPromoCents = await applyVisitPromotions({
    supabase,
    appointmentId: appointment.id,
    clientId: routed?.client_id ?? req.clientId,
    baseCents: Math.max(priced.totalCents - membershipCut, 0),
    lines: services,
    referralCode: req.referralCode,
    now,
  })

  // A membership or a promotion can take the total below the deposit, and a
  // deposit larger than the whole appointment is not a deposit — it is asking
  // somebody to prepay more than they owe. `deposit_cents` was written at
  // insert, before either was applied, because applying them needs the lines
  // to exist. So it is capped here, once the real total is known, and the row
  // is corrected rather than the response quietly disagreeing with the
  // database.
  //
  // Integer cents throughout: `Math.min` on two integers, never a rate.
  const finalTotalCents = Math.max(priced.totalCents - membershipCut - visitPromoCents, 0)
  let depositAfterBenefit = appointment.deposit_cents
  if (depositAfterBenefit > finalTotalCents) {
    depositAfterBenefit = finalTotalCents
    const { error: capError } = await supabase
      .from('appointments')
      .update({
        deposit_cents: depositAfterBenefit,
        deposit_status: depositAfterBenefit > 0 ? 'pending' : 'none',
      })
      .eq('id', appointment.id)

    // A booking that is already committed must not fail over this. Worst case
    // the client is asked for a deposit that is too large and the studio
    // refunds it — visible and fixable, unlike losing the appointment.
    if (capError) {
      console.error('deposit cap failed for', appointment.id, capError.message)
      depositAfterBenefit = appointment.deposit_cents
    }
  }

  // Mirror it into the provider's Google Calendar. Deliberately not awaited
  // into the response path: the booking is already committed and the client is
  // waiting. If Google is slow or down, the next sync reconciles rather than
  // the client seeing an error for a slot they successfully took.
  void syncAppointmentToCalendar(appointment.id)

  return {
    ok: true,
    booking: {
      id: appointment.id,
      startsAt: appointment.starts_at,
      endsAt: appointment.ends_at,
      status: routed?.status ?? appointment.status,
      depositCents: depositAfterBenefit,
      totalCents: Math.max(
        finalTotalCents,
        0
      ),
      timezone: provider.timezone,
    },
  }
}

/** Client-facing copy for each failure mode. */
export const BOOKING_ERROR_MESSAGES: Record<BookingError, string> = {
  invalid_request: 'Something in that request did not look right. Please try again.',
  unknown_provider: 'That provider is not available.',
  provider_not_bookable: 'That provider is not taking online bookings right now.',
  provider_timezone_invalid: 'We hit a scheduling error. Please call us to book.',
  unknown_service: 'That service is no longer available.',
  service_not_offered_by_provider: 'That provider does not offer this service.',
  consultation_required: 'This treatment starts with a consultation. Please get in touch.',
  age_verification_required: 'You must confirm you are 18 or older to book this service.',
  unknown_addon: 'One of the add-ons is no longer available.',
  addon_not_available_for_service: 'That add-on cannot be combined with this service.',
  slot_unavailable: 'That time is no longer open. Please pick another.',
  slot_taken: 'Someone just booked that time. Please pick another.',
  // The word "banned" never reaches a client. The staff-facing reason lives in
  // client_bans, which no client can read. See migration 039.
  client_banned:
    'We are not able to book this one online. Please call the studio and we will take it from there.',
  rate_limited: 'That is a lot of bookings at once. Please wait a few minutes.',
  booking_failed: 'We could not complete the booking. Please try again or call us.',
  service_unavailable:
    'We could not check the calendar just now. Nothing is wrong on your side — give it a moment and try again.',
}

// ── Staff bookings ──────────────────────────────────────────

export interface StaffBookingRequest {
  clientId: string
  providerId: string
  /** One or more services, booked as a single continuous appointment. */
  serviceIds: number[]
  addonIds: number[]
  startsAt: string
  notes: string | null
  /** The staff member doing the booking; recorded on the appointment. */
  createdBy: string
  /**
   * Staff can book outside published hours — squeezing someone in before open
   * is a normal thing for a studio to do. The exclusion constraint still runs,
   * so this can never create a double booking; it only skips the
   * "is this slot advertised" check.
   */
  overrideAvailability?: boolean
}

/**
 * Book on behalf of an existing client.
 *
 * Shares the pricing and insert path with `createBooking` on purpose. The
 * previous implementation was a separate hand-rolled route that built the
 * `slot` column itself — `slot` is a tstzrange maintained by a trigger, so
 * every staff booking failed with `22P02 malformed range literal`. Anything
 * that writes an appointment goes through here or `createBooking`, and neither
 * touches `slot`.
 *
 * No deposit is taken: when the studio books someone in, payment is handled in
 * person rather than by emailing them a Stripe link.
 */
export async function createStaffBooking(req: StaffBookingRequest): Promise<BookingOutcome> {
  const supabase = createAdminClient()
  const now = new Date()

  const requested = new Date(req.startsAt)
  if (Number.isNaN(requested.getTime())) return failure('invalid_request', 400)
  if (req.addonIds.length > MAX_ADDONS) return failure('invalid_request', 400)

  const { data: client } = await supabase
    .from('profiles')
    .select('id')
    .eq('id', req.clientId)
    .eq('role', 'client')
    .maybeSingle()

  if (!client) return failure('invalid_request', 404)

  // Same server-side pricing as a public booking: the caller names the service,
  // never what it costs.
  const outcome = await priceService(req.providerId, req.serviceIds, req.addonIds)
  if (!outcome.ok) {
    return failure(outcome.error, outcome.error === 'unknown_service' ? 404 : 409)
  }
  const { services, addons, durationMinutes, bufferMinutes } = outcome.priced

  const { data: provider } = await supabase
    .from('profiles')
    .select('timezone')
    .eq('id', req.providerId)
    .maybeSingle()

  if (!provider) return failure('unknown_provider', 404)

  if (!req.overrideAvailability) {
    const dateKey = dateKeyInTimeZone(requested, provider.timezone)
    const availability = await loadAvailability({
      providerId: req.providerId,
      serviceIds: req.serviceIds,
      durationMinutes,
      bufferMinutes,
      fromDateKey: dateKey,
      days: 1,
      now,
    })
    if (availability === 'unavailable') {
    // Nothing is known — "not bookable" or "slot taken" would be a fabricated
    // fact. 503 with retry semantics is the honest answer.
    return failure('service_unavailable', 503)
  }
  if (!availability) return failure('provider_not_bookable', 409)

    const [day] = generateSlots(availability, dateKey, 1)
    const offered = day?.slots.some((s) => s.getTime() === requested.getTime()) ?? false
    if (!offered) return failure('slot_unavailable', 409)
  }

  const endsAt = new Date(requested.getTime() + durationMinutes * MINUTE_MS)

  // `slot` is deliberately absent — the appointments_set_slot trigger owns it.
  const { data: appointment, error: insertError } = await supabase
    .from('appointments')
    .insert({
      provider_id: req.providerId,
      client_id: req.clientId,
      starts_at: requested.toISOString(),
      ends_at: endsAt.toISOString(),
      buffer_minutes: bufferMinutes,
      status: 'confirmed',
      source: 'staff',
      deposit_cents: 0,
      deposit_status: 'none',
      client_notes: req.notes,
      created_by: req.createdBy,
    })
    .select('id, starts_at, ends_at, status, deposit_cents')
    .single()

  if (insertError) {
    // The exclusion constraint is still the thing that makes this safe, even
    // when availability was overridden.
    if (insertError.code === '23P01') return failure('slot_taken', 409)
    // 23P02 comes from appointments_refuse_banned_client (039).
    if (insertError.code === '23P02') return failure('client_banned', 403)
    console.error('staff booking insert failed', insertError)
    return failure('booking_failed', 500)
  }

  const lines = [
    ...services.map((svc, i) => ({
      appointment_id: appointment.id,
      service_id: svc.id,
      name_snapshot: svc.name,
      price_cents: svc.price_cents,
      duration_minutes: svc.duration_minutes,
      // The pair deal and every promotion apply at the desk too — the same
      // priceService decided them, and the front desk should never have to
      // take a running deal off by hand.
      full_price_cents: svc.full_price_cents ?? null,
      pair_discount_id: svc.pair_discount_id ?? null,
      promotion_id: svc.promotion_id ?? null,
      sort_order: i,
    })),
    // Add-ons sort after every service, so the receipt reads services first.
    ...addons.map((a, i) => ({
      appointment_id: appointment.id,
      addon_id: a.id,
      name_snapshot: a.name,
      price_cents: a.price_cents,
      duration_minutes: a.duration_minutes,
      sort_order: services.length + i,
    })),
  ]

  const { error: lineError } = await supabase.from('appointment_services').insert(lines)
  if (lineError) {
    await supabase.from('appointments').delete().eq('id', appointment.id)
    console.error('staff booking line items failed', lineError)
    return failure('booking_failed', 500)
  }

  // The same benefit as an online booking. A member who rings up rather than
  // using the website is still a member, and the front desk should never have
  // to remember to take the discount off by hand.
  const applied = await applyMembershipBenefit({
    appointmentId: appointment.id,
    clientId: req.clientId,
    lines: services.map((s) => ({ serviceId: s.id, priceCents: s.price_cents })),
    subtotalCents: outcome.priced.totalCents,
    now,
  })

  // Visit-level promotions too — a new client booked over the phone is still
  // a new client. No referral code on this path; the desk can read one out of
  // the client's account instead.
  const staffMembershipCut = applied ? applied.coveredCents + applied.discountCents : 0
  const staffPromoCents = await applyVisitPromotions({
    supabase,
    appointmentId: appointment.id,
    clientId: req.clientId,
    baseCents: Math.max(outcome.priced.totalCents - staffMembershipCut, 0),
    lines: services,
    now,
  })

  void syncAppointmentToCalendar(appointment.id)

  // No notification is written here: the appointment_notify trigger already
  // tells the client and the provider. Doing it again sent two.
  return {
    ok: true,
    booking: {
      id: appointment.id,
      startsAt: appointment.starts_at,
      endsAt: appointment.ends_at,
      status: appointment.status,
      depositCents: 0,
      totalCents: Math.max(
        outcome.priced.totalCents - staffMembershipCut - staffPromoCents,
        0
      ),
      timezone: provider.timezone,
    },
  }
}
