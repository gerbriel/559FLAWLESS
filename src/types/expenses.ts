/**
 * Row shapes for the expense domain — migration 033.
 *
 * These live here rather than in `src/types/database.ts` only because that file
 * is regenerated wholesale from the live schema. The entries that belong in its
 * `Tables` and `Functions` maps are listed at the bottom of this file; until
 * they are merged, a `.from('expenses')` call has no type to resolve against.
 *
 * Row shapes are `type` aliases and not `interface` for the reason given in
 * AGENTS.md: an interface has no implicit index signature, so it fails
 * supabase-js's `Record<string, unknown>` constraint and silently collapses
 * every query result to `never`.
 */

/**
 * How the studio paid. Not `payments.method` from 008 — that vocabulary is
 * about how a *client* pays the studio ('gift_card', 'package'), which has
 * nothing to say about a rent cheque or an ACH to a wholesaler.
 */
export type ExpensePaymentMethod = 'card' | 'cash' | 'check' | 'ach' | 'autopay' | 'other'

export type ExpenseCadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly'

export type ExpenseCategory = {
  id: number
  name: string
  slug: string
  description: string | null
  /**
   * Stock purchases. `profit_summary()` reports these on their own line and
   * never adds them to operating expense, because the same product is counted
   * again as cost of goods when it sells.
   */
  is_cogs: boolean
  default_deductible: boolean
  sort_order: number
  is_active: boolean
  created_at: string
}

export type Expense = {
  id: number
  /** A calendar day in the studio's zone, 'YYYY-MM-DD'. Never an instant. */
  incurred_on: string
  /** Integer cents. Negative is a vendor credit; zero is rejected. */
  amount_cents: number
  category_id: number
  description: string
  vendor_id: number | null
  vendor_name: string | null
  payment_method: ExpensePaymentMethod
  /** Invoice or cheque number — what is printed on the paper. */
  reference: string | null
  /** Object key in the private `receipts` bucket. Signed on demand, never public. */
  receipt_path: string | null
  purchase_order_id: number | null
  is_tax_deductible: boolean
  note: string | null
  recurring_id: number | null
  /** The scheduled date this row was posted for, as opposed to when it was paid. */
  recurring_period: string | null
  recorded_by: string | null
  created_at: string
  updated_at: string
}

export type RecurringExpense = {
  id: number
  description: string
  amount_cents: number
  category_id: number
  vendor_id: number | null
  vendor_name: string | null
  payment_method: ExpensePaymentMethod
  note: string | null
  is_tax_deductible: boolean
  cadence: ExpenseCadence
  starts_on: string
  ends_on: string | null
  is_active: boolean
  created_by: string | null
  created_at: string
  updated_at: string
}

/** One row of `expense_totals(from, to)`. */
export type ExpenseCategoryTotal = {
  category_id: number
  category_name: string
  is_cogs: boolean
  entry_count: number
  total_cents: number
}

/**
 * The single row `profit_summary(from, to)` returns. Every figure is integer
 * cents.
 *
 * `stock_purchase_cents` is reported beside the others and is deliberately NOT
 * part of `net_cents`: it and `cogs_cents` measure the same product from
 * opposite ends — what was bought, and what was sold — so exactly one of them
 * may be subtracted.
 */
export type ProfitSummary = {
  service_revenue_cents: number
  product_revenue_cents: number
  cogs_cents: number
  operating_expense_cents: number
  stock_purchase_cents: number
  gross_margin_cents: number
  net_cents: number
}

export const PAYMENT_METHOD_LABELS: Record<ExpensePaymentMethod, string> = {
  card: 'Card',
  cash: 'Cash',
  check: 'Check',
  ach: 'Bank transfer',
  autopay: 'Autopay',
  other: 'Other',
}

export const CADENCE_LABELS: Record<ExpenseCadence, string> = {
  weekly: 'Every week',
  monthly: 'Every month',
  quarterly: 'Every three months',
  yearly: 'Every year',
}
