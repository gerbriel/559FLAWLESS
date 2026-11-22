/**
 * Membership product perk tests (086). Run with:
 *   npx tsx scripts/member-product-perks.test.ts
 *
 * These decide what a member's bottle costs at the till and at checkout, and
 * the failure mode is never an exception: it is a buy-one-get-one that frees
 * the dearer bottle, or a category perk that quietly reaches the whole shelf.
 */

import assert from 'node:assert/strict'
import { bestProductPerk, perkApplies, perkDiscountCents, perkPricing, type PerkUnit } from '../src/lib/member-product-perks'
import { describePerkLimit, describeProductPerk, type MembershipProductPerk } from '../src/types/memberships'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    passed++
    console.log(`  PASS  ${name}`)
  } catch (err) {
    failed++
    console.log(`  FAIL  ${name}`)
    console.log(`        ${(err as Error).message.split('\n')[0]}`)
  }
}

let nextId = 1
function perk(p: Partial<MembershipProductPerk> & Pick<MembershipProductPerk, 'kind' | 'percent_off'>): MembershipProductPerk {
  return {
    id: nextId++,
    membership_id: 1,
    buy_qty: null,
    product_id: null,
    category_id: null,
    label: null,
    sort_order: 0,
    max_uses: null,
    uses_window: 'period',
    max_units_per_use: null,
    ...p,
  }
}

/** `n` units of one product. */
function units(productId: number, categoryId: number | null, priceCents: number, n = 1): PerkUnit[] {
  return Array.from({ length: n }, () => ({ productId, categoryId, priceCents }))
}

const CLEANSER = 10
const SERUM = 11
const SPF = 12
const CLEANSERS_CAT = 1
const SERUMS_CAT = 2

// ── Percent off ─────────────────────────────────────────────
console.log('\nPercent off')

test('on all products, every unit, each rounded half-up', () => {
  const p = perk({ kind: 'percent_off', percent_off: 15 })
  // 15% of 3250 = 487.5 -> 488; 15% of 1999 = 299.85 -> 300; twice.
  const basket = [...units(CLEANSER, CLEANSERS_CAT, 3250), ...units(SERUM, SERUMS_CAT, 1999, 2)]
  assert.equal(perkDiscountCents(p, basket), 488 + 300 + 300)
})

test('scoped to one product reaches only that product', () => {
  const p = perk({ kind: 'percent_off', percent_off: 20, product_id: CLEANSER })
  const basket = [...units(CLEANSER, CLEANSERS_CAT, 3000, 2), ...units(SERUM, SERUMS_CAT, 5000)]
  assert.equal(perkDiscountCents(p, basket), 1200)
  assert.equal(perkApplies(p, basket[2]), false)
})

test('scoped to a category reaches only that category', () => {
  const p = perk({ kind: 'percent_off', percent_off: 10, category_id: SERUMS_CAT })
  const basket = [
    ...units(CLEANSER, CLEANSERS_CAT, 3000),
    ...units(SERUM, SERUMS_CAT, 5000),
    ...units(SPF, null, 4000),
  ]
  assert.equal(perkDiscountCents(p, basket), 500)
})

// ── Buy N, get one cheaper ──────────────────────────────────
console.log('\nBuy N, get one cheaper')

const bogo = perk({ kind: 'buy_get', percent_off: 100, buy_qty: 1 })

test('buy 1 get 1 free with 2 units frees the cheaper', () => {
  const basket = [...units(CLEANSER, CLEANSERS_CAT, 3000), ...units(SERUM, SERUMS_CAT, 5000)]
  assert.equal(perkDiscountCents(bogo, basket), 3000)
})

test('buy 1 get 1 free with 3 units frees only one, the cheapest', () => {
  const basket = [
    ...units(SERUM, SERUMS_CAT, 5000),
    ...units(SPF, null, 2500),
    ...units(CLEANSER, CLEANSERS_CAT, 3000),
  ]
  assert.equal(perkDiscountCents(bogo, basket), 2500)
})

test('buy 1 get 1 free with 4 units frees the two cheapest', () => {
  const basket = [
    ...units(SERUM, SERUMS_CAT, 5000),
    ...units(SPF, null, 2500),
    ...units(CLEANSER, CLEANSERS_CAT, 3000),
    ...units(SERUM, SERUMS_CAT, 6000),
  ]
  assert.equal(perkDiscountCents(bogo, basket), 2500 + 3000)
})

test('buy 2 get the third half off', () => {
  const p = perk({ kind: 'buy_get', percent_off: 50, buy_qty: 2 })
  // Two units: no full group of three.
  assert.equal(perkDiscountCents(p, units(CLEANSER, CLEANSERS_CAT, 3000, 2)), 0)
  // Three: the cheapest (2001) is half off, 1000.5 -> 1001.
  const three = [...units(CLEANSER, CLEANSERS_CAT, 3000, 2), ...units(SPF, null, 2001)]
  assert.equal(perkDiscountCents(p, three), 1001)
  // Six: two groups, the two cheapest.
  const six = [...three, ...units(SERUM, SERUMS_CAT, 5000, 2), ...units(SPF, null, 1000)]
  assert.equal(perkDiscountCents(p, six), 500 + 1001)
})

