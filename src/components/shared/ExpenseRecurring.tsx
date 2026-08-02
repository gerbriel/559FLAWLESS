'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { X, Pause, Play, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import { dayLabelForDateKey } from '@/lib/time'
import {
  CADENCE_LABELS,
  PAYMENT_METHOD_LABELS,
  type ExpenseCadence,
  type ExpensePaymentMethod,
  type RecurringExpense,
} from '@/types/expenses'
import type { ExpenseEditorCategory, ExpenseEditorVendor } from './ExpenseEditor'

export type ExpenseRecurringRule = RecurringExpense & {
  category_name: string
  /** The next occurrence not yet on the books. Null once the rule has run out. */
  next_due: string | null
}

interface Props {
  rules: ExpenseRecurringRule[]
  categories: ExpenseEditorCategory[]
  vendors: ExpenseEditorVendor[]
  today: string
}

const CADENCES = Object.keys(CADENCE_LABELS) as ExpenseCadence[]
const METHODS = Object.keys(PAYMENT_METHOD_LABELS) as ExpensePaymentMethod[]

function toCents(dollars: string): number | null {
  const n = Number(dollars.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/**
 * The rent-and-software list, and the button that posts what has come due.
 *
 * Posting is a single call to `generate_recurring_expenses()`, which is
 * idempotent against a unique index — so pressing this twice, or pressing it
 * after a scheduled job already ran, posts nothing the second time. That is why
 * there is no "are you sure": there is nothing to be unsure about.
 */
export function ExpenseRecurring({ rules, categories, vendors, today }: Props) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)

  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [categoryId, setCategoryId] = useState(String(categories[0]?.id ?? ''))
  const [cadence, setCadence] = useState<ExpenseCadence>('monthly')
  const [startsOn, setStartsOn] = useState(today)
  const [endsOn, setEndsOn] = useState('')
  const [vendorId, setVendorId] = useState('')
  const [method, setMethod] = useState<ExpensePaymentMethod>('autopay')

  const due = rules.filter((r) => r.is_active && r.next_due && r.next_due <= today)

  async function postDue() {
    setBusy(true)
    const { data, error } = await createClient().rpc('generate_recurring_expenses', {})
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not post those.')
      return
    }
    const n = Number(data ?? 0)
    toast.success(
      n === 0 ? 'Nothing is due — everything is already on the books.' : `Posted ${n} entries.`
    )
    router.refresh()
  }

  async function addRule(e: React.FormEvent) {
    e.preventDefault()

    const cents = toCents(amount)
    if (cents === null || cents === 0) {
      toast.error('Enter an amount.')
      return
    }
    if (!description.trim()) {
      toast.error('Give it a name — it becomes the description on every entry.')
      return
    }
    if (endsOn && endsOn < startsOn) {
      toast.error('It cannot end before it starts.')
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('recurring_expenses')
      .insert({
        description: description.trim(),
        amount_cents: cents,
        category_id: Number(categoryId),
        vendor_id: vendorId ? Number(vendorId) : null,
        payment_method: method,
        cadence,
        starts_on: startsOn,
        ends_on: endsOn || null,
      })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not save that.')
      return
    }

    toast.success('Saved. Post it whenever you are ready.')
    setDescription('')
    setAmount('')
    setEndsOn('')
    setAdding(false)
    router.refresh()
  }

  async function toggle(rule: ExpenseRecurringRule) {
    setBusy(true)
    const { error } = await createClient()
      .from('recurring_expenses')
      .update({ is_active: !rule.is_active })
      .eq('id', rule.id)
    setBusy(false)
    if (error) {
      toast.error('Could not change that.')
      return
    }
    router.refresh()
  }

  async function remove(rule: ExpenseRecurringRule) {
    if (
      !confirm(
        `Delete "${rule.description}"? Entries already posted stay on the books as ordinary expenses.`
      )
    ) {
      return
    }
    setBusy(true)
    const { error } = await createClient().from('recurring_expenses').delete().eq('id', rule.id)
    setBusy(false)
    if (error) {
      toast.error('Could not delete that.')
      return
    }
    toast.success('Deleted.')
    router.refresh()
  }

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="display text-2xl">Recurring</h2>
        <div className="flex items-center gap-3">
          {due.length > 0 && (
            <Badge tone="warning">
              {due.length} due
            </Badge>
          )}
          <Button variant="subtle" size="sm" onClick={postDue} disabled={busy}>
            {busy ? 'Working…' : 'Post what is due'}
          </Button>
        </div>
      </div>

      <p className="mt-3 max-w-2xl text-sm text-[var(--color-muted)]">
        Rent, software, insurance. Set the amount once and post the month when you pay it —
        posting twice cannot double-charge you, and raising the rent here never rewrites what
        was already paid.
      </p>

      {rules.length === 0 ? (
        <p className="mt-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          Nothing recurring yet.
        </p>
      ) : (
        <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {rules.map((r) => {
            const overdue = r.is_active && !!r.next_due && r.next_due <= today
            return (
              <li key={r.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-4">
                <div className="min-w-48 flex-1">
                  <span className="block text-sm">{r.description}</span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {r.category_name} · {CADENCE_LABELS[r.cadence].toLowerCase()}
                    {r.ends_on ? ` · until ${r.ends_on}` : ''}
                  </span>
                </div>

                <div className="min-w-40 text-xs text-[var(--color-muted)]">
                  {!r.is_active ? (
                    <Badge tone="neutral">Paused</Badge>
                  ) : r.next_due ? (
                    <span className={overdue ? 'text-amber-700 dark:text-amber-400' : ''}>
                      Next {dayLabelForDateKey(r.next_due)}
                    </span>
                  ) : (
                    <span>Finished</span>
                  )}
                </div>

                <span className="w-24 text-right text-sm tabular-nums">
                  {formatMoney(r.amount_cents)}
                </span>

                <span className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => toggle(r)}
                    disabled={busy}
                    className="flex h-9 w-9 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)] disabled:opacity-45"
                    aria-label={r.is_active ? `Pause ${r.description}` : `Resume ${r.description}`}
                  >
                    {r.is_active ? (
                      <Pause className="h-4 w-4" strokeWidth={1.5} />
                    ) : (
                      <Play className="h-4 w-4" strokeWidth={1.5} />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(r)}
                    disabled={busy}
                    className="flex h-9 w-9 items-center justify-center text-[var(--color-muted)] hover:text-red-700 disabled:opacity-45 dark:hover:text-red-400"
                    aria-label={`Delete ${r.description}`}
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                  </button>
                </span>
              </li>
            )
          })}
        </ul>
      )}

      {adding ? (
        <form
          onSubmit={addRule}
          className="relative mt-6 space-y-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
        >
          <button
            type="button"
            onClick={() => setAdding(false)}
            className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
            aria-label="Close"
          >
            <X className="h-4 w-4" strokeWidth={1.5} />
          </button>

          <p className="label-caps text-[var(--color-muted)]">New recurring expense</p>

          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="What it is" htmlFor="rec_desc">
              <Input
                id="rec_desc"
                required
                maxLength={200}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Suite rent"
              />
            </Field>

            <Field label="Amount" htmlFor="rec_amount" hint="In dollars.">
              <Input
                id="rec_amount"
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="1325.00"
              />
            </Field>

            <Field label="Category" htmlFor="rec_cat">
              <Select
                id="rec_cat"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
              >
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="How often" htmlFor="rec_cadence">
              <Select
                id="rec_cadence"
                value={cadence}
                onChange={(e) => setCadence(e.target.value as ExpenseCadence)}
              >
                {CADENCES.map((c) => (
                  <option key={c} value={c}>
                    {CADENCE_LABELS[c]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="First one"
              htmlFor="rec_starts"
              hint="Every later date is measured from this one."
            >
              <Input
                id="rec_starts"
                type="date"
                required
                value={startsOn}
                onChange={(e) => setStartsOn(e.target.value)}
              />
            </Field>

            <Field label="Stop after" htmlFor="rec_ends" hint="Optional — leave blank to run on.">
              <Input
                id="rec_ends"
                type="date"
                value={endsOn}
                onChange={(e) => setEndsOn(e.target.value)}
              />
            </Field>

            <Field label="Vendor" htmlFor="rec_vendor">
              <Select id="rec_vendor" value={vendorId} onChange={(e) => setVendorId(e.target.value)}>
                <option value="">Not on the list</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="How you pay" htmlFor="rec_method">
              <Select
                id="rec_method"
                value={method}
                onChange={(e) => setMethod(e.target.value as ExpensePaymentMethod)}
              >
                {METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <Button type="submit" size="sm" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </form>
      ) : (
        <div className="mt-6">
          <Button variant="subtle" size="sm" onClick={() => setAdding(true)}>
            Add a recurring expense
          </Button>
        </div>
      )}
    </section>
  )
}
