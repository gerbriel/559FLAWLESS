/**
 * Report shell tests. Run with:
 *   npx tsx scripts/reports.test.ts
 *
 * The shell does no business arithmetic of its own — each report module owns
 * that. What it does own is everything that decides WHICH rows a module is
 * asked about and how the answer is rendered, and every one of those is a quiet
 * way to be wrong:
 *
 *   • a date preset that lands a day off puts a sale in the wrong month;
 *   • a footer total that averages over blanks understates itself;
 *   • a CSV that writes "$1,234.50" cannot be summed by the thing it was
 *     exported for;
 *   • an allow-list that lets one unknown key through is not an allow-list.
 */

import assert from 'node:assert/strict'
import {
  centsToDecimalString,
  columnTotal,
  csvCell,
  formatCell,
  percent,
  ratioToPercent,
  rangeToInstants,
  resolveDateRange,
  roleAtLeast,
  type ReportColumn,
} from '../src/lib/reports/types'
import {
  buildSelect,
  compileRows,
  dateBounds,
  findSubject,
  readCell,
  sanitiseDefinition,
} from '../src/lib/reports/custom'
import { escapeCsv, resultToCsv } from '../src/lib/reports/csv'

const ZONE = 'America/Los_Angeles'
let passed = 0

function test(name: string, fn: () => void) {
  fn()
  passed += 1
  console.log(`  ok  ${name}`)
}

/** An instant, expressed as the wall clock a Fresno till would have shown. */
function at(iso: string): number {
  return new Date(iso).getTime()
}

console.log('\nDate range presets')

test('this month covers the whole calendar month', () => {
  // 11pm on 31 March, Pacific.
  const r = resolveDateRange('this_month', ZONE, at('2026-04-01T06:00:00Z'))
  assert.equal(r.from, '2026-03-01')
  assert.equal(r.to, '2026-03-31')
})

test('a late sale on the last of the month belongs to that month', () => {
  // 11:30pm on 31 January in Fresno is 07:30 UTC on 1 February. Reading the
  // clock in UTC would file this under February and quietly move a sale.
  const r = resolveDateRange('this_month', ZONE, at('2026-02-01T07:30:00Z'))
  assert.equal(r.from, '2026-01-01')
  assert.equal(r.to, '2026-01-31')
})

test('last month handles February in a non-leap year', () => {
  const r = resolveDateRange('last_month', ZONE, at('2026-03-15T19:00:00Z'))
  assert.equal(r.from, '2026-02-01')
  assert.equal(r.to, '2026-02-28')
})

test('last month handles February in a leap year', () => {
  const r = resolveDateRange('last_month', ZONE, at('2024-03-15T19:00:00Z'))
  assert.equal(r.to, '2024-02-29')
})

test('last month from the 31st does not skip a month', () => {
  // Naive month arithmetic on the 31st lands on "31 April" and rolls to May.
  const r = resolveDateRange('last_month', ZONE, at('2026-05-31T19:00:00Z'))
  assert.equal(r.from, '2026-04-01')
  assert.equal(r.to, '2026-04-30')
})

test('quarters start in Jan, Apr, Jul, Oct', () => {
  assert.equal(resolveDateRange('this_quarter', ZONE, at('2026-02-10T19:00:00Z')).from, '2026-01-01')
  assert.equal(resolveDateRange('this_quarter', ZONE, at('2026-05-10T19:00:00Z')).from, '2026-04-01')
  assert.equal(resolveDateRange('this_quarter', ZONE, at('2026-08-10T19:00:00Z')).from, '2026-07-01')
  const q4 = resolveDateRange('this_quarter', ZONE, at('2026-11-10T19:00:00Z'))
  assert.equal(q4.from, '2026-10-01')
  assert.equal(q4.to, '2026-12-31')
})

test('last 30 days is 30 days inclusive of today, not 31', () => {
  const r = resolveDateRange('last_30', ZONE, at('2026-07-31T19:00:00Z'))
  assert.equal(r.to, '2026-07-31')
  assert.equal(r.from, '2026-07-02') // 2 July … 31 July = 30 days
})

test('last 90 days spans a DST boundary without drifting a day', () => {
  // 8 March 2026 is spring-forward. Counting in local days rather than adding
  // 90 × 86,400,000 ms to an instant is what keeps this exact.
  const r = resolveDateRange('last_90', ZONE, at('2026-05-01T19:00:00Z'))
  assert.equal(r.to, '2026-05-01')
  assert.equal(r.from, '2026-02-01')
})

test('a backwards custom range is swapped, not returned empty', () => {
  const r = resolveDateRange('custom', ZONE, at('2026-07-31T19:00:00Z'), {
    from: '2026-07-30',
    to: '2026-07-01',
  })
  assert.equal(r.from, '2026-07-01')
  assert.equal(r.to, '2026-07-30')
})

