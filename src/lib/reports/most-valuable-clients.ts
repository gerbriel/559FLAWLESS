// 559 Flawless — Most Valuable Clients.
//
// "Who matters to this business" is not "who spent the most", which is why this
// report ranks on lifetime takings but then pulls three named lists out of the
// same data: the high-value clients who are overdue against THEIR OWN rhythm,
// the new ones spending above the house average, and the ones whose value has
// to be read against how often they fail to turn up.
//
// Three decisions run through the whole file and are stated in `notes` for the
// person reading the screen:
//
//  1. MONEY IS WHAT WAS TAKEN. `payments` is the ledger (008/025); a completed
//     appointment nobody paid for is not revenue. Refunds are negative rows and
//     net out on their own. `client_records.lifetime_value_cents` measures
//     something different — see the reconciliation below — and this report
//     shows the gap rather than hiding it.
//
//  2. VISIT STATS COME FROM `client_records`. Migration 005's
//     `client_record_sync_stats` trigger maintains visit_count, first/last
//     visit, no_show_count and cancel_count. They are not recomputed here. The
//     one exception is a run filtered to a single location, because 032 keeps
//     `client_records` deliberately location-free — one person, one history —
//     so those columns cannot answer a per-site question and are derived from
//     `appointments` instead. That switch is announced in `notes`.
//
//  3. ANONYMISED ACCOUNTS ARE NOT PEOPLE. Migration 030 rewrites the profile to
//     "Deleted Account" and leaves the appointments, payments and aggregates in
//     place. Putting that row in a list of names would be both useless and a
//     small betrayal of the erasure. They are EXCLUDED from every row and
//     section, and their takings are reported as one anonymous total so the
//     figures still reconcile.

import type {
  ReportColumn,
  ReportContext,
  ReportModule,
  ReportResult,
} from '@/lib/reports/types'
import { DAY_MS, dateKeyInTimeZone, zonedTimeToUtc, addDaysToDateKey } from '@/lib/time'
import { formatMoney } from '@/lib/utils'

// ── Tunables, all of them stated on screen ───────────────────
//
// Every one of these is a judgement call, so it lives here as a named constant
// with the reasoning attached rather than as a number buried in a condition.

/** PostgREST caps a response; everything is read in pages of this size. */
const PAGE_SIZE = 1000

/** `client_id=in.(...)` goes in the URL, so ids are sent in batches. */
const ID_CHUNK = 150

/** The table is a shortlist, not a database dump. Totals cover everyone. */
const MAX_ROWS = 100

/** Each named list is meant to be worked through, so it stays short. */
const SECTION_ROWS = 25

/**
 * How far past their own average gap a client has to be before "overdue".
 *
 * 1.0 would flag half the book at any moment: the cadence IS the mean, so half
 * of all intervals are longer than it. 1.5 is the smallest multiple that says
 * something beyond arithmetic. It pairs with the 2.0 used for churn in the
 * Utilisation & Retention report — overdue first, gone second.
 */
const AT_RISK_CADENCE_MULTIPLIER = 1.5

/** Below three visits there is no rhythm to be late against — one gap is noise. */
const AT_RISK_MIN_VISITS = 3

/** "High value" for the at-risk list: the top quarter of ranked lifetime value. */
const AT_RISK_VALUE_QUANTILE = 0.75

/** "Few visits" for the promising list. */
const NEW_MAX_VISITS = 2

/** And recently enough that acting on it is still possible. */
const NEW_WINDOW_DAYS = 180

/** A single missed appointment is an accident; a pattern needs a second one. */
const HIGH_NO_SHOW_MIN = 2

/** …and at least this share of their resolved bookings, as a fraction. */
const HIGH_NO_SHOW_RATE = 0.2

// ── Shapes read back from PostgREST ──────────────────────────

type RecordRow = {
  client_id: string
  first_visit_at: string | null
  last_visit_at: string | null
  visit_count: number
  no_show_count: number
  cancel_count: number
  lifetime_value_cents: number
  profiles: { first_name: string | null; last_name: string | null } | null
}

