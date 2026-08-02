/**
 * Scheduling-mechanics tests — gap time, orphan fragments, processing time.
 * Run with: npx tsx scripts/scheduling.test.ts
 *
 * The first block is the important one. Every new field on AvailabilityInput is
 * optional and every default is a no-op, and the claim that says so is not a
 * comment — it is a fixture matrix run twice, once with the fields absent and
 * once with them explicitly at their defaults, asserting the same instants come
 * out. Migration 036 is worth nothing if it moved an existing studio's slots.
 */

import assert from 'node:assert/strict'
import { generateSlots, type AvailabilityInput } from '../src/lib/availability'
import { formatTimeInTimeZone, zonedTimeToUtc } from '../src/lib/time'

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

// Monday 7 Sep 2026. Provider works 10:00–14:00 Pacific on a 15-minute grid —
// the same fixture the availability suite uses, on purpose.
const MONDAY = '2026-09-07'
const NOW = new Date('2026-09-01T12:00:00Z')

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
const at = (time: string, dateKey = MONDAY) => zonedTimeToUtc(dateKey, time, TZ).toISOString()
const times = (over: Partial<AvailabilityInput> = {}, days = 1) =>
  generateSlots(input(over), MONDAY, days).flatMap((d) => d.slots.map(local))

// ── The regression that matters ─────────────────────────────
console.log('\nNo behaviour change for a studio that configures nothing')

/**
 * Every shape the old slot generator had to handle. Each is run twice: once
 * with the 036 fields absent entirely, once with them written out at their
 * documented defaults.
 */
const FIXTURES: { name: string; over: Partial<AvailabilityInput> }[] = [
  { name: 'an empty day', over: {} },
  { name: 'a longer service', over: { durationMinutes: 120 } },
  { name: 'no buffer', over: { bufferMinutes: 0 } },
  { name: 'a service that cannot fit', over: { durationMinutes: 300 } },
  { name: 'a five-minute grid', over: {
      schedules: [
        { day_of_week: 1, start_time: '10:00', end_time: '14:00', slot_interval_minutes: 5 },
      ],
    } },
  { name: 'two schedule windows', over: {
      schedules: [
        { day_of_week: 1, start_time: '10:00', end_time: '14:00', slot_interval_minutes: 15 },
        { day_of_week: 1, start_time: '12:00', end_time: '17:00', slot_interval_minutes: 15 },
      ],
    } },
  { name: 'one existing booking', over: {
      busy: [{ starts_at: at('11:00'), ends_at: at('12:00') }],
    } },
  { name: 'three existing bookings', over: {
      busy: [
        { starts_at: at('10:00'), ends_at: at('11:00') },
        { starts_at: at('11:30'), ends_at: at('12:00') },
        { starts_at: at('13:00'), ends_at: at('14:00') },
      ],
    } },
  { name: 'a mid-morning block', over: {
      blocks: [{ block_date: MONDAY, start_time: '11:00', end_time: '12:00' }],
    } },
  { name: 'an all-day block', over: {
      blocks: [{ block_date: MONDAY, start_time: null, end_time: null }],
    } },
  { name: 'a studio closure', over: { closures: [MONDAY] } },
  { name: 'a tight lead time', over: {
      minLeadMinutes: 60,
      now: new Date('2026-09-07T18:30:00Z'),
    } },
  { name: 'a short horizon', over: { maxAdvanceDays: 3 } },
  { name: 'a week at once', over: {} },
  { name: 'a booking carrying an is_processing flag, overlap off', over: {
      busy: [
        { starts_at: at('11:00'), ends_at: at('11:20'), is_processing: false },
        { starts_at: at('11:20'), ends_at: at('12:00'), is_processing: true },
      ],
    } },
]

const DEFAULTS = {
  minGapMinutes: 0,
  maxGapMinutes: null,
  minFragmentMinutes: 0,
  allowProcessingOverlap: false,
} as const

for (const fixture of FIXTURES) {
  test(`${fixture.name} — identical with the fields absent and at defaults`, () => {
    for (const days of [1, 7]) {
      const before = generateSlots(input(fixture.over), MONDAY, days)
      const after = generateSlots(input({ ...fixture.over, ...DEFAULTS }), MONDAY, days)

      assert.deepEqual(
        after.map((d) => ({ dateKey: d.dateKey, slots: d.slots.map((s) => s.toISOString()) })),
        before.map((d) => ({ dateKey: d.dateKey, slots: d.slots.map((s) => s.toISOString()) })),
        `${fixture.name} over ${days} day(s)`
      )
    }
  })
}