test('a junk custom range falls back to this month rather than erroring', () => {
  const r = resolveDateRange('custom', ZONE, at('2026-07-15T19:00:00Z'), {
    from: 'yesterday',
    to: null,
  })
  assert.equal(r.from, '2026-07-01')
  assert.equal(r.to, '2026-07-15')
})

console.log('\nRange to instants')

test('the window is half-open and covers the last second of the last day', () => {
  const { startIso, endIso } = rangeToInstants('2026-07-01', '2026-07-31', ZONE)
  assert.equal(startIso, '2026-07-01T07:00:00.000Z') // midnight PDT
  assert.equal(endIso, '2026-08-01T07:00:00.000Z') // midnight PDT on 1 Aug
  // 11:59:59pm on the 31st is inside; midnight on the 1st is not.
  assert.ok(new Date('2026-08-01T06:59:59Z') < new Date(endIso))
  assert.ok(new Date('2026-08-01T07:00:00Z') >= new Date(endIso))
})

test('a range across spring-forward is still exactly the days asked for', () => {
  // 8 March 2026: PST (-08) before, PDT (-07) after.
  const { startIso, endIso } = rangeToInstants('2026-03-07', '2026-03-09', ZONE)
  assert.equal(startIso, '2026-03-07T08:00:00.000Z')
  assert.equal(endIso, '2026-03-10T07:00:00.000Z')
  // Three calendar days, but 71 hours — which is correct, and is exactly what a
  // fixed 24h × 3 would have got wrong.
  const hours = (new Date(endIso).getTime() - new Date(startIso).getTime()) / 3_600_000
  assert.equal(hours, 71)
})

console.log('\nRoles')

test('minRole is a total order', () => {
  assert.equal(roleAtLeast('manager', 'manager'), true)
  assert.equal(roleAtLeast('admin', 'manager'), true)
  assert.equal(roleAtLeast('front_desk', 'manager'), false)
  assert.equal(roleAtLeast('provider', 'front_desk'), false)
  assert.equal(roleAtLeast('client', 'provider'), false)
})

test('an unknown or missing role is never good enough', () => {
  assert.equal(roleAtLeast(null, 'provider'), false)
  assert.equal(roleAtLeast(undefined, 'provider'), false)
  assert.equal(roleAtLeast('superuser', 'client'), false)
})

console.log('\nMoney and formatting')

test('cents become a decimal string with no float arithmetic', () => {
  assert.equal(centsToDecimalString(0), '0.00')
  assert.equal(centsToDecimalString(5), '0.05')
  assert.equal(centsToDecimalString(123_456), '1234.56')
  assert.equal(centsToDecimalString(-2_500), '-25.00')
  // 0.1 + 0.2 territory: 8,675,309 cents is exact here and is not in a float.
  assert.equal(centsToDecimalString(8_675_309), '86753.09')
})

test('a percent denominator of zero is null, never NaN', () => {
  assert.equal(ratioToPercent(3, 0), null)
  assert.equal(ratioToPercent(0, 0), null)
  assert.equal(ratioToPercent(1, 4), 25)
  assert.equal(percent(null), '—')
  assert.equal(percent(62.66), '62.7%')
  assert.equal(percent(100), '100.0%')
})

test('a string cell passes through whatever the column claims', () => {
  const col: ReportColumn = { key: 'x', label: 'X', format: 'money' }
  // A module that formatted its own value keeps it rather than being mangled.
  assert.equal(formatCell('$1,234 (est.)', col, ZONE), '$1,234 (est.)')
  assert.equal(formatCell(123_400, col, ZONE), '$1,234')
  assert.equal(formatCell(null, col, ZONE), '—')
})

test('a date key is rendered from its own parts, not reinterpreted by zone', () => {
  const col: ReportColumn = { key: 'd', label: 'D', format: 'date' }
  assert.equal(formatCell('2026-03-01', col, 'Australia/Sydney'), 'Mar 1, 2026')
})

console.log('\nColumn totals')

test('sum skips non-numeric cells rather than counting them as zero', () => {
  const col: ReportColumn = { key: 'v', label: 'V', format: 'money', total: 'sum' }
  const rows = [{ v: 1_000 }, { v: null }, { v: '—' }, { v: 2_500 }]
  assert.equal(columnTotal(rows, col), 3_500)
})

test('avg divides by the numeric cells, not the row count', () => {
  const col: ReportColumn = { key: 'v', label: 'V', format: 'number', total: 'avg' }
  // Three rows, two numbers. Averaging over 3 would report 5 and be wrong.
  assert.equal(columnTotal([{ v: 10 }, { v: null }, { v: 5 }], col), 7.5)
})

