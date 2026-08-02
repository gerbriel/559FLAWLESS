/**
 * Sales tax — the report somebody files a CDTFA return from.
 *
 * Which is why it is built the way it is rather than the easy way. Four things
 * decide whether it is defensible:
 *
 *  1. `orders.tax_cents` is money held for the state. It is never revenue and
 *    never appears inside a taxable figure — it sits in its own column, and the
 *    identity that binds the report together is
 *      gross = exempt + delivery + non-taxable product + taxable + tax.
 *    That gross equals the Sales report's "Total taken" over the same range, and
 *    equals the sum of the Transaction Detail report. All three read the same
 *    `payments` rows through `loadLedger()`, so they cannot drift.
 *
 *  2. Services are not taxable in California. Every appointment payment is
 *    exempt; the taxable base is the product subtotal after discount, and
 *    separately stated delivery is broken out because a return asks for it
 *    separately.
 *
 *  3. Reported BY LOCATION, because California assesses by district.
 *    `orders.location_id` exists for exactly this reason — a second site in
 *    another district is the whole point of the column.
 *
 *  4. A refund reduces the base in the period the REFUND happened, not in the
 *    period of the original sale. A return already filed is not reopened; the
 *    credit is claimed on the next one. Refunds are negative `payments` rows and
 *    are bucketed by their own date, so this falls out of the ledger rather than
 *    being a special case somebody has to remember.
 *
 * The known limit, stated in `notes[]` on every run rather than buried here:
 * `sales_tax_rate()` returns ONE rate for the whole business. The per-location
 * split below is correct for what was actually collected, but a genuine
 * multi-district return also needs a per-district RATE, and the schema has
 * nowhere to put one.
 */

import type { ReportModule, ReportColumn, ReportContext, ReportResult } from '@/lib/reports/types'
import { formatMoney } from '@/lib/utils'
import { loadLedger, splitRetailPayment, type LedgerEntry } from '@/lib/reports/money'

interface TaxBucket {
  grossCents: number
  /** Services, packages, and anything else that is not a product sale. */
  exemptCents: number
  /** Separately stated delivery. Not taxable, but reported on its own line. */
  deliveryCents: number
  /** Product sales that carried no tax — the line an auditor asks about. */
  nonTaxableProductCents: number
  /** Product subtotal after discount on sales that were taxed. */
  taxableCents: number
  /** `orders.tax_cents`. The state's. */
  taxCents: number
  /** Clamped-total artefacts, carried so the identity stays exact. */
  residualCents: number
  saleCount: number
  refundCount: number
}

function emptyBucket(): TaxBucket {
  return {
    grossCents: 0,
    exemptCents: 0,
    deliveryCents: 0,
    nonTaxableProductCents: 0,
    taxableCents: 0,
    taxCents: 0,
    residualCents: 0,
    saleCount: 0,
    refundCount: 0,
  }
}

function add(bucket: TaxBucket, entry: LedgerEntry): void {
  bucket.grossCents += entry.amountCents
  if (entry.amountCents < 0) bucket.refundCount += 1
  else bucket.saleCount += 1

  if (entry.line === 'retail' && entry.order) {
    const split = splitRetailPayment(entry.amountCents, entry.order)
    bucket.deliveryCents += split.shippingCents
    bucket.taxCents += split.taxCents
    // Residual is a clamping artefact, not a sale of anything. It rides with
    // exempt so the columns still add up to gross exactly.
    bucket.residualCents += split.residualCents
    bucket.exemptCents += split.residualCents

    // A sale is taxable when tax was assessed on it. Classifying on the ORDER
    // rather than on the split keeps a partial refund on the same side of the
    // line as the sale it reverses.
    if (entry.order.tax_cents > 0) bucket.taxableCents += split.baseCents
    else bucket.nonTaxableProductCents += split.baseCents
  } else {
    // Services, deposits, packages, gift cards, and anything unattributed.
    // None of it is a taxable sale of tangible personal property.
    bucket.exemptCents += entry.amountCents
  }
}

function merge(into: TaxBucket, from: TaxBucket): void {
  into.grossCents += from.grossCents
  into.exemptCents += from.exemptCents
  into.deliveryCents += from.deliveryCents
  into.nonTaxableProductCents += from.nonTaxableProductCents
  into.taxableCents += from.taxableCents
  into.taxCents += from.taxCents
  into.residualCents += from.residualCents
  into.saleCount += from.saleCount
  into.refundCount += from.refundCount
}

