import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { ExpenseEditor } from '@/components/shared/ExpenseEditor'
import {
  ExpenseRecurring,
  type ExpenseRecurringRule,
} from '@/components/shared/ExpenseRecurring'
import { formatMoney } from '@/lib/utils'
import { addDaysToDateKey, dateKeyInTimeZone, requestNow } from '@/lib/time'
import { isManager, type UserRole } from '@/types/database'
import {
  PAYMENT_METHOD_LABELS,
  type Expense,
  type ExpenseCadence,
  type ExpensePaymentMethod,
} from '@/types/expenses'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ range?: string; from?: string; to?: string; category?: string }>
}

const RANGES = [
  { key: 'month', label: 'This month' },
  { key: 'last', label: 'Last month' },
  { key: 'quarter', label: 'Last 90 days' },
  { key: 'year', label: 'This year' },
]

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

/** First of the month a date key falls in. String arithmetic — a key is already a day. */
function monthStart(dateKey: string): string {
  return `${dateKey.slice(0, 7)}-01`
}

/** First of the following month. */
function nextMonthStart(dateKey: string): string {
  const year = Number(dateKey.slice(0, 4))
  const month = Number(dateKey.slice(5, 7))
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, '0')}-01`
}

/** First of the previous month. */
function prevMonthStart(dateKey: string): string {
  const year = Number(dateKey.slice(0, 4))
  const month = Number(dateKey.slice(5, 7))
  return month === 1
    ? `${year - 1}-12-01`
    : `${year}-${String(month - 1).padStart(2, '0')}-01`
}

/**
 * Resolve the requested window to two date keys.
 *
 * Month lengths come from `addDaysToDateKey(nextMonthStart, -1)` rather than a
 * table of 28/30/31 — the first of next month minus a day is right in February
 * and right in a leap year, for free.
 */
function resolveRange(
  range: string,
  from: string | undefined,
  to: string | undefined,
  today: string
): { key: string; from: string; to: string } {
  if (from && to && DATE_KEY.test(from) && DATE_KEY.test(to) && from <= to) {
    return { key: 'custom', from, to }
  }
  if (range === 'last') {
    const start = prevMonthStart(today)
    return { key: 'last', from: start, to: addDaysToDateKey(monthStart(today), -1) }
  }
  if (range === 'quarter') {
    return { key: 'quarter', from: addDaysToDateKey(today, -89), to: today }
  }
  if (range === 'year') {
    const year = today.slice(0, 4)
    return { key: 'year', from: `${year}-01-01`, to: `${year}-12-31` }
  }
  return {
    key: 'month',
    from: monthStart(today),
    to: addDaysToDateKey(nextMonthStart(today), -1),
  }
}

/** e.g. 'Jan 5' — a date key is a calendar day and is never reinterpreted by zone. */
function shortDate(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  })
}

type ExpenseRow = Expense & {
  expense_categories: { name: string; is_cogs: boolean } | null
  vendors: { name: string } | null
}

export default async function ExpensesPage({ searchParams }: Props) {
  const { range, from, to, category } = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  // RLS already returns nothing to anyone below manager. Redirecting rather than
  // rendering an empty page is the difference between "you can't see this" and
  // "there is nothing here", and only one of those is true.
  const role = (profile?.role ?? 'provider') as UserRole
  if (!isManager(role)) redirect('/dashboard')

  const { data: settings } = await supabase
    .from('booking_settings')
    .select('timezone')
    .eq('id', 1)
    .maybeSingle()
  const zone = settings?.timezone ?? 'America/Los_Angeles'
  const today = dateKeyInTimeZone(new Date(requestNow()), zone)

  const period = resolveRange(range ?? 'month', from, to, today)

  const [
    { data: expenseRows },
    { data: categoryRows },
    { data: vendorRows },
    { data: poRows },
    { data: linkedPoRows },
    { data: ruleRows },
  ] = await Promise.all([
    supabase
      .from('expenses')
      .select('id, incurred_on, amount_cents, category_id, description, vendor_id, vendor_name, payment_method, reference, receipt_path, purchase_order_id, is_tax_deductible, note, recurring_id, recurring_period, recorded_by, created_at, updated_at, expense_categories(name, is_cogs), vendors(name)')
      .gte('incurred_on', period.from)
      .lte('incurred_on', period.to)
      .order('incurred_on', { ascending: false })
      .order('id', { ascending: false }),
    supabase
      .from('expense_categories')
      .select('id, name, is_cogs, default_deductible')
      .eq('is_active', true)
      .order('sort_order'),
    supabase.from('vendors').select('id, name').eq('is_active', true).order('name'),
    supabase
      .from('purchase_orders')
      .select('id, po_number, total_cents, vendor_id')
      .in('status', ['ordered', 'partial', 'received'])
      .order('id', { ascending: false })
      .limit(50),
    supabase.from('expenses').select('purchase_order_id').not('purchase_order_id', 'is', null),
    supabase
      .from('recurring_expenses')
      .select('id, description, amount_cents, category_id, vendor_id, vendor_name, payment_method, note, is_tax_deductible, cadence, starts_on, ends_on, is_active, created_by, created_at, updated_at, expense_categories(name)')
      .order('is_active', { ascending: false })
      .order('starts_on'),
  ])

  const all = (expenseRows ?? []) as unknown as ExpenseRow[]
  const categories = categoryRows ?? []
  const vendors = vendorRows ?? []

  const alreadyLinked = new Set(
    (linkedPoRows ?? []).map((r) => (r as { purchase_order_id: number }).purchase_order_id)
  )
  const purchaseOrders = (poRows ?? []).filter((p) => !alreadyLinked.has(p.id))

  // ── Totals ───────────────────────────────────────────
  // Every figure below is a sum of integer cents. Nothing here divides.
  const byCategory = new Map<number, { name: string; is_cogs: boolean; cents: number }>()
  for (const e of all) {
    const current = byCategory.get(e.category_id)
    if (current) {
      current.cents += e.amount_cents
    } else {
      byCategory.set(e.category_id, {
        name: e.expense_categories?.name ?? 'Uncategorised',
        is_cogs: e.expense_categories?.is_cogs ?? false,
        cents: e.amount_cents,
      })
    }
  }
  const breakdown = Array.from(byCategory.entries())
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.cents - a.cents)

  const periodTotal = all.reduce((n, e) => n + e.amount_cents, 0)
  const deductibleTotal = all
    .filter((e) => e.is_tax_deductible)
    .reduce((n, e) => n + e.amount_cents, 0)
  const stockTotal = all
    .filter((e) => e.expense_categories?.is_cogs)
    .reduce((n, e) => n + e.amount_cents, 0)

  const categoryId = category && /^\d+$/.test(category) ? Number(category) : null
  const rows = categoryId === null ? all : all.filter((e) => e.category_id === categoryId)
  const shownTotal =
    categoryId === null ? periodTotal : rows.reduce((n, e) => n + e.amount_cents, 0)

  // ── Recurring ────────────────────────────────────────
  // Next-due comes from the database function rather than a second implementation
  // of the cadence arithmetic here. One rule, one place.
  const rulesRaw = (ruleRows ?? []) as unknown as (ExpenseRecurringRule & {
    cadence: ExpenseCadence
    payment_method: ExpensePaymentMethod
    expense_categories: { name: string } | null
  })[]

  const nextDue = await Promise.all(
    rulesRaw.map((r) => supabase.rpc('recurring_expense_next_due', { p_rule: r.id }))
  )

  const rules: ExpenseRecurringRule[] = rulesRaw.map((r, i) => ({
    ...r,
    category_name: r.expense_categories?.name ?? 'Uncategorised',
    next_due: (nextDue[i]?.data as string | null) ?? null,
  }))

  const params = (next: Record<string, string | undefined>) => {
    const q = new URLSearchParams()
    const merged = {
      range: period.key === 'custom' ? undefined : period.key,
      from: period.key === 'custom' ? period.from : undefined,
      to: period.key === 'custom' ? period.to : undefined,
      category: category,
      ...next,
    }
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, v)
    const s = q.toString()
    return s ? `/dashboard/expenses?${s}` : '/dashboard/expenses'
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Expenses</h1>
        <div className="text-right">
          <span className="display block text-3xl tabular-nums">{formatMoney(shownTotal)}</span>
          <span className="label-caps text-[var(--color-muted)]">
            {rows.length} {rows.length === 1 ? 'entry' : 'entries'} · {shortDate(period.from)} –{' '}
            {shortDate(period.to)}
          </span>
        </div>
      </div>

      <nav className="mt-8 flex flex-wrap gap-x-7 gap-y-2" aria-label="Period">
        {RANGES.map((r) => (
          <Link
            key={r.key}
            href={params({ range: r.key, from: undefined, to: undefined })}
            className={`label-caps pb-1 ${
              period.key === r.key
                ? 'border-b border-[var(--color-foreground)]'
                : 'text-[var(--color-muted)]'
            }`}
          >
            {r.label}
          </Link>
        ))}
        {period.key === 'custom' && (
          <span className="label-caps border-b border-[var(--color-foreground)] pb-1">Custom</span>
        )}
      </nav>

      <form className="mt-6 flex flex-wrap items-end gap-3">
        {category && <input type="hidden" name="category" value={category} />}
        <Field label="From" htmlFor="from" className="w-44">
          <Input id="from" type="date" name="from" defaultValue={period.from} />
        </Field>
        <Field label="To" htmlFor="to" className="w-44">
          <Input id="to" type="date" name="to" defaultValue={period.to} />
        </Field>
        <Button type="submit" variant="subtle" size="sm" className="mb-0.5">
          Apply
        </Button>
      </form>

      <div className="mt-8 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
        <div className="bg-[var(--color-surface)] p-5">
          <span className="label-caps text-[var(--color-muted)]">Total out</span>
          <span className="mt-1 block text-2xl tabular-nums">{formatMoney(periodTotal)}</span>
        </div>
        <div className="bg-[var(--color-surface)] p-5">
          <span className="label-caps text-[var(--color-muted)]">Tax deductible</span>
          <span className="mt-1 block text-2xl tabular-nums">{formatMoney(deductibleTotal)}</span>
        </div>
        <div className="bg-[var(--color-surface)] p-5">
          <span className="label-caps text-[var(--color-muted)]">Of that, stock</span>
          <span className="mt-1 block text-2xl tabular-nums">{formatMoney(stockTotal)}</span>
          <span className="mt-1 block text-xs text-[var(--color-muted)]">
            Counted again as cost of goods when it sells, so profit uses one or the other —
            never both.
          </span>
        </div>
      </div>

      {breakdown.length > 0 && (
        <nav className="mt-8 flex flex-wrap gap-x-6 gap-y-2" aria-label="Category">
          <Link
            href={params({ category: undefined })}
            className={`label-caps pb-1 ${
              categoryId === null
                ? 'border-b border-[var(--color-foreground)]'
                : 'text-[var(--color-muted)]'
            }`}
          >
            All · {formatMoney(periodTotal)}
          </Link>
          {breakdown.map((b) => (
            <Link
              key={b.id}
              href={params({ category: String(b.id) })}
              className={`label-caps pb-1 ${
                categoryId === b.id
                  ? 'border-b border-[var(--color-foreground)]'
                  : 'text-[var(--color-muted)]'
              }`}
            >
              {b.name} · {formatMoney(b.cents)}
            </Link>
          ))}
        </nav>
      )}

      <div className="mt-8">
        <ExpenseEditor
          categories={categories}
          vendors={vendors}
          purchaseOrders={purchaseOrders}
          today={today}
        />
      </div>

      {rows.length === 0 ? (
        <p className="mt-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          Nothing recorded in this period.
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-3xl text-sm">
            <thead>
              <tr className="border-y border-[var(--color-border)]">
                <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">Date</th>
                <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">What</th>
                <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">
                  Category
                </th>
                <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">Paid</th>
                <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                  Amount
                </th>
                <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                  <span className="sr-only">Edit</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e) => (
                <tr key={e.id} className="border-b border-[var(--color-border)]">
                  <td className="whitespace-nowrap px-3 py-3 tabular-nums text-[var(--color-muted)]">
                    {shortDate(e.incurred_on)}
                  </td>
                  <td className="px-3 py-3">
                    <span className="block">{e.description}</span>
                    <span className="text-xs text-[var(--color-muted)]">
                      {e.vendors?.name ?? e.vendor_name ?? '—'}
                      {e.reference ? ` · ${e.reference}` : ''}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <span className="flex flex-wrap items-center gap-1.5">
                      {e.expense_categories?.name ?? '—'}
                      {e.expense_categories?.is_cogs && <Badge tone="info">Stock</Badge>}
                      {e.recurring_id && <Badge tone="neutral">Recurring</Badge>}
                      {!e.is_tax_deductible && <Badge tone="warning">Not deductible</Badge>}
                    </span>
                  </td>
                  <td className="px-3 py-3 text-[var(--color-muted)]">
                    {PAYMENT_METHOD_LABELS[e.payment_method]}
                  </td>
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatMoney(e.amount_cents)}
                  </td>
                  <td className="w-80 px-3 py-3 text-right align-top">
                    <ExpenseEditor
                      expense={e}
                      categories={categories}
                      vendors={vendors}
                      purchaseOrders={purchaseOrders}
                      today={today}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-b border-[var(--color-border)]">
                <td className="label-caps px-3 py-3 text-[var(--color-muted)]" colSpan={4}>
                  Total
                </td>
                <td className="px-3 py-3 text-right tabular-nums">{formatMoney(shownTotal)}</td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      <ExpenseRecurring
        rules={rules}
        categories={categories}
        vendors={vendors}
        today={today}
      />
    </div>
  )
}
