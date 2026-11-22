/**
 * Included allowance tests (088). Run with:
 *   npx tsx scripts/membership-allowances.test.ts
 *
 * A plan's included sessions are either one shared pool ("2 treatments: a
 * facial or a Brazilian") or a set number of each treatment ("1 facial and 1
 * Brazilian"). These helpers count what is left the same way the database
 * trigger does, and a miscount here is a member told they have a facial left
 * when the booking will charge them for it.
 */

import assert from 'node:assert/strict'
import {
  allowancesLeftLabel,
  describeIncluded,
  includedAllowances,
  includedSessionsLeft,
} from '../src/types/memberships'

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

const PERIOD = '2026-11-01T08:00:00+00:00'
const LAST_PERIOD = '2026-10-01T07:00:00+00:00'
const FACIAL = 1
const BRAZILIAN = 2
const BROW = 3

const poolScope = [
  { service_id: FACIAL, sessions_per_period: null, name: 'Custom Corrective Facial' },
  { service_id: BRAZILIAN, sessions_per_period: null, name: 'Full Brazilian' },
]
const eachScope = [
  { service_id: FACIAL, sessions_per_period: 1, name: 'Custom Corrective Facial' },
  { service_id: BRAZILIAN, sessions_per_period: 1, name: 'Full Brazilian' },
]

// ── Pool only ────────────────────────────────────────────────
console.log('\nPool only')

test('one pool entry, counting every redemption this period', () => {
  const a = includedAllowances({ included_sessions_per_period: 2 }, poolScope, [
    { service_id: FACIAL, sessions: 1, redeemed_for_period_start: PERIOD },
    { service_id: FACIAL, sessions: 1, redeemed_for_period_start: PERIOD },
  ], PERIOD)
  assert.deepEqual(a, [{ serviceId: null, serviceName: null, total: 2, used: 2 }])
  assert.equal(allowancesLeftLabel(a), '0 of 2 treatments left')
  assert.equal(includedSessionsLeft(a), 0)
})

test('pool wording matches describeMembershipBenefit', () => {
  const a = includedAllowances({ included_sessions_per_period: 2 }, poolScope, [], PERIOD)
  assert.equal(
    describeIncluded(a, 'month', ['Custom Corrective Facial', 'Full Brazilian']),
    '2 treatments included each month: Custom Corrective Facial or Full Brazilian'
  )
  assert.equal(describeIncluded(a, 'month', []), '2 treatments included each month')
  const one = includedAllowances({ included_sessions_per_period: 1 }, [], [], PERIOD)
  assert.equal(describeIncluded(one, 'quarter', []), '1 treatment included each quarter')
  assert.equal(allowancesLeftLabel(one), '1 of 1 treatment left')
})

test('legacy redemptions with no service count against the pool', () => {
  const a = includedAllowances({ included_sessions_per_period: 3 }, [], [
    { service_id: null, sessions: 1, redeemed_for_period_start: PERIOD },
  ], PERIOD)
  assert.equal(a[0].used, 1)
})

// ── Per treatment only ───────────────────────────────────────
console.log('\nPer treatment only')

test('one entry per treatment in scope order, no pool at zero', () => {
  const a = includedAllowances({ included_sessions_per_period: 0 }, eachScope, [
    { service_id: BRAZILIAN, sessions: 1, redeemed_for_period_start: PERIOD },
  ], PERIOD)
  assert.deepEqual(a, [
    { serviceId: FACIAL, serviceName: 'Custom Corrective Facial', total: 1, used: 0 },
    { serviceId: BRAZILIAN, serviceName: 'Full Brazilian', total: 1, used: 1 },
  ])
  assert.equal(
    describeIncluded(a, 'month', []),
    '1 Custom Corrective Facial and 1 Full Brazilian included each month'
  )
  assert.equal(
    allowancesLeftLabel(a),
    '1 of 1 Custom Corrective Facial and 0 of 1 Full Brazilian left'
  )
  assert.equal(includedSessionsLeft(a), 1)
})

test('two facials spent do not touch the Brazilian', () => {
  const a = includedAllowances({ included_sessions_per_period: 0 }, eachScope, [
    { service_id: FACIAL, sessions: 1, redeemed_for_period_start: PERIOD },
    { service_id: FACIAL, sessions: 1, redeemed_for_period_start: PERIOD },
  ], PERIOD)
  assert.equal(a[0].used, 2)
  assert.equal(a[1].used, 0)
  assert.equal(allowancesLeftLabel(a), '0 of 1 Custom Corrective Facial and 1 of 1 Full Brazilian left')
})

test('three treatments read as a list', () => {
  const a = includedAllowances(
    { included_sessions_per_period: 0 },
    [...eachScope, { service_id: BROW, sessions_per_period: 2, name: 'Brow Wax' }],
    [],
    PERIOD
  )
  assert.equal(
    describeIncluded(a, 'month', []),
    '1 Custom Corrective Facial, 1 Full Brazilian and 2 Brow Wax visits included each month'
  )
})