type PaymentRow = {
  client_id: string | null
  amount_cents: number
  kind: string
  method: string
  created_at: string
  appointment_id: string | null
  order_id: number | null
  appointments: { location_id: number } | null
  orders: { location_id: number } | null
}

/** Everything the report knows about one client, before it is turned into a row. */
type Tally = {
  clientId: string
  name: string
  /** Money taken, net of refunds, excluding redemptions. Integer cents. */
  takenCents: number
  /** The retail slice of the above. Integer cents. */
  retailCents: number
  /** Value handed over as a gift card or package session — no new money. */
  redeemedCents: number
  /** Money taken against appointments, for the reconciliation against 005. */
  serviceTakenCents: number
  /** `client_records.lifetime_value_cents`: appointments.total_cents, billed. */
  billedCents: number
  visits: number
  noShows: number
  cancels: number
  firstVisitMs: number | null
  lastVisitMs: number | null
  hasUpcoming: boolean
}

export const mostValuableClientsReport: ReportModule = {
  key: 'most-valuable-clients',
  title: 'Most Valuable Clients',
  description:
    'Lifetime value, cadence and reliability per client, with the overdue, ' +
    'the promising and the unreliable pulled out as their own lists.',
  // Names against spend. Front desk can already see a client's own record; a
  // ranked list of who the studio earns from is a management figure.
  minRole: 'manager',
  filters: ['dateRange', 'location'],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const notes: string[] = []
    const db = ctx.supabase

    // ── The site, and the clock its days are measured on ──────
    const { data: locationRows, error: locationError } = await db
      .from('locations')
      .select('id, name, timezone')
      .order('sort_order')
    if (locationError) throw new Error(`locations: ${locationError.message}`)

    const locations = (locationRows ?? []).filter(
      (l) => ctx.locationId === null || l.id === ctx.locationId,
    )
    const scopedLocation = ctx.locationId === null ? null : locations[0]
    // The period is a pair of calendar days in the studio's zone, never UTC:
    // a sale at 11pm on the 31st belongs to the 31st.
    const zone = scopedLocation?.timezone ?? ctx.timeZone
    const periodStartMs = zonedTimeToUtc(ctx.from, '00:00', zone).getTime()
    const periodEndMs = zonedTimeToUtc(addDaysToDateKey(ctx.to, 1), '00:00', zone).getTime()

    // ── 1. The aggregates migration 005 already maintains ─────
    const records = await readAll<RecordRow>((from, to) =>
      db
        .from('client_records')
        .select(
          'client_id, first_visit_at, last_visit_at, visit_count, no_show_count, cancel_count, lifetime_value_cents, profiles!client_records_client_id_fkey(first_name, last_name)',
        )
        .order('client_id')
        .range(from, to),
    )

    // ── 2. The ledger ─────────────────────────────────────────
    //
    // Read whole rather than pre-aggregated because location lives on the
    // appointment or the order, not on the payment, so the attribution has to
    // happen after the embed comes back.
    const payments = await readAll<PaymentRow>((from, to) =>
      db
        .from('payments')
        .select(
          'client_id, amount_cents, kind, method, created_at, appointment_id, order_id, appointments!payments_appointment_id_fkey(location_id), orders!payments_order_id_fkey(location_id)',
        )
        .eq('status', 'succeeded')
        .order('id')
        .range(from, to),
    )

    // ── 3. Who is already booked back in ──────────────────────
    //
    // Without this, every regular who happens to be between visits reads as
    // "at risk", including the one sitting in the chair next Tuesday.
    const upcoming = await readAll<{ client_id: string | null; location_id: number }>(
      (from, to) =>
        db
          .from('appointments')
          .select('client_id, location_id')
          .in('status', ['pending', 'confirmed'])
          .gte('starts_at', new Date(ctx.now).toISOString())
          .order('starts_at')
          .range(from, to),
    )

    // ── 4. The tombstones ─────────────────────────────────────
    const deleted = await readAll<{ profile_id: string }>((from, to) =>
      db.from('deleted_accounts').select('profile_id').order('profile_id').range(from, to),
    )
    const deletedIds = new Set(deleted.map((d) => d.profile_id))

    // ── 5. Per-site visit stats, only when a site was asked for ──
    //
    // `client_records` is business-wide on purpose (032: one person, one
    // history), so it cannot answer "how many times did she come to THIS
    // room". When a location filter is on, these columns are derived instead —
    // announced below rather than silently swapped.
    const perSite = new Map<string, { visits: number; noShows: number; cancels: number; first: number | null; last: number | null }>()
    if (ctx.locationId !== null) {
      const siteAppointments = await readAll<{
        client_id: string | null
        starts_at: string
        status: string
      }>((from, to) =>
        db
          .from('appointments')
          .select('client_id, starts_at, status')
          .eq('location_id', ctx.locationId as number)
          .not('client_id', 'is', null)
          .order('starts_at')
          .range(from, to),
      )
      for (const a of siteAppointments) {
        if (!a.client_id) continue
        const at = Date.parse(a.starts_at)
        const acc =
          perSite.get(a.client_id) ??
          { visits: 0, noShows: 0, cancels: 0, first: null, last: null }
        if (a.status === 'completed') {
          acc.visits += 1
          if (acc.first === null || at < acc.first) acc.first = at
          if (acc.last === null || at > acc.last) acc.last = at
        } else if (a.status === 'no_show') acc.noShows += 1
        else if (a.status === 'cancelled') acc.cancels += 1
        perSite.set(a.client_id, acc)
      }
    }

    // ── 6. Fold the ledger onto the clients ───────────────────
    const tallies = new Map<string, Tally>()
    const tallyFor = (clientId: string): Tally => {
      let t = tallies.get(clientId)
      if (!t) {
        t = {
          clientId,
          name: 'Unnamed client',
          takenCents: 0,
          retailCents: 0,
          redeemedCents: 0,
          serviceTakenCents: 0,
          billedCents: 0,
          visits: 0,
          noShows: 0,
          cancels: 0,
          firstVisitMs: null,
          lastVisitMs: null,
          hasUpcoming: false,
        }
        tallies.set(clientId, t)
      }
      return t
    }

    for (const r of records) {
      const t = tallyFor(r.client_id)
      const name = `${r.profiles?.first_name ?? ''} ${r.profiles?.last_name ?? ''}`.trim()
      if (name) t.name = name
      const site = perSite.get(r.client_id)
      if (ctx.locationId !== null) {
        t.visits = site?.visits ?? 0
        t.noShows = site?.noShows ?? 0
        t.cancels = site?.cancels ?? 0
        t.firstVisitMs = site?.first ?? null
        t.lastVisitMs = site?.last ?? null
      } else {
        t.visits = r.visit_count
        t.noShows = r.no_show_count
        t.cancels = r.cancel_count
        t.firstVisitMs = r.first_visit_at ? Date.parse(r.first_visit_at) : null
        t.lastVisitMs = r.last_visit_at ? Date.parse(r.last_visit_at) : null
      }
      // Always the business-wide figure: it is what 005 stores, and the
      // reconciliation below is about that number specifically.
      t.billedCents = r.lifetime_value_cents
    }

    let unattributedCents = 0
    let guestCents = 0
    let redemptionTotal = 0
    let periodTakenCents = 0
    for (const p of payments) {
      // A payment made with a gift card or a package session moves no new
      // money — it spends value the studio already took when the card or the
      // package was sold. Counting both is how a $600 package becomes $1,200
      // of "revenue". `method` is the tell, not `kind`.
      const isRedemption = p.method === 'gift_card' || p.method === 'package'

      const paidAt = Date.parse(p.created_at)
      const site = p.appointments?.location_id ?? p.orders?.location_id ?? null
      if (ctx.locationId !== null && site !== ctx.locationId) {
        if (site === null && !isRedemption) unattributedCents += p.amount_cents
        continue
      }
      if (isRedemption) {
        redemptionTotal += p.amount_cents
        if (p.client_id) tallyFor(p.client_id).redeemedCents += p.amount_cents
        continue
      }
      if (!p.client_id) {
        // A guest booking that never matched an account (004's matcher found
        // no email or phone). Real money, no person to attribute it to.
        guestCents += p.amount_cents
        continue
      }
      const t = tallyFor(p.client_id)
      t.takenCents += p.amount_cents
      if (paidAt >= periodStartMs && paidAt < periodEndMs) periodTakenCents += p.amount_cents
      // Retail is anything against an order; a refund inherits the side of the
      // ledger it is reversing, which is what its order_id/appointment_id says.
      if (p.order_id !== null) t.retailCents += p.amount_cents
      if (p.appointment_id !== null) t.serviceTakenCents += p.amount_cents
    }

    for (const u of upcoming) {
      if (!u.client_id) continue
      if (ctx.locationId !== null && u.location_id !== ctx.locationId) continue
      const t = tallies.get(u.client_id)
      if (t) t.hasUpcoming = true
    }

    // Anybody who has only ever bought retail has payments but may have no
    // `client_records` row at all, so their name has to be fetched directly.
    const nameless = [...tallies.values()]
      .filter((t) => t.name === 'Unnamed client' && !deletedIds.has(t.clientId))
      .map((t) => t.clientId)
    for (const batch of chunk(nameless, ID_CHUNK)) {
      const { data, error } = await db
        .from('profiles')
        .select('id, first_name, last_name')
        .in('id', batch)
      if (error) throw new Error(`profiles: ${error.message}`)
      for (const p of data ?? []) {
        const name = `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim()
        if (name) tallyFor(p.id).name = name
      }
    }

    // ── 7. Anonymised accounts come out of the list ───────────
    const anonymised = [...tallies.values()].filter((t) => deletedIds.has(t.clientId))
    const anonymisedCents = anonymised.reduce((s, t) => s + t.takenCents, 0)
    const anonymisedVisits = anonymised.reduce((s, t) => s + t.visits, 0)

    const ranked = [...tallies.values()]
      .filter((t) => !deletedIds.has(t.clientId))
      .filter((t) => t.takenCents !== 0 || t.visits > 0)
      .sort((a, b) => b.takenCents - a.takenCents || a.name.localeCompare(b.name))

    // ── 8. The derived figures ────────────────────────────────
    const totalTaken = ranked.reduce((s, t) => s + t.takenCents, 0)
    const totalVisits = ranked.reduce((s, t) => s + t.visits, 0)
    const totalBilled = ranked.reduce((s, t) => s + t.billedCents, 0)
    const totalServiceTaken = ranked.reduce((s, t) => s + t.serviceTakenCents, 0)
    const houseAvgTicket = totalVisits > 0 ? divideCents(totalTaken, totalVisits) : 0

    // The value threshold for "high value", computed over the ranked list only
    // so a studio with ten clients and a studio with a thousand both get a
    // meaningful cut rather than a fixed dollar figure that suits neither.
    const valueThreshold = quantile(
      ranked.map((t) => t.takenCents),
      AT_RISK_VALUE_QUANTILE,
    )

    const view = ranked.map((t) => {
      const cadenceDays =
        t.visits >= 2 && t.firstVisitMs !== null && t.lastVisitMs !== null
          ? (t.lastVisitMs - t.firstVisitMs) / (t.visits - 1) / DAY_MS
          : null
      const daysSince =
        t.lastVisitMs === null ? null : Math.floor((ctx.now - t.lastVisitMs) / DAY_MS)
      // "Resolved" = every booking that reached an end state. Pending and
      // confirmed bookings in the past are a data-entry gap, not a no-show.
      const resolved = t.visits + t.noShows + t.cancels
      const noShowRate = resolved > 0 ? t.noShows / resolved : 0
      const avgTicket = t.visits > 0 ? divideCents(t.takenCents, t.visits) : null

      const overdue =
        cadenceDays !== null &&
        daysSince !== null &&
        daysSince > cadenceDays * AT_RISK_CADENCE_MULTIPLIER
      const atRisk =
        overdue &&
        !t.hasUpcoming &&
        t.visits >= AT_RISK_MIN_VISITS &&
        t.takenCents >= valueThreshold &&
        t.takenCents > 0
      const promising =
        t.visits >= 1 &&
        t.visits <= NEW_MAX_VISITS &&
        t.firstVisitMs !== null &&
        ctx.now - t.firstVisitMs <= NEW_WINDOW_DAYS * DAY_MS &&
        avgTicket !== null &&
        avgTicket > houseAvgTicket
      const unreliable = t.noShows >= HIGH_NO_SHOW_MIN && noShowRate >= HIGH_NO_SHOW_RATE

      const flags: string[] = []
      if (atRisk) flags.push('At risk')
      if (promising) flags.push('New & promising')
      if (unreliable) flags.push('High no-show')

      return {
        t,
        cadenceDays,
        daysSince,
        noShowRate,
        avgTicket,
        atRisk,
        promising,
        unreliable,
        row: {
          client: t.name,
          lifetime_cents: t.takenCents,
          visits: t.visits,
          avg_ticket_cents: avgTicket,
          retail_cents: t.retailCents,
          retail_pct: t.takenCents > 0 ? pct(t.retailCents / t.takenCents) : null,
          last_visit: t.lastVisitMs === null ? null : dateKeyInTimeZone(new Date(t.lastVisitMs), zone),
          cadence_days: cadenceDays === null ? null : Math.round(cadenceDays),
          days_since: daysSince,
          no_shows: t.noShows,
          no_show_pct: resolved > 0 ? pct(noShowRate) : null,
          // Value discounted by reliability: what the missed slots would have
          // been worth at this client's own average ticket, taken back off.
          adjusted_cents:
            avgTicket === null ? t.takenCents : t.takenCents - t.noShows * avgTicket,
          redeemed_cents: t.redeemedCents,
          flags: flags.join(' · '),
        } satisfies Record<string, string | number | null>,
      }
    })

    // The redeemed column earns its place only where gift cards and packages
    // are actually in use; otherwise it is a column of zeroes.
    const showRedeemed = redemptionTotal !== 0

    const columns: ReportColumn[] = [
      { key: 'client', label: 'Client', align: 'left', format: 'text' },
      { key: 'lifetime_cents', label: 'Lifetime taken', align: 'right', format: 'money', total: 'sum' },
      { key: 'visits', label: 'Visits', align: 'right', format: 'number', total: 'sum' },
      { key: 'avg_ticket_cents', label: 'Avg ticket', align: 'right', format: 'money', total: 'avg' },
      { key: 'retail_cents', label: 'Retail', align: 'right', format: 'money', total: 'sum' },
      { key: 'retail_pct', label: 'Retail %', align: 'right', format: 'percent' },
      { key: 'last_visit', label: 'Last visit', align: 'right', format: 'date' },
      { key: 'cadence_days', label: 'Cadence (days)', align: 'right', format: 'number' },
      { key: 'days_since', label: 'Days since', align: 'right', format: 'number' },
      { key: 'no_shows', label: 'No-shows', align: 'right', format: 'number', total: 'sum' },
      { key: 'no_show_pct', label: 'No-show %', align: 'right', format: 'percent' },
      { key: 'adjusted_cents', label: 'Adj. value', align: 'right', format: 'money', total: 'sum' },
      ...(showRedeemed
        ? ([{ key: 'redeemed_cents', label: 'Redeemed', align: 'right', format: 'money', total: 'sum' }] as ReportColumn[])
        : []),
      { key: 'flags', label: 'Flags', align: 'left', format: 'text' },
    ]

    // A row carries the key whether or not the column is declared; drop it
    // when it is not, so a CSV export cannot emit an undeclared column.
    const strip = (r: Record<string, string | number | null>) => {
      if (showRedeemed) return r
      const rest = { ...r }
      delete rest.redeemed_cents
      return rest
    }

    const atRisk = view.filter((v) => v.atRisk).sort((a, b) => b.t.takenCents - a.t.takenCents)
    const promising = view
      .filter((v) => v.promising)
      .sort((a, b) => (b.avgTicket ?? 0) - (a.avgTicket ?? 0))
    const unreliable = view
      .filter((v) => v.unreliable)
      .sort((a, b) => b.noShowRate - a.noShowRate || b.t.takenCents - a.t.takenCents)

    const atRiskValue = atRisk.reduce((s, v) => s + v.t.takenCents, 0)
    const ledgerGap = totalServiceTaken - totalBilled

    // ── 9. Notes: every figure above, defined ─────────────────
    notes.push(
      `Money is what was TAKEN: succeeded rows in \`payments\`, refunds included as the negative amounts they are. A completed appointment nobody paid for is not counted.`,
      `Payments made with method \`gift_card\` or \`package\` are EXCLUDED from lifetime value. That value was taken when the card or package was sold; counting the redemption as well would book the same money twice.${showRedeemed ? ` ${formatMoney(redemptionTotal)} of redemption is shown in its own column.` : ''}`,
      `A payment is dated by \`payments.created_at\` — when the money moved — resolved against ${zone}.`,
      `Average ticket = lifetime taken ÷ visits, where visits = completed appointments. It therefore includes retail bought on those visits.`,
      `Retail % = money against an order ÷ lifetime taken. It is a share of takings, not the retail-to-service ratio.`,
      `Cadence = (last visit − first visit) ÷ (visits − 1): the client's own mean gap between visits, from the counters migration 005's trigger maintains. Blank below two visits.`,
      `AT RISK = ${AT_RISK_MIN_VISITS}+ visits, lifetime value in the top ${Math.round((1 - AT_RISK_VALUE_QUANTILE) * 100)}% of this list (≥ ${formatMoney(valueThreshold)}), nothing on the books, and ${AT_RISK_CADENCE_MULTIPLIER}× their own cadence since the last visit. The multiplier is not 1.0 because the cadence is a mean: half of all gaps exceed it by definition.`,
      `NEW & PROMISING = ${NEW_MAX_VISITS} visits or fewer, first visit within ${NEW_WINDOW_DAYS} days, average ticket above the house average of ${formatMoney(houseAvgTicket)}.`,
      `HIGH NO-SHOW = ${HIGH_NO_SHOW_MIN}+ no-shows and a no-show rate ≥ ${Math.round(HIGH_NO_SHOW_RATE * 100)}%. Denominator = completed + no-show + cancelled, i.e. bookings that reached an end state; past bookings still sitting at pending or confirmed are excluded as a data-entry gap, not a miss.`,
      `Adj. value = lifetime taken − (no-shows × that client's average ticket): the value discounted by what the missed slots would have earned.`,
      `Percentages are on a 0–100 scale.`,
    )

    if (ctx.locationId !== null) {
      notes.push(
        `Filtered to ${scopedLocation?.name ?? `location ${ctx.locationId}`}. \`client_records\` is deliberately business-wide (032: a client who books a facial at one site and a wax at the other is one person with one history), so visits, first/last visit, no-shows and cancels are DERIVED from \`appointments\` at this site for this run. Lifetime taken counts payments whose appointment or order belongs to this site.`,
      )
      if (unattributedCents !== 0) {
        notes.push(
          `${formatMoney(unattributedCents)} of takings is attached to neither an appointment nor an order and so cannot be placed at a site. It is missing from this filtered run and present in the all-locations one.`,
        )
      }
    } else {
      notes.push(
        `All locations. Visits, first/last visit, no-shows and cancels are read straight from \`client_records\` — the counters migration 005's \`client_record_sync_stats\` trigger maintains — and are not recomputed.`,
      )
    }

    // The reconciliation the brief asks for, stated whether or not it is zero.
    notes.push(
      `RECONCILIATION. \`client_records.lifetime_value_cents\` is not takings: 005's trigger sums \`appointments.total_cents\` for completed appointments, which is what was BILLED for services. Across this list it is ${formatMoney(totalBilled)}, against ${formatMoney(totalServiceTaken)} actually taken on appointments — a difference of ${formatMoney(ledgerGap)}. The gap is structural, not a bug: it holds unpaid balances (negative), deposits taken on appointments not yet completed (positive), refunds, and every payment against an appointment that was later cancelled. It also excludes retail entirely. This report ranks on the ledger; the counter is shown for what it measures.`,
    )

    if (anonymised.length > 0) {
      notes.push(
        `${anonymised.length} anonymised account${anonymised.length === 1 ? '' : 's'} (migration 030) EXCLUDED from the rows and sections — a "Deleted Account" line is not a person to call. Between them: ${anonymisedVisits} visits and ${formatMoney(anonymisedCents)} taken, which is why this list does not sum to the studio's gross.`,
      )
    }
    if (guestCents !== 0) {
      notes.push(
        `${formatMoney(guestCents)} was taken from guest bookings that never matched an account (004's \`appointment_match_client\` found no email or phone), so it belongs to no client on this list.`,
      )
    }
    notes.push(
      `Showing the top ${Math.min(MAX_ROWS, ranked.length)} of ${ranked.length} ranked clients; the summary figures cover all ${ranked.length}.`,
      `The date range scopes the "taken in period" tile only. Lifetime value, visits and cadence are lifetime by definition and are not clipped to it — an at-risk list that could only see inside the window would be blind to exactly the people it is for.`,
    )

    const summary: NonNullable<ReportResult['summary']> = [
      { label: 'Clients ranked', value: String(ranked.length) },
      { label: 'Lifetime taken', value: formatMoney(totalTaken) },
      { label: 'Taken in period', value: formatMoney(periodTakenCents) },
      { label: 'Average ticket', value: formatMoney(houseAvgTicket) },
      {
        label: 'At risk',
        value: `${atRisk.length} · ${formatMoney(atRiskValue)}`,
        tone: atRisk.length > 0 ? 'warn' : 'good',
      },
      {
        label: 'High no-show',
        value: String(unreliable.length),
        tone: unreliable.length > 0 ? 'warn' : 'good',
      },
      {
        label: 'Ledger vs client_records',
        value: formatMoney(ledgerGap),
        tone: ledgerGap === 0 ? 'good' : 'warn',
      },
    ]

    return {
      columns,
      rows: view.slice(0, MAX_ROWS).map((v) => strip(v.row)),
      summary,
      sections: [
        {
          title: `At risk — high value, overdue against their own cadence (${atRisk.length})`,
          rows: atRisk.slice(0, SECTION_ROWS).map((v) => strip(v.row)),
        },
        {
          title: `New and promising — few visits, above-average ticket (${promising.length})`,
          rows: promising.slice(0, SECTION_ROWS).map((v) => strip(v.row)),
        },
        {
          title: `High no-show — value read against reliability (${unreliable.length})`,
          rows: unreliable.slice(0, SECTION_ROWS).map((v) => strip(v.row)),
        },
      ],
      notes,
    }
  },
}

// ── Small helpers ────────────────────────────────────────────

/**
 * Page a PostgREST query to the end.
 *
 * Supabase caps a single response, and a studio's payment ledger passes that
 * cap in the second year. A truncated read here would not error — it would
 * just quietly under-report somebody's lifetime value.
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

/**
 * Cents ÷ count, back to whole cents.
 *
 * The only division money is allowed to go through, and it lands on an integer
 * immediately so no fractional cent is ever carried into a later sum.
 */
function divideCents(total: number, count: number): number {
  return count === 0 ? 0 : Math.round(total / count)
}

/** A fraction as a 0–100 figure, one decimal. Rates are not money. */
function pct(fraction: number): number {
  return Math.round(fraction * 1000) / 10
}

/** Nearest-rank quantile of a list of integers. Empty list = 0. */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))
  return sorted[index]
}
