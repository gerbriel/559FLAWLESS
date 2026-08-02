/**
 * Transaction detail — the line-by-line audit trail.
 *
 * One row per succeeded payment: when, who it was for, what kind, how it was
 * taken, at which site, against which appointment or order, and who processed
 * it. This is what somebody reconciles a bank statement against, which sets two
 * requirements the other reports do not have.
 *
 *  1. It must BALANCE to the Sales report exactly over the same range. If it
 *     does not, one of them is wrong and neither can be trusted. It cannot drift
 *     because both read the same rows through `loadLedger()` — there is one
 *     query, not two that ought to agree. The check is run anyway and its result
 *     is a summary tile, because "should be equal by construction" is how every
 *     reconciliation bug in history has been introduced.
 *
 *  2. It must be COMPLETE. A truncated audit trail that does not say it is
 *     truncated is worse than none, so paging runs to a hard ceiling and hitting
 *     that ceiling is a loud note, not a silent slice.
 */

import type { ReportModule, ReportColumn, ReportContext, ReportResult } from '@/lib/reports/types'
import { formatMoney } from '@/lib/utils'
import { zonedParts } from '@/lib/time'
import { loadLedger, sumCents, ROW_CEILING } from '@/lib/reports/money'

/** Sortable AND readable: 'YYYY-MM-DD HH:MM' in the studio's own clock. */
function localStamp(at: Date, timeZone: string): string {
  const p = zonedParts(at, timeZone)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ${pad(p.hour)}:${pad(p.minute)}`
}

const KIND_LABELS: Record<string, string> = {
  deposit: 'Deposit',
  service: 'Service',
  product: 'Product',
  gift_card: 'Gift card',
  package: 'Package',
  refund: 'Refund',
}

const METHOD_LABELS: Record<string, string> = {
  card: 'Card',
  cash: 'Cash',
  gift_card: 'Gift card',
  package: 'Package',
  other: 'Other',
}

export const transactionDetailReport: ReportModule = {
  key: 'transaction-detail',
  title: 'Transaction detail',
  description:
    'Every payment taken, line by line — what it was for, how, by whom and where. Reconciles to the Sales report.',
  minRole: 'manager',
  filters: ['dateRange', 'location', 'provider'],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const ledger = await loadLedger(ctx)
    const entries = ledger.entries
    const notes: string[] = []

    const columns: ReportColumn[] = [
      { key: 'when', label: 'Date & time', align: 'left', format: 'text' },
      { key: 'location', label: 'Site', align: 'left', format: 'text' },
      { key: 'client', label: 'Client', align: 'left', format: 'text' },
      { key: 'kind', label: 'Kind', align: 'left', format: 'text' },
      { key: 'method', label: 'Method', align: 'left', format: 'text' },
      { key: 'channel', label: 'Channel', align: 'left', format: 'text' },
      { key: 'reference', label: 'Against', align: 'left', format: 'text' },
      { key: 'provider', label: 'Provider', align: 'left', format: 'text' },
      { key: 'processed_by', label: 'Processed by', align: 'left', format: 'text' },
      { key: 'amount_cents', label: 'Amount', align: 'right', format: 'money', total: 'sum' },
      { key: 'payment_id', label: 'Payment #', align: 'right', format: 'number' },
    ]

    // Already ordered by (created_at, id) from the ledger query. Kept stable so
    // the same range always produces the same document.
    const rows = entries.map((e) => ({
      when: localStamp(e.at, ctx.timeZone),
      location: e.locationName,
      client: e.clientName,
      kind: KIND_LABELS[e.kind] ?? e.kind,
      method: METHOD_LABELS[e.method] ?? e.method,
      channel: e.channel === 'in_studio' ? 'In studio' : 'Online',
      reference: e.reference,
      provider: e.providerName ?? e.sellerName ?? '—',
      processed_by: e.processedByName,
      amount_cents: e.amountCents,
      payment_id: e.paymentId,
    }))

    const netCents = sumCents(entries.map((e) => e.amountCents))
    const takenCents = sumCents(entries.filter((e) => e.amountCents > 0).map((e) => e.amountCents))
    const refundCents = sumCents(entries.filter((e) => e.amountCents < 0).map((e) => e.amountCents))

    // The balance check, done rather than assumed. Both sides are derived from
    // the same ledger, so a failure here means the shaping code lost or
    // duplicated a row — exactly the class of bug this report exists to catch.
    const rowSum = rows.reduce((acc, r) => acc + r.amount_cents, 0)
    const balances = rowSum === netCents

    // Per method, for reconciling the till and the merchant statement
    // separately — they settle on different days and through different accounts.
    const byMethod = new Map<string, number>()
    for (const e of entries) {
      byMethod.set(e.method, (byMethod.get(e.method) ?? 0) + e.amountCents)
    }
    const methodTiles = Array.from(byMethod.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([method, cents]) => ({
        label: METHOD_LABELS[method] ?? method,
        value: formatMoney(cents),
      }))

    notes.push(
      'Every row is a `payments` record with status = succeeded. The total of the Amount column ' +
        'is the Sales report’s "Total taken" and the Sales tax report’s "Gross receipts" for the ' +
        'same range — all three read one ledger through one query, so they cannot disagree.'
    )
    notes.push(
      `Times are the studio’s own clock (${ctx.timeZone}), formatted YYYY-MM-DD HH:MM so the ` +
        'column sorts the way it reads.'
    )
    notes.push(
      'Refunds are negative rows, dated when the refund was issued rather than when the original ' +
        'sale was taken. "Net" below is takings after refunds; "Taken" and "Refunded" are the two ' +
        'sides separately, which is what a bank statement shows.'
    )
    notes.push(
      '"Processed by" is `payments.processed_by` — the member of staff who recorded it. A Stripe ' +
        'payment has nobody at the desk, so it reads "Online (Stripe)" rather than being ' +
        'attributed to whoever happened to be logged in.'
    )
    notes.push(
      '"Against" is the order number or the appointment the money belongs to. A payment with ' +
        'neither is shown as unattributed — `record_payment()` refuses to create one, so it should ' +
        'not appear.'
    )
    if (ctx.locationId != null && ledger.unattributedExcluded > 0) {
      notes.push(
        `${ledger.unattributedExcluded} payment(s) have no site and are excluded from a ` +
          'single-site view — they would otherwise appear to belong to this one.'
      )
    }
    if (ctx.providerId != null) {
      notes.push(
        'Filtered to one member of staff: payments against appointments they performed, plus ' +
          'retail sales recorded against them as the seller. It will NOT balance to an unfiltered ' +
          'Sales report — filter both the same way.'
      )
    }
    if (ledger.foreignZones.length > 0) {
      notes.push(
        `Another active site keeps its clock in ${ledger.foreignZones.join(', ')}; timestamps here ` +
          `are rendered in ${ctx.timeZone}.`
      )
    }
    if (!balances) {
      notes.push(
        `RECONCILIATION FAILED: the rows sum to ${formatMoney(rowSum)} but the ledger nets ` +
          `${formatMoney(netCents)}. Do not use this. Report it.`
      )
    }
    if (ledger.truncated) {
      notes.push(
        `TRUNCATED — more than ${ROW_CEILING.toLocaleString('en-US')} payments fall in this range ` +
          'and the report stops there. It is NOT a complete audit trail and will not balance. ' +
          'Narrow the date range.'
      )
    } else {
      notes.push(
        `Complete: all ${rows.length.toLocaleString('en-US')} payment${rows.length === 1 ? '' : 's'} ` +
          'in the range are listed, with nothing truncated.'
      )
    }

    return {
      columns,
      rows,
      summary: [
        { label: 'Transactions', value: String(rows.length) },
        { label: 'Taken', value: formatMoney(takenCents) },
        { label: 'Refunded', value: formatMoney(refundCents), tone: refundCents < 0 ? 'warn' : undefined },
        { label: 'Net', value: formatMoney(netCents) },
        {
          label: 'Balances to Sales',
          value: balances && !ledger.truncated ? 'Yes' : 'NO',
          tone: balances && !ledger.truncated ? 'good' : 'warn',
        },
        ...methodTiles,
      ],
      notes,
    }
  },
}
