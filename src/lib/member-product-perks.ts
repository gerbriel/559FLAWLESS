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
 * How many times a limited perk has already won inside its window (087), as
 * perk_uses_so_far() counted it. A perk with no entry has used nothing.
 */
export interface PerkAvailability {
  perkId: number
  usesSoFar: number
}

/** What one perk does to a basket: the cut, and how many units it reached. */
export interface PerkPricing {
  off: number
  units: number
}

/** Has this perk used up its max_uses? Unlimited perks never have. */
export function perkExhausted(
  perk: Pick<MembershipProductPerk, 'id' | 'max_uses'>,
  availability: PerkAvailability[] | undefined
): boolean {
  if (perk.max_uses == null) return false
  const max = Math.trunc(perk.max_uses)
  if (max < 1) return false
  const used = availability?.find((a) => a.perkId === perk.id)?.usesSoFar ?? 0
  return used >= max
}

/**
 * What one perk takes off the whole basket, and how many units it discounted.
 *
 *   percent_off  every eligible unit, each rounded on its own. With
 *                max_units_per_use N, only the dearest N eligible units:
 *                a limit is worth most where the price is highest, the way
 *                an included session takes the dearest treatment.
 *   buy_get      for every FULL group of buy_qty + 1 eligible units, the
 *                cheapest eligible units get percent_off. Cheapest first,
 *                the same reading as multibuyDiscountCents: six units on a
 *                buy-1-get-1 free perk make the three cheapest free. With
 *                max_units_per_use N, at most N units (N groups).
 */
export function perkPricing(perk: MembershipProductPerk, units: PerkUnit[]): PerkPricing {
  const none = { off: 0, units: 0 }
  if (perk.percent_off <= 0) return none
  const prices = units.filter((u) => perkApplies(perk, u)).map((u) => Math.trunc(u.priceCents))
  if (prices.length === 0) return none
  const cap =
    perk.max_units_per_use != null && Math.trunc(perk.max_units_per_use) >= 1
      ? Math.trunc(perk.max_units_per_use)
      : Infinity

  if (perk.kind === 'percent_off') {
    const reached = cap < prices.length ? [...prices].sort((a, b) => b - a).slice(0, cap) : prices
    return {
      off: reached.reduce((sum, cents) => sum + pairDiscountCents(cents, perk.percent_off), 0),
      units: reached.length,
    }
  }

  const buy = Math.trunc(perk.buy_qty ?? 0)
  if (buy < 1) return none
  const groups = Math.min(Math.floor(prices.length / (buy + 1)), cap)
  if (groups === 0) return none
  const cheapestFirst = [...prices].sort((a, b) => a - b)
  let off = 0
  for (let i = 0; i < groups; i++) off += pairDiscountCents(cheapestFirst[i], perk.percent_off)
  return { off, units: groups }
}

/** What one perk takes off the whole basket, integer cents. See perkPricing. */
export function perkDiscountCents(perk: MembershipProductPerk, units: PerkUnit[]): number {
  return perkPricing(perk, units).off
}

/**
 * The single best perk for this basket, or null when none takes anything off.
 * A perk whose max_uses is spent (per `availability`) is skipped; without
 * `availability` every perk is treated as unused, which is right for a
 * preview with nobody signed in and wrong anywhere money is decided. Ties go
 * first to an unlimited perk (max_uses null), so a capped use is never spent
 * where an unlimited perk gives the same cut, then to the lower sort_order,
 * then the lower id, so the answer is the same every time the basket is
 * priced. `units` is how many units the winner discounted.
 */
export function bestProductPerk(
  perks: MembershipProductPerk[],
  units: PerkUnit[],
  availability?: PerkAvailability[]
): { perk: MembershipProductPerk; off: number; units: number } | null {
  let best: { perk: MembershipProductPerk; off: number; units: number } | null = null
  for (const perk of perks) {
    if (perkExhausted(perk, availability)) continue
    const priced = perkPricing(perk, units)
    const off = priced.off
    if (off <= 0) continue
    if (!best || off > best.off || (off === best.off && winsTie(perk, best.perk))) {
      best = { perk, off, units: priced.units }
    }
  }
  return best
}

/** Between two perks giving the same cut: unlimited first, then sort_order, then id. */
function winsTie(a: MembershipProductPerk, b: MembershipProductPerk): boolean {
  const aUnlimited = a.max_uses == null
  const bUnlimited = b.max_uses == null
  if (aUnlimited !== bUnlimited) return aUnlimited
  if (a.sort_order !== b.sort_order) return a.sort_order < b.sort_order
  return a.id < b.id
}
