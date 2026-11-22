import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getStripe, stripeConfigured, siteUrl } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { multibuyDiscountCents, multibuyPromo, type PromotionRule } from '@/lib/promotions'
import { couponDiscountFor, lookupCoupon, type RedeemableCoupon } from '@/lib/stripe-coupon'
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit'
import { currentMembershipPerks } from '@/lib/memberships'
import { bestProductPerk, type PerkUnit } from '@/lib/member-product-perks'

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
  // Pickup only. Shipping was retired from studio checkout: shipped orders go
  // through the Rhonda Allison storefront, which takes payment and mails them
  // itself — the studio ships nothing. Refusing here keeps an old tab honest.
  fulfillment: z.literal('pickup').default('pickup'),
  email: z.string().email().max(254),
  name: z.string().trim().min(1).max(120),
  phone: z.string().trim().max(40).nullish(),
  // A promo code, typed in the bag. Looked up in Stripe below; the client never says what
  // it is worth, only which one.
  coupon: z.string().trim().max(40).nullish(),
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

  // A stranger's route that now answers "is this code real": the budget is
  // what stops guessing from being free. Fails open like every limiter here.
  const { allowed } = await checkRateLimit(request, 'checkout')
  if (!allowed) return rateLimitedResponse('checkout')

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  const { lines, fulfillment, email, name, phone, coupon: couponCode } = parsed.data
  const admin = createAdminClient()

  const productIds = lines.map((l) => l.productId)
  const { data: products } = await admin
    .from('products')
    .select('id, name, sku, price_cents, category_id, stock_qty, is_active, is_retail, archived_at')
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

  const subtotal = lines.reduce(
    (sum, line) => sum + byId.get(line.productId)!.price_cents * line.qty,
    0
  )

  // The multibuy deal (068), same arithmetic as the till: whole basket,
  // cheapest units first. The order carries it so the totals trigger agrees,
  // and Stripe gets it as a one-off coupon so the charge agrees too.
  const { data: promoRows } = await admin
    .from('promotions')
    .select(
      'id, name, kind, percent_off, amount_cents, sale_price_cents, min_items, service_ids, starts_at, ends_at, is_active'
    )
    .eq('is_active', true)
    .eq('kind', 'product_multibuy')
  const multibuy = multibuyPromo((promoRows ?? []) as PromotionRule[], Date.now())
  const multibuyCents = multibuy
    ? multibuyDiscountCents(
        multibuy,
        lines.flatMap((l) => Array<number>(l.qty).fill(byId.get(l.productId)!.price_cents))
      )
    : 0

  // The signed-in shopper's membership perks (086): each perk priced over the
  // whole basket, the single best one kept. A guest has no membership to ask
  // about, so this is null for them without a query.
  const units: PerkUnit[] = lines.flatMap((l) => {
    const p = byId.get(l.productId)!
    return Array.from({ length: l.qty }, () => ({
      productId: p.id,
      categoryId: p.category_id,
      priceCents: p.price_cents,
    }))
  })
  const memberPerks = await currentMembershipPerks(user?.id ?? null)
  const memberBest = memberPerks ? bestProductPerk(memberPerks.perks, units) : null
  const memberCents = memberBest?.off ?? 0

  // The promo code, checked before any order row exists so a bad code leaves
  // nothing behind. Refused loudly rather than silently charged full price:
  // a shopper who typed a code wants to know it did not take.
  let coupon: RedeemableCoupon | null = null
  let couponCents = 0
  if (couponCode) {
    const found = await lookupCoupon(getStripe(), couponCode)
    if (!found.ok) {
      return NextResponse.json({ error: found.reason, code: couponCode }, { status: 409 })
    }
    const cut = couponDiscountFor(found.coupon, subtotal)
    if (!cut.ok) {
      return NextResponse.json(
        { error: cut.reason, code: found.coupon.code, minimum_cents: found.coupon.minimum_amount_cents },
        { status: 409 }
      )
    }
    coupon = found.coupon
    couponCents = cut.cents
  }

  // Discounts never stack (068): the best single cut wins among the promo
  // code, the membership's best perk and the multibuy deal. Stripe allows one
  // discount per Checkout Session anyway, so this is also the only honest
  // reading of a code plus a running deal. Ties go coupon, then membership,
  // then multibuy: a code the shopper typed should not silently lose a tie,
  // and a member's own entitlement outranks a deal anyone gets.
  let source: 'coupon' | 'membership' | 'multibuy' | null = null
  let discount = 0
  if (coupon !== null && couponCents > 0) {
    source = 'coupon'
    discount = couponCents
  }
  if (memberCents > discount) {
    source = 'membership'
    discount = memberCents
  }
  if (multibuy && multibuyCents > discount) {
    source = 'multibuy'
    discount = multibuyCents
  }
  const couponWins = source === 'coupon'

  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      client_id: user?.id ?? null,
      guest_email: email.toLowerCase(),
      guest_name: name,
      guest_phone: phone ?? null,
      status: 'pending_payment',
      fulfillment,
      discount_cents: discount,
      discount_source: source,
      client_membership_id: source === 'membership' ? memberPerks!.clientMembershipId : null,
      // Online there is no manual discount, so the whole cut is the deal's.
      deal_discount_cents: discount,
      // Recorded whether or not it won: the shopper used it, and the
      // studio wants to know which codes get typed.
      promo_code: coupon?.code ?? null,
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

  // A winning promo code reaches Stripe as the promotion code itself, so
  // Stripe enforces its own rules (redemption cap, expiry, minimum) and its
  // redemption counter ticks. couponCents is only our estimate for picking
  // the best single cut; after the session exists, Stripe's figure replaces
  // it on the order. The multibuy deal and a membership perk are ours, not
  // Stripe's, so either goes as a single-use coupon named for the deal or the
  // plan: line items stay at list price (the receipt shows the deal rather
  // than quietly cheaper bottles), and the webhook's recorded payment matches
  // the order total.
  let discounts: ({ coupon: string } | { promotion_code: string })[] | undefined
  if (couponWins) {
    discounts = [{ promotion_code: coupon!.promotionCodeId }]
  } else if (discount > 0) {
    const dealName = source === 'membership' ? memberPerks!.planName : multibuy!.name
    const stripeCoupon = await stripe.coupons.create({
      amount_off: discount,
      currency: 'usd',
      duration: 'once',
      name: dealName.slice(0, 40),
    })
    discounts = [{ coupon: stripeCoupon.id }]
  }

  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: email,
    ...(discounts ? { discounts } : {}),
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
    // `amount` rides along for the confirmation page's ad pixel, which needs a
    // value and has no other honest way to get one: the page is public, the
    // order may be a guest's, and letting it look totals up by guessable id
    // would leak every order's value to anyone counting upward. This is
    // marketing telemetry only — the webhook remains the record of payment,
    // and a client editing their own URL edits nothing but their own ad
    // attribution. It is fixed before Stripe has priced the session, so for
    // a promotion code it carries our estimate (couponCents), which can be
    // a cent off Stripe's rounding; the order row carries Stripe's figure.
    success_url: `${siteUrl()}/shop/confirmation?order=${order.id}&amount=${Math.max(
      subtotal - discount,
      0
    )}`,
    cancel_url: `${siteUrl()}/cart?cancelled=1`,
    metadata: { kind: 'product_order', order_id: String(order.id) },
  })

  // What Stripe will actually take off, to the cent. For a promotion code
  // that is Stripe's own rounding of the percent, which the order must match
  // or the totals trigger and the charge disagree.
  const stripeDiscount = session.total_details?.amount_discount
  const chargedDiscount = typeof stripeDiscount === 'number' ? stripeDiscount : discount

  await admin
    .from('orders')
    .update({
      stripe_session_id: session.id,
      ...(chargedDiscount !== discount
        ? {
            discount_cents: chargedDiscount,
            // Online the whole cut is the deal's, so the deal figure follows
            // Stripe's to the cent. In practice only a promo code is ever
            // repriced (a percent rounded by Stripe); an amount_off coupon
            // for the multibuy or a member perk charges exactly `discount`.
            ...(source !== null ? { deal_discount_cents: chargedDiscount } : {}),
          }
        : {}),
    })
    .eq('id', order.id)

  // The deal's paper trail, for a multibuy win only: a membership win is
  // recorded on the order itself (discount_source, client_membership_id), and
  // a promo code is counted by Stripe. Written now rather than in the webhook,
  // because an abandoned checkout leaves an unpaid order AND its redemption
  // row behind, and both read as what they are: an order that never happened.
  if (multibuy && source === 'multibuy' && discount > 0) {
    await admin.from('promotion_redemptions').insert({
      promotion_id: multibuy.id,
      promotion_name: multibuy.name,
      client_id: user?.id ?? null,
      order_id: order.id,
      discount_cents: discount,
    })
  }

  return NextResponse.json({ url: session.url, order_id: order.id })
}
