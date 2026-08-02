// 559 Flawless — Appointment Report.
//
// The operational picture: what got booked, what happened to it, how far ahead
// people commit, and what the studio spends time on that it did not choose to.
//
// One decision shapes the whole file. The contract gives a report ONE set of
// columns, shared by `rows` and every entry in `sections`. So the first column
// is a generic `group` label and every other column is a figure that means the
// same thing whatever the grouping is — a day, a week, a service, a provider, a
// site, a booking source, an hour of the day, a reason a booking needed review.
// `rows` is the day-by-day series (the operational default); the sections are
// the same measurements cut the other ways.
//
// Correctness:
//   • Every boundary is studio-local, resolved through `locations.timezone`.
//     Two sites in two zones do not share a midnight, so each appointment is
//     bucketed in ITS OWN site's wall clock rather than a single window's.
//   • Minutes are integers. Durations and lead times are whole minutes end to
//     end; only the percentage columns are fractional, and those are ratios,
//     not money.
//   • Lead time is `starts_at − created_at`. Migration 029 raised the client
//     notice rule from 2 hours to 24 (`booking_settings.min_lead_minutes` =
//     1440), and the column that actually answers "is 24 hours right" is the
//     share of bookings made with LESS than 24 hours' notice — not the mean,
//     which a handful of bookings made three months out will drag anywhere.
//   • Migration 036's approval queue: `approval_reason` records why a booking
//     was held for review. It is not cleared when the booking is approved, so
//     it reads as "needed a human", which is the thing that costs time.

import type {
  ReportColumn,
  ReportContext,
  ReportModule,
  ReportResult,
  ReportRow,
} from '@/lib/reports/types'
import { ratioToPercent, rangeToInstants, shortDate } from '@/lib/reports/types'
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
  dayOfWeekForDateKey,
  zonedParts,
} from '@/lib/time'

// ---------------------------------------------------------------------------
// Definitions with a number in them
// ---------------------------------------------------------------------------

/**
 * The notice rule the studio is testing against.
 *
 * 1440 minutes is what migration 029 set `booking_settings.min_lead_minutes`
 * to. It is repeated here as a REPORTING threshold, not as policy — nothing
 * books or refuses against this constant; `src/lib/booking.ts` reads the real
 * setting. If the studio changes the rule, this line should follow it so the
 * column keeps answering the question that was asked.
 */
const NOTICE_MINUTES = 1440

/** Past this many appointments the per-service cut is dropped rather than paged. */
const MAX_SERVICE_JOIN = 5000

const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
]

/** Why a booking was held for review, in the words the queue uses. */
const APPROVAL_LABELS: Record<string, string> = {
  studio_policy: 'Studio policy — auto-confirm is off',
  service_policy: 'Service requires approval',
  first_visit: 'First visit',
  no_show_history: 'No-show history',
}

const SOURCE_LABELS: Record<string, string> = {
  online: 'Online',
  staff: 'Booked by staff',
  walk_in: 'Walk-in',
  phone: 'Phone',
}

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
  client_id: string | null
  starts_at: string
  ends_at: string
  created_at: string
  status: string
  source: string
  approval_reason: string | null
  checked_in_at: string | null
  completed_at: string | null
}

/** One appointment, resolved into the studio-local facts the report groups on. */
export interface ResolvedAppointment {
  id: string
  providerId: string
  locationId: number
  clientId: string | null
  status: string
  source: string
  approvalReason: string | null
  /** 'YYYY-MM-DD' in the site's own zone. */
  dateKey: string
  /** 0–23, in the site's own zone. */
  hour: number
  /** Whole minutes between booking and start. Never negative. */
  leadMinutes: number
  /** ends_at − starts_at, whole minutes. What the calendar set aside. */
  scheduledMinutes: number
  /** completed_at − checked_in_at, whole minutes, or null if either is missing. */
  actualMinutes: number | null
  /** null when the booking is a guest with no account to look up. */
  isFirstVisit: boolean | null
}

