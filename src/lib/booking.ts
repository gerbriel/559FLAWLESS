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
import { createAdminClient } from '@/lib/supabase/admin'
import { generateSlots, type AvailabilityInput } from '@/lib/availability'
import { dateKeyInTimeZone, isValidTimeZone, MINUTE_MS } from '@/lib/time'

export const MAX_ADDONS = 6
/** The UI offers slots with the full lead time; this absorbs page-load-to-submit
 *  latency so a valid booking isn't rejected for being seconds too late. */
const LEAD_SLACK_MINUTES = 30
const RATE_LIMIT_WINDOW_MIN = 10
const RATE_LIMIT_MAX = 4

export type BookingError =
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

export interface BookingRequest {
  providerId: string
  serviceId: number
  addonIds: number[]
  startsAt: string
  firstName: string
  lastName: string
  email: string
  phone: string | null
  notes: string | null
  ageAttested: boolean
  clientId: string | null
}

export interface BookingResult {
  id: string
  startsAt: string
  endsAt: string
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
  now?: Date
}): Promise<AvailabilityInput | null> {
  const supabase = createAdminClient()
  const now = opts.now ?? new Date()

  const { data: provider } = await supabase
    .from('profiles')
    .select('timezone, accepts_online_booking, suspended_at, role')
    .eq('id', opts.providerId)
    .maybeSingle()

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
    { data: settings },
    { data: schedules },
    { data: blocks },
    { data: closureRows },
    { data: appts },
    { data: calBusy },
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
  ])

  // An existing appointment occupies its window PLUS its own turnover buffer.
  const busy = [
    ...(appts ?? []).map((a) => ({
      starts_at: a.starts_at,
      ends_at: new Date(
        new Date(a.ends_at).getTime() + (a.buffer_minutes ?? 0) * MINUTE_MS
      ).toISOString(),
    })),
    ...(calBusy ?? []),
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

export interface PricedService {
  service: {
    id: number
    name: string
    deposit_cents: number
    requires_age_verification: boolean
    requires_consultation: boolean
  }
  addons: { id: number; name: string; price_cents: number; duration_minutes: number }[]
  baseDuration: number
  basePrice: number
  durationMinutes: number
  bufferMinutes: number
  totalCents: number
}

export type PriceOutcome =
  | { ok: true; priced: PricedService }
  | { ok: false; error: BookingError }

/**
 * Server-authoritative duration/price for a service as performed by a specific
 * provider, including add-ons. This is where the numbers come from — never the
 * request body.
 */
export async function priceService(
  providerId: string,
  serviceId: number,
  addonIds: number[]
): Promise<PriceOutcome> {
  const supabase = createAdminClient()

  const [{ data: service }, { data: link }] = await Promise.all([
    supabase
      // One string literal: postgrest-js parses the select at the type level,
      // and `'a' + 'b'` widens to `string`, collapsing the result type.
      .from('services')
      .select(
        'id, name, price_cents, duration_minutes, buffer_minutes, deposit_cents, is_active, requires_age_verification, requires_consultation'
      )
      .eq('id', serviceId)
      .maybeSingle(),
    supabase
      .from('provider_services')
      .select('price_cents, duration_minutes, is_active')
      .eq('provider_id', providerId)
      .eq('service_id', serviceId)
      .maybeSingle(),
  ])

  if (!service?.is_active) return { ok: false, error: 'unknown_service' }
  if (!link?.is_active) return { ok: false, error: 'service_not_offered_by_provider' }

  let addons: PricedService['addons'] = []

  if (addonIds.length > 0) {
    const [{ data: addonRows }, { data: allowed }] = await Promise.all([
      supabase
        .from('service_addons')
        .select('id, name, price_cents, duration_minutes')
        .in('id', addonIds)
        .eq('is_active', true),
      supabase
        .from('service_addon_links')
        .select('addon_id')
        .eq('service_id', serviceId)
        .in('addon_id', addonIds),
    ])

    addons = addonRows ?? []
    if (addons.length !== addonIds.length) return { ok: false, error: 'unknown_addon' }
    if ((allowed?.length ?? 0) !== addonIds.length) {
      return { ok: false, error: 'addon_not_available_for_service' }
    }
  }

  const baseDuration = link.duration_minutes ?? service.duration_minutes
  const basePrice = link.price_cents ?? service.price_cents

  return {
    ok: true,
    priced: {
      service: {
        id: service.id,
        name: service.name,
        deposit_cents: service.deposit_cents,
        requires_age_verification: service.requires_age_verification,
        requires_consultation: service.requires_consultation,
      },
      addons,
      baseDuration,
      basePrice,
      durationMinutes: baseDuration + addons.reduce((n, a) => n + a.duration_minutes, 0),
      bufferMinutes: service.buffer_minutes,
      totalCents: basePrice + addons.reduce((n, a) => n + a.price_cents, 0),
    },
  }
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
  const outcome = await priceService(req.providerId, req.serviceId, req.addonIds)
  if (!outcome.ok) {
    return failure(outcome.error, outcome.error === 'unknown_service' ? 404 : 409)
  }

  const priced = outcome.priced
  const { service, addons, baseDuration, basePrice, durationMinutes, bufferMinutes } = priced

  if (service.requires_consultation) return failure('consultation_required', 409)

  // The client's attestation is necessary but never sufficient — the service's
  // own flag is what makes it required.
  if (service.requires_age_verification && !req.ageAttested) {
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
    durationMinutes,
    bufferMinutes,
    fromDateKey: dateKey,
    days: 1,
    now,
  })

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

  const depositCents = service.deposit_cents || settings?.default_deposit_cents || 0
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
      status: (settings?.auto_confirm ?? true) ? 'confirmed' : 'pending',
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
    console.error('booking insert failed', insertError)
    return failure('booking_failed', 500)
  }

  const lines = [
    {
      appointment_id: appointment.id,
      service_id: service.id,
      name_snapshot: service.name,
      price_cents: basePrice,
      duration_minutes: baseDuration,
      sort_order: 0,
    },
    ...addons.map((a, i) => ({
      appointment_id: appointment.id,
      addon_id: a.id,
      name_snapshot: a.name,
      price_cents: a.price_cents,
      duration_minutes: a.duration_minutes,
      sort_order: i + 1,
    })),
  ]

  const { error: lineError } = await supabase.from('appointment_services').insert(lines)
  if (lineError) {
    // Roll back rather than leave a zero-total appointment on the calendar.
    await supabase.from('appointments').delete().eq('id', appointment.id)
    console.error('line item insert failed', lineError)
    return failure('booking_failed', 500)
  }

  return {
    ok: true,
    booking: {
      id: appointment.id,
      startsAt: appointment.starts_at,
      endsAt: appointment.ends_at,
      status: appointment.status,
      depositCents: appointment.deposit_cents,
      totalCents: priced.totalCents,
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
  rate_limited: 'That is a lot of bookings at once. Please wait a few minutes.',
  booking_failed: 'We could not complete the booking. Please try again or call us.',
}

// ── Staff bookings ──────────────────────────────────────────

export interface StaffBookingRequest {
  clientId: string
  providerId: string
  serviceId: number
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
  const outcome = await priceService(req.providerId, req.serviceId, req.addonIds)
  if (!outcome.ok) {
    return failure(outcome.error, outcome.error === 'unknown_service' ? 404 : 409)
  }
  const { service, addons, baseDuration, basePrice, durationMinutes, bufferMinutes } =
    outcome.priced

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
      durationMinutes,
      bufferMinutes,
      fromDateKey: dateKey,
      days: 1,
      now,
    })
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
    console.error('staff booking insert failed', insertError)
    return failure('booking_failed', 500)
  }

  const lines = [
    {
      appointment_id: appointment.id,
      service_id: service.id,
      name_snapshot: service.name,
      price_cents: basePrice,
      duration_minutes: baseDuration,
      sort_order: 0,
    },
    ...addons.map((a, i) => ({
      appointment_id: appointment.id,
      addon_id: a.id,
      name_snapshot: a.name,
      price_cents: a.price_cents,
      duration_minutes: a.duration_minutes,
      sort_order: i + 1,
    })),
  ]

  const { error: lineError } = await supabase.from('appointment_services').insert(lines)
  if (lineError) {
    await supabase.from('appointments').delete().eq('id', appointment.id)
    console.error('staff booking line items failed', lineError)
    return failure('booking_failed', 500)
  }

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
      totalCents: outcome.priced.totalCents,
      timezone: provider.timezone,
    },
  }
}
