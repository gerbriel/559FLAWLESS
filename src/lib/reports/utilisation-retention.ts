// 559 Flawless — Utilisation & Retention.
//
// Two questions that are almost always quoted without a denominator, which is
// the same as not quoting them at all. Every rate this module emits has a line
// in `notes` saying exactly what it was divided by.
//
// ── UTILISATION ──────────────────────────────────────────────
//
// "How much of the available chair time was actually sold."
//
//   denominator  bookable minutes: the union of `provider_schedules` windows
//                for each day in the period, resolved to instants in the
//                LOCATION's zone, minus `closures`, minus
//                `availability_blocks`, minus cached `calendar_busy`.
//   numerator    minutes of appointments that actually happened — `completed`
//                and `checked_in` — intersected with that bookable set.
//
// Cancellations are not in the numerator: that time went back on the shelf.
// No-shows are not either — the studio did not sell those minutes, it lost
// them — so they get their own column instead of being quietly counted as
// utilisation, which is the single most common way this number is flattered.
//
// TURNAROUND BUFFER COUNTS AS UTILISED. `appointments.buffer_minutes` is
// stripping the bed, wiping the wax pot and writing the note. The provider
// cannot sell it, it exists only because the appointment does, and `slot`
// (004) already defines it as part of the booking. Excluding it would make a
// studio look idle for doing the work that a treatment requires, and would
// reward shortening turnaround on paper rather than in the room. It is in.
//
// PROCESSING TIME IS SHOWN BOTH WAYS. Migration 036 split provider time from
// room time: `provider_slot` is a multirange of the minutes the provider is
// genuinely ACTIVE — `slot` minus each processing gap, the interval where the
// client is developing under a mask and the provider is doing nothing. That is
// the more honest measure of the person, and this report uses it for the
// "Active" figure. It is NOT the more honest measure of the chair, because in
// a single-room studio the client is still in the room: 036 ships
// `allow_processing_overlap` defaulting to FALSE for exactly that reason. So:
//
//   Utilisation %  = occupied minutes (`slot`, buffer included) ÷ bookable
//   Active %       = `provider_slot` minutes ÷ bookable
//
// The distance between them is processing time. Where a site or a provider has
// turned `allow_processing_overlap` on, that gap really is resellable and
// Utilisation % overstates; the report says so by name.
//
// ── RETENTION ────────────────────────────────────────────────
//
// Rebooking, new vs returning, first-visit retention, churn, and the two
// reliability rates. Every one of them states its denominator, and the two
// that look forward (rebooking, first-visit retention) only count visits whose
// window has actually elapsed — otherwise last week's visits are scored as
// failures for not having had time to come back yet.

import type {
  ReportColumn,
  ReportContext,
  ReportModule,
  ReportResult,
} from '@/lib/reports/types'
import {
  DAY_MS,
  MINUTE_MS,
  addDaysToDateKey,
  dateKeyInTimeZone,
  dayOfWeekForDateKey,
  monthLabelForDateKey,
  zonedTimeToUtc,
} from '@/lib/time'

// ── Tunables, all of them stated on screen ───────────────────

/** PostgREST caps a response; everything is read in pages of this size. */
const PAGE_SIZE = 1000

/**
 * The rebooking window.
 *
 * A facial or a wax runs on a four-week cycle, so 45 days is one cycle plus
 * the slack a real diary needs. Short enough that "she rebooked" still means
 * something; long enough that a fortnight's holiday does not read as churn.
 */
const REBOOK_DAYS = 45

/**
 * The first-visit retention window. Longer on purpose: a first visit is often
 * a trial, and the decision to come back is made over a skin cycle, not a
 * diary cycle.
 */
const FIRST_VISIT_DAYS = 90

/** How far past the period the follow-up read has to reach to answer both. */
const FOLLOW_UP_DAYS = Math.max(REBOOK_DAYS, FIRST_VISIT_DAYS)

/**
 * Churn, for a business nobody subscribes to.
 *
 * There is no cancellation event to count, so the only honest definition is
 * silence measured against that client's own rhythm: gone when they have not
 * been seen in twice their own mean gap. Twice, not once, because the cadence
 * IS the mean — half of all gaps exceed it, and flagging half the book as
 * churned would be arithmetic rather than information. It sits one step beyond
 * the 1.5× the Most Valuable Clients report uses for "overdue": overdue first,
 * gone second.
 */
const CHURN_CADENCE_MULTIPLIER = 2

/** A cancellation inside this many hours of the start is a late cancellation. */
const LATE_CANCEL_HOURS = 24

/** Cohort tables stop being readable somewhere around two years of rows. */
const MAX_COHORT_ROWS = 24

/** Appointments that count as time the studio actually sold. */
const ATTENDED = new Set(['completed', 'checked_in'])

/** Appointments that reached an end state, i.e. the reliability denominator. */
const RESOLVED = new Set(['completed', 'checked_in', 'no_show', 'cancelled'])

// ── Shapes read back from PostgREST ──────────────────────────

type AppointmentRow = {
  id: string
  client_id: string | null
  provider_id: string
  location_id: number
  starts_at: string
  ends_at: string
  buffer_minutes: number
  status: string
  provider_slot: string | null
  cancelled_at: string | null
}

type ClientRecordRow = {
  client_id: string
  first_visit_at: string | null
  last_visit_at: string | null
  visit_count: number
}

/** Half-open [s, e) in epoch milliseconds. All arithmetic here is integer ms. */
type Iv = { s: number; e: number }

