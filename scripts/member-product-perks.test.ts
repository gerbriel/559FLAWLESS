/**
 * Membership product perk tests (086). Run with:
 *   npx tsx scripts/member-product-perks.test.ts
 *
 * These decide what a member's bottle costs at the till and at checkout, and
 * the failure mode is never an exception: it is a buy-one-get-one that frees
 * the dearer bottle, or a category perk that quietly reaches the whole shelf.
 */

import assert from 'node:assert/strict'
import { bestProductPerk, perkApplies, perkDiscountCents, type PerkUnit } from '../src/lib/member-product-perks'
import { describeProductPerk, type MembershipProductPerk } from '../src/types/memberships'

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