function row(location: string, period: string, b: TaxBucket) {
  return {
    location,
    period,
    gross_cents: b.grossCents,
    exempt_cents: b.exemptCents,
    delivery_cents: b.deliveryCents,
    nontaxable_product_cents: b.nonTaxableProductCents,
    taxable_cents: b.taxableCents,
    tax_cents: b.taxCents,
    // A ratio, not money — the one place a fraction is the right type. Null
    // rather than zero when there is no base, because 0% would be a claim.
    effective_rate: b.taxableCents !== 0 ? b.taxCents / b.taxableCents : null,
  }
}

export const salesTaxReport: ReportModule = {
  key: 'sales-tax',
  title: 'Sales tax',
  description:
    'Taxable base, exempt sales and tax collected, by period and by district. What a CDTFA return is filed from.',
  minRole: 'manager',
  filters: ['dateRange', 'location'],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const ledger = await loadLedger(ctx)
    const entries = ledger.entries
    const notes: string[] = []

    const configuredRate = await ctx.supabase.rpc('sales_tax_rate')
    const rate = typeof configuredRate.data === 'number' ? configuredRate.data : null

    const columns: ReportColumn[] = [
      { key: 'location', label: 'Site', align: 'left', format: 'text' },
      { key: 'period', label: 'Period', align: 'left', format: 'text' },
      { key: 'gross_cents', label: 'Gross receipts', align: 'right', format: 'money', total: 'sum' },
      { key: 'exempt_cents', label: 'Exempt (services)', align: 'right', format: 'money', total: 'sum' },
      { key: 'delivery_cents', label: 'Delivery', align: 'right', format: 'money', total: 'sum' },
      {
        key: 'nontaxable_product_cents',
        label: 'Product, untaxed',
        align: 'right',
        format: 'money',
        total: 'sum',
      },
      { key: 'taxable_cents', label: 'Taxable sales', align: 'right', format: 'money', total: 'sum' },
      { key: 'tax_cents', label: 'Tax collected', align: 'right', format: 'money', total: 'sum' },
      { key: 'effective_rate', label: 'Effective rate', align: 'right', format: 'percent' },
    ]

    // ── Per site, per month ───────────────────────────────────
    // Month rather than day: a return is filed for a month or a quarter, and a
    // daily grid is 90 rows nobody transcribes.
    const cells = new Map<string, { locationId: number | null; period: string; bucket: TaxBucket }>()
    const byLocation = new Map<number | null, TaxBucket>()
    const byPeriod = new Map<string, TaxBucket>()
    const grand = emptyBucket()

    for (const e of entries) {
      const cellKey = `${e.locationId ?? 'none'}|${e.monthKey}`
      let cell = cells.get(cellKey)
      if (!cell) {
        cell = { locationId: e.locationId, period: e.monthKey, bucket: emptyBucket() }
        cells.set(cellKey, cell)
      }
      add(cell.bucket, e)

      let loc = byLocation.get(e.locationId)
      if (!loc) {
        loc = emptyBucket()
        byLocation.set(e.locationId, loc)
      }
      add(loc, e)

      let period = byPeriod.get(e.monthKey)
      if (!period) {
        period = emptyBucket()
        byPeriod.set(e.monthKey, period)
      }
      add(period, e)

      add(grand, e)
    }

    const rows = Array.from(cells.values())
      .sort((a, b) =>
        a.period === b.period
          ? ledger.locationName(a.locationId).localeCompare(ledger.locationName(b.locationId))
          : a.period.localeCompare(b.period)
      )
      .map((c) => row(ledger.locationName(c.locationId), c.period, c.bucket))

    const locationRows = Array.from(byLocation.entries())
      .sort((a, b) => b[1].taxableCents - a[1].taxableCents)
      .map(([id, bucket]) => row(ledger.locationName(id), 'All periods', bucket))

    const periodRows = Array.from(byPeriod.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([period, bucket]) => row('All sites', period, bucket))

    // The identity the whole report rests on, asserted rather than assumed. If
    // it ever fails the report says so instead of quietly filing a wrong return.
    const identity =
      grand.exemptCents +
      grand.deliveryCents +
      grand.nonTaxableProductCents +
      grand.taxableCents +
      grand.taxCents
    const identityHolds = identity === grand.grossCents

    // ── Notes ─────────────────────────────────────────────────
    notes.push(
      'THE KNOWN LIMIT: `sales_tax_rate()` holds ONE rate for the whole business. The per-site ' +
        'columns below are correct for what was actually collected, but California assesses by ' +
        'district — a genuine multi-district return also needs a per-location RATE, and the schema ' +
        'has nowhere to store one. Until it does, treat a second site in another district as a ' +
        'manual adjustment.'
    )
    if (rate != null) {
      notes.push(
        `Configured rate: ${(rate * 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}% ` +
          '(site setting `sales_tax_rate`, Fresno County combined 8.35% by default).'
      )
    }
    notes.push(
      'A REFUND REDUCES THE BASE IN THE PERIOD THE REFUND HAPPENED, not in the period of the ' +
        'original sale. A return already filed is not reopened — the credit is taken on the next ' +
        'one. Refunds are negative `payments` rows and are bucketed by their own date, so a ' +
        'January sale refunded in March reduces March’s taxable base.'
    )
    notes.push(
      'A partial refund is apportioned across base, tax and delivery in the same proportion as the ' +
        'original sale, in integer cents that sum exactly to the refund.'
    )
    notes.push(
      'Tax collected is `orders.tax_cents` and is NEVER counted as revenue. Gross receipts is what ' +
        'hit the bank and therefore includes it; the Sales report’s "Total taken" is the same number.'
    )
    notes.push(
      'Services are exempt in California, so every appointment payment — deposit, balance, ' +
        'package — sits in the exempt column. Separately stated delivery is exempt too and is ' +
        'broken out because a return asks for it separately.'
    )
    notes.push(
      'A sale counts as taxable when tax was assessed on it (`orders.tax_cents > 0`). Product sold ' +
        'with no tax recorded is shown in its own column rather than being assumed exempt.'
    )
    if (grand.nonTaxableProductCents !== 0) {
      notes.push(
        `${formatMoney(grand.nonTaxableProductCents)} of product moved with no sales tax recorded. ` +
          'That is either a legitimate exempt sale or a till that was misconfigured — worth ' +
          'resolving before filing.'
      )
    }
    if (grand.residualCents !== 0) {
      notes.push(
        `${formatMoney(grand.residualCents)} could not be explained by subtotal − discount + tax + ` +
          'delivery, because `order_item_recalc()` clamps a total at zero when a discount exceeds ' +
          'the subtotal. It is carried in the exempt column so the columns still add to gross.'
      )
    }
    notes.push(
      `Period boundaries are studio-local via the location’s IANA zone (${ctx.timeZone}). An 11pm ` +
        'sale on the 31st is in that month’s return.'
    )
    if (!identityHolds) {
      notes.push(
        `RECONCILIATION FAILED: exempt + delivery + untaxed product + taxable + tax = ` +
          `${formatMoney(identity)} but gross receipts are ${formatMoney(grand.grossCents)}. ` +
          'Do not file from this. Report it.'
      )
    }
    if (ctx.locationId != null && ledger.unattributedExcluded > 0) {
      notes.push(
        `${ledger.unattributedExcluded} payment(s) have no site and are excluded from a ` +
          'single-site view. Run across every location before filing.'
      )
    }
    if (ledger.foreignZones.length > 0) {
      notes.push(
        `Another active site keeps its clock in ${ledger.foreignZones.join(', ')}. Period ` +
          `boundaries here use ${ctx.timeZone}; file that site from its own filtered run.`
      )
    }
    if (ledger.truncated) {
      notes.push('TRUNCATED — the row ceiling was reached. These totals are incomplete.')
    }

    return {
      columns,
      rows,
      summary: [
        { label: 'Gross receipts', value: formatMoney(grand.grossCents) },
        { label: 'Exempt (services)', value: formatMoney(grand.exemptCents) },
        { label: 'Taxable sales', value: formatMoney(grand.taxableCents) },
        { label: 'Tax collected', value: formatMoney(grand.taxCents), tone: 'warn' },
        {
          label: 'Reconciles to Sales',
          value: identityHolds ? 'Yes' : 'NO — do not file',
          tone: identityHolds ? 'good' : 'warn',
        },
      ],
      sections: [
        { title: 'Totals by site (district)', rows: locationRows },
        { title: 'Totals by period', rows: periodRows },
      ],
      notes,
    }
  },
}
