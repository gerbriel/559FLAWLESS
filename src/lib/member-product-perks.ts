/**
 * Membership product perks (086): pure on purpose, like promotions.ts.
 *
 * The checkout and the till apply these where retail prices are decided; the
 * membership editor and the public plan card import the same functions to
 * preview them. One implementation, so the preview and the receipt can never
 * be two roundings of the same idea.
 *
 * The policy, stated once: each perk is priced over the whole basket on its
 * own, and the single best perk wins. That figure then competes with the
 * multibuy deal and any promo code, and the best single cut wins (068).
 * Nothing stacks. This module answers only the first half; the routes settle
 * the competition.
 *
 * Every amount is integer cents. The only percentage-to-money step is
 * pairDiscountCents, half-up in integers.
 */

import { pairDiscountCents } from '@/lib/pair-discounts'
import type { MembershipProductPerk } from '@/types/memberships'

/** One unit on the shelf. Quantity three is three entries. */
export interface PerkUnit {
  productId: number
  categoryId: number | null
  priceCents: number
}

/** Does this perk reach this unit? A free unit is never discounted. */
export function perkApplies(
  perk: Pick<MembershipProductPerk, 'product_id' | 'category_id'>,
  unit: PerkUnit
): boolean {
  if (unit.priceCents <= 0) return false
  if (perk.product_id !== null) return unit.productId === perk.product_id
  if (perk.category_id !== null) return unit.categoryId === perk.category_id
  return true
}

/**
 * What one perk takes off the whole basket, integer cents.
 *
 *   percent_off  every eligible unit, each rounded on its own.
 *   buy_get      for every FULL group of buy_qty + 1 eligible units, the
 *                cheapest eligible units get percent_off. Cheapest first,
 *                the same reading as multibuyDiscountCents: six units on a
 *                buy-1-get-1 free perk make the three cheapest free.
 */
export function perkDiscountCents(perk: MembershipProductPerk, units: PerkUnit[]): number {
  if (perk.percent_off <= 0) return 0
  const prices = units.filter((u) => perkApplies(perk, u)).map((u) => Math.trunc(u.priceCents))
  if (prices.length === 0) return 0

  if (perk.kind === 'percent_off') {
    return prices.reduce((sum, cents) => sum + pairDiscountCents(cents, perk.percent_off), 0)
  }

  const buy = Math.trunc(perk.buy_qty ?? 0)
  if (buy < 1) return 0
  const groups = Math.floor(prices.length / (buy + 1))
  if (groups === 0) return 0
  const cheapestFirst = [...prices].sort((a, b) => a - b)
  let off = 0
  for (let i = 0; i < groups; i++) off += pairDiscountCents(cheapestFirst[i], perk.percent_off)
  return off
}

/**
 * The single best perk for this basket, or null when none takes anything off.
 * Ties go to the lower sort_order, then the lower id, so the answer is the
 * same every time the basket is priced.
 */
export function bestProductPerk(
  perks: MembershipProductPerk[],
  units: PerkUnit[]
): { perk: MembershipProductPerk; off: number } | null {
  let best: { perk: MembershipProductPerk; off: number } | null = null
  for (const perk of perks) {
    const off = perkDiscountCents(perk, units)
    if (off <= 0) continue
    if (
      !best ||
      off > best.off ||
      (off === best.off &&
        (perk.sort_order < best.perk.sort_order ||
          (perk.sort_order === best.perk.sort_order && perk.id < best.perk.id)))
    ) {
      best = { perk, off }
    }
  }
  return best
}