// ---------------------------------------------------------------------------
// The accumulator — one per group, whatever the grouping is
// ---------------------------------------------------------------------------

export interface Bucket {
  booked: number
  completed: number
  cancelled: number
  noShow: number
  pending: number
  /** Every lead time in the group, kept so the median is a real median. */
  leadMinutes: number[]
  underNotice: number
  scheduledSum: number
  scheduledCount: number
  actualSum: number
  actualCount: number
  firstVisits: number
  identifiedClients: number
  needingApproval: number
}

export function emptyBucket(): Bucket {
  return {
    booked: 0,
    completed: 0,
    cancelled: 0,
    noShow: 0,
    pending: 0,
    leadMinutes: [],
    underNotice: 0,
    scheduledSum: 0,
    scheduledCount: 0,
    actualSum: 0,
    actualCount: 0,
    firstVisits: 0,
    identifiedClients: 0,
    needingApproval: 0,
  }
}

export function addToBucket(bucket: Bucket, a: ResolvedAppointment): void {
  bucket.booked += 1
  if (a.status === 'completed') bucket.completed += 1
  if (a.status === 'cancelled') bucket.cancelled += 1
  if (a.status === 'no_show') bucket.noShow += 1
  if (a.status === 'pending') bucket.pending += 1

  bucket.leadMinutes.push(a.leadMinutes)
  if (a.leadMinutes < NOTICE_MINUTES) bucket.underNotice += 1

  bucket.scheduledSum += a.scheduledMinutes
  bucket.scheduledCount += 1
  if (a.actualMinutes !== null) {
    bucket.actualSum += a.actualMinutes
    bucket.actualCount += 1
  }

  if (a.isFirstVisit !== null) {
    bucket.identifiedClients += 1
    if (a.isFirstVisit) bucket.firstVisits += 1
  }

  if (a.approvalReason !== null) bucket.needingApproval += 1
}

/**
 * Median of whole minutes, as whole minutes.
 *
 * Median rather than mean throughout: lead time is a long-tailed distribution.
 * One client booking a wedding facial in March moves a monthly mean by days and
 * tells the studio nothing about what the notice rule should be. An even count
 * averages the two middles and rounds, so the answer stays an integer minute.
 */
export function medianMinutes(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid]
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}

/** Whole minutes between two instants, floored at zero. */
export function minutesBetween(from: string, to: string): number {
  const ms = new Date(to).getTime() - new Date(from).getTime()
  if (!Number.isFinite(ms) || ms <= 0) return 0
  return Math.round(ms / 60_000)
}

export function bucketToRow(label: string, b: Bucket): ReportRow {
  const median = medianMinutes(b.leadMinutes)
  return {
    group: label,
    booked: b.booked,
    completed: b.completed,
    cancelled: b.cancelled,
    no_show: b.noShow,
    pending: b.pending,
    no_show_pct: ratioToPercent(b.noShow, b.booked),
    lead_median_hours: median === null ? null : Math.round(median / 60),
    under_notice_pct: ratioToPercent(b.underNotice, b.booked),
    scheduled_minutes:
      b.scheduledCount > 0 ? Math.round(b.scheduledSum / b.scheduledCount) : null,
    actual_minutes: b.actualCount > 0 ? Math.round(b.actualSum / b.actualCount) : null,
    first_visit_pct: ratioToPercent(b.firstVisits, b.identifiedClients),
    approval_pct: ratioToPercent(b.needingApproval, b.booked),
  }
}

