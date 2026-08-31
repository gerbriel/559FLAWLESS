/**
 * The pair deal: book the trigger service, and the discounted service in the
 * same visit is percent_off cheaper (067).
 *
 * This module is pure on purpose. `priceService()` uses it to set the price
 * that actually books, and `BookingFlow` uses the same functions to show that
 * price before it books — one implementation, so the number on the screen and
 * the number on the appointment can never be two roundings of the same idea.
 * The server stays authoritative either way: what the flow displays is a
 * preview, what priceService computes is the booking.
 */

export interface PairDiscountRule {
  id: number
  trigger_service_id: number
  discounted_service_id: number
  percent_off: number
  /** Client-facing copy for the service card. */
  label: string
}

/**
 * A percentage turned into money, integer cents throughout. Same arithmetic as
 * `membershipDiscountCents` — floor(x + 0.5) rounding, no float on the way in
 * or out.
 */
export function pairDiscountCents(fullCents: number, percentOff: number): number {
  if (fullCents <= 0 || percentOff <= 0) return 0
  const bounded = Math.min(Math.max(Math.trunc(percentOff), 0), 100)
  return Math.floor((Math.trunc(fullCents) * bounded + 50) / 100)
}

/**
 * The rule that applies to `serviceId` given everything in the visit, or null.
 * A service is never its own trigger, and when several selected services each
 * pair with it (three facials, one Brazilian), the deepest cut wins — there is
 * one discounted line, not one per facial.
 */
export function bestPairDiscount(
  rules: PairDiscountRule[],
  visitServiceIds: number[],
  serviceId: number
): PairDiscountRule | null {
  let best: PairDiscountRule | null = null
  for (const r of rules) {
    if (r.discounted_service_id !== serviceId) continue
    if (r.trigger_service_id === serviceId) continue
    if (!visitServiceIds.includes(r.trigger_service_id)) continue
    if (best === null || r.percent_off > best.percent_off) best = r
  }
  return best
}
