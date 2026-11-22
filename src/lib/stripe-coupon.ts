import 'server-only'
import type Stripe from 'stripe'
import { couponCustomerAllows, couponCutCents, normalizeCouponCode } from '@/lib/coupon-code'

/**
 * Promo codes for retail checkout live in Stripe, not in `promotions`.
 *
 * The deal board (068) knows five kinds of deal and none of them is "type a
 * code". A shopper types one in the bag, and that needs a place where the
 * studio defines what a code is worth. Stripe's promotion codes are that
 * place — the dashboard already exists, and codes carry their own expiry,
 * redemption cap, minimum and first-purchase rules, which Stripe enforces
 * because the session is handed the promotion code itself.
 *
 * Codes that need a Stripe product (applies_to) are refused. Codes that need
 * a Stripe customer on the session (customer-locked, first-purchase only) are
 * accepted for a signed-in shopper, who has one (091), and refused for a
 * guest; see lookupCoupon.
 *
 * Only USD, only `once` or forever coupons make sense on a one-off payment;
 * a repeating coupon is treated like `once` because that is what a single
 * Checkout Session does with it anyway.
 */

export interface RedeemableCoupon {
  /** The code as the shopper will see it on the receipt. */
  code: string
  promotionCodeId: string
  percent_off: number | null
  amount_off_cents: number | null
  minimum_amount_cents: number | null
  first_time_transaction: boolean
}

export type CouponLookup =
  | { ok: true; coupon: RedeemableCoupon }
  | { ok: false; reason: 'invalid_coupon' | 'coupon_minimum' }

/**
 * The live promotion code behind `raw`, or why there is none. `customerId` is
 * the shopper's own Stripe customer, from the server (stripe-customer.ts),
 * when they are signed in; null or absent for a guest.
 */
export async function lookupCoupon(
  stripe: Stripe,
  raw: string,
  customerId?: string | null
): Promise<CouponLookup> {
  const code = normalizeCouponCode(raw)
  if (!code) return { ok: false, reason: 'invalid_coupon' }

  const { data } = await stripe.promotionCodes.list({
    code,
    active: true,
    limit: 1,
    expand: ['data.promotion.coupon'],
  })
  const promo = data[0]
  if (!promo) return { ok: false, reason: 'invalid_coupon' }

  // `active` already folds in the coupon's validity and the redemption cap,
  // but Stripe's own docs hedge on expiry, so both are checked here too.
  const now = Math.floor(Date.now() / 1000)
  if (promo.expires_at !== null && promo.expires_at <= now) return { ok: false, reason: 'invalid_coupon' }
  if (promo.max_redemptions !== null && promo.times_redeemed >= promo.max_redemptions) {
    return { ok: false, reason: 'invalid_coupon' }
  }

  const coupon = promo.promotion.type === 'coupon' ? promo.promotion.coupon : null
  if (!coupon || typeof coupon === 'string' || !coupon.valid) {
    return { ok: false, reason: 'invalid_coupon' }
  }
  if (coupon.amount_off !== null && (coupon.currency ?? 'usd').toLowerCase() !== 'usd') {
    return { ok: false, reason: 'invalid_coupon' }
  }

  // The session passes the promotion code itself, so Stripe enforces its
  // rules, and some of them cannot be met by every checkout. Refused here so
  // the shopper hears "that code does not work" rather than a Stripe error.
  // - applies_to: our line items are ad hoc price_data with no Stripe product
  //   id, so a product-limited coupon can never match anything.
  // - customer / customer_account / first_time_transaction: these need a
  //   customer on the session. A signed-in shopper's session carries their
  //   own (091); a guest's carries only an email. couponCustomerAllows has
  //   the rule and its test.
  if (coupon.applies_to && coupon.applies_to.products.length > 0) {
    return { ok: false, reason: 'invalid_coupon' }
  }
  const lockedTo = promo.customer
    ? typeof promo.customer === 'string'
      ? promo.customer
      : promo.customer.id
    : null
  if (
    !couponCustomerAllows(
      {
        customer: lockedTo,
        customerAccount: Boolean(promo.customer_account),
        firstTimeOnly: promo.restrictions.first_time_transaction,
      },
      customerId
    )
  ) {
    return { ok: false, reason: 'invalid_coupon' }
  }

  const minCurrency = (promo.restrictions.minimum_amount_currency ?? 'usd').toLowerCase()
  return {
    ok: true,
    coupon: {
      code: promo.code.toUpperCase(),
      promotionCodeId: promo.id,
      percent_off: coupon.percent_off,
      amount_off_cents: coupon.amount_off,
      minimum_amount_cents:
        minCurrency === 'usd' ? promo.restrictions.minimum_amount : null,
      first_time_transaction: promo.restrictions.first_time_transaction,
    },
  }
}

/**
 * What the code takes off this basket, or why it cannot apply to it. Pure
 * apart from the input; the arithmetic lives in coupon-code.ts with its test.
 */
export function couponDiscountFor(
  coupon: RedeemableCoupon,
  subtotalCents: number
): { ok: true; cents: number } | { ok: false; reason: 'coupon_minimum' } {
  if (coupon.minimum_amount_cents !== null && subtotalCents < coupon.minimum_amount_cents) {
    return { ok: false, reason: 'coupon_minimum' }
  }
  return { ok: true, cents: couponCutCents(coupon, subtotalCents) }
}