function hourLabel(hour: number): string {
  if (hour === 0) return '12 AM'
  if (hour === 12) return '12 PM'
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`
}

/** Monday of the week a date key falls in. Weeks are labelled by their Monday. */
export function weekStartKey(dateKey: string): string {
  const dow = dayOfWeekForDateKey(dateKey) // 0 = Sunday
  return addDaysToDateKey(dateKey, -((dow + 6) % 7))
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Group, then emit rows in a stable order. */
function section(
  title: string,
  entries: [string, Bucket][],
  order: 'given' | 'volume' | 'label'
): { title: string; rows: ReportRow[] } {
  const sorted =
    order === 'given'
      ? entries
      : [...entries].sort((a, b) =>
          order === 'volume'
            ? b[1].booked - a[1].booked || (a[0] < b[0] ? -1 : 1)
            : a[0] < b[0]
              ? -1
              : a[0] > b[0]
                ? 1
                : 0
        )
  return { title, rows: sorted.map(([label, bucket]) => bucketToRow(label, bucket)) }
}

// ---------------------------------------------------------------------------
// The module
// ---------------------------------------------------------------------------

const COLUMNS: ReportColumn[] = [
  { key: 'group', label: 'Period', format: 'text' },
  { key: 'booked', label: 'Booked', format: 'number', total: 'sum' },
  { key: 'completed', label: 'Completed', format: 'number', total: 'sum' },
  { key: 'cancelled', label: 'Cancelled', format: 'number', total: 'sum' },
  { key: 'no_show', label: 'No-show', format: 'number', total: 'sum' },
  { key: 'pending', label: 'Awaiting review', format: 'number', total: 'sum' },
  // Rates carry no footer total: an average of per-day rates is not the rate
  // over the period. The correct period-wide figures are in the tiles.
  { key: 'no_show_pct', label: 'No-show rate', format: 'percent', total: null },
  { key: 'lead_median_hours', label: 'Median notice (hrs)', format: 'number', total: null },
  { key: 'under_notice_pct', label: 'Under 24 hrs', format: 'percent', total: null },
  { key: 'scheduled_minutes', label: 'Scheduled', format: 'duration', total: null },
  { key: 'actual_minutes', label: 'Actual', format: 'duration', total: null },
  { key: 'first_visit_pct', label: 'First visit', format: 'percent', total: null },
  { key: 'approval_pct', label: 'Needed review', format: 'percent', total: null },
]

export const appointmentsReport: ReportModule = {
  key: 'appointments',
  title: 'Appointments',
  description:
    'Volume, status mix, how far ahead people book, where bookings come from, ' +
    'and how often one needs a human before it can be confirmed.',
  // Operational, not financial: no money, no cost, no margin. Front desk runs
  // the book and needs this. RLS still decides which rows come back.
  minRole: 'front_desk',
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
    if (locationError) throw new Error(`Appointments: locations — ${locationError.message}`)

    const locations = (locationData ?? []) as LocationRow[]
    if (locations.length === 0) {
      return { columns: COLUMNS, rows: [], notes: ['No location matched this filter.'] }
    }

    const zoneOf = new Map(locations.map((l) => [l.id, l.timezone]))
    const locationIds = locations.map((l) => l.id)

    // Widest instant window across every site's midnight; each row is then
    // re-checked and bucketed against its own site's zone.
    let startIso = ''
    let endIso = ''
    for (const l of locations) {
      const b = rangeToInstants(ctx.from, ctx.to, l.timezone)
      if (!startIso || b.startIso < startIso) startIso = b.startIso
      if (!endIso || b.endIso > endIso) endIso = b.endIso
    }

    // ── The bookings ───────────────────────────────────────────
    //
    // Every status, including cancelled: a report that quietly drops the
    // cancellations cannot show a cancellation rate, and "how far ahead did the
    // people who then cancelled book" is one of the more useful things here.
    let query = ctx.supabase
      .from('appointments')
      .select(
        'id, provider_id, location_id, client_id, starts_at, ends_at, created_at, status, source, approval_reason, checked_in_at, completed_at'
      )
      .in('location_id', locationIds)
      .gte('starts_at', startIso)
      .lt('starts_at', endIso)
      .order('starts_at')
    if (ctx.providerId) query = query.eq('provider_id', ctx.providerId)

    const { data, error } = await query
    if (error) throw new Error(`Appointments: bookings — ${error.message}`)
    const raw = (data ?? []) as AppointmentRow[]

    // ── New vs returning ───────────────────────────────────────
    //
    // `client_records.first_visit_at` is trigger-maintained (migration 005) as
    // the earliest COMPLETED visit, so it is read rather than recomputed. A
    // booking is a first visit when the client had no completed visit before it
    // — which is also true when they have none at all yet. A guest booking with
    // no account cannot be classified either way and is left out of the
    // denominator rather than guessed at.
    const clientIds = [...new Set(raw.map((a) => a.client_id).filter((id): id is string => !!id))]
    const firstVisitAt = new Map<string, string | null>()
    for (const ids of chunk(clientIds, 200)) {
      if (ids.length === 0) continue
      const { data: records, error: recordError } = await ctx.supabase
        .from('client_records')
        .select('client_id, first_visit_at')
        .in('client_id', ids)
      if (recordError) throw new Error(`Appointments: client records — ${recordError.message}`)
      for (const r of records ?? []) firstVisitAt.set(r.client_id, r.first_visit_at)
    }
    const clientRecordsVisible = firstVisitAt.size > 0 || clientIds.length === 0
    if (!clientRecordsVisible) {
      notes.push(
        'First-visit share is blank: no `client_records` rows came back, which ' +
          'normally means the signed-in user has no policy for them. Volume and ' +
          'status figures are unaffected.'
      )
    }

    // ── Resolve each booking into studio-local facts ───────────
    const resolved: ResolvedAppointment[] = []
    for (const a of raw) {
      const zone = zoneOf.get(a.location_id)
      if (!zone) continue
      const started = new Date(a.starts_at)
      const dateKey = dateKeyInTimeZone(started, zone)
      if (dateKey < ctx.from || dateKey > ctx.to) continue

      let isFirstVisit: boolean | null = null
      if (a.client_id !== null && clientRecordsVisible) {
        const first = firstVisitAt.get(a.client_id) ?? null
        // No completed visit on record, or the earliest one is this booking or
        // later ⇒ nothing came before it.
        isFirstVisit = first === null || first >= a.starts_at
      }

      resolved.push({
        id: a.id,
        providerId: a.provider_id,
        locationId: a.location_id,
        clientId: a.client_id,
        status: a.status,
        source: a.source,
        approvalReason: a.approval_reason,
        dateKey,
        hour: zonedParts(started, zone).hour,
        leadMinutes: minutesBetween(a.created_at, a.starts_at),
        scheduledMinutes: minutesBetween(a.starts_at, a.ends_at),
        actualMinutes:
          a.checked_in_at && a.completed_at
            ? minutesBetween(a.checked_in_at, a.completed_at)
            : null,
        isFirstVisit,
      })
    }

    if (resolved.length === 0) {
      return {
        columns: COLUMNS,
        rows: [],
        notes: [...notes, 'No appointments fall in this range at the selected location.'],
      }
    }

    // ── Names for the provider and service cuts ────────────────
    const providerIds = [...new Set(resolved.map((a) => a.providerId))]
    const providerNames = new Map<string, string>()
    for (const ids of chunk(providerIds, 100)) {
      const { data: people, error: peopleError } = await ctx.supabase
        .from('profiles')
        .select('id, first_name, last_name, display_name')
        .in('id', ids)
      if (peopleError) throw new Error(`Appointments: providers — ${peopleError.message}`)
      for (const p of people ?? []) {
        const full = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
        providerNames.set(p.id, full || p.display_name || 'Unknown provider')
      }
    }

    // ── Service lines, for the per-service cut ─────────────────
    //
    // Service lines only. An add-on is priced and timed separately but is not a
    // booking, and counting it as one would inflate every service's volume by
    // whatever was added to it.
    const byId = new Map(resolved.map((a) => [a.id, a]))
    const serviceBuckets = new Map<number, { label: string; bucket: Bucket }>()
    let serviceCutAvailable = resolved.length <= MAX_SERVICE_JOIN
    if (!serviceCutAvailable) {
      notes.push(
        `The per-service cut is omitted above ${MAX_SERVICE_JOIN.toLocaleString('en-US')} ` +
          'appointments in one range. Everything else is unaffected; narrow the range to ' +
          'see it.'
      )
    } else {
      for (const ids of chunk([...byId.keys()], 200)) {
        const { data: lines, error: lineError } = await ctx.supabase
          .from('appointment_services')
          .select('appointment_id, service_id, name_snapshot, sort_order')
          .in('appointment_id', ids)
          .not('service_id', 'is', null)
          .order('sort_order')
        if (lineError) throw new Error(`Appointments: service lines — ${lineError.message}`)
        for (const line of lines ?? []) {
          if (line.service_id === null) continue
          const appointment = byId.get(line.appointment_id)
          if (!appointment) continue
          let entry = serviceBuckets.get(line.service_id)
          if (!entry) {
            entry = { label: line.name_snapshot, bucket: emptyBucket() }
            serviceBuckets.set(line.service_id, entry)
          }
          addToBucket(entry.bucket, appointment)
        }
      }
      serviceCutAvailable = serviceBuckets.size > 0
    }

    // ── Group ──────────────────────────────────────────────────
    const byDay = new Map<string, Bucket>()
    const byWeek = new Map<string, Bucket>()
    const byDayOfWeek = new Map<number, Bucket>()
    const byHour = new Map<number, Bucket>()
    const byProvider = new Map<string, Bucket>()
    const byLocation = new Map<number, Bucket>()
    const bySource = new Map<string, Bucket>()
    const byClientType = new Map<string, Bucket>()
    const byApproval = new Map<string, Bucket>()
    const overall = emptyBucket()

    const into = <K>(map: Map<K, Bucket>, key: K, a: ResolvedAppointment): void => {
      let b = map.get(key)
      if (!b) {
        b = emptyBucket()
        map.set(key, b)
      }
      addToBucket(b, a)
    }

    for (const a of resolved) {
      addToBucket(overall, a)
      into(byDay, a.dateKey, a)
      into(byWeek, weekStartKey(a.dateKey), a)
      into(byDayOfWeek, dayOfWeekForDateKey(a.dateKey), a)
      into(byHour, a.hour, a)
      into(byProvider, a.providerId, a)
      into(byLocation, a.locationId, a)
      into(bySource, a.source, a)
      into(
        byClientType,
        a.isFirstVisit === null ? 'unknown' : a.isFirstVisit ? 'first' : 'returning',
        a
      )
      into(byApproval, a.approvalReason ?? 'none', a)
    }

    // ── Rows: every day in the range, including the empty ones ─
    //
    // A gap matters operationally — a closed Monday and a Monday nobody booked
    // look identical in a table that only lists the days with rows.
    const dayRows: ReportRow[] = []
    for (let key = ctx.from; key <= ctx.to; key = addDaysToDateKey(key, 1)) {
      dayRows.push(bucketToRow(shortDate(key), byDay.get(key) ?? emptyBucket()))
    }

    // ── Sections ───────────────────────────────────────────────
    const sections: NonNullable<ReportResult['sections']> = []

    sections.push(
      section(
        'By week',
        [...byWeek.entries()]
          .sort((a, b) => (a[0] < b[0] ? -1 : 1))
          .map(([key, bucket]) => [`Week of ${shortDate(key)}`, bucket] as [string, Bucket]),
        'given'
      )
    )

    sections.push(
      section(
        'By day of week',
        [...byDayOfWeek.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([dow, bucket]) => [DAY_NAMES[dow], bucket] as [string, Bucket]),
        'given'
      )
    )

    sections.push(
      section(
        'By hour of day',
        [...byHour.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([hour, bucket]) => [hourLabel(hour), bucket] as [string, Bucket]),
        'given'
      )
    )

    if (serviceCutAvailable) {
      sections.push(
        section(
          'By service',
          [...serviceBuckets.values()].map((e) => [e.label, e.bucket] as [string, Bucket]),
          'volume'
        )
      )
    }

    sections.push(
      section(
        'By provider',
        [...byProvider.entries()].map(
          ([id, bucket]) => [providerNames.get(id) ?? 'Unknown provider', bucket] as [string, Bucket]
        ),
        'label'
      )
    )

    if (locations.length > 1) {
      sections.push(
        section(
          'By location',
          locations
            .filter((l) => byLocation.has(l.id))
            .map((l) => [l.name, byLocation.get(l.id) as Bucket] as [string, Bucket]),
          'given'
        )
      )
    }

    sections.push(
      section(
        'By booking source',
        [...bySource.entries()].map(
          ([source, bucket]) => [SOURCE_LABELS[source] ?? source, bucket] as [string, Bucket]
        ),
        'volume'
      )
    )

    const clientTypeOrder: [string, string][] = [
      ['first', 'First visit'],
      ['returning', 'Returning'],
      ['unknown', 'Guest — no account to check'],
    ]
    sections.push(
      section(
        'New vs returning',
        clientTypeOrder
          .filter(([key]) => byClientType.has(key))
          .map(([key, label]) => [label, byClientType.get(key) as Bucket] as [string, Bucket]),
        'given'
      )
    )

    // Every booking that needed a human before it could be confirmed, and why.
    // "No review needed" is included so the queue has a denominator on screen.
    const approvalRows: [string, Bucket][] = []
    for (const [reason, bucket] of byApproval.entries()) {
      if (reason === 'none') continue
      approvalRows.push([APPROVAL_LABELS[reason] ?? reason, bucket])
    }
    approvalRows.sort((a, b) => b[1].booked - a[1].booked || (a[0] < b[0] ? -1 : 1))
    const noReview = byApproval.get('none')
    if (noReview) approvalRows.push(['No review needed', noReview])
    sections.push(section('Bookings held for review', approvalRows, 'given'))

    // ── Headline figures ───────────────────────────────────────
    const busiestDay = [...byDayOfWeek.entries()].sort(
      (a, b) => b[1].booked - a[1].booked || a[0] - b[0]
    )[0]
    const busiestHour = [...byHour.entries()].sort(
      (a, b) => b[1].booked - a[1].booked || a[0] - b[0]
    )[0]
    const overallMedian = medianMinutes(overall.leadMinutes)
    const underNoticePct = ratioToPercent(overall.underNotice, overall.booked)
    const approvalPct = ratioToPercent(overall.needingApproval, overall.booked)
    const noShowPct = ratioToPercent(overall.noShow, overall.booked)
    const scheduledAvg =
      overall.scheduledCount > 0 ? Math.round(overall.scheduledSum / overall.scheduledCount) : null
    const actualAvg =
      overall.actualCount > 0 ? Math.round(overall.actualSum / overall.actualCount) : null

    const pct = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)}%`)

    const summary: NonNullable<ReportResult['summary']> = [
      { label: 'Booked', value: overall.booked.toLocaleString('en-US') },
      { label: 'Completed', value: overall.completed.toLocaleString('en-US') },
      {
        label: 'No-show rate',
        value: pct(noShowPct),
        tone: noShowPct !== null && noShowPct >= 10 ? 'warn' : undefined,
      },
      { label: 'Cancelled', value: overall.cancelled.toLocaleString('en-US') },
      {
        label: 'Median notice',
        value: overallMedian === null ? '—' : `${Math.round(overallMedian / 60)} hrs`,
      },
      {
        label: 'Booked under 24 hrs',
        value: pct(underNoticePct),
        tone: underNoticePct !== null && underNoticePct >= 20 ? 'warn' : undefined,
      },
      {
        label: 'Busiest day',
        value: busiestDay ? `${DAY_NAMES[busiestDay[0]]} (${busiestDay[1].booked})` : '—',
      },
      {
        label: 'Busiest hour',
        value: busiestHour ? `${hourLabel(busiestHour[0])} (${busiestHour[1].booked})` : '—',
      },
      {
        label: 'Held for review',
        value: `${overall.needingApproval.toLocaleString('en-US')} (${pct(approvalPct)})`,
        tone: approvalPct !== null && approvalPct >= 15 ? 'warn' : undefined,
      },
      {
        label: 'Scheduled vs actual',
        value:
          scheduledAvg === null || actualAvg === null
            ? '—'
            : `${scheduledAvg} min vs ${actualAvg} min`,
      },
    ]

    // ── What the numbers mean ──────────────────────────────────
    notes.push(
      'An appointment is counted on the day it STARTS, in its own location\'s ' +
        'timezone. Two sites in different zones do not share a midnight, so each ' +
        'booking is bucketed against its own site\'s wall clock rather than one ' +
        'window\'s. "Booked" is every appointment in the range whatever became of it, ' +
        'so it is the denominator for every rate in the row.',
      'The status columns are completed, cancelled, no-show and awaiting review. The ' +
        'remainder — booked minus those four — is confirmed or checked in and has not ' +
        'reached an outcome yet, which is normal for a range that includes today or ' +
        'anything after it.',
      `Notice is starts_at − created_at. The median is shown rather than the mean ` +
        'because a handful of bookings made months out drags a mean anywhere. ' +
        `"Under 24 hrs" is the share booked with less than ${NOTICE_MINUTES} minutes’ ` +
        'notice — the figure that says whether the 24-hour rule migration 029 set is ' +
        'in the right place. A high share means the rule is turning away business the ' +
        'studio could take; a share near zero means it is not binding on anyone. Staff, ' +
        'phone and walk-in bookings are in this figure too, and those are not subject ' +
        'to the rule at all — read the online row in "By booking source" to judge the ' +
        'policy itself.',
      '"Scheduled" is ends_at − starts_at: the time the calendar set aside, excluding ' +
        'turnover buffer. "Actual" is completed_at − checked_in_at and is averaged only ' +
        'over the appointments that carry both timestamps, so it is silent about visits ' +
        'nobody checked in or nobody closed off. If the two counts diverge, the gap ' +
        'between the columns is about the front desk\'s habits as much as the room\'s.',
      '"First visit" means the client had no completed visit before this booking, read ' +
        'from `client_records.first_visit_at`, which migration 005 maintains by trigger. ' +
        'The denominator is bookings with an account attached; guest bookings that never ' +
        'matched a profile are shown separately and are in no rate, because there is no ' +
        'way to tell whether they had been in before.',
      'A booking is "held for review" when migration 036 set `approval_reason` on it. ' +
        'The reason is not cleared once someone approves it, so this counts bookings ' +
        'that needed a human — which is the thing that costs the studio time — not ' +
        'bookings still waiting. "Awaiting review" is the status column for those still ' +
        'sitting in the queue.',
      'In "By service" one appointment appears once per service booked on it, so that ' +
        'section\'s Booked column sums to more than the studio total when clients book ' +
        'two services in a visit. Add-ons are not counted as bookings. Every other ' +
        'section counts each appointment exactly once.',
      'Footer totals cover the count columns only. An average of per-day rates is not ' +
        'the rate over the period, so the rate columns have no footer; the period-wide ' +
        'figures are in the tiles above.'
    )

    return { columns: COLUMNS, rows: dayRows, summary, sections, notes }
  },
}

export default appointmentsReport
