'use client'

import { useCallback, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { Search, Plus, Minus, Trash2, ExternalLink, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Select } from '@/components/ui/field'
import { createClient } from '@/lib/supabase/client'
import { formatMoney } from '@/lib/utils'
import {
  barcodeVariants,
  matchProductByBarcode,
  resolveScan,
  type ScannableProduct,
  type ScanResolution,
} from '@/types/barcode'
import { BarcodeScanHint, useBarcodeScanner } from './BarcodeScanner'
import { BarcodeCameraScanner } from './BarcodeCameraScanner'

export interface SellableProduct {
  id: number
  name: string
  sku: string | null
  /** The code on the packaging. Optional so an older page keeps compiling. */
  barcode?: string | null
  price_cents: number
  stock_qty: number
  unit: string
  external_url: string | null
  brand: string | null
}

export interface CustomerOption {
  id: string
  name: string
  email: string | null
}

interface Line {
  product: SellableProduct
  qty: number
}

interface Receipt {
  order_number: string | null
  subtotal_cents: number
  tax_cents: number
  total_cents: number
  customer: string
}

/**
 * The counter till.
 *
 * Built around what actually happens in the room: someone is standing there
 * with a bottle, and the sale should take seconds. So the product list is a
 * single filter box, the cart is always visible, and nothing needs a client
 * account — a walk-in is just a name.
 *
 * Out-of-stock items stay visible rather than disappearing, because the useful
 * answer is not "we don't have it" but "we can ship it to you" — the studio's
 * Rhonda Allison storefront handles that, so the link is right there.
 */
export function PointOfSale({
  products,
  customers,
  taxRate,
}: {
  products: SellableProduct[]
  customers: CustomerOption[]
  taxRate: number
}) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [customerId, setCustomerId] = useState('')
  const [walkIn, setWalkIn] = useState('')
  const [method, setMethod] = useState<'cash' | 'card' | 'other'>('card')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [lastScan, setLastScan] = useState<string | null>(null)
  const [camera, setCamera] = useState(false)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return products
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q) ||
        p.barcode?.includes(q) ||
        p.brand?.toLowerCase().includes(q)
    )
  }, [products, search])

  const subtotal = lines.reduce((s, l) => s + l.product.price_cents * l.qty, 0)
  const tax = Math.round(subtotal * taxRate)
  const total = subtotal + tax

  function add(product: SellableProduct) {
    setLines((cur) => {
      const existing = cur.find((l) => l.product.id === product.id)
      if (existing) {
        if (existing.qty >= product.stock_qty) {
          toast.error(`Only ${product.stock_qty} ${product.unit} of ${product.name} on the shelf.`)
          return cur
        }
        return cur.map((l) => (l.product.id === product.id ? { ...l, qty: l.qty + 1 } : l))
      }
      return [...cur, { product, qty: 1 }]
    })
  }

  /**
   * What a scan does at the till.
   *
   * Every refusal here is one the sale endpoint would give anyway — no price,
   * no stock, not sold to clients — said at the moment the bottle is scanned
   * rather than after the customer has been told a total. The endpoint still
   * re-checks all of it; this is the courtesy, not the guard.
   */
  const applyScan = useCallback((result: ScanResolution) => {
    switch (result.kind) {
      case 'unknown':
        toast.error(`Nothing on file for ${result.code}.`, {
          description: 'Save that barcode against the product under Inventory first.',
        })
        return
      case 'not_for_sale':
        toast.error(`${result.product.name} is back-bar stock, not something clients buy.`)
        return
      case 'unpriced':
        toast.error(`${result.product.name} has no price yet.`, {
          description: 'Set one under Inventory before selling it.',
        })
        return
      case 'out_of_stock':
        toast.error(`No ${result.product.name} left on the shelf.`, {
          description: result.product.external_url
            ? 'It can be shipped from the Rhonda Allison store instead.'
            : undefined,
        })
        return
      case 'match': {
        const p = result.product
        // Checked here rather than left to `add`, which refuses inside a state
        // updater — scanning a fourth of three would otherwise show the refusal
        // and a cheerful confirmation side by side.
        const inCart = lines.find((l) => l.product.id === p.id)?.qty ?? 0
        if (inCart >= p.stock_qty) {
          toast.error(
            `Only ${p.stock_qty} ${p.unit} of ${p.name} on the shelf, and it is all in this sale.`
          )
          return
        }
        add({
          id: p.id,
          name: p.name,
          sku: p.sku,
          barcode: p.barcode,
          price_cents: p.price_cents,
          stock_qty: p.stock_qty,
          unit: p.unit,
          external_url: p.external_url,
          brand: products.find((row) => row.id === p.id)?.brand ?? null,
        })
        toast.success(`${p.name} — ${formatMoney(p.price_cents)}`)
      }
    }
  }, [products, lines])

  const handleScan = useCallback(
    async (code: string) => {
      setLastScan(code)

      // The till already holds every active retail product, so the common case
      // never touches the network — and keeps working if it is down.
      const local = matchProductByBarcode(code, products)
      if (local) {
        applyScan(
          resolveScan(code, [
            { ...local, barcode: local.barcode ?? null, is_active: true, is_retail: true },
          ])
        )
        return
      }

      // Not in the retail list. It may still be on file, and "that one is back
      // bar" is a far more useful answer than "unknown barcode".
      const { data, error } = await createClient()
        .from('products')
        .select('id, name, sku, barcode, price_cents, stock_qty, unit, external_url, is_active, is_retail, archived_at')
        .in('barcode', barcodeVariants(code))
        .limit(1)

      if (error) {
        toast.error('Could not look that barcode up.')
        return
      }

      const row = (data ?? [])[0] as
        | (ScannableProduct & { archived_at: string | null })
        | undefined

      if (!row || row.archived_at) {
        applyScan({ kind: 'unknown', code })
        return
      }

      applyScan(resolveScan(code, [{ ...row, stock_qty: Number(row.stock_qty) }]))
    },
    [products, applyScan]
  )

  useBarcodeScanner({
    // The receipt screen is a full stop; a scan there should not quietly begin
    // a new sale behind it.
    enabled: !receipt && !camera,
    onScan: (scan) => {
      void handleScan(scan.code)
    },
  })

  function setQty(productId: number, qty: number) {
    setLines((cur) =>
      qty <= 0
        ? cur.filter((l) => l.product.id !== productId)
        : cur.map((l) => (l.product.id === productId ? { ...l, qty } : l))
    )
  }

  async function ringUp() {
    if (lines.length === 0) {
      toast.error('Add something to the sale first.')
      return
    }
    if (!customerId && !walkIn.trim()) {
      toast.error('Pick a client or type a name for the walk-in.')
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/pos/sale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: customerId || null,
          guestName: customerId ? null : walkIn.trim(),
          items: lines.map((l) => ({ productId: l.product.id, qty: l.qty })),
          paymentMethod: method,
          notes: notes.trim() || null,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        toast.error(data.message ?? 'Could not complete that sale.')
        return
      }

      setReceipt({
        ...data.order,
        customer: customerId
          ? (customers.find((c) => c.id === customerId)?.name ?? 'Client')
          : walkIn.trim(),
      })
      setLines([])
      setCustomerId('')
      setWalkIn('')
      setNotes('')
      router.refresh()
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  if (receipt) {
    return (
      <div className="mt-10 max-w-md border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
        <div className="flex items-center gap-2.5">
          <Check className="h-5 w-5 text-emerald-600" strokeWidth={2.5} />
          <h2 className="display text-2xl">Sale complete</h2>
        </div>

        <dl className="mt-6 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-[var(--color-muted)]">Customer</dt>
            <dd>{receipt.customer}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--color-muted)]">Order</dt>
            <dd className="tabular-nums">{receipt.order_number ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--color-muted)]">Subtotal</dt>
            <dd className="tabular-nums">{formatMoney(receipt.subtotal_cents)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--color-muted)]">Tax</dt>
            <dd className="tabular-nums">{formatMoney(receipt.tax_cents)}</dd>
          </div>
          <div className="flex justify-between border-t border-[var(--color-border)] pt-2 text-base">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatMoney(receipt.total_cents)}</dd>
          </div>
        </dl>

        <p className="mt-5 text-sm text-[var(--color-muted)]">
          Stock has been updated and this is on the customer&rsquo;s history.
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => setReceipt(null)}>New sale</Button>
          <Link href="/dashboard/orders">
            <Button variant="subtle">All orders</Button>
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_22rem]">
      <div>
        <BarcodeScanHint
          className="mb-5"
          label="Scan a bottle to add it to the sale."
          lastCode={lastScan}
          onOpenCamera={() => setCamera(true)}
        />

        {camera && (
          <BarcodeCameraScanner
            title="Scan to add"
            onClose={() => setCamera(false)}
            onDetect={(code) => {
              // Stay open: at a counter you are usually ringing up more than one.
              void handleScan(code)
              return false
            }}
          />
        )}

        <label className="relative block">
          <span className="sr-only">Search products</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]"
            strokeWidth={1.5}
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, brand, SKU or barcode"
            className="w-full border border-[var(--color-border)] bg-[var(--color-surface)] py-3 pl-10 pr-3 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>

        {filtered.length === 0 ? (
          <p className="mt-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
            Nothing matches &ldquo;{search}&rdquo;.
          </p>
        ) : (
          <ul className="mt-5 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {filtered.map((p) => {
              const inCart = lines.find((l) => l.product.id === p.id)?.qty ?? 0
              const remaining = p.stock_qty - inCart
              const soldOut = p.stock_qty <= 0

              return (
                <li key={p.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <span className="block truncate">{p.name}</span>
                    <span className="text-xs text-[var(--color-muted)]">
                      {p.brand ? `${p.brand} · ` : ''}
                      {soldOut ? (
                        <span className="text-amber-700 dark:text-amber-400">Out of stock</span>
                      ) : (
                        `${remaining} ${p.unit} left`
                      )}
                    </span>
                  </div>

                  <div className="flex shrink-0 items-center gap-3">
                    <span className="tabular-nums text-sm">{formatMoney(p.price_cents)}</span>
                    {soldOut ? (
                      p.external_url ? (
                        <a
                          href={p.external_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="label-caps flex min-h-11 items-center gap-1 px-2 text-[var(--color-accent)]"
                        >
                          Ship it
                          <ExternalLink className="h-3 w-3" strokeWidth={2} />
                        </a>
                      ) : (
                        <Badge tone="neutral">None left</Badge>
                      )
                    ) : (
                      <Button
                        size="sm"
                        variant="subtle"
                        onClick={() => add(p)}
                        disabled={remaining <= 0}
                      >
                        <Plus className="h-4 w-4" strokeWidth={2} />
                        <span className="sr-only">Add {p.name}</span>
                      </Button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <h2 className="label-caps text-[var(--color-muted)]">This sale</h2>

          {lines.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">Nothing added yet.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {lines.map((l) => (
                <li key={l.product.id} className="flex items-start justify-between gap-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="block truncate">{l.product.name}</span>
                    <span className="text-xs tabular-nums text-[var(--color-muted)]">
                      {formatMoney(l.product.price_cents)} each
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setQty(l.product.id, l.qty - 1)}
                      className="flex h-8 w-8 items-center justify-center border border-[var(--color-border)]"
                      aria-label={`One fewer ${l.product.name}`}
                    >
                      <Minus className="h-3 w-3" strokeWidth={2} />
                    </button>
                    <span className="w-7 text-center tabular-nums">{l.qty}</span>
                    <button
                      type="button"
                      onClick={() =>
                        l.qty < l.product.stock_qty
                          ? setQty(l.product.id, l.qty + 1)
                          : toast.error(`Only ${l.product.stock_qty} on the shelf.`)
                      }
                      className="flex h-8 w-8 items-center justify-center border border-[var(--color-border)]"
                      aria-label={`One more ${l.product.name}`}
                    >
                      <Plus className="h-3 w-3" strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      onClick={() => setQty(l.product.id, 0)}
                      className="ml-1 flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-red-700"
                      aria-label={`Remove ${l.product.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <dl className="mt-5 space-y-1.5 border-t border-[var(--color-border)] pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">Subtotal</dt>
              <dd className="tabular-nums">{formatMoney(subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">
                Tax {(taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%
              </dt>
              <dd className="tabular-nums">{formatMoney(tax)}</dd>
            </div>
            <div className="flex justify-between pt-1 text-base">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatMoney(total)}</dd>
            </div>
          </dl>
        </div>

        <div className="mt-5 space-y-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <Field label="Client" htmlFor="pos_client" hint="Leave blank for a walk-in.">
            <Select
              id="pos_client"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              <option value="">Walk-in</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.email ? ` — ${c.email}` : ''}
                </option>
              ))}
            </Select>
          </Field>

          {!customerId && (
            <Field label="Walk-in name" htmlFor="pos_walkin">
              <Input
                id="pos_walkin"
                maxLength={120}
                value={walkIn}
                onChange={(e) => setWalkIn(e.target.value)}
                placeholder="Walk-in"
              />
            </Field>
          )}

          <Field label="Paid by" htmlFor="pos_method">
            <Select
              id="pos_method"
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
            >
              <option value="card">Card</option>
              <option value="cash">Cash</option>
              <option value="other">Other</option>
            </Select>
          </Field>

          <Field label="Note" htmlFor="pos_note">
            <Input
              id="pos_note"
              maxLength={200}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>

          <Button onClick={ringUp} disabled={busy || lines.length === 0} className="w-full">
            {busy ? 'Ringing up…' : `Take ${formatMoney(total)}`}
          </Button>
        </div>
      </aside>
    </div>
  )
}
