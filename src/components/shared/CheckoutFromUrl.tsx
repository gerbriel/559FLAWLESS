'use client'

import { useEffect, useRef } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { useCart } from '@/store/cart'
import { parseCheckoutUrl } from '@/lib/checkout-url'
import { trackCartEvent } from './ClientAnalytics'

/**
 * Fills the bag from a marketplace checkout URL, then cleans the address bar.
 *
 * Meta Shops lands buyers on /cart?products=ID:QTY,...&coupon=CODE. The ids
 * are resolved against the live catalog — SKU or slug first, numeric id
 * after — and only products that can actually be bought here
 * (active, retail, in the public read policy) make it in. Quantities are SET,
 * not added, so a refresh or a second tap on the same ad is the same bag.
 *
 * Renders nothing. Must sit behind a Suspense boundary: /cart is prerendered
 * and useSearchParams bails the subtree out of that.
 */
export function CheckoutFromUrl() {
  const params = useSearchParams()
  const router = useRouter()
  // Strict mode runs effects twice in dev, and the route re-renders when the
  // params are replaced. One URL, one application.
  const handled = useRef<string | null>(null)

  useEffect(() => {
    const key = params.toString()
    if (handled.current === key) return
    handled.current = key

    const request = parseCheckoutUrl(params)
    if (!request.present) return

    let cancelled = false

    async function apply() {
      const { setQty, setCoupon } = useCart.getState()
      let placed = 0
      let missing = 0

      if (request.lines.length > 0) {
        const supabase = createClient()
        const numeric = request.lines.filter((l) => /^\d{1,12}$/.test(l.ref)).map((l) => Number(l.ref))
        // Every ref, digits included: an all-digit ref may be a SKU (barcode
        // style) rather than an id, so it is looked up both ways.
        const named = request.lines.map((l) => l.ref)

        // Only what the shop sells. Staff can read every product through RLS,
        // so without these a signed-in stylist following an ad could land a
        // back-bar item or an archived one in a bag.
        const [byId, byName] = await Promise.all([
          numeric.length > 0
            ? supabase
                .from('products')
                .select('id, sku, slug, stock_qty, price_cents')
                .in('id', numeric)
                .eq('is_active', true)
                .eq('is_retail', true)
                .is('archived_at', null)
            : Promise.resolve({ data: [] as Found[] }),
          named.length > 0
            ? supabase
                .from('products')
                .select('id, sku, slug, stock_qty, price_cents')
                // The refs have already passed a [A-Za-z0-9._-] filter, so
                // they are safe inside PostgREST's in.() without quoting.
                .or(`sku.in.(${named.join(',')}),slug.in.(${named.join(',')})`)
                .eq('is_active', true)
                .eq('is_retail', true)
                .is('archived_at', null)
            : Promise.resolve({ data: [] as Found[] }),
        ])
        if (cancelled) return

        const found: Found[] = [...(byId.data ?? []), ...(byName.data ?? [])]
        for (const line of request.lines) {
          // A SKU (or slug) match wins over an id match: a catalog keyed by
          // numeric SKUs means the SKU, and an id that happens to collide
          // with it is a different product.
          const product =
            found.find((p) => p.sku === line.ref || p.slug === line.ref) ??
            found.find((p) => String(p.id) === line.ref)
          // Anything priced and stocked goes in. Out-of-stock items still go
          // in — the bag shows "Only N left" and checkout refuses — so the
          // buyer sees what they asked for rather than a silently shorter bag.
          if (!product || product.price_cents <= 0) {
            missing++
            continue
          }
          setQty(product.id, line.qty)
          placed++
        }
      }

      if (request.coupon) setCoupon(request.coupon)

      if (placed > 0) {
        void trackCartEvent('add', {
          source: 'checkout_url',
          origin: request.origin,
          lines: placed,
          coupon: request.coupon !== null,
        })
      }

      if (missing > 0) {
        toast.error(
          placed > 0
            ? 'Some of those products are not sold here any more.'
            : 'Those products are not sold here any more.'
        )
      } else if (placed > 0 && request.coupon) {
        toast.success(
          `Added to your bag. Code ${request.coupon} is checked at checkout. The best single discount applies.`
        )
      } else if (placed > 0) {
        toast.success('Added to your bag.')
      }

      // The bag now holds everything the URL said; the URL itself has done
      // its job. Replacing it keeps a bookmark or refresh from re-applying,
      // and keeps the pixel's fbclid out of anything that gets shared.
      router.replace('/cart')
    }

    void apply()
    return () => {
      cancelled = true
    }
  }, [params, router])

  return null
}

interface Found {
  id: number
  sku: string
  slug: string
  stock_qty: number
  price_cents: number
}