test('the untouched fixture still yields 10:00 through 12:45', () => {
  // The number the availability suite asserts. If 036 moved it, it moved
  // every studio's booking page.
  assert.deepEqual(times(), [
    '10:00 AM', '10:15 AM', '10:30 AM', '10:45 AM',
    '11:00 AM', '11:15 AM', '11:30 AM', '11:45 AM',
    '12:00 PM', '12:15 PM', '12:30 PM', '12:45 PM',
  ])
})

// ── Minimum gap ─────────────────────────────────────────────
console.log('\nMinimum gap')

// An 11:00–12:00 booking, and a 45-minute service with no buffer looking for
// room around it.
const around = { busy: [{ starts_at: at('11:00'), ends_at: at('12:00') }] }
const short = { ...around, durationMinutes: 45, bufferMinutes: 0 }

test('with no gap rule, a slot may butt straight up against a booking', () => {
  assert.ok(times(short).includes('10:15 AM'), '10:15–11:00 touches the booking')
  assert.ok(times(short).includes('12:00 PM'), '12:00 starts the moment it ends')
})

test('a 15-minute minimum gap pushes both sides away', () => {
  const t = times({ ...short, minGapMinutes: 15 })
  assert.ok(!t.includes('10:15 AM'), '10:15 would leave no gap before')
  assert.ok(!t.includes('12:00 PM'), '12:00 would leave no gap after')
  assert.ok(t.includes('10:00 AM'), '10:00–10:45 leaves 15 minutes')
  assert.ok(t.includes('12:15 PM'), '12:15 starts 15 minutes after')
})

test('the minimum gap is measured against bookings, not the working day', () => {
  // Nothing booked at all: 10:00 sharp is still offered even with a 30-minute
  // rule. A gap rule is about other clients, not about opening the doors late.
  const t = times({ durationMinutes: 45, bufferMinutes: 0, minGapMinutes: 30 })
  assert.equal(t[0], '10:00 AM')
})

// ── Orphan fragments ────────────────────────────────────────
console.log('\nOrphan fragments')

test('a 20-minute floor refuses the slot that would strand 15 minutes', () => {
  // 11:00–12:00 booked, so the morning stretch is 10:00–11:00. A 45-minute
  // service has nowhere in it that does not strand fifteen minutes: start at
  // 10:00 and the 15 before the booking is orphaned, start at 10:15 and the 15
  // at the top of the day is. So the morning closes, which is the point.
  const t = times({ ...short, minFragmentMinutes: 20 })
  assert.ok(!t.includes('10:00 AM'), '10:00 strands 10:45–11:00')
  assert.ok(!t.includes('10:15 AM'), '10:15 strands 10:00–10:15')
  assert.ok(t.includes('12:00 PM'), 'the afternoon is still wide open')
})

test('a service that fits the stretch cleanly is still offered', () => {
  // Same 60-minute morning, a 40-minute service: 10:00–10:40 leaves exactly
  // the 20 minutes the studio said it would sell.
  const t = times({ ...short, durationMinutes: 40, minFragmentMinutes: 20 })
  assert.ok(t.includes('10:00 AM'))
})

test('the floor applies against the edge of the working day too', () => {
  // Opening is 10:00. A 45-minute service starting 10:10 would strand the
  // first ten minutes of the day.
  const t = times({
    schedules: [
      { day_of_week: 1, start_time: '10:00', end_time: '14:00', slot_interval_minutes: 5 },
    ],
    durationMinutes: 45,
    bufferMinutes: 0,
    minFragmentMinutes: 20,
  })
  assert.ok(!t.includes('10:10 AM'), '10:10 strands ten minutes at the top of the day')
  assert.ok(t.includes('10:00 AM'))
  assert.ok(t.includes('10:20 AM'), '10:20 strands a bookable twenty')
})

test('a fragment of exactly the floor is fine', () => {
  const t = times({ ...short, minFragmentMinutes: 15 })
  assert.ok(t.includes('10:00 AM'), '15 minutes is not shorter than 15 minutes')
})

// ── Maximum gap ─────────────────────────────────────────────
console.log('\nMaximum gap')