/** One bucket of the report — a provider-at-a-site, a month, or the studio. */
type Cell = {
  bookableMs: number
  /** `slot` minutes inside the bookable window: the utilisation numerator. */
  occupiedInMs: number
  /** `slot` minutes outside it — why a row can read over 100%. */
  occupiedOutMs: number
  /** `provider_slot` minutes inside the bookable window. */
  activeInMs: number
  /** Bookable minutes burned by someone not turning up. Never utilisation. */
  noShowInMs: number
  visits: number
  resolved: number
  noShows: number
  lateCancels: number
  rebookEligible: number
  rebooked: number
  newClients: Set<string>
  returningClients: Set<string>
  cohort: Set<string>
  cohortRetained: Set<string>
}

const emptyCell = (): Cell => ({
  bookableMs: 0,
  occupiedInMs: 0,
  occupiedOutMs: 0,
  activeInMs: 0,
  noShowInMs: 0,
  visits: 0,
  resolved: 0,
  noShows: 0,
  lateCancels: 0,
  rebookEligible: 0,
  rebooked: 0,
  newClients: new Set(),
  returningClients: new Set(),
  cohort: new Set(),
  cohortRetained: new Set(),
})

export const utilisationRetentionReport: ReportModule = {
  key: 'utilisation-retention',
  title: 'Utilisation & Retention',
  description:
    'How much of the bookable day was sold, and how many clients came back — ' +
    'each with its denominator written down.',
  // Utilisation is a judgement on a named person's working day and retention is
  // a judgement on the book. Both are management figures.
  minRole: 'manager',
  filters: ['dateRange', 'location', 'provider'],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const notes: string[] = []
    const db = ctx.supabase

    // ── Sites, and the clocks their days are measured on ──────
    const { data: locationRows, error: locationError } = await db
      .from('locations')
      .select('id, name, timezone')
      .order('sort_order')
    if (locationError) throw new Error(`locations: ${locationError.message}`)

    const locations = (locationRows ?? []).filter(
      (l) => ctx.locationId === null || l.id === ctx.locationId,
    )
    if (locations.length === 0) {
      return {
        columns: baseColumns(),
        rows: [],
        notes: ['No location matched the filter, so there is nothing to measure.'],
      }
    }

    const zoneOf = new Map(locations.map((l) => [l.id, l.timezone]))
    const nameOf = new Map(locations.map((l) => [l.id, l.name]))
    /** Labelling zone for month buckets and dates that are not site-specific. */
    const reportZone = ctx.locationId === null ? ctx.timeZone : (zoneOf.get(ctx.locationId) ?? ctx.timeZone)

    // Every calendar day in the range, once. Date keys, never instants: a day
    // is a wall-clock fact and each site resolves it against its own zone.
    const dateKeys: string[] = []
    for (let k = ctx.from; k <= ctx.to; k = addDaysToDateKey(k, 1)) {
      dateKeys.push(k)
      if (dateKeys.length > 800) break // a range this long is a mistake, not a report
    }

    // The widest instant window any site in scope could need, so one read
    // serves all of them even when their zones differ.
    const bounds = locations.map((l) => ({
      from: zonedTimeToUtc(ctx.from, '00:00', l.timezone).getTime(),
      to: zonedTimeToUtc(addDaysToDateKey(ctx.to, 1), '00:00', l.timezone).getTime(),
    }))
    const periodFromMs = Math.min(...bounds.map((b) => b.from))
    const periodToMs = Math.max(...bounds.map((b) => b.to))

    // ── The denominator's raw material ────────────────────────
    const schedules = await readAll<{
      provider_id: string
      location_id: number
      day_of_week: number
      start_time: string
      end_time: string
    }>((from, to) =>
      db
        .from('provider_schedules')
        .select('provider_id, location_id, day_of_week, start_time, end_time')
        .eq('is_active', true)
        .order('id')
        .range(from, to),
    )

    const closures = await readAll<{ location_id: number; closure_date: string }>((from, to) =>
      db
        .from('closures')
        .select('location_id, closure_date')
        .gte('closure_date', ctx.from)
        .lte('closure_date', ctx.to)
        .order('id')
        .range(from, to),
    )

    const blocks = await readAll<{
      provider_id: string
      location_id: number
      block_date: string
      start_time: string | null
      end_time: string | null
    }>((from, to) =>
      db
        .from('availability_blocks')
        .select('provider_id, location_id, block_date, start_time, end_time')
        .gte('block_date', ctx.from)
        .lte('block_date', ctx.to)
        .order('id')
        .range(from, to),
    )

    // `calendar_busy` carries no location_id, and correctly so: it is the
    // provider's own diary, and a dentist appointment removes them from every
    // room at once. It is subtracted from each site's window.
    const busy = await readAll<{ provider_id: string; starts_at: string; ends_at: string }>(
      (from, to) =>
        db
          .from('calendar_busy')
          .select('provider_id, starts_at, ends_at')
          .lt('starts_at', new Date(periodToMs).toISOString())
          .gt('ends_at', new Date(periodFromMs).toISOString())
          .order('id')
          .range(from, to),
    )

    // ── The numerator, plus the follow-up window retention needs ──
    //
    // Deliberately NOT filtered by location: a client who rebooks at the other
    // site did come back, and scoring that as churn because the report is
    // filtered would be a lie about the business. The location filter is
    // applied per row, below, to the anchor visit only.
    const appointments = await readAll<AppointmentRow>((from, to) =>
      db
        .from('appointments')
        .select(
          'id, client_id, provider_id, location_id, starts_at, ends_at, buffer_minutes, status, provider_slot, cancelled_at',
        )
        .gte('starts_at', new Date(periodFromMs).toISOString())
        .lt('starts_at', new Date(periodToMs + FOLLOW_UP_DAYS * DAY_MS).toISOString())
        .order('starts_at')
        .range(from, to),
    )

    // ── Who is new, who is returning, who has gone quiet ──────
    //
    // Straight off the counters migration 005's `client_record_sync_stats`
    // trigger maintains. Not recomputed: first_visit_at IS the first completed
    // appointment, and 032 keeps the record business-wide on purpose, so "new"
    // means new to the business rather than new to this room even when the
    // report is filtered to one site.
    const clientRecords = await readAll<ClientRecordRow>((from, to) =>
      db
        .from('client_records')
        .select('client_id, first_visit_at, last_visit_at, visit_count')
        .gt('visit_count', 0)
        .order('client_id')
        .range(from, to),
    )

    const deleted = await readAll<{ profile_id: string }>((from, to) =>
      db.from('deleted_accounts').select('profile_id').order('profile_id').range(from, to),
    )
    const deletedIds = new Set(deleted.map((d) => d.profile_id))

    // ── Whether a processing gap is genuinely resellable ──────
    const { data: policyRows, error: policyError } = await db
      .from('scheduling_policies')
      .select('location_id, allow_processing_overlap')
    if (policyError) throw new Error(`scheduling_policies: ${policyError.message}`)
    const { data: providerSettingRows, error: settingError } = await db
      .from('provider_scheduling_settings')
      .select('provider_id, location_id, allow_processing_overlap')
    if (settingError) throw new Error(`provider_scheduling_settings: ${settingError.message}`)
    const sitePolicy = new Map(
      (policyRows ?? []).map((p) => [p.location_id, p.allow_processing_overlap]),
    )
    const providerPolicy = new Map(
      (providerSettingRows ?? []).map((p) => [
        `${p.provider_id}|${p.location_id}`,
        p.allow_processing_overlap,
      ]),
    )

    // ── Provider names ────────────────────────────────────────
    const providerIds = new Set<string>()
    for (const s of schedules) if (inScopeLocation(s.location_id)) providerIds.add(s.provider_id)
    for (const a of appointments) {
      if (Date.parse(a.starts_at) >= periodToMs) continue
      if (inScopeLocation(a.location_id)) providerIds.add(a.provider_id)
    }
    if (ctx.providerId !== null) {
      for (const id of [...providerIds]) if (id !== ctx.providerId) providerIds.delete(id)
    }
    const providerNames = new Map<string, string>()
    for (const batch of chunk([...providerIds], 150)) {
      if (batch.length === 0) continue
      const { data, error } = await db
        .from('profiles')
        .select('id, first_name, last_name, display_name')
        .in('id', batch)
      if (error) throw new Error(`profiles: ${error.message}`)
      for (const p of data ?? []) {
        providerNames.set(
          p.id,
          p.display_name ?? `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() ?? p.id,
        )
      }
    }

    function inScopeLocation(id: number): boolean {
      return ctx.locationId === null || id === ctx.locationId
    }

    // ── 1. Bookable minutes, per provider · site · day ────────
    const closedDays = new Set(closures.map((c) => `${c.location_id}|${c.closure_date}`))
    const busyByProvider = new Map<string, Iv[]>()
    for (const b of busy) {
      const list = busyByProvider.get(b.provider_id) ?? []
      list.push({ s: Date.parse(b.starts_at), e: Date.parse(b.ends_at) })
      busyByProvider.set(b.provider_id, list)
    }
    for (const [k, v] of busyByProvider) busyByProvider.set(k, union(v))

    const blocksByKey = new Map<string, typeof blocks>()
    for (const b of blocks) {
      const key = `${b.provider_id}|${b.location_id}|${b.block_date}`
      const list = blocksByKey.get(key) ?? []
      list.push(b)
      blocksByKey.set(key, list)
    }

    /** Bookable intervals, keyed `${provider}|${location}|${dateKey}`. */
    const bookable = new Map<string, Iv[]>()
    let scheduleWithoutSite = 0

    for (const location of locations) {
      const zone = location.timezone
      const daySchedules = new Map<number, typeof schedules>()
      for (const s of schedules) {
        if (s.location_id !== location.id) continue
        if (ctx.providerId !== null && s.provider_id !== ctx.providerId) continue
        const list = daySchedules.get(s.day_of_week) ?? []
        list.push(s)
        daySchedules.set(s.day_of_week, list)
      }

      for (const dateKey of dateKeys) {
        if (closedDays.has(`${location.id}|${dateKey}`)) continue
        const dow = dayOfWeekForDateKey(dateKey)
        const rows = daySchedules.get(dow) ?? []
        const byProvider = new Map<string, Iv[]>()
        for (const s of rows) {
          const list = byProvider.get(s.provider_id) ?? []
          // Wall clock in the SITE's zone, through the one conversion the
          // codebase allows. A spring-forward Sunday is genuinely an hour
          // shorter and this is where that becomes true.
          list.push({
            s: zonedTimeToUtc(dateKey, s.start_time, zone).getTime(),
            e: zonedTimeToUtc(dateKey, s.end_time, zone).getTime(),
          })
          byProvider.set(s.provider_id, list)
        }

        const dayStart = zonedTimeToUtc(dateKey, '00:00', zone).getTime()
        const dayEnd = zonedTimeToUtc(addDaysToDateKey(dateKey, 1), '00:00', zone).getTime()

        for (const [providerId, windows] of byProvider) {
          // Overlapping schedule rows for one day would otherwise be counted
          // twice, and a provider cannot be twice as available as she is.
          let free = union(windows)

          const dayBlocks = blocksByKey.get(`${providerId}|${location.id}|${dateKey}`) ?? []
          const unavailable: Iv[] = []
          for (const b of dayBlocks) {
            // Null start and end is the whole day off — 003's own convention.
            if (b.start_time === null || b.end_time === null) {
              unavailable.push({ s: dayStart, e: dayEnd })
            } else {
              unavailable.push({
                s: zonedTimeToUtc(dateKey, b.start_time, zone).getTime(),
                e: zonedTimeToUtc(dateKey, b.end_time, zone).getTime(),
              })
            }
          }
          const providerBusy = busyByProvider.get(providerId) ?? []
          free = subtract(free, union([...unavailable, ...providerBusy]))
          if (free.length > 0) bookable.set(`${providerId}|${location.id}|${dateKey}`, free)
        }
      }
    }
    for (const s of schedules) if (!zoneOf.has(s.location_id)) scheduleWithoutSite += 1

    // ── 2. Buckets ────────────────────────────────────────────
    const byProviderSite = new Map<string, Cell>()
    const byMonth = new Map<string, Cell>()
    const total = emptyCell()

    const cellFor = (map: Map<string, Cell>, key: string): Cell => {
      let c = map.get(key)
      if (!c) {
        c = emptyCell()
        map.set(key, c)
      }
      return c
    }

    for (const [key, intervals] of bookable) {
      const [providerId, locationIdText, dateKey] = key.split('|')
      const ms = totalMs(intervals)
      const month = dateKey.slice(0, 7)
      cellFor(byProviderSite, `${providerId}|${locationIdText}`).bookableMs += ms
      cellFor(byMonth, month).bookableMs += ms
      total.bookableMs += ms
    }

    // ── 3. Appointments ───────────────────────────────────────
    //
    // First index everything the follow-up questions need, over the whole
    // read including the tail past the period.
    const attendedByClient = new Map<string, number[]>()
    for (const a of appointments) {
      if (!a.client_id || !ATTENDED.has(a.status)) continue
      const list = attendedByClient.get(a.client_id) ?? []
      list.push(Date.parse(a.starts_at))
      attendedByClient.set(a.client_id, list)
    }
    for (const [k, v] of attendedByClient) attendedByClient.set(k, v.sort((x, y) => x - y))

    const recordById = new Map(clientRecords.map((r) => [r.client_id, r]))

    let providerSlotFallbacks = 0
    let unresolvedPast = 0

    for (const a of appointments) {
      const startMs = Date.parse(a.starts_at)
      // The tail past the period exists only to answer "did they come back".
      if (startMs >= periodToMs) continue
      if (!inScopeLocation(a.location_id)) continue
      if (ctx.providerId !== null && a.provider_id !== ctx.providerId) continue

      const zone = zoneOf.get(a.location_id) ?? reportZone
      const dateKey = dateKeyInTimeZone(new Date(startMs), zone)
      // The site's own day boundaries decide which period an appointment falls
      // in: an 11pm booking on the 31st belongs to the 31st.
      const siteFrom = zonedTimeToUtc(ctx.from, '00:00', zone).getTime()
      const siteTo = zonedTimeToUtc(addDaysToDateKey(ctx.to, 1), '00:00', zone).getTime()
      if (startMs < siteFrom || startMs >= siteTo) continue

      const month = dateKey.slice(0, 7)
      const cells = [
        cellFor(byProviderSite, `${a.provider_id}|${a.location_id}`),
        cellFor(byMonth, month),
        total,
      ]
      const dayBookable = bookable.get(`${a.provider_id}|${a.location_id}|${dateKey}`) ?? []

      // `slot` as 004 defines it: the client's whole window plus turnover.
      // Rebuilt from the timestamps rather than parsed, because starts_at and
      // ends_at are plain ISO instants and buffer_minutes is an integer.
      const occupied: Iv[] = [
        { s: startMs, e: Date.parse(a.ends_at) + a.buffer_minutes * MINUTE_MS },
      ]
      // `provider_slot` as 036 defines it: the same window minus each
      // processing gap. Parsed, because it is the authoritative column and the
      // one the exclusion constraint is built on.
      let active = parseMultirange(a.provider_slot)
      if (active === null || totalMs(active) > totalMs(occupied)) {
        active = occupied
        if (a.provider_slot) providerSlotFallbacks += 1
      }

      if (RESOLVED.has(a.status)) {
        for (const c of cells) c.resolved += 1
      } else {
        unresolvedPast += 1
      }

      if (ATTENDED.has(a.status)) {
        const inside = totalMs(intersect(occupied, dayBookable))
        const activeInside = totalMs(intersect(active, dayBookable))
        for (const c of cells) {
          c.occupiedInMs += inside
          c.occupiedOutMs += totalMs(occupied) - inside
          c.activeInMs += activeInside
          if (a.status === 'completed') c.visits += 1
        }
      } else if (a.status === 'no_show') {
        const inside = totalMs(intersect(occupied, dayBookable))
        for (const c of cells) {
          c.noShowInMs += inside
          c.noShows += 1
        }
      } else if (a.status === 'cancelled') {
        const cancelledAt = a.cancelled_at ? Date.parse(a.cancelled_at) : null
        // Late = cancelled inside the notice window. A cancellation with no
        // timestamp cannot be judged and is counted as ordinary, never late.
        if (cancelledAt !== null && startMs - cancelledAt < LATE_CANCEL_HOURS * 60 * MINUTE_MS) {
          for (const c of cells) c.lateCancels += 1
        }
      }

      // ── Retention, anchored on visits that actually happened ──
      if (a.status !== 'completed' || !a.client_id) continue
      const clientId = a.client_id
      const record = recordById.get(clientId)
      const firstVisitMs = record?.first_visit_at ? Date.parse(record.first_visit_at) : null

      // New vs returning: a client is new to this period if their first-ever
      // completed visit falls inside it.
      const isNew = firstVisitMs !== null && firstVisitMs >= siteFrom && firstVisitMs < siteTo
      for (const c of cells) {
        if (isNew) c.newClients.add(clientId)
        else c.returningClients.add(clientId)
      }

      // Rebooking. Only visits whose whole window has elapsed are scored;
      // otherwise a visit three days ago counts as a failure to return.
      const followUps = attendedByClient.get(clientId) ?? []
      if (startMs + REBOOK_DAYS * DAY_MS <= ctx.now) {
        const returned = followUps.some(
          (t) => t > startMs && t <= startMs + REBOOK_DAYS * DAY_MS,
        )
        for (const c of cells) {
          c.rebookEligible += 1
          if (returned) c.rebooked += 1
        }
      }

      // First-visit retention: of the people whose first-ever visit landed in
      // this period, how many came a second time. Same maturity rule.
      if (
        firstVisitMs !== null &&
        Math.abs(firstVisitMs - startMs) < MINUTE_MS &&
        firstVisitMs + FIRST_VISIT_DAYS * DAY_MS <= ctx.now
      ) {
        const cameBack = followUps.some(
          (t) => t > firstVisitMs && t <= firstVisitMs + FIRST_VISIT_DAYS * DAY_MS,
        )
        for (const c of cells) {
          c.cohort.add(clientId)
          if (cameBack) c.cohortRetained.add(clientId)
        }
      }
    }

    // ── 4. Churn, as a state of the book right now ────────────
    //
    // Not a period figure and not pretended to be one: it is asked of every
    // client the studio has ever completed a visit for, as at `ctx.now`.
    const cadences: number[] = []
    for (const r of clientRecords) {
      if (deletedIds.has(r.client_id)) continue
      if (r.visit_count >= 2 && r.first_visit_at && r.last_visit_at) {
        cadences.push(
          (Date.parse(r.last_visit_at) - Date.parse(r.first_visit_at)) / (r.visit_count - 1),
        )
      }
    }
    const medianCadenceMs = median(cadences)
    let churned = 0
    let everActive = 0
    for (const r of clientRecords) {
      if (deletedIds.has(r.client_id)) continue
      if (!r.last_visit_at) continue
      everActive += 1
      // One visit gives no rhythm of their own, so they are measured against
      // the studio's median. Stated, because it is an assumption.
      const cadence =
        r.visit_count >= 2 && r.first_visit_at
          ? (Date.parse(r.last_visit_at) - Date.parse(r.first_visit_at)) / (r.visit_count - 1)
          : medianCadenceMs
      if (cadence > 0 && ctx.now - Date.parse(r.last_visit_at) > cadence * CHURN_CADENCE_MULTIPLIER) {
        churned += 1
      }
    }

    // ── 5. Cohorts by first-visit month ───────────────────────
    const cohortByMonth = new Map<string, { size: number; retained: number }>()
    for (const r of clientRecords) {
      if (deletedIds.has(r.client_id)) continue
      if (!r.first_visit_at) continue
      const firstMs = Date.parse(r.first_visit_at)
      if (firstMs < periodFromMs || firstMs >= periodToMs) continue
      if (firstMs + FIRST_VISIT_DAYS * DAY_MS > ctx.now) continue
      const month = dateKeyInTimeZone(new Date(firstMs), reportZone).slice(0, 7)
      const acc = cohortByMonth.get(month) ?? { size: 0, retained: 0 }
      acc.size += 1
      const followUps = attendedByClient.get(r.client_id) ?? []
      if (followUps.some((t) => t > firstMs && t <= firstMs + FIRST_VISIT_DAYS * DAY_MS)) {
        acc.retained += 1
      }
      cohortByMonth.set(month, acc)
    }

    // ── 6. Rows ───────────────────────────────────────────────
    const rows = [...byProviderSite.entries()]
      .filter(([key]) => {
        const [providerId] = key.split('|')
        return ctx.providerId === null || providerId === ctx.providerId
      })
      .map(([key, cell]) => {
        const [providerId, locationIdText] = key.split('|')
        return {
          sortName: providerNames.get(providerId) ?? providerId,
          sortSite: nameOf.get(Number(locationIdText)) ?? locationIdText,
          row: cellRow(
            providerNames.get(providerId) ?? providerId,
            nameOf.get(Number(locationIdText)) ?? `Location ${locationIdText}`,
            cell,
          ),
        }
      })
      .sort((a, b) => a.sortSite.localeCompare(b.sortSite) || a.sortName.localeCompare(b.sortName))
      .map((r) => r.row)

    const monthRows = [...byMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, cell]) => cellRow(monthLabelForDateKey(`${month}-01`), '—', cell))

    const cohortRows = [...cohortByMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(-MAX_COHORT_ROWS)
      .map(([month, c]) => {
        const row = blankRow()
        row.scope = monthLabelForDateKey(`${month}-01`)
        row.location = '—'
        row.new_clients = c.size
        row.returning_clients = c.retained
        row.first_visit_retention_pct = c.size > 0 ? pct(c.retained / c.size) : null
        return row
      })

    // ── 7. Notes: every denominator, written down ─────────────
    const overlapOn: string[] = []
    for (const key of byProviderSite.keys()) {
      const [providerId, locationIdText] = key.split('|')
      const locationId = Number(locationIdText)
      const resolvedFlag =
        providerPolicy.get(`${providerId}|${locationId}`) ?? sitePolicy.get(locationId) ?? false
      if (resolvedFlag) {
        overlapOn.push(
          `${providerNames.get(providerId) ?? providerId} at ${nameOf.get(locationId) ?? locationId}`,
        )
      }
    }

    notes.push(
      `UTILISATION DENOMINATOR — bookable minutes. For each provider, each site and each day in ${ctx.from}…${ctx.to}: the union of that provider's active \`provider_schedules\` windows for that weekday, resolved from wall clock to instants in the SITE's own \`locations.timezone\`, minus any \`closures\` row for that site and day (whole day), minus that provider's \`availability_blocks\` for that site and day (a row with null start and end is the whole day), minus cached \`calendar_busy\`. Overlapping schedule rows are unioned before subtraction, so a duplicated row cannot make anyone more available than they are.`,
      `UTILISATION NUMERATOR — occupied minutes. Appointments with status \`completed\` or \`checked_in\` only. Not \`cancelled\` (that time went back on the shelf) and not \`no_show\` (that time was lost, not sold — it has its own column). Each appointment contributes \`slot\` as 004 defines it: starts_at through ends_at PLUS \`buffer_minutes\`, intersected with the bookable set for that provider, site and day.`,
      `TURNAROUND BUFFER IS COUNTED AS UTILISED. It is stripping the bed and writing the note; the provider cannot sell it and it exists only because the appointment does. Excluding it would make a studio look idle for doing the work a treatment requires.`,
      `ACTIVE % uses \`appointments.provider_slot\` instead — the multirange migration 036 maintains, which is \`slot\` minus each processing gap, i.e. the minutes the provider is genuinely working rather than waiting for a mask to develop. Same denominator. The distance between Utilisation % and Active % IS the processing time.${overlapOn.length > 0 ? ` \`allow_processing_overlap\` is ON for ${overlapOn.join(', ')}, so for those rows the gap really is resellable and Utilisation % overstates.` : ` \`allow_processing_overlap\` is off everywhere in scope, so in a single-room studio the client is still in the chair during that gap and Utilisation % is the fair reading of the room.`}`,
      `Minutes falling outside the bookable window — work done off the posted schedule — are reported as "Outside hrs" and are NOT in the numerator, which is why Utilisation % is a true fraction and a busy day can still read under 100%.`,
      `Idle = bookable − occupied − no-show minutes: the time that was open, nobody paid for, and nobody even failed to turn up to.`,
      `REBOOKING RATE — denominator: completed visits in the period whose ${REBOOK_DAYS}-day window has fully elapsed as at the report's clock. Visits too recent to have had the chance are excluded rather than scored as failures. Numerator: those where the same client has another \`completed\` or \`checked_in\` appointment starting within ${REBOOK_DAYS} days. The follow-up is business-wide even when the report is filtered to one site or one provider — a client who rebooks with someone else did come back.`,
      `NEW vs RETURNING — denominator: distinct clients with a completed visit in the row's scope during the period. New = their \`client_records.first_visit_at\` falls inside the period; returning = it is earlier. Those counters are maintained by 005's \`client_record_sync_stats\` trigger and are not recomputed here. Because 032 keeps \`client_records\` business-wide on purpose, "new" means new to the BUSINESS: on a location-filtered run a client who first visited the other site counts as returning. A client seen by two providers appears in both of their rows and once in the studio total.`,
      `FIRST-VISIT RETENTION — denominator: clients whose first-ever completed visit fell in the period and was at least ${FIRST_VISIT_DAYS} days ago. Numerator: those with a second completed visit within ${FIRST_VISIT_DAYS} days of it. This is the sharpest single number a studio has and it is deliberately slower than the rebooking window: a first visit is a trial, and the decision to come back is made over a skin cycle.`,
      `NO-SHOW % and LATE-CANCELLATION % — denominator: appointments starting in the period that reached an end state (\`completed\`, \`checked_in\`, \`no_show\`, \`cancelled\`). Past bookings still sitting at \`pending\` or \`confirmed\` are a data-entry gap, not a miss, and are excluded${unresolvedPast > 0 ? ` — there ${unresolvedPast === 1 ? 'is 1' : `are ${unresolvedPast}`} of them in this period` : ''}. Late = \`cancelled_at\` within ${LATE_CANCEL_HOURS} hours of \`starts_at\`; a cancellation with no timestamp is counted as ordinary, never as late.`,
      `CHURN — denominator: every client with at least one completed visit ever, as at the report's clock, NOT the period. There is no subscription to cancel, so churn is silence measured against the client's own rhythm: gone when the time since their last visit exceeds ${CHURN_CADENCE_MULTIPLIER}× their own mean gap ((last − first) ÷ (visits − 1)). A client with a single visit has no rhythm and is measured against the studio's median of ${Math.round(medianCadenceMs / DAY_MS)} days. Anonymised accounts (030) are left out — a "Deleted Account" is not a client to win back.`,
      `Percentages are on a 0–100 scale. Durations are whole minutes. Month buckets are labelled in ${reportZone}.`,
      `Appointments are assigned to the day and month of \`starts_at\` in the site's own zone; a booking that runs past midnight has its minutes counted against the day it started.`,
      `CAVEAT — \`provider_schedules\` holds only the CURRENT weekly pattern. There is no history of hours, so a schedule changed since the period began is projected backwards over it, and a schedule row deleted since is invisible. Utilisation for a past period is only as true as the hours still on file.`,
    )
    if (ctx.locationId === null) {
      notes.push(
        `All locations. Rows are one per provider per site; the footer sums the minute and count columns across every site.`,
      )
    } else {
      notes.push(
        `Filtered to ${nameOf.get(ctx.locationId) ?? ctx.locationId}. \`calendar_busy\` carries no location — it is the provider's own diary — so it is subtracted from this site's window too.`,
      )
    }
    if (providerSlotFallbacks > 0) {
      notes.push(
        `${providerSlotFallbacks} appointment${providerSlotFallbacks === 1 ? "'s" : "s'"} \`provider_slot\` could not be read as a multirange, so Active % falls back to the full \`slot\` for ${providerSlotFallbacks === 1 ? 'it' : 'them'} — it is understated by whatever processing time those bookings carried.`,
      )
    }
    if (scheduleWithoutSite > 0) {
      notes.push(
        `${scheduleWithoutSite} schedule row${scheduleWithoutSite === 1 ? '' : 's'} point${scheduleWithoutSite === 1 ? 's' : ''} at a site this run cannot see, and contributed no bookable time.`,
      )
    }

    const utilisation = total.bookableMs > 0 ? total.occupiedInMs / total.bookableMs : 0
    const activeShare = total.bookableMs > 0 ? total.activeInMs / total.bookableMs : 0

    return {
      columns: baseColumns(),
      rows,
      summary: [
        {
          label: 'Utilisation',
          value: `${pct(utilisation)}%`,
          tone: utilisation >= 0.75 ? 'good' : 'warn',
        },
        { label: 'Active (provider working)', value: `${pct(activeShare)}%` },
        { label: 'Bookable', value: `${minutes(total.bookableMs)} min` },
        { label: 'Sold', value: `${minutes(total.occupiedInMs)} min` },
        {
          label: 'Lost to no-shows',
          value: `${minutes(total.noShowInMs)} min`,
          tone: total.noShowInMs > 0 ? 'warn' : 'good',
        },
        {
          label: `Rebooked within ${REBOOK_DAYS}d`,
          value:
            total.rebookEligible > 0
              ? `${pct(total.rebooked / total.rebookEligible)}% of ${total.rebookEligible}`
              : 'no matured visits',
        },
        {
          label: `First-visit retention (${FIRST_VISIT_DAYS}d)`,
          value:
            total.cohort.size > 0
              ? `${pct(total.cohortRetained.size / total.cohort.size)}% of ${total.cohort.size}`
              : 'no matured cohort',
        },
        {
          label: 'New / returning',
          value: `${total.newClients.size} / ${total.returningClients.size}`,
        },
        {
          label: `Churned (${CHURN_CADENCE_MULTIPLIER}× cadence)`,
          value: everActive > 0 ? `${churned} of ${everActive} · ${pct(churned / everActive)}%` : '0',
          tone: everActive > 0 && churned / everActive > 0.3 ? 'warn' : 'good',
        },
        {
          label: 'No-show rate',
          value: total.resolved > 0 ? `${pct(total.noShows / total.resolved)}%` : 'n/a',
          tone: total.resolved > 0 && total.noShows / total.resolved > 0.05 ? 'warn' : 'good',
        },
      ],
      sections: [
        { title: 'Studio total', rows: [cellRow('All providers', 'All sites', total)] },
        { title: 'By month', rows: monthRows },
        {
          title: `First-visit cohorts — clients whose first visit fell in the period, and how many came back inside ${FIRST_VISIT_DAYS} days`,
          rows: cohortRows,
        },
      ],
      notes,
    }
  },
}

