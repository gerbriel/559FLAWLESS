/**
 * The checkout URL a marketplace hands us (Meta Shops, and anything else that
 * speaks the same dialect).
 *
 * Meta's "checkout on another website" sends the buyer to our cart with the
 * bag in the query string:
 *
 *   /cart?products=12345%3A3%2C23456%3A1&coupon=SUMMERSALE20
 *
 * `products` is a comma-separated list of `id:quantity`, where the id is the
 * catalog content id — which for this site is the numeric product id the pixel
 * already reports (`content_ids: [String(productId)]`). `coupon` is one
 * optional code. Meta also rides `fbclid` and `cart_origin` along; the former
 * is the pixel's business, the latter is only ever analytics.
 *
 * Pure on purpose, like promotions.ts: the browser parses the URL with this,
 * the test script exercises it, and nothing here decides a price. The ids are
 * resolved against the catalog and the coupon against Stripe elsewhere.
 */

/** Same ceiling as the cart store and the checkout route. */
export const MAX_LINE_QTY = 99
/** Same ceiling as the checkout route's MAX_LINES. */
export const MAX_URL_LINES = 25

export interface CheckoutUrlLine {
  /** The id as written — numeric product id, or a SKU or slug for catalogs built that way. */
  ref: string
  qty: number
}

export interface CheckoutUrlRequest {
  lines: CheckoutUrlLine[]
  coupon: string | null
  /** Meta's cart_origin, when present. Analytics only. */
  origin: string | null
  /** True when the URL carried a products or coupon parameter at all. */
  present: boolean
}

/**
 * What a product reference may look like. Numeric ids, SKUs and slugs all fit;
 * anything else is somebody typing, and is dropped rather than queried.
 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/

/** Codes are uppercased and trimmed; Stripe matches them case-insensitively anyway. */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/

export function normalizeCouponCode(raw: string | null | undefined): string | null {
  const code = (raw ?? '').trim()
  if (!code || !CODE_PATTERN.test(code)) return null
  return code.toUpperCase()
}

/**
 * Parse the `products` value. Malformed entries are skipped, not fatal — a bag
 * with one bad line should still arrive with its good ones. Repeats of the
 * same id are summed; quantities are clamped to the cart's ceiling.
 */
export function parseProductsParam(raw: string | null | undefined): CheckoutUrlLine[] {
  if (!raw) return []
  const byRef = new Map<string, number>()
  for (const entry of raw.split(',')) {
    const [ref, qtyText, ...rest] = entry.trim().split(':')
    if (rest.length > 0 || !ref || !REF_PATTERN.test(ref)) continue
    // Meta always sends a quantity; a bare id is read as one, which is what a
    // person pasting a link would mean.
    const qty = qtyText === undefined || qtyText === '' ? 1 : Number(qtyText)
    if (!Number.isInteger(qty) || qty < 1) continue
    byRef.set(ref, Math.min((byRef.get(ref) ?? 0) + qty, MAX_LINE_QTY))
    if (byRef.size >= MAX_URL_LINES) break
  }
  return [...byRef].map(([ref, qty]) => ({ ref, qty }))
}

/**
 * The whole request from a query string. `URLSearchParams` has already
 * undone the %3A/%2C escaping Meta applies.
 */
export function parseCheckoutUrl(params: {
  get(name: string): string | null
}): CheckoutUrlRequest {
  const products = params.get('products')
  const coupon = params.get('coupon')
  const origin = params.get('cart_origin')
  return {
    lines: parseProductsParam(products),
    coupon: normalizeCouponCode(coupon),
    origin: origin && /^[a-z_]{1,32}$/i.test(origin) ? origin.toLowerCase() : null,
    present: products !== null || coupon !== null,
  }
}

/**
 * What a coupon takes off a basket, integer cents throughout — the same
 * floor(x + 0.5) rounding as every other percent in this codebase. A flat
 * amount never exceeds the subtotal; a discount never becomes money owed.
 * It is the estimate checkout compares with the multibuy deal to pick the
 * best single cut. Stripe applies the promotion code itself, and its figure
 * replaces this one on the order once the session exists.
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
