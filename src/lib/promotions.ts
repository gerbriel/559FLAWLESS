/**
 * Promotion arithmetic (068) — pure on purpose, like pair-discounts.ts.
 *
 * The server applies these where prices are decided (priceService, the
 * booking engine, the till, checkout); the booking flow imports the same
 * functions to preview them. One implementation, so the screen and the
 * receipt can never be two roundings of the same idea.
 *
 * The one policy every function here respects: discounts never stack on one
 * line. The best single cut wins — which is also the only arithmetic a person
 * standing at the counter can verify in their head.
 */

import { pairDiscountCents } from '@/lib/pair-discounts'
import type { PromotionKind } from '@/types/database'

export interface PromotionRule {
  id: number
  name: string
  kind: PromotionKind
  percent_off: number | null
  amount_cents: number | null
  sale_price_cents: number | null
  min_items: number | null
  service_ids: number[]
  starts_at: string | null
  ends_at: string | null
  is_active: boolean
}

/** Inside its window and switched on. Null bounds are open ends. */
export function promotionIsLive(p: PromotionRule, nowMs: number): boolean {
  if (!p.is_active) return false
  if (p.starts_at && new Date(p.starts_at).getTime() > nowMs) return false
  if (p.ends_at && new Date(p.ends_at).getTime() < nowMs) return false
  return true
}

/**
 * What a service_sale takes off one line. A flat sale price wins over a
 * percent when both are set — "HELLO KITTY $175 reg $200" means $175, whatever
 * the percent works out to. A sale price above the current price cuts nothing:
 * a deal never raises a price.
 */
export function saleCutCents(rule: PromotionRule, priceCents: number): number {
  if (rule.sale_price_cents !== null && rule.sale_price_cents >= 0) {
    return Math.max(priceCents - rule.sale_price_cents, 0)
  }
  if (rule.percent_off) return pairDiscountCents(priceCents, rule.percent_off)
  return 0
}

/** The deepest live sale covering this service, with its cut. */
export function bestSaleForService(
  rules: PromotionRule[],
  serviceId: number,
  priceCents: number,
  nowMs: number
): { rule: PromotionRule; off: number } | null {
  let best: { rule: PromotionRule; off: number } | null = null
  for (const r of rules) {
    if (r.kind !== 'service_sale') continue
    if (!promotionIsLive(r, nowMs)) continue
    if (!r.service_ids.includes(serviceId)) continue
    const off = saleCutCents(r, priceCents)
    if (off > 0 && (best === null || off > best.off)) best = { rule: r, off }
  }
  return best
}

/** The live "mix and match" rule, deepest percent first. */
export function secondServicePromo(rules: PromotionRule[], nowMs: number): PromotionRule | null {
  let best: PromotionRule | null = null
  for (const r of rules) {
    if (r.kind !== 'second_service' || !r.percent_off) continue
    if (!promotionIsLive(r, nowMs)) continue
    if (best === null || r.percent_off > best.percent_off!) best = r
  }
  return best
}

export function newClientPromo(rules: PromotionRule[], nowMs: number): PromotionRule | null {
  let best: PromotionRule | null = null
  for (const r of rules) {
    if (r.kind !== 'new_client' || !r.percent_off) continue
    if (!promotionIsLive(r, nowMs)) continue
    if (best === null || r.percent_off > best.percent_off!) best = r
  }
  return best
}

export function multibuyPromo(rules: PromotionRule[], nowMs: number): PromotionRule | null {
  for (const r of rules) {
    if (r.kind !== 'product_multibuy') continue
    if (!r.percent_off || !r.min_items) continue
    if (promotionIsLive(r, nowMs)) return r
  }
  return null
}

/** The referral program's live reward config — the newest active row governs. */
export function referralPromo(rules: PromotionRule[], nowMs: number): PromotionRule | null {
  for (const r of rules) {
    if (r.kind !== 'referral') continue
    if (!r.amount_cents && !r.percent_off) continue
    if (promotionIsLive(r, nowMs)) return r
  }
  return null
}

/**
 * "Buy 2 get the 3rd half off", generalised: for every FULL group of
 * min_items units in the basket, the cheapest units in the basket get
 * percent_off. Six items on a buy-3 deal discount the two cheapest.
 * Cheapest-first is the reading that can never be accused of gaming the
 * grouping — it is also how every big retailer words it.
 */
export function multibuyDiscountCents(rule: PromotionRule, unitPricesCents: number[]): number {
  if (!rule.percent_off || !rule.min_items) return 0
  const groups = Math.floor(unitPricesCents.length / rule.min_items)
  if (groups === 0) return 0
  const cheapestFirst = [...unitPricesCents].sort((a, b) => a - b)
  let off = 0
  for (let i = 0; i < groups; i++) off += pairDiscountCents(cheapestFirst[i], rule.percent_off)
  return off
}

/** A percent-or-flat reward turned into cents against a base. */
export function rewardCents(rule: PromotionRule, baseCents: number): number {
  if (rule.amount_cents) return rule.amount_cents
  if (rule.percent_off) return pairDiscountCents(baseCents, rule.percent_off)
  return 0
}

/** Plain-language value of a deal, for lists and previews. */
export function promotionValueLabel(p: PromotionRule): string {
  switch (p.kind) {
    case 'service_sale':
      return p.sale_price_cents !== null
        ? `sale price on ${p.service_ids.length} service${p.service_ids.length === 1 ? '' : 's'}`
        : `${p.percent_off}% off ${p.service_ids.length} service${p.service_ids.length === 1 ? '' : 's'}`
    case 'second_service':
      return `2nd service ${p.percent_off}% off`
    case 'product_multibuy':
      return `buy ${(p.min_items ?? 1) - 1}, next ${p.percent_off}% off`
    case 'new_client':
      return `${p.percent_off}% off first visit`
    case 'referral':
      return p.amount_cents
        ? `referrer earns $${Math.floor(p.amount_cents / 100)}`
        : `referrer earns ${p.percent_off}% off a visit`
  }
}

export const PROMOTION_KIND_LABELS: Record<PromotionKind, string> = {
  service_sale: 'Sale price on services',
  second_service: 'Second service % off',
  product_multibuy: 'Buy several products, cheapest % off',
  new_client: 'New client % off',
  referral: 'Referral reward',
}
