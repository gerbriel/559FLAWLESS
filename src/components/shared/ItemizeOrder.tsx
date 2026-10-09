'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Minus, Plus, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Select } from '@/components/ui/field'
import { formatMoney } from '@/lib/utils'

export interface ItemizeOption {
  /** `p:<id>` or `s:<id>` — one picker for both. */
  key: string
  name: string
  price_cents: number
  kind: 'product' | 'service'
  /** Products only: what is on the shelf right now. */
  stock?: number
}

interface Pick {
  option: ItemizeOption
  qty: number
}

/**
 * Put products and services against a custom amount after it was paid.
 *
 * The total never moves — the client paid what they paid. What is assigned
 * comes off the open amount, and anything beyond it is recorded as discount by
 * `itemize_order()` (076), which also prices every line from the catalogue and
 * takes products off the shelf. The prices shown here are the preview; the
 * database's are the ones written.
 */
export function ItemizeOrder({
  orderId,
  openCents,
  options,
}: {
  orderId: number
  openCents: number
  options: ItemizeOption[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [choice, setChoice] = useState('')
  const [picks, setPicks] = useState<Pick[]>([])

  const products = useMemo(() => options.filter((o) => o.kind === 'product'), [options])
  const services = useMemo(() => options.filter((o) => o.kind === 'service'), [options])

  const assigned = picks.reduce((s, p) => s + p.option.price_cents * p.qty, 0)
  const left = openCents - assigned

  function add(key: string) {
    const option = options.find((o) => o.key === key)
    if (!option) return
    setPicks((cur) =>
      cur.some((p) => p.option.key === key)
        ? cur.map((p) => (p.option.key === key ? { ...p, qty: p.qty + 1 } : p))
        : [...cur, { option, qty: 1 }]
    )
    setChoice('')
  }

  function setQty(key: string, qty: number) {
    setPicks((cur) =>
      qty <= 0 ? cur.filter((p) => p.option.key !== key) : cur.map((p) => (p.option.key === key ? { ...p, qty } : p))
    )
  }

  async function save() {
    if (picks.length === 0) return
    setBusy(true)
    const { data, error } = await createClient().rpc('itemize_order', {
      p_order: orderId,
      p_lines: picks.map((p) => {
        const id = Number(p.option.key.slice(2))
        return p.option.kind === 'product' ? { product_id: id, qty: p.qty } : { service_id: id, qty: p.qty }
      }),
    })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not assign those items.')
      return
    }

    const result = data as { assigned_cents: number; unassigned_cents: number; over_cents: number } | null
    toast.success(
      result && result.over_cents > 0
        ? `Assigned. ${formatMoney(result.over_cents)} over what was paid is recorded as discount.`
        : result && result.unassigned_cents > 0
          ? `Assigned. ${formatMoney(result.unassigned_cents)} still unassigned.`
          : 'Assigned. Nothing left to itemise.'
    )
    setPicks([])
    setOpen(false)
    router.refresh()
  }

  if (!open) {
    return (
      <Button size="sm" variant="subtle" onClick={() => setOpen(true)}>
        Assign items
      </Button>
    )
  }

  return (
    <div className="mt-3 w-full border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <Field label="Add a product or service" htmlFor={`itemize_${orderId}`}>
        <Select id={`itemize_${orderId}`} value={choice} onChange={(e) => add(e.target.value)}>
          <option value="">Choose…</option>
          {products.length > 0 && (
            <optgroup label="Products">
              {products.map((o) => (
                <option key={o.key} value={o.key} disabled={(o.stock ?? 0) <= 0}>
                  {o.name} — {formatMoney(o.price_cents)}
                  {(o.stock ?? 0) <= 0 ? ' (none on the shelf)' : ''}
                </option>
              ))}
            </optgroup>
          )}
          {services.length > 0 && (
            <optgroup label="Services">
              {services.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.name} — {formatMoney(o.price_cents)}
                </option>
              ))}
            </optgroup>
          )}
        </Select>
      </Field>

      {picks.length > 0 && (
        <ul className="mt-4 space-y-2">
          {picks.map((p) => (
            <li key={p.option.key} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate">{p.option.name}</span>
              <button
                type="button"
                onClick={() => setQty(p.option.key, p.qty - 1)}
                className="flex h-7 w-7 items-center justify-center border border-[var(--color-border)]"
                aria-label={`One fewer ${p.option.name}`}
              >
                <Minus className="h-3 w-3" strokeWidth={2} />
              </button>
              <span className="w-6 text-center tabular-nums">{p.qty}</span>
              <button
                type="button"
                onClick={() => add(p.option.key)}
                className="flex h-7 w-7 items-center justify-center border border-[var(--color-border)]"
                aria-label={`One more ${p.option.name}`}
              >
                <Plus className="h-3 w-3" strokeWidth={2} />
              </button>
              <span className="w-20 text-right tabular-nums">{formatMoney(p.option.price_cents * p.qty)}</span>
              <button
                type="button"
                onClick={() => setQty(p.option.key, 0)}
                className="flex h-7 w-7 items-center justify-center text-[var(--color-muted)] hover:text-red-700"
                aria-label={`Remove ${p.option.name}`}
              >
                <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              </button>
            </li>
          ))}
        </ul>
      )}

      <dl className="mt-4 space-y-1 border-t border-[var(--color-border)] pt-3 text-sm">
        <div className="flex justify-between">
          <dt className="text-[var(--color-muted)]">Unassigned</dt>
          <dd className="tabular-nums">{formatMoney(openCents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-[var(--color-muted)]">Assigning</dt>
          <dd className="tabular-nums">{formatMoney(assigned)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>{left >= 0 ? 'Left unassigned' : 'Over what was paid'}</dt>
          <dd className={`tabular-nums ${left < 0 ? 'text-amber-700 dark:text-amber-400' : ''}`}>
            {formatMoney(Math.abs(left))}
          </dd>
        </div>
      </dl>
      {left < 0 && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          The total stays what was paid; the difference is recorded as a discount on this order.
        </p>
      )}

      <div className="mt-4 flex gap-2">
        <Button size="sm" onClick={save} disabled={busy || picks.length === 0}>
          {busy ? 'Saving…' : 'Assign'}
        </Button>
        <Button
          size="sm"
          variant="subtle"
          onClick={() => {
            setPicks([])
            setOpen(false)
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
