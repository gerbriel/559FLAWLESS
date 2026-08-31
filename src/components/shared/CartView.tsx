'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Minus, Plus, X, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { SignedInAs, useSignedInContact, backfillProfile } from '@/components/shared/SignedInIdentity'
import { useCart } from '@/store/cart'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import { formatMoney } from '@/lib/utils'
import { trackCartEvent } from './ClientAnalytics'
import { trackMetaEvent } from './MetaPixelEvent'

interface CartProduct {
  id: number
  name: string
  slug: string
  price_cents: number
  stock_qty: number
  /** The product's page on the studio's Rhonda Allison storefront — where
   *  shipping actually happens. The studio ships nothing itself. */
  external_url: string | null
}

export function CartView() {
  const { lines, setQty, remove } = useCart()
  // Resolved in the browser: /cart is statically rendered, and a server-side
  // session read would make the whole subtree dynamic for the sake of three
  // prefilled fields.
  const me = useSignedInContact()
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
  // Set when the shopper chooses to type different details than we hold.
  const [overrideIdentity, setOverrideIdentity] = useState(false)

  // Known well enough to skip asking: we can name them and reach them.
  const known =
    !!me.userId &&
    !!me.email &&
    !!(me.firstName || me.lastName) &&
    !overrideIdentity

  /**
   * What actually gets submitted.
   *
   * Derived at render rather than copied into state by an effect: the profile
   * arrives asynchronously, and syncing it into `form` would both fight the
   * React Compiler's purity rule and race someone who has already started
   * typing. Anything typed wins; otherwise we fall back to what we hold.
   *
   * `overrideIdentity` deliberately does NOT fall back — someone who asked to
   * use different details should get empty fields, not their own again.
   */
  const profileName = [me.firstName, me.lastName].filter(Boolean).join(' ')
  const contact = overrideIdentity
    ? { name: form.name, email: form.email, phone: form.phone }
    : {
        name: form.name || profileName,
        email: form.email || me.email || '',
        phone: form.phone || me.phone || '',
      }

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
        .select('id, name, slug, price_cents, stock_qty, external_url')
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
    // Unreachable through the UI (shipping swaps the button for the Rhonda
    // Allison links), kept as the belt to that suspender.
    if (form.fulfillment === 'shipping') return
    setSubmitting(true)

    // At the click, not the redirect — if Stripe refuses (stock, config), the
    // attempt to check out still happened, which is what this event names.
    trackMetaEvent('InitiateCheckout', {
      content_ids: rows.map((r) => String(r.productId)),
      content_type: 'product',
      contents: rows.map((r) => ({ id: String(r.productId), quantity: r.qty })),
      num_items: rows.reduce((n, r) => n + r.qty, 0),
      value: subtotal / 100,
      currency: 'USD',
    })

    try {
      const supabase = createClient()

      // If user opted in to newsletter, subscribe them
      if (form.subscribeNewsletter) {
        await supabase.rpc('subscribe_newsletter', {
          p_email: contact.email.trim().toLowerCase(),
          p_source: 'checkout',
        })
      }

      // Keep a phone number we had to ask for, so no later form asks again.
      // Awaited: Stripe navigation follows immediately and would cancel it.
      if (me.userId && contact.phone.trim() && !me.phone) {
        await backfillProfile(me.userId, { phone: contact.phone })
      }

      const res = await fetch('/api/stripe/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          lines: rows.map((r) => ({ productId: r.productId, qty: r.qty })),
          fulfillment: form.fulfillment,
          email: contact.email,
          name: contact.name,
          phone: contact.phone || null,
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
            {/* The choice comes first because it decides everything below:
                pickup checks out here; shipping is Rhonda Allison's job, and
                pretending otherwise made the studio a free postage service. */}
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

            {form.fulfillment === 'pickup' && known ? (
              <>
                <SignedInAs
                  label="Ordering as"
                  name={[me.firstName, me.lastName].filter(Boolean).join(' ')}
                  email={me.email}
                  changeLabel="Use different details"
                  onChange={() => setOverrideIdentity(true)}
                />
                {/* Only asked when we do not already hold one. Kept on the
                    account afterwards so no later form asks again. */}
                {!me.phone && (
                  <Field
                    label="Phone"
                    htmlFor="cart_phone"
                    hint="Optional. We will keep it on your account."
                  >
                    <Input
                      id="cart_phone"
                      type="tel"
                      maxLength={40}
                      value={form.phone}
                      onChange={(e) => setForm({ ...form, phone: e.target.value })}
                    />
                  </Field>
                )}
              </>
            ) : form.fulfillment === 'pickup' ? (
              <>
                <Field label="Name" htmlFor="cart_name">
                  <Input
                    id="cart_name"
                    required
                    maxLength={120}
                    value={contact.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </Field>
                <Field label="Email" htmlFor="cart_email">
                  <Input
                    id="cart_email"
                    type="email"
                    required
                    maxLength={254}
                    value={contact.email}
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
              </>
            ) : null}

            {form.fulfillment === 'pickup' && (
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
            )}
          </div>

          {form.fulfillment === 'pickup' ? (
            <>
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
            </>
          ) : (
            /* Shipping is Rhonda Allison's department. Their site takes the
               payment, sets the postage, and mails it — the studio never
               boxes anything. Prices there are theirs, so no figure is quoted
               here that this page cannot honour. */
            <div className="mt-6 border-t border-[var(--color-border)] pt-6">
              <p className="text-sm leading-relaxed text-[var(--color-muted)]">
                Shipped orders come straight from our Rhonda Allison shop — they take
                payment and mail it to you directly. Order each product there:
              </p>
              <ul className="mt-4 space-y-2">
                {rows.map((r) =>
                  r.product.external_url ? (
                    <li key={r.productId}>
                      <a
                        href={r.product.external_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-sm underline underline-offset-4 hover:text-[var(--color-accent)]"
                      >
                        Order {r.product.name} shipped ↗
                      </a>
                    </li>
                  ) : (
                    <li key={r.productId} className="text-sm text-[var(--color-muted)]">
                      {r.product.name} — studio pickup only
                    </li>
                  )
                )}
              </ul>
              <p className="mt-4 text-xs text-[var(--color-muted)]">
                Prices and postage are set at their checkout. Anything marked pickup-only
                stays in your bag here — switch back to pick it up at the studio.
              </p>
            </div>
          )}
        </div>
      </form>
    </div>
  )
}