// ── Rows and columns ─────────────────────────────────────────
//
// One column set serves the provider table and every section, because the
// contract gives a section rows but not columns of its own. Cells that do not
// apply to a section are null rather than zero — an empty cell reads as "not
// this question", a zero reads as an answer.

function baseColumns(): ReportColumn[] {
  return [
    { key: 'scope', label: 'Provider / period', align: 'left', format: 'text' },
    { key: 'location', label: 'Site', align: 'left', format: 'text' },
    { key: 'bookable_minutes', label: 'Bookable', align: 'right', format: 'duration', total: 'sum' },
    { key: 'sold_minutes', label: 'Sold', align: 'right', format: 'duration', total: 'sum' },
    { key: 'no_show_minutes', label: 'No-show', align: 'right', format: 'duration', total: 'sum' },
    { key: 'idle_minutes', label: 'Idle', align: 'right', format: 'duration', total: 'sum' },
    { key: 'outside_minutes', label: 'Outside hrs', align: 'right', format: 'duration', total: 'sum' },
    { key: 'utilisation_pct', label: 'Utilisation %', align: 'right', format: 'percent' },
    { key: 'active_pct', label: 'Active %', align: 'right', format: 'percent' },
    { key: 'visits', label: 'Visits', align: 'right', format: 'number', total: 'sum' },
    { key: 'new_clients', label: 'New', align: 'right', format: 'number', total: 'sum' },
    { key: 'returning_clients', label: 'Returning', align: 'right', format: 'number', total: 'sum' },
    { key: 'rebooked_pct', label: `Rebooked ${REBOOK_DAYS}d %`, align: 'right', format: 'percent' },
    {
      key: 'first_visit_retention_pct',
      label: `1st-visit ret. ${FIRST_VISIT_DAYS}d %`,
      align: 'right',
      format: 'percent',
    },
    { key: 'no_show_pct', label: 'No-show %', align: 'right', format: 'percent' },
    { key: 'late_cancel_pct', label: 'Late cancel %', align: 'right', format: 'percent' },
  ]
}