test('a scoped buy-get counts only eligible units toward a group', () => {
  const p = perk({ kind: 'buy_get', percent_off: 100, buy_qty: 1, product_id: CLEANSER })
  const basket = [...units(CLEANSER, CLEANSERS_CAT, 3000), ...units(SERUM, SERUMS_CAT, 1000)]
  assert.equal(perkDiscountCents(p, basket), 0)
})

// ── The best single perk ────────────────────────────────────
console.log('\nThe best single perk')

test('a scoped perk beats an all-products perk when the basket is its product', () => {
  const all = perk({ kind: 'percent_off', percent_off: 10 })
  const cleanser = perk({ kind: 'buy_get', percent_off: 100, buy_qty: 1, product_id: CLEANSER })
  const basket = [...units(CLEANSER, CLEANSERS_CAT, 3000, 2), ...units(SERUM, SERUMS_CAT, 5000)]
  // all: 300 + 300 + 500 = 1100; cleanser BOGO: 3000.
  const best = bestProductPerk([all, cleanser], basket)
  assert.equal(best?.perk.id, cleanser.id)
  assert.equal(best?.off, 3000)
})

test('an all-products perk beats a scoped perk when the basket is mostly elsewhere', () => {
  const all = perk({ kind: 'percent_off', percent_off: 15 })
  const cleanser = perk({ kind: 'percent_off', percent_off: 30, product_id: CLEANSER })
  const basket = [...units(CLEANSER, CLEANSERS_CAT, 2000), ...units(SERUM, SERUMS_CAT, 8000, 2)]
  // all: 300 + 1200 + 1200 = 2700; cleanser: 600.
  const best = bestProductPerk([cleanser, all], basket)
  assert.equal(best?.perk.id, all.id)
  assert.equal(best?.off, 2700)
})

test('a tie goes to the lower sort_order, then the lower id', () => {
  const a = perk({ kind: 'percent_off', percent_off: 10, sort_order: 2 })
  const b = perk({ kind: 'percent_off', percent_off: 10, sort_order: 1 })
  const c = perk({ kind: 'percent_off', percent_off: 10, sort_order: 1 })
  const basket = units(SERUM, SERUMS_CAT, 5000)
  assert.equal(bestProductPerk([a, c, b], basket)?.perk.id, b.id)
})

test('no eligible units means no perk', () => {
  const p = perk({ kind: 'percent_off', percent_off: 20, category_id: CLEANSERS_CAT })
  assert.equal(bestProductPerk([p], units(SERUM, SERUMS_CAT, 5000)), null)
  assert.equal(bestProductPerk([p], []), null)
  assert.equal(bestProductPerk([], units(SERUM, SERUMS_CAT, 5000)), null)
})

test('zero-price units are ignored, never counted toward a group', () => {
  const basket = [...units(CLEANSER, CLEANSERS_CAT, 0), ...units(SERUM, SERUMS_CAT, 5000)]
  assert.equal(perkDiscountCents(bogo, basket), 0)
  assert.equal(perkDiscountCents(perk({ kind: 'percent_off', percent_off: 10 }), basket), 500)
})

// ── Limits (087) ────────────────────────────────────────────
console.log('\nLimits')

test('max_units_per_use caps a percent perk to the dearest N eligible units', () => {
  const p = perk({ kind: 'percent_off', percent_off: 20, max_units_per_use: 2 })
  const basket = [
    ...units(CLEANSER, CLEANSERS_CAT, 3000),
    ...units(SERUM, SERUMS_CAT, 8000),
    ...units(SPF, null, 2000),
    ...units(SERUM, SERUMS_CAT, 6000),
  ]
  // The dearest two: 8000 and 6000 -> 1600 + 1200.
  assert.deepEqual(perkPricing(p, basket), { off: 2800, units: 2 })
  // Fewer eligible units than the cap: all of them, as before.
  assert.deepEqual(perkPricing(p, units(SPF, null, 2000)), { off: 400, units: 1 })
})

test('max_units_per_use caps a buy-get perk to N discounted units', () => {
  const p = perk({ kind: 'buy_get', percent_off: 100, buy_qty: 1, max_units_per_use: 1 })
  const basket = [
    ...units(SERUM, SERUMS_CAT, 5000),
    ...units(SPF, null, 2500),
    ...units(CLEANSER, CLEANSERS_CAT, 3000),
    ...units(SERUM, SERUMS_CAT, 6000),
  ]
  // Two groups available, one allowed: only the cheapest goes free.
  assert.deepEqual(perkPricing(p, basket), { off: 2500, units: 1 })
  const two = perk({ kind: 'buy_get', percent_off: 100, buy_qty: 1, max_units_per_use: 2 })
  assert.deepEqual(perkPricing(two, [...basket, ...units(SPF, null, 1000, 2)]), { off: 1000 + 1000, units: 2 })
})