test('a count above one reads as visits, one stays bare', () => {
  const scope = [
    { service_id: FACIAL, sessions_per_period: 2, name: 'Custom Corrective Facial' },
    { service_id: BRAZILIAN, sessions_per_period: 1, name: 'Full Brazilian' },
  ]
  const a = includedAllowances({ included_sessions_per_period: 0 }, scope, [
    { service_id: FACIAL, sessions: 1, redeemed_for_period_start: PERIOD },
  ], PERIOD)
  assert.equal(
    describeIncluded(a, 'month', []),
    '2 Custom Corrective Facial visits and 1 Full Brazilian included each month'
  )
  assert.equal(
    allowancesLeftLabel(a),
    '1 of 2 Custom Corrective Facial visits and 1 of 1 Full Brazilian left'
  )
})

test('a count of two with no name still reads as visits', () => {
  const a = includedAllowances(
    { included_sessions_per_period: 0 },
    [{ service_id: FACIAL, sessions_per_period: 2, name: null }],
    [],
    PERIOD
  )
  assert.equal(describeIncluded(a, 'month', []), '2 visits of this treatment included each month')
  assert.equal(allowancesLeftLabel(a), '2 of 2 visits of this treatment left')
})

// ── Mixed ────────────────────────────────────────────────────
console.log('\nMixed')

test('own allowance and pool count separately, pool last', () => {
  const scope = [
    { service_id: FACIAL, sessions_per_period: 1, name: 'Custom Corrective Facial' },
    { service_id: BRAZILIAN, sessions_per_period: null, name: 'Full Brazilian' },
    { service_id: BROW, sessions_per_period: null, name: 'Brow Wax' },
  ]
  const a = includedAllowances({ included_sessions_per_period: 2 }, scope, [
    { service_id: FACIAL, sessions: 1, redeemed_for_period_start: PERIOD },
    { service_id: BROW, sessions: 1, redeemed_for_period_start: PERIOD },
    { service_id: null, sessions: 1, redeemed_for_period_start: PERIOD },
  ], PERIOD)
  assert.deepEqual(a, [
    { serviceId: FACIAL, serviceName: 'Custom Corrective Facial', total: 1, used: 1 },
    { serviceId: null, serviceName: null, total: 2, used: 2 },
  ])
  assert.equal(
    describeIncluded(a, 'month', ['Full Brazilian', 'Brow Wax']),
    '1 Custom Corrective Facial included each month, plus 2 treatments included each month: Full Brazilian or Brow Wax'
  )
  assert.equal(allowancesLeftLabel(a), '0 of 1 Custom Corrective Facial and 0 of 2 treatments left')
})

// ── The period start ─────────────────────────────────────────
console.log('\nThe period start')

test('last period does not count', () => {
  const a = includedAllowances({ included_sessions_per_period: 1 }, eachScope, [
    { service_id: FACIAL, sessions: 1, redeemed_for_period_start: LAST_PERIOD },
    { service_id: BRAZILIAN, sessions: 1, redeemed_for_period_start: LAST_PERIOD },
    { service_id: null, sessions: 1, redeemed_for_period_start: LAST_PERIOD },
    { service_id: BRAZILIAN, sessions: 1, redeemed_for_period_start: PERIOD },
  ], PERIOD)
  assert.deepEqual(a.map((x) => x.used), [0, 1, 0])
})

test('the same instant spelled differently still counts', () => {
  const a = includedAllowances({ included_sessions_per_period: 1 }, [], [
    { service_id: FACIAL, sessions: 1, redeemed_for_period_start: '2026-11-01T08:00:00.000Z' },
  ], PERIOD)
  assert.equal(a[0].used, 1)
})

// ── Nothing spent, nothing included ──────────────────────────
console.log('\nZero')

test('zero redemptions leaves everything', () => {
  const a = includedAllowances({ included_sessions_per_period: 0 }, eachScope, [], PERIOD)
  assert.deepEqual(a.map((x) => x.used), [0, 0])
  assert.equal(includedSessionsLeft(a), 2)
})

test('a plan that includes nothing has no allowances and no words', () => {
  const a = includedAllowances({ included_sessions_per_period: 0 }, poolScope, [], PERIOD)
  assert.deepEqual(a, [])
  assert.equal(describeIncluded(a, 'month', ['Custom Corrective Facial']), '')
  assert.equal(allowancesLeftLabel(a), '')
})

test('overspent never reads below zero', () => {
  const a = includedAllowances({ included_sessions_per_period: 1 }, [], [
    { service_id: FACIAL, sessions: 2, redeemed_for_period_start: PERIOD },
  ], PERIOD)
  assert.equal(allowancesLeftLabel(a), '0 of 1 treatment left')
  assert.equal(includedSessionsLeft(a), 0)
})

test('no em dashes in any sentence', () => {
  const a = includedAllowances({ included_sessions_per_period: 2 }, eachScope.slice(0, 1), [], PERIOD)
  for (const s of [describeIncluded(a, 'month', ['Full Brazilian']), allowancesLeftLabel(a)]) {
    assert.ok(!s.includes('—'), s)
  }
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