function blankRow(): Record<string, string | number | null> {
  const row: Record<string, string | number | null> = {}
  for (const c of baseColumns()) row[c.key] = null
  return row
}

function cellRow(scope: string, location: string, cell: Cell): Record<string, string | number | null> {
  const bookable = minutes(cell.bookableMs)
  const sold = minutes(cell.occupiedInMs)
  const noShow = minutes(cell.noShowInMs)
  return {
    scope,
    location,
    bookable_minutes: bookable,
    sold_minutes: sold,
    no_show_minutes: noShow,
    // Never negative: a rounding artefact would otherwise show as a debt.
    idle_minutes: Math.max(0, bookable - sold - noShow),
    outside_minutes: minutes(cell.occupiedOutMs),
    utilisation_pct: cell.bookableMs > 0 ? pct(cell.occupiedInMs / cell.bookableMs) : null,
    active_pct: cell.bookableMs > 0 ? pct(cell.activeInMs / cell.bookableMs) : null,
    visits: cell.visits,
    new_clients: cell.newClients.size,
    returning_clients: cell.returningClients.size,
    rebooked_pct: cell.rebookEligible > 0 ? pct(cell.rebooked / cell.rebookEligible) : null,
    first_visit_retention_pct:
      cell.cohort.size > 0 ? pct(cell.cohortRetained.size / cell.cohort.size) : null,
    no_show_pct: cell.resolved > 0 ? pct(cell.noShows / cell.resolved) : null,
    late_cancel_pct: cell.resolved > 0 ? pct(cell.lateCancels / cell.resolved) : null,
  }
}

