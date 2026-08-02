// 559 Flawless — Commissions.
//
// THIS REPORT GETS PAID FROM. Everything below defers to migration 034, which
// owns the arithmetic:
//
//   commission_for_appointment(appointment, location?)
//   commission_for_order(order, location?)
//   commission_for_period(profile, from, to, location?)
//
// Nothing here re-derives a rate, a percentage or a payout. This module asks
// those functions, groups what they answer, and shows the plan and rate that
// produced each figure so a provider can check their own number instead of
// being handed one. Three properties of 034 are load-bearing and are surfaced
// rather than hidden:
//
//   • Rates are BASIS POINTS. 4000 is 40.00%. Rendered by integer division of
//     the bp value, never by dividing a float.
//   • The plan in force ON THE DATE OF THE APPOINTMENT is used, not today's.
//     A window that straddles a plan change comes out right per line, which is
//     why the summary row can name two plans.
//   • Commission is on money TAKEN. A no-show nobody paid for earns nothing; a
//     forfeited deposit earns on the deposit; a refund is a negative payment
//     row and reverses what it reversed.
//
// The one figure 034 cannot be asked for separately is the flat-per-service
// component — see FLAT_NOTE below. It is reported as the rate in force rather
// than decomposed, because decomposing it means a second implementation of the
// service → category → tier → plan ladder, which is exactly the drift 034 was
// written to prevent.

import type {
  ReportColumn,
  ReportContext,
  ReportModule,
  ReportResult,
  ReportRow,
} from '@/lib/reports/types'
import { money, rangeToInstants } from '@/lib/reports/types'
import { dateKeyInTimeZone } from '@/lib/time'

// ---------------------------------------------------------------------------
// Shapes fetched from the database
// ---------------------------------------------------------------------------

interface LocationRow {
  id: number
  name: string
  timezone: string
}

interface AppointmentRow {
  id: string
  provider_id: string
  location_id: number
  starts_at: string
  status: string
}

interface OrderRow {
  id: number
  order_number: string | null
  location_id: number
  sold_by: string | null
  paid_at: string | null
  created_at: string
  subtotal_cents: number
  discount_cents: number
}

interface PlanWindow {
  planId: number
  /** Wall-clock 'YYYY-MM-DD' in the location's zone. */
  from: string
  to: string | null
}

interface PlanCard {
  id: number
  name: string
  serviceRateBp: number
  retailRateBp: number
  serviceFlatCents: number
}

/** One appointment or one retail sale, priced by 034. */
export interface CommissionLine {
  kind: 'service' | 'retail'
  providerId: string
  locationId: number
  /** Studio-local date the work happened / the sale was taken. */
  dateKey: string
  detail: string
  /** Money actually taken against this appointment or order, in cents. */
  collectedCents: number
  /** What 034 said this line earned, in cents. */
  commissionCents: number
  planId: number | null
}

// ---------------------------------------------------------------------------
// Presentation helpers — integer arithmetic only
// ---------------------------------------------------------------------------

/**
 * Basis points to a percentage string, without ever touching a float.
 *
 * `Math.trunc(bp / 100)` and `bp % 100` are the same technique
 * `centsToDecimalString` uses in types.ts: the division is only ever consumed
 * through a truncation, so no fractional value survives into a figure.
 */