test('a column with no numbers totals to null, not zero', () => {
  const col: ReportColumn = { key: 'v', label: 'V', total: 'sum' }
  assert.equal(columnTotal([{ v: null }, { v: 'x' }], col), null)
  assert.equal(columnTotal([], col), null)
})

test('a column without total: set is never totalled', () => {
  assert.equal(columnTotal([{ v: 1 }], { key: 'v', label: 'V' }), null)
})

console.log('\nCSV')

test('RFC 4180: quotes are doubled and dangerous fields are quoted', () => {
  assert.equal(escapeCsv('plain'), 'plain')
  assert.equal(escapeCsv('a,b'), '"a,b"')
  assert.equal(escapeCsv('say "hi"'), '"say ""hi"""')
  assert.equal(escapeCsv('line\r\nbreak'), '"line\r\nbreak"')
})

test('money exports as a bare number a spreadsheet can sum', () => {
  const money: ReportColumn = { key: 'm', label: 'M', format: 'money' }
  const pct: ReportColumn = { key: 'p', label: 'P', format: 'percent' }
  assert.equal(csvCell(123_456, money), '1234.56')
  assert.equal(csvCell(-500, money), '-5.00')
  assert.equal(csvCell(62.5, pct), '62.50')
  assert.equal(csvCell(null, money), '')
})

test('sections and notes travel with the numbers', () => {
  const csv = resultToCsv({
    columns: [
      { key: 'name', label: 'Name' },
      { key: 'cents', label: 'Total', format: 'money', total: 'sum' },
    ],
    rows: [{ name: 'Facial, deep', cents: 12_000 }],
    sections: [{ title: 'By provider', rows: [{ name: 'Alma', cents: 12_000 }] }],
    notes: ['Denominator: completed appointments.'],
  })
  const lines = csv.split('\r\n')
  assert.equal(lines[0], 'Name,Total')
  assert.equal(lines[1], '"Facial, deep",120.00') // comma in the name forced a quote
  assert.equal(lines[2], '')
  assert.equal(lines[3], 'By provider')
  assert.equal(lines[5], 'Alma,120.00')
  assert.ok(csv.includes('Denominator: completed appointments.'))
})

console.log('\nCustom builder — the allow-list')

test('an unknown subject produces no definition at all', () => {
  assert.equal(sanitiseDefinition({ subject: 'client_notes' }), null)
  assert.equal(sanitiseDefinition({ subject: 'treatment_photos' }), null)
  assert.equal(sanitiseDefinition({}), null)
})

test('a column that is not on the list ceases to exist', () => {
  const d = sanitiseDefinition({
    subject: 'clients',
    // Every one of these is a real column on client_records, and every one is
    // health information. None of them are offered, so none survive.
    columns: ['medical_notes', 'allergies', 'medications', 'fitzpatrick', 'visit_count'],
  })!
  assert.deepEqual(d.columns, ['visit_count'])
})

test('an all-invalid column list falls back to the subject default, not to everything', () => {
  const d = sanitiseDefinition({ subject: 'clients', columns: ['medical_notes'] })!
  assert.equal(d.columns.length, 4)
  assert.ok(!d.columns.includes('medical_notes'))
})

test('a filter value outside its option list is dropped', () => {
  const d = sanitiseDefinition({
    subject: 'payments',
    columns: ['amount_cents'],
    filters: { status: "succeeded' or '1'='1", kind: 'refund' },
  })!
  assert.equal(d.filters.status, undefined)
  assert.equal(d.filters.kind, 'refund')
})

test('a non-groupable column cannot become the grouping', () => {
  const d = sanitiseDefinition({
    subject: 'expenses',
    columns: ['amount_cents'],
    groupBy: 'amount_cents',
  })!
  assert.equal(d.groupBy, null)
  const ok = sanitiseDefinition({
    subject: 'expenses',
    columns: ['amount_cents'],
    groupBy: 'category',
  })!
  assert.equal(ok.groupBy, 'category')
})

test('a sort must name a column that will actually be in the table', () => {
  const ungrouped = sanitiseDefinition({
    subject: 'orders',
    columns: ['total_cents'],
    sort: 'tax_cents', // not selected
  })!
  assert.equal(ungrouped.sort, null)

  const grouped = sanitiseDefinition({
    subject: 'orders',
    columns: ['total_cents'],
    groupBy: 'channel',
    sort: 'row_count',
  })!
  assert.equal(grouped.sort, 'row_count')
})

