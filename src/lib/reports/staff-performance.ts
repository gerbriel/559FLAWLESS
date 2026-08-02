// 559 Flawless — Staff Performance.
//
// A REPORT ABOUT PEOPLE. That shaped it more than the SQL did, so the choices
// are written down here rather than left to be inferred:
//
//   • No composite score. Every "productivity index" is a set of weights
//     somebody picked, and the weights are the actual judgement — hidden inside
//     a number that then gets treated as measurement. If the studio wants to
//     weigh rebooking against retail, that is a conversation to have out loud.
//   • No ranking, and no ordering by revenue. Rows are alphabetical by name.
//     Sorting a table by takings turns it into a league table on sight, and the
//     person at the bottom is often the person who was given the quiet Tuesdays
//     or the clients nobody else wanted.
//   • Denominators are stated for every rate, in notes[], because "attach rate"
//     and "rebooking rate" mean nothing without one.
//   • The footer sums counts and money but NOT the derived rates: an average of
//     per-person averages is not the studio average. The studio-wide figures are
//     computed properly and shown as tiles instead.
//   • notes[] ends with what these figures do not account for. That is not
//     hedging — a provider's mix of services, the days they were rostered, and
//     which clients they were given are the largest terms in most of these
//     numbers, and none of them are in the data.
//
// Hours come from worked_minutes() in migration 035, which is clock time less
// UNPAID breaks — already deducted. Nothing here deducts them again. It is not
// overtime-aware and does not pretend to be; read the block above the function
// in 035 before adding anything to it.
//
// "Revenue generated" is money TAKEN, summed from the `payments` ledger, and is
// deliberately the same figure the Commissions report calls "Money taken", so
// the two reports reconcile for the same provider, site and range.

import type {
  ReportColumn,
  ReportContext,
  ReportModule,
  ReportResult,
  ReportRow,
} from '@/lib/reports/types'
import { money, percent, ratioToPercent, rangeToInstants } from '@/lib/reports/types'
import { dateKeyInTimeZone, DAY_MS } from '@/lib/time'

// ---------------------------------------------------------------------------
// Definitions with a number in them, named so they can be argued with
// ---------------------------------------------------------------------------

/**
 * A rebooking is a next visit put on the books within a week of this one.
 *
 * Longer than that and it is a client deciding to come back, which is a
 * different thing from a provider rebooking someone at the chair. The window is
 * a choice, not a fact, which is why it is a named constant and is stated in
 * notes[].
 */
const REBOOK_WINDOW_DAYS = 7

// ---------------------------------------------------------------------------
// Shapes fetched from the database
// ---------------------------------------------------------------------------

interface LocationRow {
  id: number
  name: string
  timezone: string
}

interface VisitRow {
  id: string
  provider_id: string
  location_id: number
  client_id: string | null
  starts_at: string
  status: string
}

/** Everything one person did at one site over the range. */
export interface StaffMetrics {
  providerId: string
  locationId: number
  booked: number
  completed: number
  noShows: number
  cancelled: number
  /** Money taken on this person's appointments, in cents. */
  serviceRevenueCents: number
  /** Money taken on retail this person rang up, in cents. */
  retailRevenueCents: number
  /** Completed visits that had a retail order attached. */
  attachedVisits: number
  /** Completed visits with a known client whose rebooking window has closed. */
  rebookEligible: number
  rebooked: number
  workedMinutes: number
}

export function metricKey(providerId: string, locationId: number): string {
  return `${providerId}|${locationId}`
}

// ---------------------------------------------------------------------------
// Derived figures — integer in, integer out, denominators guarded
// ---------------------------------------------------------------------------

/** Total money taken. The figure the Commissions report has to agree with. */
export function revenueCents(m: StaffMetrics): number {
  return m.serviceRevenueCents + m.retailRevenueCents
}

/**
 * Average ticket: service money taken over visits completed.
 *
 * Service money only — a client who also bought a serum did not have a bigger
 * facial. Retail lands in the attach rate, where it belongs.
 */
export function averageTicketCents(m: StaffMetrics): number | null {
  if (m.completed <= 0) return null
  return Math.round(m.serviceRevenueCents / m.completed)
}

