/**
 * Expenses — what went out, and what is left after it.
 *
 * Migration 033 already ships the two functions this needs, and they are used
 * rather than reimplemented: `expense_totals(from, to)` for the per-category
 * breakdown and `profit_summary(from, to)` for the profit arithmetic. That is
 * not deference for its own sake. `profit_summary()` encodes the one genuinely
 * subtle rule in the money model — a case of wax bought in March is a cash
 * outflow in March, but its COST OF GOODS lands in whichever month the treatment
 * that consumed it happened, and that second figure is already derivable from
 * `order_items × products.cost_cents`. Add both into one "expenses" total and
 * the stock is counted twice. `expense_categories.is_cogs` is what keeps them
 * apart; the net line uses derived COGS and reports the purchase beside it, for
 * cash flow, never summed in. Rewriting that arithmetic here would give us two
 * copies of it and one chance to get it wrong.
 *
 * WHERE THIS REPORT DISAGREES WITH `profit_summary()`, stated rather than
 * quietly worked around — see the notes emitted on every run:
 *
 *   • `profit_summary()` recognises SERVICE revenue as `sum(appointments
 *     .total_cents) where status = 'completed'`. That is money BILLED. A
 *     completed appointment nobody paid for counts. The Sales report — and the
 *     rule the reports are built on — counts money TAKEN, from `payments`. The
 *     two figures are both meaningful and they are not the same, so both are
 *     shown, each labelled with its basis.
 *   • Its product revenue is order-driven and dated by `paid_at`, so a fully
 *     refunded order disappears from the ORIGINAL period rather than the refund
 *     landing in the period it happened. The Sales tax report deliberately does
 *     the opposite.
 *   • It reads `booking_settings.timezone`, not `locations.timezone`, and takes
 *     no location argument.
 *
 * None of that makes it wrong for what it is for. It makes it a billed-basis
 * P&L, and this report says so on its face.
 */

import type { ReportModule, ReportColumn, ReportContext, ReportResult } from '@/lib/reports/types'
import { formatMoney } from '@/lib/utils'
import { monthLabelForDateKey } from '@/lib/time'
import { loadLedger, splitRetailPayment, sumCents } from '@/lib/reports/money'

type ExpenseRow = {
  id: number
  incurred_on: string
  amount_cents: number
  category_id: number
  description: string
  vendor_id: number | null
  vendor_name: string | null
  payment_method: string
  is_tax_deductible: boolean
  recurring_id: number | null
}

interface Bucket {
  entries: number
  amountCents: number
  deductibleCents: number
  nonDeductibleCents: number
}

function emptyBucket(): Bucket {
  return { entries: 0, amountCents: 0, deductibleCents: 0, nonDeductibleCents: 0 }
}

function add(bucket: Bucket, row: ExpenseRow): void {
  bucket.entries += 1
  bucket.amountCents += row.amount_cents
  if (row.is_tax_deductible) bucket.deductibleCents += row.amount_cents
  else bucket.nonDeductibleCents += row.amount_cents
}

function shape(label: string, kind: string | null, bucket: Bucket) {
  return {
    label,
    kind,
    entries: bucket.entries,
    amount_cents: bucket.amountCents,
    deductible_cents: bucket.deductibleCents,
    nondeductible_cents: bucket.nonDeductibleCents,
  }
}