test('the select string is built only from subject literals', () => {
  const subject = findSubject('appointments')!
  const d = sanitiseDefinition({
    subject: 'appointments',
    columns: ['status', 'total_cents'],
    groupBy: 'provider',
  })!
  const select = buildSelect(subject, d)
  // The grouping key is fetched even though it was not ticked as a column.
  assert.ok(select.includes('status'))
  assert.ok(select.includes('total_cents'))
  // Two FKs from appointments to profiles, so the embed names the constraint.
  assert.ok(select.includes('profiles!appointments_provider_id_fkey'))
  assert.ok(!select.includes('staff_notes'))
  assert.ok(!select.includes('client_notes'))
})

console.log('\nCustom builder — date bounds and aggregation')

test('a DATE column is compared to date keys, a timestamptz to instants', () => {
  const expenses = dateBounds(findSubject('expenses')!, '2026-07-01', '2026-07-31', ZONE)
  assert.deepEqual(expenses, { gte: '2026-07-01', lte: '2026-07-31' })

  const orders = dateBounds(findSubject('orders')!, '2026-07-01', '2026-07-31', ZONE)
  assert.equal(orders.gte, '2026-07-01T07:00:00.000Z')
  assert.equal(orders.lt, '2026-08-01T07:00:00.000Z')
  assert.equal(orders.lte, undefined)
})

test('an embedded person reads as a name, never as [object Object]', () => {
  const col = findSubject('orders')!.columns.find((c) => c.key === 'client')!
  assert.equal(readCell({ client: { display_name: 'Marisol R.' } }, col), 'Marisol R.')
  assert.equal(
    readCell({ client: { display_name: null, first_name: 'Ana', last_name: 'Ruiz' } }, col),
    'Ana Ruiz'
  )
  assert.equal(readCell({ client: null }, col), null)
})

test('grouping counts rows and sums money in integer cents', () => {
  const subject = findSubject('orders')!
  const d = sanitiseDefinition({
    subject: 'orders',
    columns: ['total_cents', 'tax_cents'],
    groupBy: 'channel',
    sort: 'total_cents',
  })!

  const raw = [
    { channel: 'in_store', total_cents: 4_599, tax_cents: 371 },
    { channel: 'online', total_cents: 12_000, tax_cents: 968 },
    { channel: 'in_store', total_cents: 2_401, tax_cents: 194 },
  ]
  const out = compileRows(subject, d, raw, false)

  // Column order is the subject's, not the order they were ticked, so the same
  // selection always renders the same table.
  assert.deepEqual(
    out.columns.map((c) => c.key),
    ['channel', 'row_count', 'tax_cents', 'total_cents']
  )
  // Sorted by total_cents descending, so online (12,000) leads and the two
  // in_store rows are folded into one at 4,599 + 2,401 = 7,000 exactly.
  assert.deepEqual(out.rows[0], {
    channel: 'online',
    row_count: 1,
    total_cents: 12_000,
    tax_cents: 968,
  })
  assert.deepEqual(out.rows[1], {
    channel: 'in_store',
    row_count: 2,
    total_cents: 7_000,
    tax_cents: 565,
  })
  // Every money column carries a footer total, and tax stays its own column —
  // it is held for the state, not earned.
  assert.equal(out.columns.find((c) => c.key === 'tax_cents')!.total, 'sum')
})

test('rows with a null grouping key are bucketed, not dropped', () => {
  const subject = findSubject('expenses')!
  const d = sanitiseDefinition({
    subject: 'expenses',
    columns: ['amount_cents'],
    groupBy: 'vendor',
  })!
  const out = compileRows(
    subject,
    d,
    [{ vendors: null, amount_cents: 500 }, { vendors: { name: 'Dermalogica' }, amount_cents: 9_900 }],
    false
  )
  assert.equal(out.rows.length, 2)
  const total = out.rows.reduce((n, r) => n + (r.amount_cents as number), 0)
  assert.equal(total, 10_400) // nothing silently lost
})

test('blank cells sink to the bottom whichever way the sort runs', () => {
  const subject = findSubject('clients')!
  const asc = sanitiseDefinition({
    subject: 'clients',
    columns: ['client', 'lifetime_value_cents'],
    sort: 'lifetime_value_cents',
    sortDir: 'asc',
  })!
  const rows = [
    { client: { display_name: 'B' }, lifetime_value_cents: 5_000 },
    { client: { display_name: 'A' }, lifetime_value_cents: null },
    { client: { display_name: 'C' }, lifetime_value_cents: 100 },
  ]
  const out = compileRows(subject, asc, rows, false)
  assert.equal(out.rows[0].lifetime_value_cents, 100)
  assert.equal(out.rows[2].lifetime_value_cents, null)
})

console.log(`\n${passed} assertions passed.\n`)
