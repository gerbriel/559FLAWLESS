/**
 * Sales — what the studio actually took over the period.
 *
 * The headline number is money TAKEN, not money billed: every figure here is a
 * sum over `payments` with `status = 'succeeded'`, read through `loadLedger()`.
 * A completed appointment nobody has paid for contributes nothing, and a refund
 * is a negative row that nets out on the day it was issued.
 *
 * Service revenue and retail revenue are kept apart on purpose. They are two
 * businesses with different margins sharing one till — a month where takings
 * held up because product moved is a different month from one where the chair
 * was full, and a single "revenue" line hides which happened.
 *
 * Sales tax is shown, never counted as revenue. `total_cents` is gross into the
 * bank and therefore includes it; `services_cents` and `retail_cents` are net of
 * it. That is also the join to the Sales Tax report: over the same range,
 *   sales.total = tax.gross_receipts
 * and both equal the sum of the Transaction Detail report.
 */

import type { ReportModule, ReportColumn, ReportContext, ReportResult } from '@/lib/reports/types'
import { formatMoney } from '@/lib/utils'
import {
  dayKeys,
  groupBy,
  loadLedger,
  splitRetailPayment,
  splitServicePayment,
  sumCents,
  type LedgerEntry,
} from '@/lib/reports/money'

/** One row of the table, whichever breakdown it belongs to. */
interface Bucket {
  transactions: number
  serviceCents: number
  retailCents: number
  taxCents: number
  otherCents: number
}

function emptyBucket(): Bucket {
  return { transactions: 0, serviceCents: 0, retailCents: 0, taxCents: 0, otherCents: 0 }
}

/**
 * Fold one payment into a bucket.
 *
 * Retail is split into base + delivery (revenue) and tax (the state's), so the
 * three amounts still sum to the payment and nothing is lost or double-counted.
 */
function add(bucket: Bucket, entry: LedgerEntry): void {
  bucket.transactions += 1
  if (entry.line === 'retail' && entry.order) {
    const split = splitRetailPayment(entry.amountCents, entry.order)
    bucket.retailCents += split.baseCents + split.shippingCents + split.residualCents
    bucket.taxCents += split.taxCents
  } else if (entry.line === 'service') {
    bucket.serviceCents += entry.amountCents
  } else {
    bucket.otherCents += entry.amountCents
  }
}

function total(bucket: Bucket): number {
  return bucket.serviceCents + bucket.retailCents + bucket.taxCents + bucket.otherCents
}

function row(label: string, bucket: Bucket, withOther: boolean) {
  const base: Record<string, string | number | null> = {
    label,
    transactions: bucket.transactions,
    services_cents: bucket.serviceCents,
    retail_cents: bucket.retailCents,
    tax_cents: bucket.taxCents,
    total_cents: total(bucket),
  }
  if (withOther) base.other_cents = bucket.otherCents
  return base
}

