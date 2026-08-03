/**
 * Form targeting tests — who a consent or intake form is actually asked of.
 * Run with:
 *   npx tsx scripts/forms.test.ts
 *
 * This module spent a week disagreeing with the database about one case, and
 * the disagreement was invisible from either side alone. `formApplies` said a
 * form with both `service_ids` and `category_ids` empty applied to EVERYONE;
 * migration 023's `appointment_outstanding_forms` matches with
 * `b.service_id = any (cf.service_ids)`, and `= any('{}')` is false, so the
 * same form applied to NOBODY. The staff screens listed a general waiver as
 * outstanding for every client booked that fortnight; the function that
 * actually pulls forms into an appointment never once asked for it. Nothing
 * threw. Nobody could see it without reading both implementations side by side.
 *
 * So the load-bearing test here is `sqlWouldMatch` — 023's predicate written
 * out in TypeScript, asserted against `formApplies` over an exhaustive grid.
 * The rest of the file is the invariants the doc comments in src/lib/forms.ts
 * claim, checked rather than asserted in prose, because the editors read this
 * rule backwards from three different screens and a fourth opinion about who a
 * form reaches is how they start disagreeing with the booking flow again.
 */

import assert from 'node:assert/strict'
import {
  INTAKE_MAX_AGE_MS,
  categoryFormLinkIsTickable,
  describeFormTargeting,
  formApplies,
  formLinkForCategory,
  formLinkForService,
  formLinkIsInherited,
  formTargetsNothing,
  intakeIsCurrent,
  signatureIsCurrent,
  type FormTarget,
} from '../src/lib/forms'

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

const form = (service_ids: number[] | null, category_ids: number[] | null): FormTarget => ({
  service_ids,
  category_ids,
})

// ── The owner's rule ────────────────────────────────────────
console.log('\nUntargeted applies to no one')

test('a form naming nothing is asked of nobody', () => {
  assert.equal(formApplies(form([], []), [1], [10]), false)
})

test('and of nobody on an appointment of several services', () => {
  assert.equal(formApplies(form([], []), [1, 2, 3], [10, 11]), false)
})

test('and of nobody even on an empty appointment', () => {
  assert.equal(formApplies(form([], []), [], []), false)
})

test('null arrays are empty arrays, not a third state', () => {
  assert.equal(formApplies(form(null, null), [1], [10]), false)
  assert.equal(formApplies(form(null, [10]), [1], [10]), true)
  assert.equal(formApplies(form([1], null), [1], [10]), true)
})

test('a targeted form still reaches what it names', () => {
  assert.equal(formApplies(form([1], []), [1], [10]), true)
  assert.equal(formApplies(form([], [10]), [1], [10]), true)
  assert.equal(formApplies(form([1], [10]), [1], [10]), true)
})

test('and nothing it does not name', () => {
  assert.equal(formApplies(form([2], []), [1], [10]), false)
  assert.equal(formApplies(form([], [11]), [1], [10]), false)
  assert.equal(formApplies(form([2], [11]), [1], [10]), false)
})

test('one match out of several services is enough', () => {
  assert.equal(formApplies(form([3], []), [1, 2, 3], [10]), true)
  assert.equal(formApplies(form([], [11]), [1, 2], [10, 11]), true)
})

test('the intimate-services consent stays off a brow wax', () => {
  const intimate = form([], [/* intimate treatments */ 4])
  assert.equal(formApplies(intimate, [/* brow wax */ 7], [/* waxing */ 2]), false)
  assert.equal(formApplies(intimate, [/* brazilian */ 9], [4]), true)
})

// ── Parity with migration 023 ───────────────────────────────
console.log('\nParity with appointment_outstanding_forms (023)')

/**
 * 023's matching predicate, transcribed:
 *
 *   exists (select 1 from booked b where b.service_id = any (cf.service_ids))
 *   or exists (select 1 from booked b where b.category_id = any (cf.category_ids))
 *
 * `x = any('{}')` is false in Postgres, which is the whole point: there is no
 * empty-array special case there and there must not be one here.
 *
 * The explicit `service_form_requirements` route in 023 is deliberately not
 * modelled — it is a separate attachment table this module does not read, and
 * a form reached that way is not a claim `formApplies` makes either way.
 */
function sqlWouldMatch(
  f: FormTarget,
  bookedServiceIds: readonly number[],
  bookedCategoryIds: readonly number[]
): boolean {
  const anyService = (f.service_ids ?? []).length > 0
  const anyCategory = (f.category_ids ?? []).length > 0
  return (
    (anyService && bookedServiceIds.some((id) => (f.service_ids ?? []).includes(id))) ||
    (anyCategory && bookedCategoryIds.some((id) => (f.category_ids ?? []).includes(id)))
  )
}

