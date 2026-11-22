/**
 * Promo codes, the pure part.
 *
 * A code is typed in the bag and checked at checkout against Stripe's
 * promotion codes (stripe-coupon.ts). Nothing here decides a price; this is
 * the shape of a code and the arithmetic the checkout route uses to compare a
 * code against the running multibuy deal, kept pure so the test script can
 * exercise it.
 */

/** Codes are uppercased and trimmed; Stripe matches them case-insensitively anyway. */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

export function normalizeCouponCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim()
  if (!code || !CODE_PATTERN.test(code)) return null
  return code.toUpperCase()
}

/**
 * What a coupon takes off a basket, integer cents throughout — the same
 * floor(x + 0.5) rounding as every other percent in this codebase. A flat
 * amount never exceeds the subtotal; a discount never becomes money owed.
 *
 * An estimate for the comparison only: the session is handed the promotion
 * code itself, and the order records what Stripe actually took off.
 */
export function couponCutCents(
  coupon: { percent_off: number | null; amount_off_cents: number | null },
  subtotalCents: number
): number {
  if (subtotalCents <= 0) return 0
  if (coupon.amount_off_cents !== null && coupon.amount_off_cents > 0) {
    return Math.min(Math.trunc(coupon.amount_off_cents), subtotalCents)
  }
  if (coupon.percent_off !== null && coupon.percent_off > 0) {
    const bounded = Math.min(Math.max(coupon.percent_off, 0), 100)
    return Math.min(Math.floor((subtotalCents * bounded + 50) / 100), subtotalCents)
  }
  return 0
}