export const expensesReport: ReportModule = {
  key: 'expenses',
  title: 'Expenses',
  description:
    'What went out, by category, vendor and month — deductible and recurring split out — and what is left after it.',
  minRole: 'manager',
  // No `location` filter: `expenses` carries no `location_id`. Rent, insurance
  // and a wholesale account are terms of the BUSINESS, not facts about a
  // building, and 032 left them out of the location split on purpose. Offering
  // the filter would imply an attribution the data cannot make.
  filters: ['dateRange'],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const db = ctx.supabase
    const notes: string[] = []

    // ── The two functions 033 ships ───────────────────────────
    const [totalsResult, profitResult] = await Promise.all([
      db.rpc('expense_totals', { p_from: ctx.from, p_to: ctx.to }),
      db.rpc('profit_summary', { p_from: ctx.from, p_to: ctx.to }),
    ])
    if (totalsResult.error) throw new Error(totalsResult.error.message)
    if (profitResult.error) throw new Error(profitResult.error.message)

    const categoryTotals = totalsResult.data ?? []
    // Both helpers gate on `is_manager()` in their own body, so a caller who is
    // not one gets zero rows rather than an error.
    const profit = (profitResult.data ?? [])[0] ?? null

    // ── The rows behind them ──────────────────────────────────
    // `expense_totals()` gives category and cash out; the deductible, vendor,
    // month and recurring splits are not in its shape, so the rows are read
    // directly and cross-checked against it below.
    const { data: expenseData, error: expenseError } = await db
      .from('expenses')
      .select(
        'id, incurred_on, amount_cents, category_id, description, vendor_id, vendor_name, payment_method, is_tax_deductible, recurring_id'
      )
      .gte('incurred_on', ctx.from)
      .lte('incurred_on', ctx.to)
      .order('incurred_on', { ascending: true })
    if (expenseError) throw new Error(expenseError.message)
    const expenses = (expenseData ?? []) as ExpenseRow[]

    const { data: categoryData, error: categoryError } = await db
      .from('expense_categories')
      .select('id, name, slug, is_cogs, sort_order')
      .order('sort_order', { ascending: true })
    if (categoryError) throw new Error(categoryError.message)
    const categoryById = new Map((categoryData ?? []).map((c) => [c.id, c]))

    const vendorIds = Array.from(
      new Set(expenses.map((e) => e.vendor_id).filter((v): v is number => v != null))
    )
    let vendorById = new Map<number, string>()
    if (vendorIds.length > 0) {
      const { data: vendorData, error: vendorError } = await db
        .from('vendors')
        .select('id, name')
        .in('id', vendorIds)
      if (vendorError) throw new Error(vendorError.message)
      vendorById = new Map((vendorData ?? []).map((v) => [v.id, v.name]))
    }

    const columns: ReportColumn[] = [
      { key: 'label', label: 'Category / group', align: 'left', format: 'text' },
      { key: 'kind', label: 'Type', align: 'left', format: 'text' },
      { key: 'entries', label: 'Entries', align: 'right', format: 'number', total: 'sum' },
      { key: 'amount_cents', label: 'Amount', align: 'right', format: 'money', total: 'sum' },
      { key: 'deductible_cents', label: 'Deductible', align: 'right', format: 'money', total: 'sum' },
      {
        key: 'nondeductible_cents',
        label: 'Not deductible',
        align: 'right',
        format: 'money',
        total: 'sum',
      },
    ]

    // ── By category, from expense_totals() ────────────────────
    const deductibleByCategory = new Map<number, Bucket>()
    for (const e of expenses) {
      let bucket = deductibleByCategory.get(e.category_id)
      if (!bucket) {
        bucket = emptyBucket()
        deductibleByCategory.set(e.category_id, bucket)
      }
      add(bucket, e)
    }

    const rows = categoryTotals.map((t) => {
      const split = deductibleByCategory.get(t.category_id) ?? emptyBucket()
      return {
        label: t.category_name,
        kind: t.is_cogs ? 'Stock (COGS)' : 'Operating',
        entries: Number(t.entry_count),
        // The cash figure is expense_totals()'s, not ours.
        amount_cents: Number(t.total_cents),
        deductible_cents: split.deductibleCents,
        nondeductible_cents: split.nonDeductibleCents,
      }
    })

    // ── By vendor ─────────────────────────────────────────────
    const byVendor = new Map<string, Bucket>()
    for (const e of expenses) {
      // A real supplier has a `vendors` row; a one-off contractor or the corner
      // shop just has a name, and 033 says that is fine. Both are grouped here.
      const name =
        (e.vendor_id != null ? vendorById.get(e.vendor_id) : null) ??
        e.vendor_name ??
        'Not recorded'
      let bucket = byVendor.get(name)
      if (!bucket) {
        bucket = emptyBucket()
        byVendor.set(name, bucket)
      }
      add(bucket, e)
    }
    const vendorRows = Array.from(byVendor.entries())
      .sort((a, b) => b[1].amountCents - a[1].amountCents)
      .map(([name, bucket]) => shape(name, null, bucket))

    // ── By month ──────────────────────────────────────────────
    // `incurred_on` is a DATE, deliberately — an expense has no time of day, so
    // the month is a slice of the key and never a timezone question.
    const byMonth = new Map<string, Bucket>()
    for (const e of expenses) {
      const key = e.incurred_on.slice(0, 7)
      let bucket = byMonth.get(key)
      if (!bucket) {
        bucket = emptyBucket()
        byMonth.set(key, bucket)
      }
      add(bucket, e)
    }
    const monthRows = Array.from(byMonth.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, bucket]) => shape(monthLabelForDateKey(`${key}-01`), null, bucket))

    // ── Recurring vs one-off ──────────────────────────────────
    const recurring = emptyBucket()
    const oneOff = emptyBucket()
    for (const e of expenses) add(e.recurring_id != null ? recurring : oneOff, e)

    // ── Stock vs operating ────────────────────────────────────
    const stock = emptyBucket()
    const operating = emptyBucket()
    for (const e of expenses) {
      add(categoryById.get(e.category_id)?.is_cogs ? stock : operating, e)
    }

    // ── Totals ────────────────────────────────────────────────
    const allOut = sumCents(expenses.map((e) => e.amount_cents))
    const deductibleOut = sumCents(
      expenses.filter((e) => e.is_tax_deductible).map((e) => e.amount_cents)
    )

    // Cross-check: our rows against the function's. A mismatch means the two
    // saw different data — an RLS difference, or a category row we cannot read.
    const functionTotal = categoryTotals.reduce((acc, t) => acc + Number(t.total_cents), 0)
    if (functionTotal !== allOut) {
      notes.push(
        `expense_totals() reports ${formatMoney(functionTotal)} out where the underlying rows sum ` +
          `to ${formatMoney(allOut)}. The two should be identical; the difference means the ` +
          'function and the table read different rows. Investigate before trusting either.'
      )
    }

    // ── What is left ──────────────────────────────────────────
    // profit_summary()'s figures, on its own billed basis.
    const billedServiceRevenue = profit ? Number(profit.service_revenue_cents) : 0
    const billedProductRevenue = profit ? Number(profit.product_revenue_cents) : 0
    const cogsCents = profit ? Number(profit.cogs_cents) : 0
    const operatingCents = profit ? Number(profit.operating_expense_cents) : 0
    const stockPurchaseCents = profit ? Number(profit.stock_purchase_cents) : 0
    const grossMarginCents = profit ? Number(profit.gross_margin_cents) : 0
    const netCents = profit ? Number(profit.net_cents) : 0

    // The same period on a money-taken basis, from the same ledger the Sales
    // report uses — so the two reports agree about what came in even though
    // they disagree about which basis to report profit on.
    const ledger = await loadLedger({ ...ctx, locationId: null, providerId: null })
    let takenExTaxCents = 0
    for (const e of ledger.entries) {
      if (e.line === 'retail' && e.order) {
        const split = splitRetailPayment(e.amountCents, e.order)
        // Tax held for the state is not income on either basis.
        takenExTaxCents += split.baseCents + split.shippingCents + split.residualCents
      } else {
        takenExTaxCents += e.amountCents
      }
    }
    // Same shape as profit_summary()'s net — COGS, not the stock purchase —
    // so the only difference between the two figures is the revenue basis.
    const netTakenBasis = takenExTaxCents - cogsCents - operatingCents

    // ── Notes ─────────────────────────────────────────────────
    notes.push(
      'Stock purchases are NEVER added to operating expense. A case of wax bought this month is ' +
        'cash out this month, but its cost of goods lands in the month the treatment that consumed ' +
        'it happened — and that is already derived from order_items × products.cost_cents. ' +
        'Summing both would count the same product twice. `expense_categories.is_cogs` is what ' +
        'keeps them apart and `profit_summary()` is what applies the rule; this report does not ' +
        'restate it.'
    )
    notes.push(
      `Net = revenue − cost of goods (${formatMoney(cogsCents)}) − operating expense ` +
        `(${formatMoney(operatingCents)}). Stock purchased (${formatMoney(stockPurchaseCents)}) is ` +
        'shown for cash flow and is deliberately NOT in that line.'
    )
    notes.push(
      'TWO BASES, BOTH SHOWN. `profit_summary()` recognises service revenue as the total of ' +
        'COMPLETED appointments — money billed — so an appointment nobody paid for counts. The ' +
        'Sales report counts money TAKEN, from `payments`. "Net (billed)" is the function’s ' +
        `figure; "Net (taken)" is the same arithmetic over ${formatMoney(takenExTaxCents)} of ` +
        'receipts net of sales tax. Where they differ, the gap is unpaid completed work plus ' +
        'refunds that landed outside their original period.'
    )
    notes.push(
      'Sales tax collected is excluded from the taken-basis revenue: it is the state’s money, not ' +
        'income. `profit_summary()` already nets it out of product revenue for the same reason.'
    )
    notes.push(
      '`expenses` carries no `location_id`, by design in 032 — rent, insurance and a wholesale ' +
        'account are terms of the business, not facts about a building. This report is therefore ' +
        'business-wide and cannot be filtered to one site.'
    )
    if (ctx.locationId != null) {
      notes.push(
        'A site filter is set but has NOT been applied: expenses are not attributed to a location. ' +
          'The figures below cover the whole business.'
      )
    }
    notes.push(
      'A negative amount is a vendor credit — a returned case, a refunded subscription — and ' +
        'reduces the category it was posted against.'
    )
    notes.push(
      'Recurring rows were posted from a template by `generate_recurring_expenses()`. They are ' +
        'ordinary expenses; the split is shown because a fixed monthly base behaves differently ' +
        'from discretionary spend when a month is short.'
    )
    notes.push(
      '`profit_summary()` resolves its revenue window through `booking_settings.timezone`, while ' +
        'the taken-basis figure uses the location’s own zone. They agree while the studio has one ' +
        'site on one clock; a second site in another zone would need the function widened.'
    )
    notes.push(
      'COGS uses `products.cost_cents` as it stands today, because `order_items` snapshots the ' +
        'price sold at but not the cost paid. Accurate until a wholesale price changes, and then it ' +
        'restates history — 033 flags this too. Fixing it means a `cost_snapshot_cents` on ' +
        '`order_items` written at sale time.'
    )
    if (!profit) {
      notes.push(
        'profit_summary() returned nothing. Both helpers gate on `is_manager()` internally, so the ' +
          'caller is not a manager or above.'
      )
    }

    return {
      columns,
      rows,
      summary: [
        { label: 'Total out', value: formatMoney(allOut) },
        { label: 'Of which stock', value: formatMoney(stock.amountCents) },
        { label: 'Of which deductible', value: formatMoney(deductibleOut) },
        { label: 'Operating expense', value: formatMoney(operatingCents) },
        { label: 'Cost of goods', value: formatMoney(cogsCents) },
        { label: 'Gross margin (billed)', value: formatMoney(grossMarginCents) },
        {
          label: 'Net (billed)',
          value: formatMoney(netCents),
          tone: netCents >= 0 ? 'good' : 'warn',
        },
        {
          label: 'Net (taken)',
          value: formatMoney(netTakenBasis),
          tone: netTakenBasis >= 0 ? 'good' : 'warn',
        },
      ],
      sections: [
        { title: 'By vendor', rows: vendorRows },
        { title: 'By month', rows: monthRows },
        {
          title: 'Recurring vs one-off',
          rows: [
            shape('Recurring (posted from a template)', null, recurring),
            shape('One-off', null, oneOff),
          ],
        },
        {
          title: 'Stock vs operating',
          rows: [
            shape('Stock purchases', 'Stock (COGS)', stock),
            shape('Operating expense', 'Operating', operating),
          ],
        },
        {
          title: 'Revenue recognised, for the lines above',
          rows: [
            shape(
              `Service revenue (billed — completed appointments)`,
              null,
              { entries: 0, amountCents: billedServiceRevenue, deductibleCents: 0, nonDeductibleCents: 0 }
            ),
            shape(
              `Product revenue (billed — paid orders, net of tax)`,
              null,
              { entries: 0, amountCents: billedProductRevenue, deductibleCents: 0, nonDeductibleCents: 0 }
            ),
            shape(
              `All receipts (taken — payments, net of sales tax)`,
              null,
              { entries: ledger.entries.length, amountCents: takenExTaxCents, deductibleCents: 0, nonDeductibleCents: 0 }
            ),
          ],
        },
      ],
      notes,
    }
  },
}
