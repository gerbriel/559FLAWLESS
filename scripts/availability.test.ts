/**
 * Slot-generation tests. Run with:
 *   node --experimental-strip-types scripts/availability.test.ts
 *
 * These cover the parts that are easy to get subtly wrong and hard to notice:
 * DST boundaries, buffer arithmetic, and every reason a slot should disappear.
 */

import assert from 'node:assert/strict'
import { generateSlots, overlaps, type AvailabilityInput } from '../src/lib/availability'
import {
  zonedTimeToUtc,
  dateKeyInTimeZone,
  dayOfWeekForDateKey,
  addDaysToDateKey,
  formatTimeInTimeZone,
} from '../src/lib/time'

const TZ = 'America/Los_Angeles'
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

// ── Timezone ────────────────────────────────────────────────
console.log('\nTimezone')

test('PST: 10:00 local is 18:00 UTC', () => {
  assert.equal(zonedTimeToUtc('2026-01-15', '10:00', TZ).toISOString(), '2026-01-15T18:00:00.000Z')
})

test('PDT: 10:00 local is 17:00 UTC', () => {
  assert.equal(zonedTimeToUtc('2026-07-15', '10:00', TZ).toISOString(), '2026-07-15T17:00:00.000Z')
})

test('spring forward: 02:30 never happens, resolves forward', () => {
  // 8 Mar 2026, clocks jump 02:00 -> 03:00 local.
  const t = zonedTimeToUtc('2026-03-08', '02:30', TZ)
  assert.equal(formatTimeInTimeZone(t, TZ), '3:30 AM')
})

test('fall back: 01:30 happens twice, resolves to the first (PDT)', () => {
  // 1 Nov 2026, clocks fall 02:00 -> 01:00 local.
  assert.equal(zonedTimeToUtc('2026-11-01', '01:30', TZ).toISOString(), '2026-11-01T08:30:00.000Z')
})

test('date key is the local day, not the UTC day', () => {
  // 18:00 Pacific on 31 Dec is already 1 Jan in UTC.
  const instant = new Date('2027-01-01T02:00:00Z')
  assert.equal(dateKeyInTimeZone(instant, TZ), '2026-12-31')
})

test('day-of-week for a date key', () => {
  assert.equal(dayOfWeekForDateKey('2026-09-07'), 1) // a Monday
})

test('date key arithmetic crosses a month boundary', () => {
  assert.equal(addDaysToDateKey('2026-08-30', 3), '2026-09-02')
})

// ── Overlap ─────────────────────────────────────────────────
console.log('\nOverlap')

test('touching intervals do not overlap', () => {
  assert.equal(overlaps({ start: 0, end: 10 }, { start: 10, end: 20 }), false)
})

test('a one-millisecond intersection does overlap', () => {
  assert.equal(overlaps({ start: 0, end: 11 }, { start: 10, end: 20 }), true)
})

test('containment overlaps', () => {
  assert.equal(overlaps({ start: 0, end: 100 }, { start: 10, end: 20 }), true)
})

// ── Slot generation ─────────────────────────────────────────
console.log('\nSlot generation')

// Monday 7 Sep 2026. Provider works 10:00–14:00 Pacific, 15-minute grid.
const MONDAY = '2026-09-07'
const NOW = new Date('2026-09-01T12:00:00Z') // a week ahead, so lead time is moot

function input(over: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return {
    timeZone: TZ,
    schedules: [
      { day_of_week: 1, start_time: '10:00', end_time: '14:00', slot_interval_minutes: 15 },
    ],
    blocks: [],
    closures: [],
    busy: [],
    durationMinutes: 60,
    bufferMinutes: 15,
    minLeadMinutes: 120,
    maxAdvanceDays: 90,
    now: NOW,
    ...over,
  }
}

const local = (d: Date) => formatTimeInTimeZone(d, TZ)

test('a 60+15 service in a 4-hour window yields 10:00 through 12:45', () => {
  const [day] = generateSlots(input(), MONDAY, 1)
  assert.equal(day.slots.length, 12)
  assert.equal(local(day.slots[0]), '10:00 AM')
  // Last start must let 75 minutes finish by 14:00 -> 12:45.
  assert.equal(local(day.slots[day.slots.length - 1]), '12:45 PM')
})

test('a longer service yields fewer slots', () => {
  const [day] = generateSlots(input({ durationMinutes: 120 }), MONDAY, 1)
  assert.equal(local(day.slots[day.slots.length - 1]), '11:45 AM')
})

test('a service that cannot fit yields nothing', () => {
  const [day] = generateSlots(input({ durationMinutes: 300 }), MONDAY, 1)
  assert.equal(day.slots.length, 0)
})

test('a non-working day yields nothing', () => {
  const [day] = generateSlots(input(), '2026-09-08', 1) // Tuesday
  assert.equal(day.slots.length, 0)
})

