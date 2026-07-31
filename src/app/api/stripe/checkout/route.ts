import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getStripe, stripeConfigured, siteUrl } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const MAX_LINES = 25

const Body = z.object({
  lines: z
    .array(
      z.object({
        productId: z.number().int().positive(),
        qty: z.number().int().min(1).max(99),
      })
    )
    .min(1)
    .max(MAX_LINES),
  fulfillment: z.enum(['pickup', 'shipping']).default('pickup'),
  email: z.string().email().max(254),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).nullish(),
})

/**
 * Retail checkout.
 *
 * Prices come from the products table at request time — the cart only supplies
 * ids and quantities. Stock is checked here for a good error message; the
 * authoritative decrement happens in the webhook when the order flips to paid.
 */
export async function POST(request: NextRequest) {
  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'stripe_not_configured' }, { status: 503 })
  }

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  const { lines, fulfillment, email, name, phone } = parsed.data
  const admin = createAdminClient()

  const productIds = lines.map((l) => l.productId)
  const { data: products } = await admin
    .from('products')
    .select('id, name, sku, price_cents, stock_qty, is_active, is_retail, archived_at')
    .in('id', productIds)

  const available = (products ?? []).filter(
    (p) => p.is_active && p.is_retail && p.archived_at === null
  )

  if (available.length !== productIds.length) {
    return NextResponse.json({ error: 'product_unavailable' }, { status: 409 })
  }

  const byId = new Map(available.map((p) => [p.id, p]))

  for (const line of lines) {
    const product = byId.get(line.productId)!
    if (Number(product.stock_qty) < line.qty) {
      return NextResponse.json(
        { error: 'insufficient_stock', product: product.name },
        { status: 409 }
      )
    }
  }

  // Attach to the signed-in account when there is one — read from the session
  // cookie, never from the body.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      client_id: user?.id ?? null,
      guest_email: email.toLowerCase(),
      guest_name: name,
      guest_phone: phone ?? null,
      status: 'pending_payment',
      fulfillment,
    })
    .select('id')
    .single()

  if (orderError || !order) {
    console.error('order insert failed', orderError)
    return NextResponse.json({ error: 'checkout_failed' }, { status: 500 })
  }

  const { error: itemsError } = await admin.from('order_items').insert(
    lines.map((line) => {
      const p = byId.get(line.productId)!
      return {
        order_id: order.id,
        product_id: p.id,
        name_snapshot: p.name,
        sku_snapshot: p.sku,
        unit_price_cents: p.price_cents,
        qty: line.qty,
      }
    })
  )

  if (itemsError) {
    await admin.from('orders').delete().eq('id', order.id)
    console.error('order items insert failed', itemsError)
    return NextResponse.json({ error: 'checkout_failed' }, { status: 500 })
  }

  const stripe = getStripe()
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: email,
    line_items: lines.map((line) => {
      const p = byId.get(line.productId)!
      return {
        quantity: line.qty,
        price_data: {
          currency: 'usd',
          unit_amount: p.price_cents,
          product_data: { name: p.name },
        },
      }
    }),
    ...(fulfillment === 'shipping'
      ? { shipping_address_collection: { allowed_countries: ['US' as const] } }
      : {}),
    success_url: `${siteUrl()}/shop/confirmation?order=${order.id}`,
    cancel_url: `${siteUrl()}/cart?cancelled=1`,
    metadata: { kind: 'product_order', order_id: String(order.id) },
  })

  await admin
    .from('orders')
    .update({ stripe_session_id: session.id })
    .eq('id', order.id)

  return NextResponse.json({ url: session.url, order_id: order.id })
}
