/**
 * Drag-to-reorder arithmetic. Run with:
 *   npx tsx scripts/reorder.test.ts
 *
 * The failure mode is a row that lands one place off from where the finger
 * let go of it, which nobody notices until the menu is wrong.
 */

import assert from 'node:assert/strict'
import { dropIndex, moveItem, shiftFor } from '../src/lib/reorder'

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

console.log('\nreorder')

// Four rows 50px tall, middles at 25, 75, 125, 175.
const mids = [25, 75, 125, 175]

test('moveItem moves down and up', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd'])
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c'])
})

test('moveItem out of range or in place is an unchanged copy', () => {
  const list = ['a', 'b']
  assert.deepEqual(moveItem(list, 0, 0), list)
  assert.deepEqual(moveItem(list, -1, 1), list)
  assert.deepEqual(moveItem(list, 0, 5), list)
  assert.notEqual(moveItem(list, 0, 0), list)
})

test('no movement drops where it started', () => {
  for (let i = 0; i < mids.length; i++) assert.equal(dropIndex(mids, i, 0), i)
})

test('a small wobble does not move a row', () => {
  assert.equal(dropIndex(mids, 1, 20), 1)
  assert.equal(dropIndex(mids, 1, -20), 1)
})

test('past the next middle moves one down, past the one before moves one up', () => {
  assert.equal(dropIndex(mids, 1, 51), 2)
  assert.equal(dropIndex(mids, 1, -51), 0)
})

test('far past either end clamps to the ends', () => {
  assert.equal(dropIndex(mids, 1, 10_000), 3)
  assert.equal(dropIndex(mids, 2, -10_000), 0)
})

test('shiftFor makes room on the way down', () => {
  // Row 0 dragged to 2: rows 1 and 2 slide up, 3 stays.
  assert.deepEqual([0, 1, 2, 3].map((i) => shiftFor(i, 0, 2)), [0, -1, -1, 0])
})

test('shiftFor makes room on the way up', () => {
  // Row 3 dragged to 1: rows 1 and 2 slide down, 0 stays.
  assert.deepEqual([0, 1, 2, 3].map((i) => shiftFor(i, 3, 1)), [0, 1, 1, 0])
})

test('dropping and moveItem agree', () => {
  const order = ['a', 'b', 'c', 'd']
  const to = dropIndex(mids, 0, 120)
  assert.equal(to, 2)
  assert.deepEqual(moveItem(order, 0, to), ['b', 'c', 'a', 'd'])
})

console.log(`\n${passed} passed, ${failed} failed\n`)
if (failed > 0) process.exit(1)
