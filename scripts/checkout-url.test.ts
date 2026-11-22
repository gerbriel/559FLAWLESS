/**
 * Marketplace checkout URL parsing and coupon arithmetic. Run with:
 *   npx tsx scripts/checkout-url.test.ts
 *
 * Meta Shops sends buyers to /cart?products=ID%3AQTY%2CID%3AQTY&coupon=CODE.
 * Getting this wrong is quiet: a bag with the wrong quantity, a code that
 * never applies, or a crafted URL that reaches the database as a filter.
 */

import assert from 'node:assert/strict'
import {
  parseProductsParam,
  parseCheckoutUrl,
  normalizeCouponCode,
  couponCutCents,
  MAX_LINE_QTY,
  MAX_URL_LINES,
} from '../src/lib/checkout-url'

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

console.log('\nproducts parameter')

test("Meta's documented sample", () => {
  const params = new URLSearchParams('products=12345%3A3%2C23456%3A1&coupon=SUMMERSALE20')
  const req = parseCheckoutUrl(params)
  assert.deepEqual(req.lines, [
    { ref: '12345', qty: 3 },
    { ref: '23456', qty: 1 },
  ])
  assert.equal(req.coupon, 'SUMMERSALE20')
  assert.equal(req.present, true)
})

test('a bare id is quantity one', () => {
  assert.deepEqual(parseProductsParam('42'), [{ ref: '42', qty: 1 }])
})

test('repeats of one id are summed', () => {
  assert.deepEqual(parseProductsParam('7:2,7:3'), [{ ref: '7', qty: 5 }])
})

test('quantities are clamped to the cart ceiling', () => {
  assert.deepEqual(parseProductsParam('7:500'), [{ ref: '7', qty: MAX_LINE_QTY }])
})

test('a bad entry is skipped, the rest arrive', () => {
  assert.deepEqual(parseProductsParam('7:2,:3,8:x,9:0,10:-1,11:1.5,12:1'), [
    { ref: '7', qty: 2 },
    { ref: '12', qty: 1 },
  ])
})

test('SKUs and slugs are kept for catalogs built that way', () => {
  assert.deepEqual(parseProductsParam('RA-CLN-01:1,gentle-cleanser:2'), [
    { ref: 'RA-CLN-01', qty: 1 },
    { ref: 'gentle-cleanser', qty: 2 },
  ])
})

test('a reference that could reach PostgREST as a filter is dropped', () => {
  assert.deepEqual(parseProductsParam('7),id.gt.(0:1'), [])
  assert.deepEqual(parseProductsParam('a b:1'), [])
  assert.deepEqual(parseProductsParam('"x":1'), [])
  assert.deepEqual(parseProductsParam('-leading:1'), [])
})

test('too many lines stop at the route ceiling', () => {
  const many = Array.from({ length: 40 }, (_, i) => `${i + 1}:1`).join(',')
  assert.equal(parseProductsParam(many).length, MAX_URL_LINES)
})

test('spaces around entries are forgiven', () => {
  assert.deepEqual(parseProductsParam(' 7:1 , 8:2 '), [
    { ref: '7', qty: 1 },
    { ref: '8', qty: 2 },
  ])
})

test('nothing in the URL is nothing, not an error', () => {
  const req = parseCheckoutUrl(new URLSearchParams('cancelled=1'))
  assert.deepEqual(req.lines, [])
  assert.equal(req.coupon, null)
  assert.equal(req.present, false)
})

test('cart_origin rides along as a plain word only', () => {
  assert.equal(parseCheckoutUrl(new URLSearchParams('products=1:1&cart_origin=Instagram')).origin, 'instagram')
  assert.equal(parseCheckoutUrl(new URLSearchParams('products=1:1&cart_origin=<b>')).origin, null)
})

console.log('\ncoupon code')

test('uppercased and trimmed', () => {
  assert.equal(normalizeCouponCode('  summer20 '), 'SUMMER20')
})

test('empty or odd input is no code', () => {
  assert.equal(normalizeCouponCode(''), null)
  assert.equal(normalizeCouponCode('   '), null)
  assert.equal(normalizeCouponCode('code with spaces'), null)
  assert.equal(normalizeCouponCode('x'.repeat(41)), null)
  assert.equal(normalizeCouponCode(undefined), null)
})

console.log('\ncoupon arithmetic')

test('percent off rounds half up, in cents', () => {
  assert.equal(couponCutCents({ percent_off: 20, amount_off_cents: null }, 10000), 2000)
  // 12.5% of $1.01 = 12.625c -> 13c
  assert.equal(couponCutCents({ percent_off: 12.5, amount_off_cents: null }, 101), 13)
})

test('a flat amount never exceeds the subtotal', () => {
  assert.equal(couponCutCents({ percent_off: null, amount_off_cents: 2500 }, 10000), 2500)
  assert.equal(couponCutCents({ percent_off: null, amount_off_cents: 25000 }, 10000), 10000)
})

test('a flat amount wins over a percent when both are present', () => {
  assert.equal(couponCutCents({ percent_off: 50, amount_off_cents: 100 }, 10000), 100)
})

test('an empty bag or an empty coupon cuts nothing', () => {
  assert.equal(couponCutCents({ percent_off: 20, amount_off_cents: null }, 0), 0)
  assert.equal(couponCutCents({ percent_off: null, amount_off_cents: null }, 5000), 0)
  assert.equal(couponCutCents({ percent_off: 0, amount_off_cents: 0 }, 5000), 0)
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