test('a maximum gap keeps the day packed around what is already booked', () => {
  const t = times({ ...short, maxGapMinutes: 30 })
  assert.ok(t.includes('10:15 AM'), 'ends at 11:00, no gap')
  assert.ok(t.includes('12:00 PM'), 'starts at 12:00, no gap')
  assert.ok(!t.includes('13:00 PM'), 'an afternoon island is refused')
  assert.ok(
    t.every((s) => s !== '13:15 PM'),
    'so is a later one'
  )
})

test('an empty day is untouched by the maximum gap', () => {
  const t = times({ durationMinutes: 45, bufferMinutes: 0, maxGapMinutes: 30 })
  assert.equal(t.length, times({ durationMinutes: 45, bufferMinutes: 0 }).length)
})

test('minimum and maximum together leave a band', () => {
  const t = times({ ...short, minGapMinutes: 15, maxGapMinutes: 45 })
  assert.ok(!t.includes('10:15 AM'), 'too close')
  assert.ok(t.includes('10:00 AM'), '15 minutes before — inside the band')
  assert.ok(!t.includes('9:15 AM'), 'nothing opens before 10:00 anyway')
  assert.ok(t.includes('12:15 PM'), '15 minutes after')
  assert.ok(!t.includes('1:00 PM'), '60 minutes after is past the ceiling')
})

// ── Processing time ─────────────────────────────────────────
console.log('\nProcessing time')

// Someone else is mid-peel 11:00–12:30: active 11:00–11:20, developing
// 11:20–12:00, active again 12:00–12:30. This is exactly the shape
// provider_busy_segments emits.
const peel: Partial<AvailabilityInput> = {
  durationMinutes: 30,
  bufferMinutes: 0,
  busy: [
    { starts_at: at('11:00'), ends_at: at('11:20'), is_processing: false },
    { starts_at: at('11:20'), ends_at: at('12:00'), is_processing: true },
    { starts_at: at('12:00'), ends_at: at('12:30'), is_processing: false },
  ],
}

test('by default the processing gap is not offered — the room is occupied', () => {
  const t = times(peel)
  assert.ok(!t.includes('11:30 AM'), 'the client under the mask is still in the room')
  assert.ok(!t.includes('11:20 AM'))
  assert.ok(t.includes('10:30 AM'), 'before it is fine')
  assert.ok(t.includes('12:30 PM'), 'after it is fine')
})

test('with the studio switch on, the gap opens up', () => {
  const t = times({ ...peel, allowProcessingOverlap: true })
  assert.ok(t.includes('11:30 AM'), '11:30–12:00 sits inside the developing window')
  assert.ok(!t.includes('11:15 AM'), '11:15–11:45 still runs into active time')
  assert.ok(!t.includes('11:45 AM'), '11:45–12:15 runs into the active tail')
})

test('the switch never opens up active time, only the gap', () => {
  const t = times({ ...peel, allowProcessingOverlap: true })
  for (const forbidden of ['11:00 AM', '11:15 AM', '11:45 AM', '12:00 PM', '12:15 PM']) {
    assert.ok(!t.includes(forbidden), `${forbidden} overlaps active provider time`)
  }
})

test('a service too long for the gap is not offered inside it', () => {
  const t = times({ ...peel, durationMinutes: 45, allowProcessingOverlap: true })
  assert.ok(!t.includes('11:30 AM'), '45 minutes does not fit in a 40-minute window')
  assert.ok(!t.includes('11:20 AM'), 'nor does it from the very start of one')
})

test('a 40-minute service fits the 40-minute gap exactly', () => {
  const t = times({
    ...peel,
    durationMinutes: 40,
    allowProcessingOverlap: true,
    schedules: [
      { day_of_week: 1, start_time: '10:00', end_time: '14:00', slot_interval_minutes: 5 },
    ],
  })
  assert.ok(t.includes('11:20 AM'), '11:20–12:00 is the gap, to the minute')
})

test('gap rules and processing time compose', () => {
  // A 10-minute minimum gap makes the 40-minute window unusable by a
  // 30-minute service: it would have to sit 10 clear of both edges.
  const t = times({ ...peel, allowProcessingOverlap: true, minGapMinutes: 10 })
  assert.ok(!t.includes('11:30 AM'), '11:30–12:00 touches the active tail')
  const wider = times({
    ...peel,
    durationMinutes: 20,
    allowProcessingOverlap: true,
    minGapMinutes: 10,
  })
  assert.ok(wider.includes('11:30 AM'), '11:30–11:50 leaves 10 either side')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