test('an exhausted perk is skipped and the next best wins', () => {
  const big = perk({ kind: 'percent_off', percent_off: 30, max_uses: 1, uses_window: 'month' })
  const small = perk({ kind: 'percent_off', percent_off: 10 })
  const basket = units(SERUM, SERUMS_CAT, 5000)
  assert.equal(bestProductPerk([big, small], basket)?.perk.id, big.id)
  const best = bestProductPerk([big, small], basket, [{ perkId: big.id, usesSoFar: 1 }])
  assert.equal(best?.perk.id, small.id)
  assert.equal(best?.off, 500)
  assert.equal(best?.units, 1)
  // One use left of three still competes.
  const thrice = perk({ kind: 'percent_off', percent_off: 30, max_uses: 3 })
  assert.equal(bestProductPerk([thrice, small], basket, [{ perkId: thrice.id, usesSoFar: 2 }])?.perk.id, thrice.id)
  // Everything spent: nothing.
  assert.equal(bestProductPerk([big], basket, [{ perkId: big.id, usesSoFar: 4 }]), null)
})

test('a tie goes to the unlimited perk before sort_order, so no capped use is spent', () => {
  const basket = units(SERUM, SERUMS_CAT, 5000)
  // Same cut, the capped one listed first: the unlimited one still wins.
  const capped = perk({ kind: 'percent_off', percent_off: 20, max_uses: 1, sort_order: 0 })
  const unlimited = perk({ kind: 'percent_off', percent_off: 20, sort_order: 5 })
  assert.equal(bestProductPerk([capped, unlimited], basket)?.perk.id, unlimited.id)
  assert.equal(bestProductPerk([unlimited, capped], basket, [])?.perk.id, unlimited.id)
  // A bigger cut from the capped perk still wins outright.
  const bigger = perk({ kind: 'percent_off', percent_off: 25, max_uses: 1, sort_order: 9 })
  assert.equal(bestProductPerk([unlimited, bigger], basket)?.perk.id, bigger.id)
  // Two capped perks tied: sort_order decides, as before.
  const cappedLater = perk({ kind: 'percent_off', percent_off: 20, max_uses: 3, sort_order: 2 })
  assert.equal(bestProductPerk([cappedLater, capped], basket)?.perk.id, capped.id)
})

test('an unlimited perk ignores availability and reports every unit', () => {
  const p = perk({ kind: 'percent_off', percent_off: 15 })
  const basket = [...units(CLEANSER, CLEANSERS_CAT, 3250), ...units(SERUM, SERUMS_CAT, 1999, 2)]
  const best = bestProductPerk([p], basket, [{ perkId: p.id, usesSoFar: 50 }])
  assert.equal(best?.off, 488 + 300 + 300)
  assert.equal(best?.units, 3)
  assert.equal(perkDiscountCents(p, basket), 488 + 300 + 300)
})

test('describes the limit in plain words', () => {
  assert.equal(describePerkLimit(perk({ kind: 'percent_off', percent_off: 10 })), '')
  assert.equal(
    describeProductPerk(perk({ kind: 'percent_off', percent_off: 15, max_uses: 1 }), {}),
    '15% off all products, once per period'
  )
  assert.equal(
    describeProductPerk(perk({ kind: 'percent_off', percent_off: 20, max_uses: 3, uses_window: 'month' }), {}),
    '20% off all products, up to 3 times a month'
  )
  assert.equal(
    describeProductPerk(perk({ kind: 'percent_off', percent_off: 20, max_units_per_use: 1 }), {}),
    '20% off all products, one item per use'
  )
  assert.equal(
    describeProductPerk(
      perk({ kind: 'buy_get', percent_off: 100, buy_qty: 1, product_id: CLEANSER, max_uses: 2, uses_window: 'month', max_units_per_use: 2 }),
      { product: 'Gentle Cleanser' }
    ),
    'Buy one Gentle Cleanser, get one free, twice a month, up to two items per use'
  )
})

// ── The sentence ────────────────────────────────────────────
console.log('\nThe sentence')

test('describes each shape without an em dash', () => {
  const lines = [
    describeProductPerk(perk({ kind: 'percent_off', percent_off: 15 }), {}),
    describeProductPerk(perk({ kind: 'percent_off', percent_off: 20, product_id: CLEANSER }), { product: 'Gentle Cleanser' }),
    describeProductPerk(perk({ kind: 'buy_get', percent_off: 50, buy_qty: 2, category_id: CLEANSERS_CAT }), { category: 'Cleansers' }),
    describeProductPerk(perk({ kind: 'buy_get', percent_off: 100, buy_qty: 1, product_id: CLEANSER }), { product: 'Gentle Cleanser' }),
    describeProductPerk(perk({ kind: 'buy_get', percent_off: 25, buy_qty: 3 }), {}),
  ]
  assert.deepEqual(lines, [
    '15% off all products',
    '20% off Gentle Cleanser',
    'Buy 2 in Cleansers, get the third half off',
    'Buy one Gentle Cleanser, get one free',
    'Buy 3 products, get the fourth 25% off',
  ])
  for (const l of lines) assert.ok(!l.includes('—'), l)
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
