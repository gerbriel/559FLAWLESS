'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import { BarcodeField } from './BarcodeField'
import type { StockReason } from '@/types/database'

const REASONS: { value: StockReason; label: string }[] = [
  { value: 'received', label: 'Received a delivery' },
  { value: 'count_correction', label: 'Correcting the count' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'expired', label: 'Expired' },
  { value: 'returned', label: 'Returned by a client' },
  { value: 'adjustment', label: 'Other adjustment' },
]

export interface EditableProduct {
  id: number
  name: string
  unit: string
  stock_qty: number
  low_stock_threshold: number
  is_retail: boolean
  is_professional: boolean
  price_cents: number
  cost_cents: number
  /** Where clients are sent when there is none left, if anywhere. */
  external_url: string | null
}

/** "$42.00" → 4200. Null if it isn't a number. */
function toCents(dollars: string): number | null {
  const n = Number(dollars.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

const money = (cents: number) => (cents / 100).toFixed(2)

/**
 * Stock and shelf settings for one product.
 *
 * Stock goes through the `adjust_stock` RPC, which moves the balance and writes
 * the log row in one statement so the two can never drift. There is no approval
 * step: whoever is holding the bottle is the person who knows the count, and the
 * RPC notifies the managers afterwards.
 */
export function ProductEditor({ product }: { product: EditableProduct }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [change, setChange] = useState('')
  const [reason, setReason] = useState<StockReason>('received')
  const [note, setNote] = useState('')

  const [retail, setRetail] = useState(product.is_retail)
  const [backBar, setBackBar] = useState(product.is_professional)
  const [threshold, setThreshold] = useState(String(product.low_stock_threshold))
  const [price, setPrice] = useState(money(product.price_cents))
  const [cost, setCost] = useState(money(product.cost_cents))

  async function applyStock(e: React.FormEvent) {
    e.preventDefault()
    const delta = Number(change)
    if (!Number.isFinite(delta) || delta === 0) {
      toast.error('Enter a non-zero amount.')
      return
    }
    if (product.stock_qty + delta < 0) {
      toast.error(`That would take ${product.name} below zero.`)
      return
    }

    setBusy(true)
    const { error } = await createClient().rpc('adjust_stock', {
      p_product_id: product.id,
      p_change: delta,
      p_reason: reason,
      p_note: note.trim() || null,
    })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not adjust stock.')
      return
    }

    toast.success(`${product.name} is now ${product.stock_qty + delta} ${product.unit}.`)
    setChange('')
    setNote('')
    router.refresh()
  }

  async function saveSettings() {
    const t = Number(threshold)
    if (!Number.isFinite(t) || t < 0) {
      toast.error('The low-stock level must be zero or more.')
      return
    }
    if (!retail && !backBar) {
      toast.error('Mark it retail, back bar, or both — otherwise it has nowhere to live.')
      return
    }

    const priceCents = toCents(price)
    const costCents = toCents(cost)
    if (priceCents === null) {
      toast.error('That price is not a number.')
      return
    }
    if (costCents === null) {
      toast.error('That cost is not a number.')
      return
    }
    if (retail && priceCents === 0) {
      toast.error('A retail product needs a price before it can be sold.')
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('products')
      .update({
        is_retail: retail,
        is_professional: backBar,
        low_stock_threshold: t,
        price_cents: priceCents,
        cost_cents: costCents,
      })
      .eq('id', product.id)
    setBusy(false)

    if (error) {
      toast.error('Could not save those settings.')
      return
    }

    toast.success('Saved.')
    router.refresh()
  }

  if (!open) {
    return (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
    )
  }

  return (
    <div className="relative space-y-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left">
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
        aria-label="Close"
      >
        <X className="h-4 w-4" strokeWidth={1.5} />
      </button>

      <form onSubmit={applyStock} className="space-y-3">
        <p className="label-caps text-[var(--color-muted)]">Adjust stock</p>

        <Field
          label="Change"
          htmlFor={`change_${product.id}`}
          hint={`Negative to remove. Now: ${product.stock_qty} ${product.unit}.`}
        >
          <Input
            id={`change_${product.id}`}
            type="number"
            step="any"
            required
            value={change}
            onChange={(e) => setChange(e.target.value)}
            placeholder="+6"
          />
        </Field>

        <Field label="Reason" htmlFor={`reason_${product.id}`}>
          <Select
            id={`reason_${product.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value as StockReason)}
          >
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Note" htmlFor={`note_${product.id}`}>
          <Input
            id={`note_${product.id}`}
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Apply'}
        </Button>
      </form>

      <div className="space-y-3 border-t border-[var(--color-border)] pt-5">
        <p className="label-caps text-[var(--color-muted)]">Price</p>

        {product.price_cents === 0 && (
          <p className="border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-3 text-sm text-[var(--color-muted)] dark:bg-[var(--color-background)]">
            No price set yet, so this cannot be sold at the counter. The catalogue was
            imported without prices — these are yours to set.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="You charge"
            htmlFor={`price_${product.id}`}
            hint="In dollars, e.g. 42 or 42.00"
          >
            <Input
              id={`price_${product.id}`}
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>

          <Field
            label="It costs you"
            htmlFor={`cost_${product.id}`}
            hint="Optional. Used for margin in Analytics."
          >
            <Input
              id={`cost_${product.id}`}
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </Field>
        </div>

        {product.external_url && (
          <p className="text-xs text-[var(--color-muted)]">
            When this runs out, clients are sent to the Rhonda Allison store to have it
            shipped. That price is theirs and is not shown here.
          </p>
        )}
      </div>

      <div className="space-y-3 border-t border-[var(--color-border)] pt-5">
        <BarcodeField productId={product.id} productName={product.name} />
      </div>

      <div className="space-y-3 border-t border-[var(--color-border)] pt-5">
        <p className="label-caps text-[var(--color-muted)]">Where it lives</p>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={retail}
            onChange={(e) => setRetail(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Retail
            <span className="block text-xs text-[var(--color-muted)]">
              Clients can see and buy it.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={backBar}
            onChange={(e) => setBackBar(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Back bar
            <span className="block text-xs text-[var(--color-muted)]">
              Used during treatments. Never shown to clients on its own.
            </span>
          </span>
        </label>

        <Field
          label="Tell me when it drops to"
          htmlFor={`thresh_${product.id}`}
          hint={`In ${product.unit}. At or below this it moves to Low stock.`}
        >
          <Input
            id={`thresh_${product.id}`}
            type="number"
            step="any"
            min={0}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </Field>

        <Button type="button" size="sm" variant="subtle" onClick={saveSettings} disabled={busy}>
          Save settings
        </Button>
      </div>
    </div>
  )
}