// ── Interval arithmetic, in integer milliseconds ─────────────

/** Sorted, merged, non-overlapping. Touching intervals are joined. */
function union(intervals: Iv[]): Iv[] {
  const sorted = intervals
    .filter((i) => Number.isFinite(i.s) && Number.isFinite(i.e) && i.e > i.s)
    .sort((a, b) => a.s - b.s)
  const out: Iv[] = []
  for (const iv of sorted) {
    const last = out[out.length - 1]
    if (last && iv.s <= last.e) last.e = Math.max(last.e, iv.e)
    else out.push({ s: iv.s, e: iv.e })
  }
  return out
}

/** a minus b. Both are normalised first, so callers need not be careful. */
function subtract(a: Iv[], b: Iv[]): Iv[] {
  const holes = union(b)
  let out = union(a)
  for (const hole of holes) {
    const next: Iv[] = []
    for (const iv of out) {
      if (hole.e <= iv.s || hole.s >= iv.e) {
        next.push(iv)
        continue
      }
      if (hole.s > iv.s) next.push({ s: iv.s, e: hole.s })
      if (hole.e < iv.e) next.push({ s: hole.e, e: iv.e })
    }
    out = next
  }
  return out
}

function intersect(a: Iv[], b: Iv[]): Iv[] {
  const left = union(a)
  const right = union(b)
  const out: Iv[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    const s = Math.max(left[i].s, right[j].s)
    const e = Math.min(left[i].e, right[j].e)
    if (e > s) out.push({ s, e })
    if (left[i].e < right[j].e) i += 1
    else j += 1
  }
  return out
}