test('formApplies agrees with 023 on every combination of targeting and booking', () => {
  const targetings: (number[] | null)[] = [null, [], [1], [2], [1, 2]]
  const bookings: number[][] = [[], [1], [2], [1, 2], [3]]
  let checked = 0

  for (const service_ids of targetings) {
    for (const category_ids of targetings) {
      const f = form(service_ids, category_ids)
      for (const booked of bookings) {
        for (const cats of bookings) {
          assert.equal(
            formApplies(f, booked, cats),
            sqlWouldMatch(f, booked, cats),
            `svc=${JSON.stringify(service_ids)} cat=${JSON.stringify(category_ids)} ` +
              `booked=${JSON.stringify(booked)}/${JSON.stringify(cats)}`
          )
          checked++
        }
      }
    }
  }

  // Guard against the loops silently collapsing to nothing.
  assert.equal(checked, 5 * 5 * 5 * 5)
})

// ── Applying to nothing ─────────────────────────────────────
console.log('\nApplying to nothing is a state worth naming')

test('formTargetsNothing spots the form nobody will ever be asked for', () => {
  assert.equal(formTargetsNothing(form([], [])), true)
  assert.equal(formTargetsNothing(form(null, null)), true)
  assert.equal(formTargetsNothing(form([1], [])), false)
  assert.equal(formTargetsNothing(form([], [10])), false)
})

test('a form applying to nothing matches no appointment anyone could book', () => {
  const dead = form([], [])
  assert.equal(formTargetsNothing(dead), true)
  for (const services of [[], [1], [1, 2], [99]]) {
    for (const categories of [[], [10], [10, 11]]) {
      assert.equal(formApplies(dead, services, categories), false)
    }
  }
})

test('ticking every category is how a form reaches everybody now', () => {
  const everyCategory = form([], [10, 11, 12])
  for (const category of [10, 11, 12]) {
    assert.equal(formApplies(everyCategory, [1], [category]), true)
  }
  assert.equal(formTargetsNothing(everyCategory), false)
})

// ── The service side ────────────────────────────────────────
console.log('\nformLinkForService')

test("there is no 'studio' link left to produce", () => {
  // Every shape of form, asked from a real service: the answers are exactly
  // 'category', 'service' and null.
  const seen = new Set<string>()
  for (const service_ids of [null, [], [1], [2]] as (number[] | null)[]) {
    for (const category_ids of [null, [], [10], [11]] as (number[] | null)[]) {
      seen.add(String(formLinkForService(form(service_ids, category_ids), 1, 10)))
    }
  }
  assert.deepEqual([...seen].sort(), ['category', 'null', 'service'])
})

test('a form naming nothing is not required, rather than inherited', () => {
  assert.equal(formLinkForService(form([], []), 1, 10), null)
  assert.equal(formLinkIsInherited(formLinkForService(form([], []), 1, 10)), false)
})

test('category beats service when both match, so no tick is offered for it', () => {
  assert.equal(formLinkForService(form([1], [10]), 1, 10), 'category')
  assert.equal(formLinkIsInherited('category'), true)
  assert.equal(formLinkIsInherited('service'), false)
})

test('a service being created has no id and so is named by nothing', () => {
  assert.equal(formLinkForService(form([1], []), null, 10), null)
  assert.equal(formLinkForService(form([], [10]), null, 10), 'category')
})

test('THE INVARIANT: a link exists iff the form applies to that one service', () => {
  for (const service_ids of [null, [], [1], [2], [1, 2]] as (number[] | null)[]) {
    for (const category_ids of [null, [], [10], [11]] as (number[] | null)[]) {
      const f = form(service_ids, category_ids)
      for (const serviceId of [1, 2, 3]) {
        for (const categoryId of [10, 11, 12]) {
          assert.equal(
            formLinkForService(f, serviceId, categoryId) !== null,
            formApplies(f, [serviceId], [categoryId]),
            `svc=${JSON.stringify(service_ids)} cat=${JSON.stringify(category_ids)} ` +
              `asking service ${serviceId} in ${categoryId}`
          )
        }
      }
    }
  }
})

// ── The category side ───────────────────────────────────────
console.log('\nformLinkForCategory')

