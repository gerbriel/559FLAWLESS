'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Minus, Plus, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useCart } from '@/store/cart'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import { formatMoney } from '@/lib/utils'
import { trackCartEvent } from './ClientAnalytics'

interface CartProduct {
  id: number
  name: string
  slug: string
  price_cents: number
  stock_qty: number
}

export function CartView() {
  const { lines, setQty, remove } = useCart()
  const [products, setProducts] = useState<CartProduct[]>([])
  const [loading, setLoading] = useState(true)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    fulfillment: 'pickup' as 'pickup' | 'shipping',
    subscribeNewsletter: true,  // Pre-checked marketing consent
  })

  // Prices are read fresh from the catalog every time the bag renders — the
  // stored cart holds ids and quantities only.
  useEffect(() => {
    let cancelled = false

    async function load() {
      if (lines.length === 0) {
        setProducts([])
        setLoading(false)
        return
      }
      const supabase = createClient()
      const { data } = await supabase
        .from('products')
        .select('id, name, slug, price_cents, stock_qty')
        .in(
          'id',
          lines.map((l) => l.productId)
        )
        .eq('is_active', true)
        .eq('is_retail', true)

      if (!cancelled) {
        setProducts(data ?? [])
        setLoading(false)
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [lines])

  const rows = lines
    .map((line) => {
      const product = products.find((p) => p.id === line.productId)
      return product ? { ...line, product } : null
    })
    .filter((r): r is { productId: number; qty: number; product: CartProduct } => r !== null)

  const subtotal = rows.reduce((n, r) => n + r.product.price_cents * r.qty, 0)

  async function checkout(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)

    try {
      const supabase = createClient()

      // If user opted in to newsletter, subscribe them
      if (form.subscribeNewsletter) {
        await supabase.rpc('subscribe_newsletter', {
          p_email: form.email.trim().toLowerCase(),
          p_source: 'checkout',
        })
      }

      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines: rows.map((r) => ({ productId: r.productId, qty: r.qty })),
          fulfillment: form.fulfillment,
          email: form.email,
          name: form.name,
          phone: form.phone || null,
        }),
      })

      const data = await res.json()

      if (!res.ok) {
        toast.error(
          data.error === 'insufficient_stock'
            ? `We are short on ${data.product}. Please reduce the quantity.`
            : data.error === 'stripe_not_configured'
              ? 'Online payment is not set up yet. Please call to order.'
              : 'Checkout failed. Please try again.'
        )
        return
      }

      window.location.assign(data.url)
    } catch {
      toast.error('Could not reach checkout. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="flex justify-center py-20 text-[var(--color-muted)]">
        <Loader2 className="h-5 w-5 animate-spin" strokeWidth={1.5} />
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-12 text-center">
        <p className="display text-2xl">Your bag is empty.</p>
        <Link href="/shop" className="label-caps mt-6 inline-block border-b border-[var(--color-foreground)] pb-1">
          Browse the shop
        </Link>
      </div>
    )
  }

  return (
    <div className="grid gap-12 lg:grid-cols-[1.4fr_1fr]">
      <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
        {rows.map((r) => (
          <li key={r.productId} className="flex flex-wrap items-center gap-6 py-6">
            <div className="h-20 w-20 shrink-0 bg-[var(--color-linen)] dark:bg-[var(--color-surface)]" />

            <div className="min-w-0 flex-1">
              <Link href={`/shop/${r.product.slug}`} className="text-base hover:text-[var(--color-accent)]">
                {r.product.name}
              </Link>
              <p className="mt-1 text-sm tabular-nums text-[var(--color-muted)]">
                {formatMoney(r.product.price_cents)} each
              </p>
              {Number(r.product.stock_qty) < r.qty && (
                <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
                  Only {r.product.stock_qty} left
                </p>
              )}
            </div>

            <div className="flex items-center border border-[var(--color-border)]">
              <button
                type="button"
                onClick={() => setQty(r.productId, r.qty - 1)}
                className="px-2.5 py-2"
                aria-label={`Decrease ${r.product.name}`}
              >
                <Minus className="h-3 w-3" strokeWidth={2} />
              </button>
              <span className="w-8 text-center text-sm tabular-nums">{r.qty}</span>
              <button
                type="button"
                onClick={() => setQty(r.productId, r.qty + 1)}
                className="px-2.5 py-2"
                aria-label={`Increase ${r.product.name}`}
              >
                <Plus className="h-3 w-3" strokeWidth={2} />
              </button>
            </div>

            <p className="w-20 text-right tabular-nums">
              {formatMoney(r.product.price_cents * r.qty)}
            </p>

            <button
              type="button"
              onClick={() => {
                remove(r.productId)
                void trackCartEvent('remove', { product_id: r.productId })
              }}
              className="p-1 text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              aria-label={`Remove ${r.product.name}`}
            >
              <X className="h-4 w-4" strokeWidth={1.5} />
            </button>
          </li>
        ))}
      </ul>

      <form onSubmit={checkout} className="lg:sticky lg:top-28 lg:self-start">
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <p className="label-caps mb-6 text-[var(--color-accent)]">Order summary</p>

          <div className="space-y-4">
            <Field label="Name" htmlFor="cart_name">
              <Input
                id="cart_name"
                required
                maxLength={120}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Email" htmlFor="cart_email">
              <Input
                id="cart_email"
                type="email"
                required
                maxLength={254}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
            <Field label="Phone" htmlFor="cart_phone" hint="Optional.">
              <Input
                id="cart_phone"
                type="tel"
                maxLength={40}
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </Field>
            <Field label="Fulfillment" htmlFor="cart_fulfillment">
              <Select
                id="cart_fulfillment"
                value={form.fulfillment}
                onChange={(e) =>
                  setForm({ ...form, fulfillment: e.target.value as 'pickup' | 'shipping' })
                }
              >
                <option value="pickup">Pick up at the studio</option>
                <option value="shipping">Ship to me</option>
              </Select>
            </Field>

            <label className="flex cursor-pointer items-start gap-3 text-sm">
              <input
                type="checkbox"
                checked={form.subscribeNewsletter}
                onChange={(e) => setForm({ ...form, subscribeNewsletter: e.target.checked })}
                className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
              />
              <span className="text-[var(--color-muted)]">
                Subscribe to our newsletter for exclusive offers and skincare tips
              </span>
            </label>
          </div>

          <dl className="mt-6 space-y-2 border-t border-[var(--color-border)] pt-6 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">Subtotal</dt>
              <dd className="tabular-nums">{formatMoney(subtotal)}</dd>
            </div>
            <div className="flex justify-between text-[var(--color-muted)]">
              <dt>Tax and shipping</dt>
              <dd>Calculated at checkout</dd>
            </div>
          </dl>

          <Button type="submit" size="lg" className="mt-6 w-full" disabled={submitting}>
            {submitting ? 'Redirecting…' : 'Checkout'}
          </Button>
        </div>
      </form>
    </div>
  )
}