test('a studio closure clears the day', () => {
  const [day] = generateSlots(input({ closures: [MONDAY] }), MONDAY, 1)
  assert.equal(day.slots.length, 0)
})

test('an all-day block clears the day', () => {
  const [day] = generateSlots(
    input({ blocks: [{ block_date: MONDAY, start_time: null, end_time: null }] }),
    MONDAY,
    1
  )
  assert.equal(day.slots.length, 0)
})

test('a mid-morning block removes only the slots it touches', () => {
  // Block 10:45–11:15. Slots run 75 minutes (60 + 15 buffer).
  const [day] = generateSlots(
    input({ blocks: [{ block_date: MONDAY, start_time: '10:45', end_time: '11:15' }] }),
    MONDAY,
    1
  )
  const times = day.slots.map(local)
  assert.ok(!times.includes('10:00 AM'), '10:00 runs to 11:15 and collides')
  assert.ok(!times.includes('10:45 AM'), 'starts inside the block')
  assert.ok(times.includes('11:15 AM'), 'starts exactly as the block ends, so it stays')
  assert.ok(times.includes('12:45 PM'), 'the last slot of the day is untouched')
})

test('the block still applies when the block is late in the window', () => {
  const [day] = generateSlots(
    input({ blocks: [{ block_date: MONDAY, start_time: '12:00', end_time: '13:00' }] }),
    MONDAY,
    1
  )
  const times = day.slots.map(local)
  assert.ok(times.includes('10:45 AM'), '10:45 finishes at 12:00 exactly, so it stays')
  assert.ok(!times.includes('11:00 AM'), '11:00 runs to 12:15 and collides')
  assert.ok(!times.includes('12:00 PM'), 'starts inside the block')
  // 13:00 is absent for a different reason: 75 minutes would run past the
  // 14:00 close. Window fit and block avoidance are separate filters.
  assert.ok(!times.includes('1:00 PM'), '1:00 would overrun the close')
})

test('an existing booking removes the overlapping slots', () => {
  const [day] = generateSlots(
    input({
      busy: [
        {
          starts_at: zonedTimeToUtc(MONDAY, '10:00', TZ).toISOString(),
          ends_at: zonedTimeToUtc(MONDAY, '11:15', TZ).toISOString(),
        },
      ],
    }),
    MONDAY,
    1
  )
  const times = day.slots.map(local)
  assert.ok(!times.includes('10:00 AM'))
  assert.ok(!times.includes('11:00 AM'))
  assert.ok(times.includes('11:15 AM'), 'the slot starting as the booking ends stays')
})

test('minimum notice hides slots that are too soon', () => {
  // "Now" is 09:30 Pacific on the Monday itself, with 120 minutes notice.
  const [day] = generateSlots(
    input({ now: zonedTimeToUtc(MONDAY, '09:30', TZ), minLeadMinutes: 120 }),
    MONDAY,
    1
  )
  const times = day.slots.map(local)
  assert.ok(!times.includes('10:00 AM'), 'inside the notice window')
  assert.ok(!times.includes('11:15 AM'), 'still inside it')
  assert.ok(times.includes('11:30 AM'), 'exactly at the boundary, so bookable')
})

test('the booking horizon caps how far out slots appear', () => {
  const [day] = generateSlots(input({ maxAdvanceDays: 3 }), MONDAY, 1)
  assert.equal(day.slots.length, 0, 'the Monday is 6 days out, past a 3-day horizon')
})

test('two schedule windows in one day do not produce duplicates', () => {
  const [day] = generateSlots(
    input({
      schedules: [
        { day_of_week: 1, start_time: '10:00', end_time: '14:00', slot_interval_minutes: 15 },
        { day_of_week: 1, start_time: '12:00', end_time: '16:00', slot_interval_minutes: 15 },
      ],
    }),
    MONDAY,
    1
  )
  const times = day.slots.map((s) => s.getTime())
  assert.equal(new Set(times).size, times.length, 'no duplicate start times')
  assert.deepEqual(times, [...times].sort((a, b) => a - b), 'sorted ascending')
})

test('slots stay on the local grid across a DST change', () => {
  // 1 Nov 2026 is the fall-back Sunday; the following Monday is PST.
  const nov = '2026-11-09'
  const [day] = generateSlots(
    input({ now: new Date('2026-11-01T12:00:00Z') }),
    nov,
    1
  )
  assert.equal(local(day.slots[0]), '10:00 AM', 'still 10:00 local, though the UTC offset moved')
  assert.equal(day.slots[0].toISOString(), '2026-11-09T18:00:00.000Z')
})

test('a multi-day request returns one entry per day', () => {
  const days = generateSlots(input(), MONDAY, 7)
  assert.equal(days.length, 7)
  assert.equal(days[0].dateKey, MONDAY)
  assert.equal(days[6].dateKey, '2026-09-13')
  assert.ok(days[0].slots.length > 0, 'Monday has slots')
  assert.equal(days[1].slots.length, 0, 'Tuesday does not')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