/**
 * Money taken per hour on the clock.
 *
 * `× 60 / minutes` rather than dividing by hours, so the only division is the
 * final one and there is no intermediate fraction of an hour to lose.
 */
export function revenuePerHourCents(m: StaffMetrics): number | null {
  if (m.workedMinutes <= 0) return null
  return Math.round((revenueCents(m) * 60) / m.workedMinutes)
}

export function attachRate(m: StaffMetrics): number | null {
  return ratioToPercent(m.attachedVisits, m.completed)
}

export function rebookRate(m: StaffMetrics): number | null {
  return ratioToPercent(m.rebooked, m.rebookEligible)
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

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

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const COLUMNS: ReportColumn[] = [
  { key: 'provider', label: 'Provider', format: 'text' },
  { key: 'location', label: 'Location', format: 'text' },
  { key: 'booked', label: 'Booked', format: 'number', total: 'sum' },
  { key: 'completed', label: 'Completed', format: 'number', total: 'sum' },
  { key: 'no_shows', label: 'No-shows', format: 'number', total: 'sum' },
  { key: 'cancelled', label: 'Cancelled', format: 'number', total: 'sum' },
  { key: 'revenue_cents', label: 'Revenue generated', format: 'money', total: 'sum' },
  // Derived rates carry no footer total on purpose — see the header comment.
  { key: 'avg_ticket_cents', label: 'Average ticket', format: 'money', total: null },
  { key: 'attach_pct', label: 'Retail attach', format: 'percent', total: null },
  { key: 'rebook_pct', label: 'Rebooking', format: 'percent', total: null },
  { key: 'worked_minutes', label: 'Hours worked', format: 'duration', total: 'sum' },
  { key: 'revenue_per_hour_cents', label: 'Revenue / hour', format: 'money', total: null },
]

export const staffPerformanceReport: ReportModule = {
  key: 'staff-performance',
  title: 'Staff Performance',
  description:
    'Per provider: what they did, what came in, and how long they were on the ' +
    'clock. Figures to talk about, not a ranking.',
  // Shows money taken per person, so manager-and-above per the reports contract.
  minRole: 'manager',
  filters: ['dateRange', 'location', 'provider'],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const notes: string[] = []

    // ── Sites in scope ─────────────────────────────────────────
    const locationQuery = ctx.supabase
      .from('locations')
      .select('id, name, timezone')
      .order('sort_order')
    const { data: locationData, error: locationError } = ctx.locationId
      ? await locationQuery.eq('id', ctx.locationId)
      : await locationQuery
    if (locationError) throw new Error(`Staff performance: locations — ${locationError.message}`)

    const locations = (locationData ?? []) as LocationRow[]
    if (locations.length === 0) {
      return { columns: COLUMNS, rows: [], notes: ['No location matched this filter.'] }
    }

    const zoneOf = new Map(locations.map((l) => [l.id, l.timezone]))
    const locationNames = new Map(locations.map((l) => [l.id, l.name]))
    const locationIds = locations.map((l) => l.id)

    // Per-site instant bounds; the widest pair drives the queries and each row
    // is then re-checked against its own site's wall clock.
    const boundsOf = new Map(
      locations.map((l) => [l.id, rangeToInstants(ctx.from, ctx.to, l.timezone)])
    )
    let startIso = ''
    let endIso = ''
    for (const b of boundsOf.values()) {
      if (!startIso || b.startIso < startIso) startIso = b.startIso
      if (!endIso || b.endIso > endIso) endIso = b.endIso
    }

    const inRange = (instant: string, locationId: number): boolean => {
      const zone = zoneOf.get(locationId)
      if (!zone) return false
      const key = dateKeyInTimeZone(new Date(instant), zone)
      return key >= ctx.from && key <= ctx.to
    }

    // ── Appointments ───────────────────────────────────────────
    let visitQuery = ctx.supabase
      .from('appointments')
      .select('id, provider_id, location_id, client_id, starts_at, status')
      .in('location_id', locationIds)
      .gte('starts_at', startIso)
      .lt('starts_at', endIso)
    if (ctx.providerId) visitQuery = visitQuery.eq('provider_id', ctx.providerId)

    const { data: visitData, error: visitError } = await visitQuery
    if (visitError) throw new Error(`Staff performance: appointments — ${visitError.message}`)

    const visits = ((visitData ?? []) as VisitRow[]).filter((v) =>
      inRange(v.starts_at, v.location_id)
    )

    // ── Retail this person rang up ─────────────────────────────
    //
    // Same rule as the Commissions report: `sold_by` is the person at the
    // counter, and the sale is dated by coalesce(paid_at, created_at) in the
    // site's own zone. An online order has no `sold_by` and belongs to nobody.
    let sellQuery = ctx.supabase
      .from('orders')
      .select('id, location_id, sold_by, paid_at, created_at, appointment_id')
      .in('location_id', locationIds)
      .not('sold_by', 'is', null)
      .or(
        `and(paid_at.gte.${startIso},paid_at.lt.${endIso}),` +
          `and(paid_at.is.null,created_at.gte.${startIso},created_at.lt.${endIso})`
      )
    if (ctx.providerId) sellQuery = sellQuery.eq('sold_by', ctx.providerId)

    const { data: sellData, error: sellError } = await sellQuery
    if (sellError) throw new Error(`Staff performance: orders — ${sellError.message}`)

    const sales = (sellData ?? []).filter((o) =>
      inRange(o.paid_at ?? o.created_at, o.location_id)
    )

    // ── Money taken, from the ledger ───────────────────────────
    const paidByVisit = new Map<string, number>()
    for (const ids of chunk(visits.map((v) => v.id), 200)) {
      if (ids.length === 0) continue
      const { data, error } = await ctx.supabase
        .from('payments')
        .select('appointment_id, amount_cents')
        .eq('status', 'succeeded')
        .in('appointment_id', ids)
      if (error) throw new Error(`Staff performance: payments — ${error.message}`)
      for (const p of data ?? []) {
        if (!p.appointment_id) continue
        paidByVisit.set(p.appointment_id, (paidByVisit.get(p.appointment_id) ?? 0) + p.amount_cents)
      }
    }

    const paidBySale = new Map<number, number>()
    for (const ids of chunk(sales.map((o) => o.id), 200)) {
      if (ids.length === 0) continue
      const { data, error } = await ctx.supabase
        .from('payments')
        .select('order_id, amount_cents')
        .eq('status', 'succeeded')
        .in('order_id', ids)
      if (error) throw new Error(`Staff performance: order payments — ${error.message}`)
      for (const p of data ?? []) {
        if (p.order_id === null) continue
        paidBySale.set(p.order_id, (paidBySale.get(p.order_id) ?? 0) + p.amount_cents)
      }
    }

    // ── Retail attached to a visit ─────────────────────────────
    //
    // Any non-cart, non-cancelled order pointing at the appointment counts,
    // whoever rang it up: the attach happened at that visit even if the front
    // desk took the money on the way out.
    const attachedVisitIds = new Set<string>()
    for (const ids of chunk(visits.filter((v) => v.status === 'completed').map((v) => v.id), 200)) {
      if (ids.length === 0) continue
      const { data, error } = await ctx.supabase
        .from('orders')
        .select('id, appointment_id, status')
        .in('appointment_id', ids)
      if (error) throw new Error(`Staff performance: attached orders — ${error.message}`)
      for (const o of data ?? []) {
        if (!o.appointment_id) continue
        if (o.status === 'cart' || o.status === 'cancelled') continue
        attachedVisitIds.add(o.appointment_id)
      }
    }

    // ── Rebooking ──────────────────────────────────────────────
    //
    // Denominator: completed visits with a KNOWN client whose window has
    // already closed as of `now`. Counting a visit from yesterday against a
    // seven-day window would mark it "not rebooked" for a week it has not had.
    const completedWithClient = visits.filter(
      (v) => v.status === 'completed' && v.client_id !== null
    )
    const rebookedVisitIds = new Set<string>()
    const clientIds = [...new Set(completedWithClient.map((v) => v.client_id as string))]

    if (clientIds.length > 0) {
      const earliest = completedWithClient
        .map((v) => v.starts_at)
        .reduce((a, b) => (a < b ? a : b))
      const laterByClient = new Map<string, { starts_at: string; created_at: string }[]>()

      for (const ids of chunk(clientIds, 100)) {
        const { data, error } = await ctx.supabase
          .from('appointments')
          .select('id, client_id, starts_at, created_at, status')
          .in('client_id', ids)
          .gt('starts_at', earliest)
          .neq('status', 'cancelled')
        if (error) throw new Error(`Staff performance: rebookings — ${error.message}`)
        for (const a of data ?? []) {
          if (!a.client_id) continue
          const bucket = laterByClient.get(a.client_id) ?? []
          bucket.push({ starts_at: a.starts_at, created_at: a.created_at })
          laterByClient.set(a.client_id, bucket)
        }
      }

      for (const v of completedWithClient) {
        const visitMs = new Date(v.starts_at).getTime()
        const deadline = visitMs + REBOOK_WINDOW_DAYS * DAY_MS
        const found = (laterByClient.get(v.client_id as string) ?? []).some(
          (a) => new Date(a.starts_at).getTime() > visitMs && new Date(a.created_at).getTime() <= deadline
        )
        if (found) rebookedVisitIds.add(v.id)
      }
    }

    const rebookWindowClosed = (v: VisitRow): boolean =>
      new Date(v.starts_at).getTime() + REBOOK_WINDOW_DAYS * DAY_MS <= ctx.now

    // ── Assemble ───────────────────────────────────────────────
    const metrics = new Map<string, StaffMetrics>()
    const blank = (providerId: string, locationId: number): StaffMetrics => ({
      providerId,
      locationId,
      booked: 0,
      completed: 0,
      noShows: 0,
      cancelled: 0,
      serviceRevenueCents: 0,
      retailRevenueCents: 0,
      attachedVisits: 0,
      rebookEligible: 0,
      rebooked: 0,
      workedMinutes: 0,
    })
    const bucket = (providerId: string, locationId: number): StaffMetrics => {
      const key = metricKey(providerId, locationId)
      let m = metrics.get(key)
      if (!m) {
        m = blank(providerId, locationId)
        metrics.set(key, m)
      }
      return m
    }

    for (const v of visits) {
      const m = bucket(v.provider_id, v.location_id)
      m.booked += 1
      if (v.status === 'completed') m.completed += 1
      if (v.status === 'no_show') m.noShows += 1
      if (v.status === 'cancelled') m.cancelled += 1
      m.serviceRevenueCents += paidByVisit.get(v.id) ?? 0
      if (v.status === 'completed' && attachedVisitIds.has(v.id)) m.attachedVisits += 1
      if (v.status === 'completed' && v.client_id !== null && rebookWindowClosed(v)) {
        m.rebookEligible += 1
        if (rebookedVisitIds.has(v.id)) m.rebooked += 1
      }
    }

    for (const o of sales) {
      if (!o.sold_by) continue
      bucket(o.sold_by, o.location_id).retailRevenueCents += paidBySale.get(o.id) ?? 0
    }

    // ── Hours on the clock ─────────────────────────────────────
    //
    // worked_minutes() is SECURITY INVOKER: RLS decides whose timesheet the
    // caller can see, and someone they cannot see comes back as zero rather
    // than as an error. That is the right failure, and it is called out in
    // notes[] so a zero is not read as "she did not turn up".
    const pairs = [...metrics.values()].map((m) => ({
      providerId: m.providerId,
      locationId: m.locationId,
    }))
    let hoursUnavailable = false
    await mapPool(pairs, 6, async (pair) => {
      const bounds = boundsOf.get(pair.locationId)
      if (!bounds) return
      const { data, error } = await ctx.supabase.rpc('worked_minutes', {
        p_staff: pair.providerId,
        p_from: bounds.startIso,
        p_to: bounds.endIso,
        p_location: pair.locationId,
      })
      if (error) {
        hoursUnavailable = true
        return
      }
      if (typeof data === 'number') {
        bucket(pair.providerId, pair.locationId).workedMinutes = data
      }
    })
    if (hoursUnavailable) {
      notes.push(
        'Some hours could not be read — worked_minutes() runs as the caller, so a ' +
          'timesheet the signed-in user has no policy for comes back empty. Revenue ' +
          'per hour is blank for those rows rather than wrong.'
      )
    }

    // ── Names ──────────────────────────────────────────────────
    const providerIds = [...new Set([...metrics.values()].map((m) => m.providerId))]
    const providerNames = new Map<string, string>()
    for (const ids of chunk(providerIds, 100)) {
      if (ids.length === 0) continue
      const { data, error } = await ctx.supabase
        .from('profiles')
        .select('id, first_name, last_name, display_name')
        .in('id', ids)
      if (error) throw new Error(`Staff performance: providers — ${error.message}`)
      for (const p of data ?? []) {
        const full = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
        providerNames.set(p.id, full || p.display_name || 'Unknown provider')
      }
    }

    // Alphabetical. Not by revenue — see the header comment.
    const ordered = [...metrics.values()].sort((a, b) => {
      const an = providerNames.get(a.providerId) ?? ''
      const bn = providerNames.get(b.providerId) ?? ''
      if (an !== bn) return an < bn ? -1 : 1
      return a.locationId - b.locationId
    })

    const rows: ReportRow[] = ordered.map((m) => ({
      provider: providerNames.get(m.providerId) ?? 'Unknown provider',
      location: locationNames.get(m.locationId) ?? `Location ${m.locationId}`,
      booked: m.booked,
      completed: m.completed,
      no_shows: m.noShows,
      cancelled: m.cancelled,
      revenue_cents: revenueCents(m),
      avg_ticket_cents: averageTicketCents(m),
      attach_pct: attachRate(m),
      rebook_pct: rebookRate(m),
      worked_minutes: m.workedMinutes,
      revenue_per_hour_cents: revenuePerHourCents(m),
    }))

    // ── Sections ───────────────────────────────────────────────
    const sections: NonNullable<ReportResult['sections']> = []
    if (locations.length > 1) {
      const byLocation = new Map<number, StaffMetrics[]>()
      for (const m of ordered) byLocation.set(m.locationId, [...(byLocation.get(m.locationId) ?? []), m])
      const locationRows: ReportRow[] = locations
        .filter((l) => byLocation.has(l.id))
        .map((l) => {
          const group = byLocation.get(l.id) ?? []
          const merged = group.reduce<StaffMetrics>((acc, m) => ({
            ...acc,
            booked: acc.booked + m.booked,
            completed: acc.completed + m.completed,
            noShows: acc.noShows + m.noShows,
            cancelled: acc.cancelled + m.cancelled,
            serviceRevenueCents: acc.serviceRevenueCents + m.serviceRevenueCents,
            retailRevenueCents: acc.retailRevenueCents + m.retailRevenueCents,
            attachedVisits: acc.attachedVisits + m.attachedVisits,
            rebookEligible: acc.rebookEligible + m.rebookEligible,
            rebooked: acc.rebooked + m.rebooked,
            workedMinutes: acc.workedMinutes + m.workedMinutes,
          }), blank('', l.id))
          return {
            provider: `${group.length} provider${group.length === 1 ? '' : 's'}`,
            location: l.name,
            booked: merged.booked,
            completed: merged.completed,
            no_shows: merged.noShows,
            cancelled: merged.cancelled,
            revenue_cents: revenueCents(merged),
            avg_ticket_cents: averageTicketCents(merged),
            attach_pct: attachRate(merged),
            rebook_pct: rebookRate(merged),
            worked_minutes: merged.workedMinutes,
            revenue_per_hour_cents: revenuePerHourCents(merged),
          }
        })
      if (locationRows.length > 0) sections.push({ title: 'By location', rows: locationRows })
    }

    // ── Studio-wide figures, computed on the real denominators ─
    const studio = ordered.reduce<StaffMetrics>((acc, m) => ({
      ...acc,
      booked: acc.booked + m.booked,
      completed: acc.completed + m.completed,
      noShows: acc.noShows + m.noShows,
      cancelled: acc.cancelled + m.cancelled,
      serviceRevenueCents: acc.serviceRevenueCents + m.serviceRevenueCents,
      retailRevenueCents: acc.retailRevenueCents + m.retailRevenueCents,
      attachedVisits: acc.attachedVisits + m.attachedVisits,
      rebookEligible: acc.rebookEligible + m.rebookEligible,
      rebooked: acc.rebooked + m.rebooked,
      workedMinutes: acc.workedMinutes + m.workedMinutes,
    }), blank('', 0))

    const noShowRate = ratioToPercent(studio.noShows, studio.booked)
    const summary: NonNullable<ReportResult['summary']> = [
      { label: 'Appointments completed', value: studio.completed.toLocaleString('en-US') },
      { label: 'Revenue generated', value: money(revenueCents(studio)) },
      { label: 'Studio average ticket', value: money(averageTicketCents(studio) ?? 0) },
      { label: 'Retail attach', value: percent(attachRate(studio)) },
      { label: 'Rebooking', value: percent(rebookRate(studio)) },
      {
        label: 'No-show rate',
        value: percent(noShowRate),
        tone: noShowRate !== null && noShowRate >= 10 ? 'warn' : undefined,
      },
      {
        label: 'Hours worked',
        value: `${Math.round(studio.workedMinutes / 60).toLocaleString('en-US')} hr`,
      },
    ]

    // ── The definitions, and the caveats ───────────────────────
    notes.push(
      'Rows are alphabetical, not ranked. These figures are for a conversation, ' +
        'not a league table — the studio-wide numbers are in the tiles above and the ' +
        'footer sums counts and money only, because an average of per-person averages ' +
        'is not the studio average.',
      '"Revenue generated" is money TAKEN, summed from succeeded rows in the ' +
        '`payments` ledger: payments against this provider\'s appointments plus ' +
        'payments against retail orders they rang up. Refunds are negative rows and ' +
        'net out. It is the same figure the Commissions report calls "Money taken", ' +
        'for the same provider, site and range.',
      'Average ticket = service money taken ÷ appointments completed. Retail is not ' +
        'in it; a client who bought a serum did not have a bigger facial.',
      'Retail attach = completed visits with a retail order attached to them ÷ ' +
        'completed visits. Any order pointing at the appointment counts, whoever rang ' +
        'it up, because the sale happened at that visit.',
      `Rebooking = completed visits where the client had a later appointment on the ` +
        `books within ${REBOOK_WINDOW_DAYS} days of the visit ÷ completed visits with a ` +
        'known client whose window has already closed. Guest bookings with no account ' +
        'are excluded from both sides — there is no way to tell whether they came back. ' +
        'A visit from three days ago is not counted against a window it has not had.',
      'Hours worked are clock minutes less UNPAID breaks, from worked_minutes() in ' +
        'migration 035. Paid breaks are left in, because paid break time is hours ' +
        'worked. A shift is attributed to the day and site it STARTED, so a shift that ' +
        'began before this range is not in it, and an open shift contributes nothing ' +
        'until it is closed. It is not overtime-aware and is not a payroll figure.',
      'Revenue per hour divides ALL money taken by ALL clocked time, including time ' +
        'spent on the desk, on stock, and on cleaning. It is not a treatment-room ' +
        'utilisation figure and should not be read as one.',
      // The important one.
      'What these figures do not account for: which services each provider is ' +
        'trained for and rostered onto — a column of brow waxes cannot reach the same ' +
        'revenue per hour as a column of peels, at any skill level; which clients they ' +
        'were given, including the difficult ones and the first-timers who no-show ' +
        'more; which days and hours they were rostered, since a quiet Tuesday and a ' +
        'full Saturday are not the same opportunity; time spent covering the desk, ' +
        'training, or cleaning, which is on the clock and generates nothing; and ' +
        'clients who book with the studio rather than with a person. None of that is ' +
        'in the data, and all of it moves these numbers more than effort does.'
    )

    return { columns: COLUMNS, rows, summary, sections, notes }
  },
}

export default staffPerformanceReport