export function bpToPercent(bp: number): string {
  const n = Math.trunc(bp)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}%`
}

/**
 * What a line actually paid out at, as a percentage of money taken.
 *
 * Derived from the two figures the report already shows rather than from a
 * rate card, so it stays honest when a service override, a category rate or a
 * tier moved the number. `× 10000` first keeps the whole thing in integers:
 * even a five-figure payment is nowhere near 2^53.
 */
export function effectiveRateBp(commissionCents: number, collectedCents: number): number | null {
  if (collectedCents <= 0) return null
  return Math.trunc((commissionCents * 10000) / collectedCents)
}

function planCardLabel(plan: PlanCard): string {
  const parts = [
    `${bpToPercent(plan.serviceRateBp)} service`,
    `${bpToPercent(plan.retailRateBp)} retail`,
  ]
  if (plan.serviceFlatCents > 0) parts.push(`+${money(plan.serviceFlatCents)}/service`)
  return parts.join(' · ')
}

// ---------------------------------------------------------------------------
// Plan resolution — a lookup, not a calculation
// ---------------------------------------------------------------------------

/**
 * The plan in force for a person, at a site, on a date.
 *
 * A deliberate mirror of `commission_plan_on()`: latest `effective_from` that
 * covers the date, ignoring whether the plan is still active. This is a row
 * lookup on a table the caller can already read, not a re-derivation of any
 * money — the payout itself still comes from 034. Doing it here rather than as
 * one RPC per line saves a round trip per appointment for a label.
 *
 * Date keys are 'YYYY-MM-DD', so string comparison IS date comparison.
 */
export function planOnDate(
  windows: PlanWindow[] | undefined,
  dateKey: string
): number | null {
  if (!windows) return null
  for (const w of windows) {
    if (w.from <= dateKey && (w.to === null || w.to >= dateKey)) return w.planId
  }
  return null
}

// ---------------------------------------------------------------------------
// Aggregation — pure, so it can be tested against a seeded fixture
// ---------------------------------------------------------------------------

export interface CommissionAggregateInput {
  lines: CommissionLine[]
  providerNames: Map<string, string>
  locationNames: Map<number, string>
  planCards: Map<number, PlanCard>
  planWindows: Map<string, PlanWindow[]>
}

export interface ProviderLocationTotals {
  providerId: string
  locationId: number
  serviceCommissionCents: number
  retailCommissionCents: number
  totalCommissionCents: number
  collectedCents: number
  appointments: number
  sales: number
  planIds: number[]
}

export function planKey(providerId: string, locationId: number): string {
  return `${providerId}|${locationId}`
}

/**
 * Roll the priced lines up per provider per site.
 *
 * `planIds` keeps the order the plans took effect in, so a window that
 * straddled a change reads "Provider standard → Senior provider" rather than
 * silently showing one of them.
 */
export function aggregateByProviderLocation(
  input: CommissionAggregateInput
): ProviderLocationTotals[] {
  const byKey = new Map<string, ProviderLocationTotals>()

  for (const line of input.lines) {
    const key = planKey(line.providerId, line.locationId)
    let row = byKey.get(key)
    if (!row) {
      row = {
        providerId: line.providerId,
        locationId: line.locationId,
        serviceCommissionCents: 0,
        retailCommissionCents: 0,
        totalCommissionCents: 0,
        collectedCents: 0,
        appointments: 0,
        sales: 0,
        planIds: [],
      }
      byKey.set(key, row)
    }
    if (line.kind === 'service') {
      row.serviceCommissionCents += line.commissionCents
      row.appointments += 1
    } else {
      row.retailCommissionCents += line.commissionCents
      row.sales += 1
    }
    row.totalCommissionCents += line.commissionCents
    row.collectedCents += line.collectedCents
  }

  // Plans in the order they took effect, read from the assignment table rather
  // than from whichever line happened to come first.
  for (const row of byKey.values()) {
    const windows = input.planWindows.get(planKey(row.providerId, row.locationId)) ?? []
    const ordered = [...windows].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0))
    const used = new Set(
      input.lines
        .filter((l) => l.providerId === row.providerId && l.locationId === row.locationId)
        .map((l) => l.planId)
        .filter((id): id is number => id !== null)
    )
    row.planIds = ordered.map((w) => w.planId).filter((id) => used.has(id))
  }

  return [...byKey.values()].sort((a, b) => {
    const an = input.providerNames.get(a.providerId) ?? ''
    const bn = input.providerNames.get(b.providerId) ?? ''
    if (an !== bn) return an < bn ? -1 : 1
    return a.locationId - b.locationId
  })
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

/** PostgREST caps URL length; `.in()` lists have to be fed in bites. */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Bounded-concurrency map.
 *
 * The per-line figures come from one RPC each — 034 is the only implementation
 * and there is no batch entry point, which is the right trade (one calculation,
 * in one place) but does mean N round trips. Eight at a time keeps a month of a
 * busy studio quick without opening a connection per appointment.
 */
async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

/** Past this, the line-level detail is dropped rather than firing 5,000 RPCs. */
const MAX_DETAIL_LINES = 2000

const FLAT_NOTE =
  'Flat per-service amounts are inside the service commission figure, not a ' +
  'separate column. commission_for_appointment() accumulates the percentage ' +
  'and the flat into one numerator and divides exactly once, so a split that ' +
  'added back up to the total would need a second copy of the service → ' +
  'category → tier → plan ladder — the drift migration 034 exists to prevent. ' +
  'The flat in force is shown in the Rate column instead.'

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const COLUMNS: ReportColumn[] = [
  { key: 'provider', label: 'Provider', format: 'text' },
  { key: 'location', label: 'Location', format: 'text' },
  { key: 'date', label: 'Date', format: 'date' },
  { key: 'detail', label: 'Detail', format: 'text' },
  { key: 'plan', label: 'Plan', format: 'text' },
  { key: 'rate', label: 'Rate', format: 'text' },
  { key: 'effective', label: 'Effective', format: 'text', align: 'right' },
  { key: 'collected_cents', label: 'Money taken', format: 'money', total: 'sum' },
  { key: 'service_commission_cents', label: 'Service commission', format: 'money', total: 'sum' },
  { key: 'retail_commission_cents', label: 'Retail commission', format: 'money', total: 'sum' },
  { key: 'total_commission_cents', label: 'Total commission', format: 'money', total: 'sum' },
]

export const commissionsReport: ReportModule = {
  key: 'commissions',
  title: 'Commissions',
  description:
    'What each provider earned, priced by the plan in force on the day and on ' +
    'money actually taken. Includes the per-appointment working.',
  // Financial report. RLS is still the boundary — can_read_commission() inside
  // 034 refuses to price somebody else's work whatever the UI allows.
  minRole: 'manager',
  filters: ['dateRange', 'location', 'provider'],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const notes: string[] = []

    // ── Sites in scope, each with its own wall clock ───────────
    const locationQuery = ctx.supabase
      .from('locations')
      .select('id, name, timezone')
      .order('sort_order')
    const { data: locationData, error: locationError } = ctx.locationId
      ? await locationQuery.eq('id', ctx.locationId)
      : await locationQuery
    if (locationError) throw new Error(`Commissions: locations — ${locationError.message}`)

    const locations = (locationData ?? []) as LocationRow[]
    if (locations.length === 0) {
      return { columns: COLUMNS, rows: [], notes: ['No location matched this filter.'] }
    }

    const zoneOf = new Map(locations.map((l) => [l.id, l.timezone]))
    const locationNames = new Map(locations.map((l) => [l.id, l.name]))
    const locationIds = locations.map((l) => l.id)

    // Widest instant window across every site's midnight, then narrowed per row
    // against that row's own site. Two sites in different zones do not share a
    // day boundary, and a single window would clip one of them.
    let startIso = ''
    let endIso = ''
    for (const l of locations) {
      const bounds = rangeToInstants(ctx.from, ctx.to, l.timezone)
      if (!startIso || bounds.startIso < startIso) startIso = bounds.startIso
      if (!endIso || bounds.endIso > endIso) endIso = bounds.endIso
    }

    /** Does this instant fall inside the range, in ITS OWN site's zone? */
    const localDateKey = (instant: string, locationId: number): string | null => {
      const zone = zoneOf.get(locationId)
      if (!zone) return null
      const key = dateKeyInTimeZone(new Date(instant), zone)
      return key >= ctx.from && key <= ctx.to ? key : null
    }

    // ── Appointments in the window ─────────────────────────────
    let appointmentQuery = ctx.supabase
      .from('appointments')
      .select('id, provider_id, location_id, starts_at, status')
      .in('location_id', locationIds)
      .gte('starts_at', startIso)
      .lt('starts_at', endIso)
    if (ctx.providerId) appointmentQuery = appointmentQuery.eq('provider_id', ctx.providerId)

    const { data: appointmentData, error: appointmentError } = await appointmentQuery
    if (appointmentError) {
      throw new Error(`Commissions: appointments — ${appointmentError.message}`)
    }

    const appointments = ((appointmentData ?? []) as AppointmentRow[]).filter(
      (a) => localDateKey(a.starts_at, a.location_id) !== null
    )

    // ── Counter sales in the window ────────────────────────────
    //
    // `coalesce(paid_at, created_at)` is what 034 dates a sale by, so the
    // filter has to be the same disjunction rather than a bound on one column.
    // An online order has no `sold_by` and earns nobody anything — nobody stood
    // at a counter — so it never reaches the report at all.
    let orderQuery = ctx.supabase
      .from('orders')
      .select(
        'id, order_number, location_id, sold_by, paid_at, created_at, subtotal_cents, discount_cents'
      )
      .in('location_id', locationIds)
      .not('sold_by', 'is', null)
      .or(
        `and(paid_at.gte.${startIso},paid_at.lt.${endIso}),` +
          `and(paid_at.is.null,created_at.gte.${startIso},created_at.lt.${endIso})`
      )
    if (ctx.providerId) orderQuery = orderQuery.eq('sold_by', ctx.providerId)

    const { data: orderData, error: orderError } = await orderQuery
    if (orderError) throw new Error(`Commissions: orders — ${orderError.message}`)

    const orders = ((orderData ?? []) as OrderRow[]).filter(
      (o) => localDateKey(o.paid_at ?? o.created_at, o.location_id) !== null
    )

    // ── Money taken against each ───────────────────────────────
    //
    // `payments` is the authoritative ledger. Refunds are negative rows and net
    // themselves out by summing. This is the SAME figure the Staff Performance
    // report calls "revenue generated" — deliberately, so the two agree.
    const collectedByAppointment = new Map<string, number>()
    const collectedByOrder = new Map<number, number>()

    for (const ids of chunk(appointments.map((a) => a.id), 200)) {
      if (ids.length === 0) continue
      const { data, error } = await ctx.supabase
        .from('payments')
        .select('appointment_id, amount_cents')
        .eq('status', 'succeeded')
        .in('appointment_id', ids)
      if (error) throw new Error(`Commissions: payments — ${error.message}`)
      for (const p of data ?? []) {
        if (!p.appointment_id) continue
        collectedByAppointment.set(
          p.appointment_id,
          (collectedByAppointment.get(p.appointment_id) ?? 0) + p.amount_cents
        )
      }
    }

    for (const ids of chunk(orders.map((o) => o.id), 200)) {
      if (ids.length === 0) continue
      const { data, error } = await ctx.supabase
        .from('payments')
        .select('order_id, amount_cents')
        .eq('status', 'succeeded')
        .in('order_id', ids)
      if (error) throw new Error(`Commissions: order payments — ${error.message}`)
      for (const p of data ?? []) {
        if (p.order_id === null) continue
        collectedByOrder.set(p.order_id, (collectedByOrder.get(p.order_id) ?? 0) + p.amount_cents)
      }
    }

    // ── What was booked, for the working ───────────────────────
    const linesByAppointment = new Map<string, { name: string; price: number }[]>()
    for (const ids of chunk(appointments.map((a) => a.id), 200)) {
      if (ids.length === 0) continue
      const { data, error } = await ctx.supabase
        .from('appointment_services')
        .select('appointment_id, name_snapshot, price_cents, sort_order')
        .in('appointment_id', ids)
        .order('sort_order')
      if (error) throw new Error(`Commissions: appointment services — ${error.message}`)
      for (const l of data ?? []) {
        const bucket = linesByAppointment.get(l.appointment_id) ?? []
        bucket.push({ name: l.name_snapshot, price: l.price_cents })
        linesByAppointment.set(l.appointment_id, bucket)
      }
    }

    // ── Who was on what plan, and when ─────────────────────────
    const providerIds = [
      ...new Set([
        ...appointments.map((a) => a.provider_id),
        ...orders.map((o) => o.sold_by).filter((id): id is string => !!id),
      ]),
    ]

    const planWindows = new Map<string, PlanWindow[]>()
    const planCards = new Map<number, PlanCard>()

    if (providerIds.length > 0) {
      for (const ids of chunk(providerIds, 100)) {
        const { data, error } = await ctx.supabase
          .from('staff_commission_plans')
          .select('profile_id, plan_id, location_id, effective_from, effective_to')
          .in('profile_id', ids)
          .in('location_id', locationIds)
          .lte('effective_from', ctx.to)
          .or(`effective_to.is.null,effective_to.gte.${ctx.from}`)
          .order('effective_from', { ascending: false })
        if (error) throw new Error(`Commissions: plan assignments — ${error.message}`)
        for (const a of data ?? []) {
          const key = planKey(a.profile_id, a.location_id)
          const bucket = planWindows.get(key) ?? []
          bucket.push({ planId: a.plan_id, from: a.effective_from, to: a.effective_to })
          planWindows.set(key, bucket)
        }
      }

      const planIds = [...new Set([...planWindows.values()].flat().map((w) => w.planId))]
      if (planIds.length > 0) {
        const { data, error } = await ctx.supabase
          .from('commission_plans')
          .select('id, name, service_rate_bp, retail_rate_bp, service_flat_cents')
          .in('id', planIds)
        if (error) throw new Error(`Commissions: plans — ${error.message}`)
        for (const p of data ?? []) {
          planCards.set(p.id, {
            id: p.id,
            name: p.name,
            serviceRateBp: p.service_rate_bp,
            retailRateBp: p.retail_rate_bp,
            serviceFlatCents: p.service_flat_cents,
          })
        }
      }
    }

    const providerNames = new Map<string, string>()
    if (providerIds.length > 0) {
      for (const ids of chunk(providerIds, 100)) {
        const { data, error } = await ctx.supabase
          .from('profiles')
          .select('id, first_name, last_name, display_name')
          .in('id', ids)
        if (error) throw new Error(`Commissions: providers — ${error.message}`)
        for (const p of data ?? []) {
          const full = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
          providerNames.set(p.id, full || p.display_name || 'Unknown provider')
        }
      }
    }

    // ── Price every line, through 034 and nothing else ─────────
    const lineCount = appointments.length + orders.length
    const detailed = lineCount <= MAX_DETAIL_LINES
    if (!detailed) {
      notes.push(
        `${lineCount.toLocaleString('en-US')} appointments and sales fall in this ` +
          `range — more than the ${MAX_DETAIL_LINES.toLocaleString('en-US')} the ` +
          'per-line working is priced for. Totals below still come from ' +
          'commission_for_period(); narrow the range or the location to see the working.'
      )
    }

    const lines: CommissionLine[] = []
    let rpcFailures = 0

    if (detailed) {
      const serviceResults = await mapPool(appointments, 8, async (a) => {
        const { data, error } = await ctx.supabase.rpc('commission_for_appointment', {
          p_appointment: a.id,
          p_location: a.location_id,
        })
        if (error) return null
        return typeof data === 'number' ? data : 0
      })

      appointments.forEach((a, i) => {
        const cents = serviceResults[i]
        if (cents === null) {
          rpcFailures += 1
          return
        }
        const dateKey = localDateKey(a.starts_at, a.location_id)
        if (!dateKey) return
        const booked = linesByAppointment.get(a.id) ?? []
        const value = booked.reduce((sum, l) => sum + l.price, 0)
        const names = booked.map((l) => l.name)
        const label = names.length > 3 ? `${names.slice(0, 3).join(' + ')} +${names.length - 3}` : names.join(' + ')
        const statusPrefix =
          a.status === 'completed' || a.status === 'confirmed' ? '' : `${a.status.replace('_', '-')} · `
        lines.push({
          kind: 'service',
          providerId: a.provider_id,
          locationId: a.location_id,
          dateKey,
          detail: `${statusPrefix}${label || 'No services recorded'} · value ${money(value)}`,
          collectedCents: collectedByAppointment.get(a.id) ?? 0,
          commissionCents: cents,
          planId: planOnDate(planWindows.get(planKey(a.provider_id, a.location_id)), dateKey),
        })
      })

      const retailResults = await mapPool(orders, 8, async (o) => {
        const { data, error } = await ctx.supabase.rpc('commission_for_order', {
          p_order: o.id,
          p_location: o.location_id,
        })
        if (error) return null
        return typeof data === 'number' ? data : 0
      })

      orders.forEach((o, i) => {
        const cents = retailResults[i]
        if (cents === null) {
          rpcFailures += 1
          return
        }
        const dateKey = localDateKey(o.paid_at ?? o.created_at, o.location_id)
        if (!dateKey || !o.sold_by) return
        // The retail base is the goods: subtotal less discount. Tax is money
        // held for the state and postage is not a sale, so neither is in it.
        const base = Math.max(o.subtotal_cents - o.discount_cents, 0)
        lines.push({
          kind: 'retail',
          providerId: o.sold_by,
          locationId: o.location_id,
          dateKey,
          detail: `Order ${o.order_number ?? `#${o.id}`} · goods ${money(base)}`,
          collectedCents: collectedByOrder.get(o.id) ?? 0,
          commissionCents: cents,
          planId: planOnDate(planWindows.get(planKey(o.sold_by, o.location_id)), dateKey),
        })
      })
    }

    if (rpcFailures > 0) {
      notes.push(
        `${rpcFailures} line${rpcFailures === 1 ? '' : 's'} could not be priced — ` +
          'commission_for_appointment() / commission_for_order() refused, which means ' +
          'the signed-in user may not read that person\'s figures. The totals from ' +
          'commission_for_period() below are short by the same amount. Do not pay from ' +
          'this run.'
      )
    }

    const totals = aggregateByProviderLocation({
      lines,
      providerNames,
      locationNames,
      planCards,
      planWindows,
    })

    // ── The studio's own total, as a cross-check ───────────────
    //
    // commission_for_period() loops the same appointments and orders and sums
    // the same two functions, so it MUST equal the working above. Asking it
    // separately is cheap and turns "the report is wrong" into a visible note
    // rather than a payslip nobody questioned.
    const periodTotals = new Map<string, { service: number; retail: number; total: number }>()
    await mapPool(providerIds, 4, async (providerId) => {
      const { data, error } = await ctx.supabase.rpc('commission_for_period', {
        p_profile: providerId,
        p_from: ctx.from,
        p_to: ctx.to,
        p_location: ctx.locationId,
      })
      if (error || !Array.isArray(data) || data.length === 0) return
      const row = data[0]
      periodTotals.set(providerId, {
        service: row.service_cents,
        retail: row.retail_cents,
        total: row.total_cents,
      })
    })

    // ── Rows ───────────────────────────────────────────────────
    const rows: ReportRow[] = totals.map((t) => {
      const cards = t.planIds.map((id) => planCards.get(id)).filter((c): c is PlanCard => !!c)
      const planLabel = cards.length > 0 ? cards.map((c) => c.name).join(' → ') : 'No plan in force'
      const rateLabel = cards.length > 0 ? cards.map(planCardLabel).join(' → ') : '—'
      const effective = effectiveRateBp(t.totalCommissionCents, t.collectedCents)
      const bits: string[] = []
      if (t.appointments > 0) {
        bits.push(`${t.appointments} appointment${t.appointments === 1 ? '' : 's'}`)
      }
      if (t.sales > 0) bits.push(`${t.sales} retail sale${t.sales === 1 ? '' : 's'}`)
      return {
        provider: providerNames.get(t.providerId) ?? 'Unknown provider',
        location: locationNames.get(t.locationId) ?? `Location ${t.locationId}`,
        date: null,
        detail: bits.join(' · ') || 'Nothing in this range',
        plan: planLabel,
        rate: rateLabel,
        effective: effective === null ? '—' : bpToPercent(effective),
        collected_cents: t.collectedCents,
        service_commission_cents: t.serviceCommissionCents,
        retail_commission_cents: t.retailCommissionCents,
        total_commission_cents: t.totalCommissionCents,
      }
    })

    // ── Sections: per location, then the per-line working ──────
    const sections: NonNullable<ReportResult['sections']> = []

    if (locations.length > 1) {
      const byLocation = new Map<number, ProviderLocationTotals[]>()
      for (const t of totals) {
        byLocation.set(t.locationId, [...(byLocation.get(t.locationId) ?? []), t])
      }
      const locationRows: ReportRow[] = locations
        .filter((l) => byLocation.has(l.id))
        .map((l) => {
          const group = byLocation.get(l.id) ?? []
          const service = group.reduce((s, t) => s + t.serviceCommissionCents, 0)
          const retail = group.reduce((s, t) => s + t.retailCommissionCents, 0)
          const total = group.reduce((s, t) => s + t.totalCommissionCents, 0)
          const collected = group.reduce((s, t) => s + t.collectedCents, 0)
          const effective = effectiveRateBp(total, collected)
          return {
            provider: `${group.length} provider${group.length === 1 ? '' : 's'}`,
            location: l.name,
            date: null,
            detail: `${group.reduce((s, t) => s + t.appointments, 0)} appointments · ${group.reduce(
              (s, t) => s + t.sales,
              0
            )} retail sales`,
            plan: '—',
            rate: '—',
            effective: effective === null ? '—' : bpToPercent(effective),
            collected_cents: collected,
            service_commission_cents: service,
            retail_commission_cents: retail,
            total_commission_cents: total,
          }
        })
      if (locationRows.length > 0) sections.push({ title: 'By location', rows: locationRows })
    }

    for (const t of totals) {
      const name = providerNames.get(t.providerId) ?? 'Unknown provider'
      const detail = lines
        .filter((l) => l.providerId === t.providerId && l.locationId === t.locationId)
        .sort((a, b) => (a.dateKey < b.dateKey ? -1 : a.dateKey > b.dateKey ? 1 : 0))
        .map((l): ReportRow => {
          const card = l.planId === null ? null : planCards.get(l.planId) ?? null
          const effective = effectiveRateBp(l.commissionCents, l.collectedCents)
          return {
            provider: name,
            location: locationNames.get(l.locationId) ?? `Location ${l.locationId}`,
            date: l.dateKey,
            detail: l.detail,
            plan: card ? card.name : 'No plan in force',
            rate: card ? planCardLabel(card) : '—',
            effective: effective === null ? '—' : bpToPercent(effective),
            collected_cents: l.collectedCents,
            service_commission_cents: l.kind === 'service' ? l.commissionCents : null,
            retail_commission_cents: l.kind === 'retail' ? l.commissionCents : null,
            total_commission_cents: l.commissionCents,
          }
        })
      if (detail.length > 0) {
        const where = locations.length > 1 ? ` — ${locationNames.get(t.locationId) ?? ''}` : ''
        sections.push({ title: `${name}${where}`, rows: detail })
      }
    }

    // ── Headline figures ───────────────────────────────────────
    const grandService = totals.reduce((s, t) => s + t.serviceCommissionCents, 0)
    const grandRetail = totals.reduce((s, t) => s + t.retailCommissionCents, 0)
    const grandTotal = grandService + grandRetail
    const grandCollected = totals.reduce((s, t) => s + t.collectedCents, 0)

    const summary: NonNullable<ReportResult['summary']> = [
      { label: 'Commission payable', value: money(grandTotal) },
      { label: 'On services', value: money(grandService) },
      { label: 'On retail', value: money(grandRetail) },
      { label: 'Money taken', value: money(grandCollected) },
      { label: 'Providers paid', value: String(new Set(totals.map((t) => t.providerId)).size) },
    ]

    // ── Reconciliation against commission_for_period() ─────────
    if (detailed) {
      const mismatches: string[] = []
      for (const providerId of providerIds) {
        const stated = periodTotals.get(providerId)
        if (!stated) continue
        const mine = totals
          .filter((t) => t.providerId === providerId)
          .reduce((s, t) => s + t.totalCommissionCents, 0)
        if (mine !== stated.total) {
          mismatches.push(
            `${providerNames.get(providerId) ?? providerId}: working ${money(mine)} vs ` +
              `commission_for_period() ${money(stated.total)}`
          )
        }
      }
      if (mismatches.length > 0) {
        summary.push({ label: 'Reconciliation', value: 'FAILED', tone: 'warn' })
        notes.push(
          'The per-line working does not add up to commission_for_period(). That ' +
            'should be impossible — the function loops the same rows and sums the same ' +
            'two functions — so treat this run as unsafe to pay from and report it: ' +
            mismatches.join('; ')
        )
      } else if (providerIds.length > 0) {
        summary.push({
          label: 'Reconciliation',
          value: 'Agrees with commission_for_period()',
          tone: 'good',
        })
      }
    }

    // A line that earned nothing because nobody was on a plan is the studio's
    // most expensive silent failure: the work happened, the money came in, and
    // the payout was zero because an assignment was never made.
    const unplanned = lines.filter((l) => l.planId === null && l.collectedCents > 0)
    if (unplanned.length > 0) {
      summary.push({
        label: 'Unassigned work',
        value: `${unplanned.length} line${unplanned.length === 1 ? '' : 's'}`,
        tone: 'warn',
      })
      notes.push(
        `${unplanned.length} appointment${unplanned.length === 1 ? '' : 's'}/sale${
          unplanned.length === 1 ? '' : 's'
        } took money at a site where the provider had no commission plan in force ` +
          'on that date, so they earned nothing on it. That is what 034 does — it ' +
          'will not borrow another site\'s rate — but it is almost always a missing ' +
          'assignment rather than an intended zero.'
      )
    }

    notes.push(
      'Commission is on money TAKEN, from the `payments` ledger — not on what was ' +
        'billed. A completed appointment nobody paid for earns nothing; a no-show ' +
        'earns on the forfeited deposit if one was taken; a refund is a negative ' +
        'payment row and reverses the commission it reversed.',
      'Every line is priced by the plan in force on ITS OWN date, in the site\'s own ' +
        'wall clock — never today\'s plan. A window that straddles a rate change shows ' +
        'both plans in the Plan column and is correct on either side of it.',
      'Rates are basis points in the database (4000 = 40.00%) and stay integers all ' +
        'the way to the payout. "Effective" is the commission divided by the money ' +
        'taken on that line, so it shows what actually paid out when a per-service ' +
        'rate, a category rate or a monthly tier moved the number off the plan rate.',
      FLAT_NOTE,
      '"Money taken" is every succeeded payment against the appointment or order. ' +
        'The commission BASE can be smaller: commission_for_appointment() caps it at ' +
        'the value of the services booked, so a tip or an overpayment is not treated ' +
        'as service revenue, and commission_for_order() pays on goods only, never on ' +
        'sales tax or postage.',
      'Online orders have no `sold_by` and appear nowhere here — nobody stood at a ' +
        'counter to earn on them. Gift-card and package payments that name neither an ' +
        'appointment nor an order are likewise unattributable to a provider.',
      'This figure matches the "Revenue generated" column in the Staff Performance ' +
        'report for the same provider, site and range, because both sum the same ' +
        'succeeded `payments` rows.',
      '034 truncates rather than rounds, once per figure. That costs under a cent per ' +
        'line and keeps every number reproducible from the ledger without a rounding ' +
        'convention to argue about.'
    )

    return { columns: COLUMNS, rows, summary, sections, notes }
  },
}

export default commissionsReport
