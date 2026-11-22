/**
 * Promo code shape and arithmetic. Run with:
 *   npx tsx scripts/coupon-code.test.ts
 *
 * The failure mode is quiet: a code that never applies, or a cent of
 * rounding that makes the order disagree with the receipt.
 */

import assert from 'node:assert/strict'
import { normalizeCouponCode, couponCutCents } from '../src/lib/coupon-code'

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