function totalMs(intervals: Iv[]): number {
  return union(intervals).reduce((sum, iv) => sum + (iv.e - iv.s), 0)
}

/** Whole minutes. Every boundary in this schema is minute-aligned. */
function minutes(ms: number): number {
  return Math.round(ms / MINUTE_MS)
}

// ── Postgres multirange text ─────────────────────────────────

/**
 * `{["2026-03-10 10:00:00-07","2026-03-10 11:00:00-07"),[…)}` → intervals.
 *
 * Postgres renders a tstzmultirange as text and PostgREST passes the text
 * straight through, so this has to cope with the server's format rather than
 * ISO 8601: a space instead of `T`, and a two-digit offset with no colon.
 * Returns null when the string is not a multirange at all, so the caller can
 * fall back to `slot` and say that it did rather than silently reporting zero.
 */
function parseMultirange(text: string | null): Iv[] | null {
  if (!text) return null
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  if (trimmed === '{}') return []
  const out: Iv[] = []
  const pattern = /([[(])\s*"?([^",]+)"?\s*,\s*"?([^",)\]]+)"?\s*([)\]])/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(trimmed)) !== null) {
    const s = parsePgTimestamp(match[2])
    const e = parsePgTimestamp(match[3])
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return null
    out.push({ s, e })
  }
  return out.length > 0 ? out : null
}

function parsePgTimestamp(raw: string): number {
  let s = raw.trim().replace(/^"|"$/g, '')
  if (!s) return NaN
  s = s.replace(' ', 'T')
  // The offset's sign can only appear after the date, so anything before
  // index 10 is one of the date's own hyphens.
  const offsetAt = Math.max(s.lastIndexOf('+'), s.lastIndexOf('-'))
  if (offsetAt > 10) {
    if (/^[+-]\d{2}$/.test(s.slice(offsetAt))) s += ':00'
  } else if (!s.endsWith('Z')) {
    s += 'Z'
  }
  return Date.parse(s)
}

// ── Small helpers ────────────────────────────────────────────

/**
 * Page a PostgREST query to the end. A truncated read would not error, it
 * would just quietly shrink a denominator — the exact failure this report is
 * meant to be immune to.
 */
async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await page(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const batch = (data ?? []) as T[]
    out.push(...batch)
    if (batch.length < PAGE_SIZE) return out
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** A fraction as a 0–100 figure, one decimal. Rates are not money. */
function pct(fraction: number): number {
  return Math.round(fraction * 1000) / 10
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid]
}
