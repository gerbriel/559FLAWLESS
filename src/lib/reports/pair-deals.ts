// 559 Flawless — pair-deal redemptions (067).
//
// Every appointment line whose price was cut by a pair deal: who got it, what
// it cost against list, and — the split the studio asked for — whether the
// client paired it themselves at booking or the provider added it in the
// chair. This is the promo's scoreboard: how often the deal fires, what it
// gives away, and how much of it is the upsell working.
//
// Correctness:
//  * A redemption is an `appointment_services` row with `pair_discount_id`
//    set. The price and the list price are frozen on the row (004/067), so a
//    later menu change never rewrites history.
//  * The window is the visit's start in the studio's zone, matching how the
//    calendar reads.
//  * Cancelled and no-show visits are listed (the row exists and says what
//    happened) but excluded from every money figure — a discount on a
//    treatment that never happened neither cost nor earned anything, the same
//    reading appointment_balance_cents (025) takes.
//  * "In the chair" means `added_by` is set: the line was added to an existing
//    appointment by a staff member. A null `added_by` came with the booking,
//    and the appointment's own `source` says which door that was.

import type { ReportModule, ReportRow } from '@/lib/reports/types'
import { money, rangeToInstants, ratioToPercent, percent } from '@/lib/reports/types'
import { dateKeyInTimeZone } from '@/lib/time'

const ROW_LIMIT = 2000

const BILLABLE = new Set(['pending', 'confirmed', 'checked_in', 'completed'])

const STATUS_LABEL: Record<string, string> = {
  pending: 'Awaiting confirmation',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
}

export const pairDealsReport: ReportModule = {
  key: 'pair-deals',
  title: 'Pair deals',
  description:
    'Every half-off pairing: who redeemed it, what it gave away, and how many were upsold in the chair.',
  minRole: 'manager',
  filters: ['dateRange', 'location', 'provider'],

  async run(ctx) {
    const { startIso, endIso } = rangeToInstants(ctx.from, ctx.to, ctx.timeZone)

    let query = ctx.supabase
      .from('appointments')
      .select(
        'id, starts_at, status, source, client_id, guest_first_name, guest_last_name, profiles!appointments_client_id_fkey(first_name, last_name), appointment_services(id, name_snapshot, price_cents, full_price_cents, pair_discount_id, added_by)'
      )
      .gte('starts_at', startIso)
      .lt('starts_at', endIso)
      .order('starts_at', { ascending: false })
      .limit(ROW_LIMIT)

    if (ctx.providerId) query = query.eq('provider_id', ctx.providerId)
    if (ctx.locationId !== null) query = query.eq('location_id', ctx.locationId)

    const { data: appointments, error } = await query
    if (error) throw error

    // The staff who added lines in the chair, named once each.
    const staffIds = [
      ...new Set(
        (appointments ?? [])
          .flatMap((a) => a.appointment_services ?? [])
          .map((l) => l.added_by)
          .filter((id): id is string => id !== null)
      ),
    ]
    const { data: staff } = staffIds.length
      ? await ctx.supabase
          .from('profiles')
          .select('id, display_name, first_name, last_name')
          .in('id', staffIds)
      : { data: [] }
    const staffName = new Map(
      (staff ?? []).map((s) => [
        s.id,
        s.display_name ?? `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() ?? 'Staff',
      ])
    )

    const rows: ReportRow[] = []
    let redemptions = 0
    let inChair = 0
    let savedCents = 0
    let chargedCents = 0
    const clients = new Set<string>()

    for (const a of appointments ?? []) {
      const client = a.profiles as { first_name: string | null; last_name: string | null } | null
      const clientName =
        (client
          ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
          : `${a.guest_first_name ?? ''} ${a.guest_last_name ?? ''}`.trim()) || 'Guest'

      for (const l of a.appointment_services ?? []) {
        if (l.pair_discount_id === null) continue
        const full = l.full_price_cents ?? l.price_cents
        const saved = full - l.price_cents
        const billable = BILLABLE.has(a.status)
        const chair = l.added_by !== null

        if (billable) {
          redemptions += 1
          if (chair) inChair += 1
          savedCents += saved
          chargedCents += l.price_cents
          clients.add(a.client_id ?? `guest:${clientName}`)
        }

        rows.push({
          date: dateKeyInTimeZone(new Date(a.starts_at), ctx.timeZone),
          client: clientName,
          service: l.name_snapshot,
          list: full,
          charged: l.price_cents,
          saved,
          how: chair
            ? `In the chair — ${staffName.get(l.added_by!) ?? 'staff'}`
            : a.source === 'online'
              ? 'Paired at booking'
              : 'Paired by the desk',
          status: STATUS_LABEL[a.status] ?? a.status,
        })
      }
    }

    const notes = [
      'A redemption is a service line whose price a pair deal cut, counted on the day of the visit.',
      'Cancelled and no-show visits are listed but excluded from every figure — the discounted treatment never happened.',
    ]
    if ((appointments ?? []).length === ROW_LIMIT) {
      notes.push(
        `Only the most recent ${ROW_LIMIT.toLocaleString()} appointments in this window were scanned — narrow the range for the rest.`
      )
    }

    return {
      columns: [
        { key: 'date', label: 'Visit', format: 'date' },
        { key: 'client', label: 'Client' },
        { key: 'service', label: 'Service' },
        { key: 'how', label: 'How it was added' },
        { key: 'status', label: 'Status' },
        { key: 'list', label: 'List', format: 'money' },
        { key: 'charged', label: 'Charged', format: 'money', total: 'sum' },
        { key: 'saved', label: 'Client saved', format: 'money', total: 'sum' },
      ],
      rows,
      summary: [
        { label: 'Redemptions', value: redemptions.toLocaleString() },
        { label: 'Clients', value: clients.size.toLocaleString() },
        { label: 'Charged at the pair price', value: money(chargedCents) },
        { label: 'Given away', value: money(savedCents) },
        {
          label: 'Upsold in the chair',
          value: `${inChair.toLocaleString()} · ${percent(ratioToPercent(inChair, redemptions)) }`,
          tone: 'good',
        },
      ],
      notes,
    }
  },
}
