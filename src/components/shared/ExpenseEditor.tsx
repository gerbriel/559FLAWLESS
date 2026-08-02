'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { X, Paperclip, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { formatMoney } from '@/lib/utils'
import {
  PAYMENT_METHOD_LABELS,
  type Expense,
  type ExpensePaymentMethod,
} from '@/types/expenses'

export interface ExpenseEditorCategory {
  id: number
  name: string
  is_cogs: boolean
  default_deductible: boolean
}

export interface ExpenseEditorVendor {
  id: number
  name: string
}

export interface ExpenseEditorPurchaseOrder {
  id: number
  po_number: string
  total_cents: number
  vendor_id: number | null
}

interface Props {
  /** Omitted for a new entry. */
  expense?: Expense
  categories: ExpenseEditorCategory[]
  vendors: ExpenseEditorVendor[]
  /** Purchase orders that have not been expensed yet. One PO, one expense. */
  purchaseOrders: ExpenseEditorPurchaseOrder[]
  /** Today in the studio's zone — the sensible default for a new entry. */
  today: string
}

const METHODS = Object.keys(PAYMENT_METHOD_LABELS) as ExpensePaymentMethod[]

/** "$42.00" → 4200. Null if it isn't a number. Negatives allowed: a credit. */
function toCents(dollars: string): number | null {
  const n = Number(dollars.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

const money = (cents: number) => (cents / 100).toFixed(2)

/**
 * Record, correct, or remove one expense.
 *
 * Writes straight to `expenses` with the signed-in user's own client, so the
 * manager-only RLS policy from 033 is the thing granting the write — there is no
 * service-role path here and no route handler to keep in step with it.
 *
 * Amounts are entered in dollars because that is what a receipt says, and
 * converted once, here, on the way in. Nothing downstream sees anything but
 * integer cents.
 */
export function ExpenseEditor({ expense, categories, vendors, purchaseOrders, today }: Props) {
  const router = useRouter()
  const isNew = !expense

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [incurredOn, setIncurredOn] = useState(expense?.incurred_on ?? today)
  const [amount, setAmount] = useState(expense ? money(expense.amount_cents) : '')
  const [categoryId, setCategoryId] = useState(
    String(expense?.category_id ?? categories[0]?.id ?? '')
  )
  const [description, setDescription] = useState(expense?.description ?? '')
  const [vendorId, setVendorId] = useState(expense?.vendor_id ? String(expense.vendor_id) : '')
  const [vendorName, setVendorName] = useState(expense?.vendor_name ?? '')
  const [method, setMethod] = useState<ExpensePaymentMethod>(expense?.payment_method ?? 'card')
  const [reference, setReference] = useState(expense?.reference ?? '')
  const [poId, setPoId] = useState(
    expense?.purchase_order_id ? String(expense.purchase_order_id) : ''
  )
  const [deductible, setDeductible] = useState(expense?.is_tax_deductible ?? true)
  const [note, setNote] = useState(expense?.note ?? '')
  const [receiptPath, setReceiptPath] = useState(expense?.receipt_path ?? null)

  const selectedCategory = categories.find((c) => String(c.id) === categoryId)

  function reset() {
    setIncurredOn(today)
    setAmount('')
    setDescription('')
    setVendorId('')
    setVendorName('')
    setMethod('card')
    setReference('')
    setPoId('')
    setDeductible(true)
    setNote('')
    setReceiptPath(null)
  }

  function pickCategory(next: string) {
    setCategoryId(next)
    // A new entry follows the category's default; an existing one keeps whatever
    // was decided about it, because someone decided it.
    if (isNew) {
      const c = categories.find((x) => String(x.id) === next)
      if (c) setDeductible(c.default_deductible)
    }
  }

  async function uploadReceipt(file: File) {
    const supabase = createClient()
    const ext = file.name.split('.').pop()?.toLowerCase() ?? 'jpg'
    // Grouped by the month it belongs to so a year's receipts stay browsable in
    // the bucket. Nothing in the path identifies a person, unlike the treatment
    // bucket, so it carries no authorisation meaning.
    const path = `${incurredOn.slice(0, 7)}/${crypto.randomUUID()}.${ext}`

    setBusy(true)
    const { error } = await supabase.storage.from('receipts').upload(path, file)
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not upload that receipt.')
      return
    }
    setReceiptPath(path)
    toast.success('Receipt attached. It saves with the entry.')
  }

  async function viewReceipt() {
    if (!receiptPath) return
    // The bucket is private. A short-lived signed URL is the only way in, and
    // storage RLS checks is_manager() before minting it.
    const { data, error } = await createClient()
      .storage.from('receipts')
      .createSignedUrl(receiptPath, 60)
    if (error || !data) {
      toast.error('Could not open that receipt.')
      return
    }
    window.open(data.signedUrl, '_blank', 'noopener,noreferrer')
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()

    const cents = toCents(amount)
    if (cents === null) {
      toast.error('That amount is not a number.')
      return
    }
    if (cents === 0) {
      toast.error('An expense of nothing is not an expense. Use a negative amount for a credit.')
      return
    }
    if (!description.trim()) {
      toast.error('Say what it was — "$340, Utilities" means nothing in June.')
      return
    }
    if (!categoryId) {
      toast.error('Pick a category.')
      return
    }

    const row = {
      incurred_on: incurredOn,
      amount_cents: cents,
      category_id: Number(categoryId),
      description: description.trim(),
      // The trigger overwrites vendor_id from the purchase order when one is
      // linked, so a mismatch corrects itself rather than being rejected.
      vendor_id: vendorId ? Number(vendorId) : null,
      vendor_name: vendorId ? null : vendorName.trim() || null,
      payment_method: method,
      reference: reference.trim() || null,
      receipt_path: receiptPath,
      purchase_order_id: poId ? Number(poId) : null,
      is_tax_deductible: deductible,
      note: note.trim() || null,
    }

    const supabase = createClient()
    setBusy(true)
    const { error } = isNew
      ? await supabase.from('expenses').insert(row)
      : await supabase.from('expenses').update(row).eq('id', expense.id)
    setBusy(false)

    if (error) {
      toast.error(
        error.code === '23505'
          ? 'That purchase order has already been expensed.'
          : error.message || 'Could not save that.'
      )
      return
    }

    toast.success(isNew ? `${formatMoney(cents)} recorded.` : 'Saved.')
    if (isNew) reset()
    setOpen(false)
    router.refresh()
  }

  async function remove() {
    if (!expense) return
    if (!confirm(`Delete "${expense.description}"? This cannot be undone.`)) return

    const supabase = createClient()
    setBusy(true)
    const { error } = await supabase.from('expenses').delete().eq('id', expense.id)
    if (!error && expense.receipt_path) {
      // Orphaned receipts in a private bucket are invisible and permanent.
      await supabase.storage.from('receipts').remove([expense.receipt_path])
    }
    setBusy(false)

    if (error) {
      toast.error('Could not delete that entry.')
      return
    }
    toast.success('Deleted.')
    setOpen(false)
    router.refresh()
  }

  if (!open) {
    return isNew ? (
      <Button onClick={() => setOpen(true)}>Record an expense</Button>
    ) : (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
    )
  }

  const id = expense?.id ?? 'new'

  return (
    <form
      onSubmit={save}
      className="relative space-y-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-5 text-left"
    >
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
        aria-label="Close"
      >
        <X className="h-4 w-4" strokeWidth={1.5} />
      </button>

      <div className="space-y-3">
        <p className="label-caps text-[var(--color-muted)]">
          {isNew ? 'New expense' : 'Edit expense'}
        </p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date" htmlFor={`date_${id}`} hint="The day it was paid.">
            <Input
              id={`date_${id}`}
              type="date"
              required
              value={incurredOn}
              onChange={(e) => setIncurredOn(e.target.value)}
            />
          </Field>

          <Field
            label="Amount"
            htmlFor={`amount_${id}`}
            hint="In dollars. Negative for a vendor credit."
          >
            <Input
              id={`amount_${id}`}
              inputMode="decimal"
              required
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="1325.00"
            />
          </Field>
        </div>

        <Field label="What it was" htmlFor={`desc_${id}`}>
          <Input
            id={`desc_${id}`}
            required
            maxLength={200}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Suite rent — January"
          />
        </Field>

        <Field
          label="Category"
          htmlFor={`cat_${id}`}
          hint={
            selectedCategory?.is_cogs
              ? 'Stock. Reported on its own line so it is not counted twice against margin.'
              : undefined
          }
        >
          <Select id={`cat_${id}`} value={categoryId} onChange={(e) => pickCategory(e.target.value)}>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      <div className="space-y-3 border-t border-[var(--color-border)] pt-5">
        <p className="label-caps text-[var(--color-muted)]">Who it went to</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Vendor" htmlFor={`vendor_${id}`} hint="From your supplier list.">
            <Select
              id={`vendor_${id}`}
              value={vendorId}
              onChange={(e) => setVendorId(e.target.value)}
            >
              <option value="">Not on the list</option>
              {vendors.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Or just a name"
            htmlFor={`vname_${id}`}
            hint="For a one-off not worth a record."
          >
            <Input
              id={`vname_${id}`}
              maxLength={120}
              disabled={!!vendorId}
              value={vendorId ? '' : vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              placeholder="Costco"
            />
          </Field>
        </div>

        {purchaseOrders.length > 0 && (
          <Field
            label="Paying a purchase order"
            htmlFor={`po_${id}`}
            hint="Links this to the order in Inventory. Each one can be paid once."
          >
            <Select id={`po_${id}`} value={poId} onChange={(e) => setPoId(e.target.value)}>
              <option value="">Not against an order</option>
              {expense?.purchase_order_id && !purchaseOrders.some((p) => p.id === expense.purchase_order_id) && (
                <option value={expense.purchase_order_id}>
                  Currently linked order #{expense.purchase_order_id}
                </option>
              )}
              {purchaseOrders.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.po_number} · {formatMoney(p.total_cents)}
                </option>
              ))}
            </Select>
          </Field>
        )}
      </div>

      <div className="space-y-3 border-t border-[var(--color-border)] pt-5">
        <p className="label-caps text-[var(--color-muted)]">Paper trail</p>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="How you paid" htmlFor={`method_${id}`}>
            <Select
              id={`method_${id}`}
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

          <Field
            label="Reference"
            htmlFor={`ref_${id}`}
            hint="Invoice or check number, if there is one."
          >
            <Input
              id={`ref_${id}`}
              maxLength={80}
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
        </div>

        <div>
          <p className="label-caps mb-2 text-[var(--color-muted)]">Receipt</p>
          <div className="flex flex-wrap items-center gap-3">
            <label className="label-caps inline-flex h-11 cursor-pointer items-center gap-2 border border-[var(--color-border)] bg-[var(--color-background)] px-4 hover:border-[var(--color-accent)] sm:h-9">
              <Paperclip className="h-3.5 w-3.5" strokeWidth={1.5} />
              {receiptPath ? 'Replace' : 'Attach'}
              <input
                type="file"
                className="sr-only"
                accept="image/jpeg,image/png,image/webp,image/heic,application/pdf"
                onChange={(e) => {
                  const f = e.target.files?.[0]
                  if (f) void uploadReceipt(f)
                }}
              />
            </label>
            {receiptPath && (
              <>
                <Button type="button" variant="ghost" size="sm" onClick={viewReceipt}>
                  View
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => setReceiptPath(null)}
                >
                  Detach
                </Button>
              </>
            )}
          </div>
          <p className="mt-1.5 text-xs text-[var(--color-muted)]">
            Kept in a private bucket and only ever opened through a link that expires in a
            minute.
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={deductible}
            onChange={(e) => setDeductible(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Tax deductible
            <span className="block text-xs text-[var(--color-muted)]">
              Untick for anything personal that went through the business.
            </span>
          </span>
        </label>

        <Field label="Note" htmlFor={`note_${id}`}>
          <Textarea
            id={`note_${id}`}
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-5">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : isNew ? 'Record it' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {!isNew && (
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="label-caps ml-auto inline-flex items-center gap-1.5 text-[var(--color-muted)] hover:text-red-700 disabled:opacity-45 dark:hover:text-red-400"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.5} />
            Delete
          </button>
        )}
      </div>
    </form>
  )
}