test("there is no 'studio' coverage left to produce", () => {
  const seen = new Set<string>()
  for (const service_ids of [null, [], [1], [3]] as (number[] | null)[]) {
    for (const category_ids of [null, [], [10], [11]] as (number[] | null)[]) {
      seen.add(String(formLinkForCategory(form(service_ids, category_ids), 10, [1, 2]).link))
    }
  }
  assert.deepEqual([...seen].sort(), ['category', 'null', 'services'])
})

test('a form naming nothing covers none of a category', () => {
  const { link, covered, total } = formLinkForCategory(form([], []), 10, [1, 2, 3])
  assert.equal(link, null)
  assert.equal(covered, 0)
  assert.equal(total, 3)
})

test('a targeted category covers all of it, including one with nothing filed under it', () => {
  assert.deepEqual(formLinkForCategory(form([], [10]), 10, [1, 2]), {
    link: 'category',
    covered: 2,
    total: 2,
  })
  // Targeting waiting for its first service. The tick has to stay on to say so.
  assert.deepEqual(formLinkForCategory(form([], [10]), 10, []), {
    link: 'category',
    covered: 0,
    total: 0,
  })
})

test('some-of-these-services is its own answer, with a count', () => {
  assert.deepEqual(formLinkForCategory(form([1, 2], []), 10, [1, 2, 3, 4]), {
    link: 'services',
    covered: 2,
    total: 4,
  })
})

test('THE INVARIANT: covered is exactly what the service side says is required', () => {
  const services = [1, 2, 3]
  for (const service_ids of [null, [], [1], [1, 2], [4]] as (number[] | null)[]) {
    for (const category_ids of [null, [], [10], [11]] as (number[] | null)[]) {
      const f = form(service_ids, category_ids)
      const { covered } = formLinkForCategory(f, 10, services)
      const fromServiceSide = services.filter(
        (id) => formLinkForService(f, id, 10) !== null
      ).length
      assert.equal(
        covered,
        fromServiceSide,
        `svc=${JSON.stringify(service_ids)} cat=${JSON.stringify(category_ids)}`
      )
    }
  }
})

test('only the two ends of one switch get a checkbox', () => {
  assert.equal(categoryFormLinkIsTickable('category'), true)
  assert.equal(categoryFormLinkIsTickable(null), true)
  assert.equal(categoryFormLinkIsTickable('services'), false)
})

// ── What the Forms screens print ────────────────────────────
console.log('\ndescribeFormTargeting')

const names = new Map([
  [10, 'Facials'],
  [11, 'Waxing'],
])

test('a form naming nothing says so', () => {
  assert.equal(describeFormTargeting(form([], []), names), 'applies to nothing')
  assert.equal(describeFormTargeting(form(null, null), names), 'applies to nothing')
})

test('categories are named, services are counted', () => {
  assert.equal(describeFormTargeting(form([], [10, 11]), names), 'asked for Facials, Waxing')
  assert.equal(describeFormTargeting(form([7], []), names), 'asked for 1 named service')
  assert.equal(describeFormTargeting(form([7, 8], []), names), 'asked for 2 named services')
  assert.equal(
    describeFormTargeting(form([7], [10]), names),
    'asked for Facials · 1 named service'
  )
})

test('a category with no name left does not collapse into "applies to nothing"', () => {
  // The one answer that would be a lie: the form is targeted, the category has
  // just been deleted or hidden out from under the label.
  assert.equal(describeFormTargeting(form([], [99]), names), 'asked for some categories')
})

// ── Staleness ───────────────────────────────────────────────
console.log('\nA signature or a health history that has aged out')

const NOW = Date.UTC(2026, 6, 31)

test('an expired signature is not consent', () => {
  assert.equal(signatureIsCurrent({ expires_at: new Date(NOW - 1).toISOString() }, NOW), false)
  assert.equal(signatureIsCurrent({ expires_at: new Date(NOW + 1).toISOString() }, NOW), true)
  assert.equal(signatureIsCurrent({ expires_at: null }, NOW), true)
})

test('a health history over a year old is stale, and a missing one is not current', () => {
  const old = new Date(NOW - INTAKE_MAX_AGE_MS - 1).toISOString()
  const recent = new Date(NOW - INTAKE_MAX_AGE_MS + 1).toISOString()
  assert.equal(intakeIsCurrent({ submitted_at: old }, NOW), false)
  assert.equal(intakeIsCurrent({ submitted_at: recent }, NOW), true)
  assert.equal(intakeIsCurrent(null, NOW), false)
  assert.equal(intakeIsCurrent(undefined, NOW), false)
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