export const salesReport: ReportModule = {
  key: 'sales',
  title: 'Sales',
  description:
    'What the studio took, by day, service, provider, channel and site. Money received, not money billed.',
  minRole: 'manager',
  filters: ['dateRange', 'location', 'provider'],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const ledger = await loadLedger(ctx)
    const entries = ledger.entries
    const notes: string[] = []

    const hasOther = entries.some((e) => e.line === 'unattributed')

    const columns: ReportColumn[] = [
      { key: 'label', label: 'Date / breakdown', align: 'left', format: 'text' },
      { key: 'transactions', label: 'Transactions', align: 'right', format: 'number', total: 'sum' },
      { key: 'services_cents', label: 'Services', align: 'right', format: 'money', total: 'sum' },
      { key: 'retail_cents', label: 'Retail', align: 'right', format: 'money', total: 'sum' },
      { key: 'tax_cents', label: 'Sales tax held', align: 'right', format: 'money', total: 'sum' },
      ...(hasOther
        ? ([{ key: 'other_cents', label: 'Unattributed', align: 'right', format: 'money', total: 'sum' }] as ReportColumn[])
        : []),
      { key: 'total_cents', label: 'Total taken', align: 'right', format: 'money', total: 'sum' },
    ]

    // ── By day ────────────────────────────────────────────────
    // Every calendar day in the range, including the ones that took nothing —
    // a gap in a takings series should be visible as a zero, not as a missing
    // row that reads as "no data".
    const byDay = groupBy(entries, (e) => e.dayKey)
    const rows = dayKeys(ctx.from, ctx.to).map((day) => {
      const bucket = emptyBucket()
      for (const e of byDay.get(day) ?? []) add(bucket, e)
      return row(day, bucket, hasOther)
    })

    // ── Totals ────────────────────────────────────────────────
    const grand = emptyBucket()
    for (const e of entries) add(grand, e)

    // ── By service ────────────────────────────────────────────
    // One appointment payment covers every line on that appointment, so it is
    // apportioned across them by the price frozen at booking. Retail has no
    // service, so it is excluded here rather than lumped under a fake name.
    const serviceTotals = new Map<string, { name: string; cents: number; count: number }>()
    for (const e of entries) {
      if (e.line !== 'service') continue
      for (const share of splitServicePayment(e)) {
        const cur = serviceTotals.get(share.serviceKey) ?? {
          name: share.serviceName,
          cents: 0,
          count: 0,
        }
        cur.cents += share.amountCents
        cur.count += 1
        serviceTotals.set(share.serviceKey, cur)
      }
    }
    const serviceRows = Array.from(serviceTotals.values())
      .sort((a, b) => b.cents - a.cents)
      .map((s) => {
        const bucket = emptyBucket()
        bucket.transactions = s.count
        bucket.serviceCents = s.cents
        return row(s.name, bucket, hasOther)
      })

    // ── By provider ───────────────────────────────────────────
    // Service money follows the esthetician who performed the work; retail
    // follows whoever rang it up. An online order has neither.
    const byPerson = groupBy(entries, (e) => {
      if (e.providerName) return e.providerName
      if (e.sellerName) return e.sellerName
      return e.channel === 'online' ? 'Online — no staff member' : 'Not recorded'
    })
    const providerRows = Array.from(byPerson.entries())
      .map(([name, list]) => {
        const bucket = emptyBucket()
        for (const e of list) add(bucket, e)
        return { name, bucket }
      })
      .sort((a, b) => total(b.bucket) - total(a.bucket))
      .map(({ name, bucket }) => row(name, bucket, hasOther))

    // ── By channel ────────────────────────────────────────────
    const byChannel = groupBy(entries, (e) => e.channel)
    const channelRows = (['in_studio', 'online'] as const).map((channel) => {
      const bucket = emptyBucket()
      for (const e of byChannel.get(channel) ?? []) add(bucket, e)
      return row(channel === 'in_studio' ? 'In studio' : 'Online', bucket, hasOther)
    })

    // ── By location ───────────────────────────────────────────
    const byLocation = groupBy(entries, (e) => e.locationId)
    const locationRows = Array.from(byLocation.entries())
      .map(([id, list]) => {
        const bucket = emptyBucket()
        for (const e of list) add(bucket, e)
        return { name: ledger.locationName(id), bucket }
      })
      .sort((a, b) => total(b.bucket) - total(a.bucket))
      .map(({ name, bucket }) => row(name, bucket, hasOther))

    // ── Average ticket ────────────────────────────────────────
    // Denominator stated because it has to be: a "sale" is one appointment or
    // one order that took money in this period, NOT one payment row. A deposit
    // online and the balance in the room are one visit and one ticket, and
    // counting them as two would halve the figure.
    const saleKeys = new Set<string>()
    for (const e of entries) {
      if (e.kind === 'refund' || e.amountCents < 0) continue
      if (e.appointmentId) saleKeys.add(`a:${e.appointmentId}`)
      else if (e.orderId != null) saleKeys.add(`o:${e.orderId}`)
      else saleKeys.add(`p:${e.paymentId}`)
    }
    const netTaken = total(grand)
    const averageTicket = saleKeys.size > 0 ? Math.round(netTaken / saleKeys.size) : 0

    const refunds = entries.filter((e) => e.amountCents < 0)
    const refundCents = sumCents(refunds.map((e) => e.amountCents))

    // ── Notes ─────────────────────────────────────────────────
    notes.push(
      'Revenue is money taken: every figure sums `payments` rows with status = succeeded. ' +
        'A completed appointment that has not been paid for contributes nothing until it is.'
    )
    notes.push(
      'Sales tax is shown on its own line and is NOT part of Services or Retail — it is the ' +
        'state’s money being held. "Total taken" is gross into the bank and does include it.'
    )
    notes.push(
      `Average ticket = total taken ÷ ${saleKeys.size} sale${saleKeys.size === 1 ? '' : 's'}, where ` +
        'a sale is one appointment or one order that took money in this period. A deposit and its ' +
        'balance are one ticket, not two.'
    )
    notes.push(
      'Channel is where the money was taken, not where the work happened: an order states it ' +
        'outright (in_store / online); an appointment payment counts as online exactly when Stripe ' +
        'handled it, which is what separates a booking deposit from cash at the desk.'
    )
    notes.push(
      'Days are studio-local, resolved through the location’s IANA zone — an 11pm sale on the ' +
        '31st belongs to the 31st.'
    )
    if (refunds.length > 0) {
      notes.push(
        `${refunds.length} refund${refunds.length === 1 ? '' : 's'} totalling ` +
          `${formatMoney(refundCents)} net out on the day each was issued, not against the ` +
          'original sale’s day.'
      )
    }
    if (hasOther) {
      notes.push(
        'Some payments are attached to neither an appointment nor an order. They are shown under ' +
          '"Unattributed" rather than being folded into either business — that combination should ' +
          'not occur and is worth chasing.'
      )
    }
    if (ctx.locationId != null && ledger.unattributedExcluded > 0) {
      notes.push(
        `${ledger.unattributedExcluded} payment(s) have no site (no order and no appointment) and ` +
          'are therefore excluded from a single-location view. Run with every location to see them.'
      )
    }
    if (ctx.providerId != null) {
      notes.push(
        'Filtered to one member of staff: appointments they performed, plus retail sales recorded ' +
          'against them as the seller.'
      )
    }
    if (ledger.foreignZones.length > 0) {
      notes.push(
        `Day boundaries use ${ctx.timeZone}. Another active site keeps its clock in ` +
          `${ledger.foreignZones.join(', ')}, so its late-evening sales may fall either side of a ` +
          'boundary here. Filter to that site to report it on its own clock.'
      )
    }
    if (ledger.truncated) {
      notes.push(
        'TRUNCATED — the row ceiling was reached and these totals are incomplete. Narrow the date ' +
          'range.'
      )
    }

    return {
      columns,
      rows,
      summary: [
        { label: 'Total taken', value: formatMoney(netTaken) },
        { label: 'Service revenue', value: formatMoney(grand.serviceCents) },
        { label: 'Retail revenue', value: formatMoney(grand.retailCents) },
        { label: 'Sales tax held', value: formatMoney(grand.taxCents), tone: 'warn' },
        { label: 'Average ticket', value: formatMoney(averageTicket) },
        { label: 'Transactions', value: String(grand.transactions) },
      ],
      sections: [
        { title: 'By service', rows: serviceRows },
        { title: 'By provider', rows: providerRows },
        { title: 'By channel', rows: channelRows },
        { title: 'By location', rows: locationRows },
      ],
      notes,
    }
  },
}
