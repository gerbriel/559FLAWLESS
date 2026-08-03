/**
 * CSV parser, value coercion and column-guessing tests. Run with:
 *   npx tsx scripts/csv.test.ts
 *
 * These are the parts that decide whether a studio's client list imports
 * correctly, and every one of them is easy to get subtly wrong and impossible
 * to notice afterwards: a quoted comma that splits a name into two columns, a
 * BOM that makes the first header match nothing, `parseFloat * 100` turning
 * $12.50 into 1249 cents. The failure mode is never an exception — it is a
 * database full of plausible, wrong data.
 */

import assert from 'node:assert/strict'
import { parseCsv, parseCsvRows, sniffDelimiter } from '../src/lib/csv/parse'
import {
  parseMoneyCents,
  parseDateKey,
  parseBoolean,
  parseInteger,
  parseEmail,
  parsePhone,
  slugify,
  guardFormula,
  unguardFormula,
} from '../src/lib/csv/values'
import {
  headerScore,
  headersLookLikeData,
  profileColumn,
  suggestMapping,
  valueScore,
} from '../src/lib/csv/suggest'
import { prepare } from '../src/lib/csv/prepare'
import { csvEntity } from '../src/lib/csv/entities'
import { importableFields, templateRows } from '../src/lib/csv/schema'
import { toCsv } from '../src/lib/csv/serialize'

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

// ── The parser ──────────────────────────────────────────────
console.log('\nParser')

test('plain rows', () => {
  const { headers, rows } = parseCsv('a,b,c\n1,2,3\n4,5,6')
  assert.deepEqual(headers, ['a', 'b', 'c'])
  assert.deepEqual(rows, [['1', '2', '3'], ['4', '5', '6']])
})

test('a quoted field keeps its comma', () => {
  const { rows } = parseCsv('name,city\n"Vega, Maria",Fresno')
  assert.deepEqual(rows, [['Vega, Maria', 'Fresno']])
})

test('a quoted field keeps its newline', () => {
  const { rows } = parseCsv('name,address\nMaria,"1 Elm St\nApt 4"')
  assert.deepEqual(rows, [['Maria', '1 Elm St\nApt 4']])
})

test('a doubled quote is one literal quote', () => {
  const { rows } = parseCsv('a\n"she said ""hello"""')
  assert.deepEqual(rows, [['she said "hello"']])
})

test('an empty quoted field is empty, not missing', () => {
  const { rows } = parseCsv('a,b,c\n1,"",3')
  assert.deepEqual(rows, [['1', '', '3']])
})

test('a UTF-8 BOM does not become part of the first header', () => {
  const { headers } = parseCsv('﻿First Name,Email\nMaria,m@example.com')
  assert.equal(headers[0], 'First Name')
})

test('CRLF is one line ending, not two', () => {
  const { headers, rows } = parseCsv('a,b\r\n1,2\r\n3,4\r\n')
  assert.deepEqual(headers, ['a', 'b'])
  assert.deepEqual(rows, [['1', '2'], ['3', '4']])
})

test('a lone CR ends a line too', () => {
  const { rows } = parseCsv('a,b\r1,2\r3,4')
  assert.deepEqual(rows, [['1', '2'], ['3', '4']])
})

test('a trailing newline does not invent a last row', () => {
  assert.equal(parseCsv('a,b\n1,2\n').rows.length, 1)
  assert.equal(parseCsv('a,b\r\n1,2\r\n\r\n').rows.length, 1)
})

test('a blank line in the middle is dropped', () => {
  const { rows } = parseCsv('a,b\n1,2\n\n3,4')
  assert.deepEqual(rows, [['1', '2'], ['3', '4']])
})

test('a row of nothing but commas is dropped', () => {
  const { rows } = parseCsv('a,b,c\n1,2,3\n,,\n4,5,6')
  assert.deepEqual(rows, [['1', '2', '3'], ['4', '5', '6']])
})

test('a short row is padded to the header width', () => {
  const { rows, ragged } = parseCsv('a,b,c\n1,2')
  assert.deepEqual(rows, [['1', '2', '']])
  assert.equal(ragged, 1)
})

test('a long row is clipped and counted', () => {
  const { rows, ragged } = parseCsv('a,b\n1,2,3,4')
  assert.deepEqual(rows, [['1', '2']])
  assert.equal(ragged, 1)
})

test('a stray quote mid-field is a literal, not an error', () => {
  const { rows } = parseCsv('size\n5" x 7"')
  assert.deepEqual(rows, [['5" x 7"']])
})

test('a quote right before the delimiter closes the field', () => {
  const { rows } = parseCsv('a,b\n"one",two')
  assert.deepEqual(rows, [['one', 'two']])
})

test('the last row survives without a trailing newline', () => {
  const { rows } = parseCsv('a\n1\n2')
  assert.deepEqual(rows, [['1'], ['2']])
})

test('a CRLF inside quotes stays inside the field', () => {
  const { rows } = parseCsv('a,b\r\n"line1\r\nline2",x\r\n')
  assert.deepEqual(rows, [['line1\r\nline2', 'x']])
})

test('semicolons are sniffed', () => {
  assert.equal(sniffDelimiter('a;b;c\n1;2;3'), ';')
  const { headers, rows } = parseCsv('name;email\nMaria;m@example.com')
  assert.deepEqual(headers, ['name', 'email'])
  assert.deepEqual(rows, [['Maria', 'm@example.com']])
})

test('tabs are sniffed', () => {
  assert.equal(sniffDelimiter('a\tb\tc'), '\t')
})

test('a comma inside quotes does not win the delimiter vote', () => {
  // One real semicolon; three commas, all inside a quoted field.
  assert.equal(sniffDelimiter('"a,b,c,d";e'), ';')
})

test('a single-column file with no delimiter defaults to comma', () => {
  const { headers, rows } = parseCsv('Email\nm@example.com')
  assert.deepEqual(headers, ['Email'])
  assert.deepEqual(rows, [['m@example.com']])
})

test('an empty file yields nothing rather than throwing', () => {
  const empty = parseCsv('')
  assert.deepEqual(empty.headers, [])
  assert.deepEqual(empty.rows, [])
})

test('a header-only file has zero rows', () => {
  assert.equal(parseCsv('a,b,c').rows.length, 0)
})

test('maxDataRows stops early and says it did', () => {
  const text = ['h', '1', '2', '3', '4', '5'].join('\n')
  const cut = parseCsv(text, { maxDataRows: 2 })
  assert.equal(cut.rows.length, 2)
  assert.equal(cut.truncated, true)
  const whole = parseCsv(text, { maxDataRows: 10 })
  assert.equal(whole.truncated, false, 'not truncated when it fits')
})

test('parseCsvRows returns the header as a row', () => {
  const { rows } = parseCsvRows('a,b\n1,2')
  assert.deepEqual(rows, [['a', 'b'], ['1', '2']])
})

test('what the writer writes, the parser reads back', () => {
  const headers = ['Name', 'Note']
  const rows = [
    ['Vega, Maria', 'said "hello"'],
    ['O’Neil', 'line one\nline two'],
    ['', 'trailing space  '],
  ]
  const round = parseCsv(toCsv(headers, rows))
  assert.deepEqual(round.headers, headers)
  // The last cell's trailing space survives the writer; prepare() trims it.
  assert.deepEqual(round.rows[0], rows[0])
  assert.deepEqual(round.rows[1], rows[1])
})

// ── Money ───────────────────────────────────────────────────
console.log('\nMoney')

const cents = (s: string) => {
  const r = parseMoneyCents(s)
  assert.ok(r.ok, `expected ${s} to parse: ${r.ok ? '' : r.error}`)
  return r.ok ? r.value : NaN
}

test('12.50 is 1250 cents exactly', () => {
  assert.equal(cents('12.50'), 1250)
  // The bug this guards: parseFloat('12.50') * 100 is not always 1250.
  assert.ok(Number.isInteger(cents('12.50')))
})

test('one decimal place is tenths, not hundredths', () => {
  assert.equal(cents('12.5'), 1250)
  assert.equal(cents('12.05'), 1205)
})

test('no decimal point means whole dollars', () => {
  assert.equal(cents('85'), 8500)
  assert.equal(cents('0'), 0)
})

test('a dollar sign and thousands separators come off', () => {
  assert.equal(cents('$1,234.50'), 123450)
  assert.equal(cents('USD 99.99'), 9999)
  assert.equal(cents('$ 40'), 4000)
})

test('accounting parentheses are negative', () => {
  assert.equal(cents('(4.00)'), -400)
  assert.equal(cents('-4.00'), -400)
})

test('the classic float cases land on the cent', () => {
  for (const [text, expected] of [
    ['0.07', 7],
    ['1.10', 110],
    ['1.15', 115],
    ['8.20', 820],
    ['29.97', 2997],
    ['1234567.89', 123456789],
  ] as const) {
    assert.equal(cents(text), expected, `${text} should be ${expected}`)
  }
})

test('three decimal places are refused, not rounded', () => {
  const r = parseMoneyCents('12.505')
  assert.equal(r.ok, false)
})

test('a comma decimal separator is refused rather than read as thousands', () => {
  assert.equal(parseMoneyCents('1,5').ok, false)
})

test('words are not money', () => {
  for (const bad of ['', 'free', 'n/a', '--', '12.50.50']) {
    assert.equal(parseMoneyCents(bad).ok, false, `${bad} should not parse`)
  }
})

test('the message tells her the format', () => {
  const r = parseMoneyCents('free')
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(r.error.includes('12.50'), 'names an example')
})

// ── Dates ───────────────────────────────────────────────────
console.log('\nDates')

const dateKey = (s: string) => {
  const r = parseDateKey(s)
  return r.ok ? r.value : null
}

test('ISO is taken as written', () => {
  assert.equal(dateKey('1990-03-04'), '1990-03-04')
  assert.equal(dateKey('1990-3-4'), '1990-03-04')
  assert.equal(dateKey('1990/03/04'), '1990-03-04')
})

test('a slash date is read month-first', () => {
  assert.equal(dateKey('3/4/1990'), '1990-03-04')
  assert.equal(dateKey('12/25/1990'), '1990-12-25')
})

test('an unmistakably day-first date is refused, not guessed', () => {
  const r = parseDateKey('25/12/1990')
  assert.equal(r.ok, false)
  if (!r.ok) assert.ok(r.error.includes('1990-12-25'), 'suggests the fix')
})

test('a two-digit year is refused', () => {
  assert.equal(parseDateKey('3/4/90').ok, false)
})

test('29 February is real in a leap year and not otherwise', () => {
  assert.equal(dateKey('2024-02-29'), '2024-02-29')
  assert.equal(parseDateKey('2023-02-29').ok, false)
  assert.equal(dateKey('2000-02-29'), '2000-02-29', '2000 is a leap year')
  assert.equal(parseDateKey('1900-02-29').ok, false, '1900 is not')
})

test('impossible days and months are refused', () => {
  assert.equal(parseDateKey('2024-04-31').ok, false)
  assert.equal(parseDateKey('2024-13-01').ok, false)
  assert.equal(parseDateKey('2024-00-10').ok, false)
})

test('a date key never depends on the machine timezone', () => {
  // No Date is constructed anywhere in parseDateKey, so this is a statement
  // about the implementation as much as the result.
  const before = process.env.TZ
  process.env.TZ = 'Pacific/Kiritimati'
  const east = dateKey('1990-03-04')
  process.env.TZ = 'Pacific/Midway'
  const west = dateKey('1990-03-04')
  process.env.TZ = before
  assert.equal(east, west)
  assert.equal(east, '1990-03-04')
})

// ── The other coercions ─────────────────────────────────────
console.log('\nOther values')

test('yes/no in the many shapes a spreadsheet writes it', () => {
  for (const truthy of ['yes', 'Y', 'TRUE', '1', 'x', 'active']) {
    const r = parseBoolean(truthy)
    assert.ok(r.ok && r.value === true, `${truthy} is true`)
  }
  for (const falsy of ['no', 'N', 'FALSE', '0', 'inactive']) {
    const r = parseBoolean(falsy)
    assert.ok(r.ok && r.value === false, `${falsy} is false`)
  }
  assert.equal(parseBoolean('maybe').ok, false)
})

test('a whole number tolerates a spreadsheet .0', () => {
  const r = parseInteger('60.0')
  assert.ok(r.ok && r.value === 60)
  assert.equal(parseInteger('60.5').ok, false)
  const grouped = parseInteger('1,200')
  assert.ok(grouped.ok && grouped.value === 1200)
})

test('an email is lowercased, and a non-email is refused', () => {
  const r = parseEmail('  Maria.Vega@Example.COM ')
  assert.ok(r.ok && r.value === 'maria.vega@example.com')
  for (const bad of ['maria at example', 'maria@', '@example.com', 'Maria Vega']) {
    assert.equal(parseEmail(bad).ok, false, `${bad} is not an email`)
  }
})

test('a phone is normalised, and a short one is refused', () => {
  const ten = parsePhone('559-555-0134')
  assert.ok(ten.ok && ten.value === '(559) 555-0134')
  const eleven = parsePhone('1 (559) 555.0134')
  assert.ok(eleven.ok && eleven.value === '(559) 555-0134')
  assert.equal(parsePhone('555').ok, false)
})

test('a slug is url-safe and drops accents', () => {
  assert.equal(slugify('Signature Facial'), 'signature-facial')
  assert.equal(slugify('Café  Crème!'), 'cafe-creme')
})

// ── The guesser ─────────────────────────────────────────────
console.log('\nColumn guessing')

const clients = csvEntity('clients')!
const fieldNamed = (key: string) => importableFields(clients).find((f) => f.key === key)!

test('an exact header is a perfect score however it is punctuated', () => {
  for (const header of ['First Name', 'first_name', 'FIRSTNAME', 'first-name', 'firstname']) {
    assert.equal(headerScore(header, fieldNamed('first_name')), 1, header)
  }
})

test('a known abbreviation lands on the right field', () => {
  assert.equal(headerScore('fname', fieldNamed('first_name')), 1)
  assert.equal(headerScore('DOB', fieldNamed('date_of_birth')), 1)
  assert.equal(headerScore('Mobile', fieldNamed('phone')), 1)
})

test('an unrelated header does not score', () => {
  assert.ok(headerScore('Invoice Total', fieldNamed('first_name')) < 0.45)
})

test('a column of addresses reads as email whatever the header says', () => {
  const profile = profileColumn('Field 7', 0, [
    'maria@example.com',
    'jo@example.org',
    'sam.p@studio.co',
  ])
  assert.ok(profile.email > 0.9)
  assert.ok(valueScore(profile, 'email') > 0.9)
})

test('a column of phone numbers reads as phone', () => {
  const profile = profileColumn('col2', 1, ['559-555-0134', '(559) 555 0135', '15595550136'])
  assert.ok(profile.phone > 0.9)
})

test('a year is not a phone number', () => {
  const profile = profileColumn('col', 0, ['2024', '2025', '2026'])
  assert.equal(profile.phone, 0)
})

test('two decimal places read as money; bare integers do not', () => {
  assert.ok(profileColumn('c', 0, ['12.50', '8.00', '125.00']).money > 0.9)
  assert.ok(profileColumn('c', 0, ['12', '8', '125']).money < 0.1)
})

test('a two-valued column reads as a yes/no', () => {
  const profile = profileColumn('Field 9', 0, ['S', 'U', 'S', 'S', 'U', 'S'])
  assert.ok(valueScore(profile, 'boolean') >= 0.7, 'two distinct values is the signal')
})

test('dates read as dates in either separator', () => {
  assert.ok(profileColumn('c', 0, ['1990-03-04', '1985-12-01']).date > 0.9)
  assert.ok(profileColumn('c', 0, ['3/4/1990', '12/1/1985']).date > 0.9)
})

test('the values decide when the header is useless', () => {
  const headers = ['Field 1', 'Field 2', 'Field 3', 'Field 4']
  const rows = [
    ['Maria', 'maria@example.com', '559-555-0134', '1990-03-04'],
    ['Jo', 'jo@example.org', '(559) 555-0135', '1985-12-01'],
    ['Sam', 'sam@studio.co', '5595550136', '2001-06-30'],
  ]
  const { chosen } = suggestMapping(headers, rows, importableFields(clients))
  assert.equal(chosen.email?.column, 1)
  assert.equal(chosen.phone?.column, 2)
  assert.equal(chosen.date_of_birth?.column, 3)
})

test('the reason says which signal was used', () => {
  const { chosen } = suggestMapping(
    ['Field 2'],
    [['maria@example.com'], ['jo@example.org']],
    importableFields(clients)
  )
  assert.ok(chosen.email?.reason.includes('email'), chosen.email?.reason)
})

test('a strong pairing is not stolen by an earlier weaker field', () => {
  // "Name" would otherwise grab the column that "First Name" matches exactly.
  const headers = ['Name', 'First Name', 'Last Name', 'Email']
  const rows = [['Maria Vega', 'Maria', 'Vega', 'maria@example.com']]
  const { chosen } = suggestMapping(headers, rows, importableFields(clients))
  assert.equal(chosen.first_name?.column, 1)
  assert.equal(chosen.last_name?.column, 2)
  assert.equal(chosen.email?.column, 3)
})

test('one column is not suggested for two fields', () => {
  const headers = ['Email', 'Phone']
  const rows = [['maria@example.com', '5595550134']]
  const { chosen } = suggestMapping(headers, rows, importableFields(clients))
  const used = Object.values(chosen)
    .filter((s) => s !== undefined)
    .map((s) => s!.column)
  assert.equal(new Set(used).size, used.length)
})

test('nothing is suggested for a field with no plausible column', () => {
  const { chosen } = suggestMapping(['Widget'], [['blue']], importableFields(clients))
  assert.equal(chosen.date_of_birth, undefined)
})

test('an exported header maps back onto itself perfectly', () => {
  // The round trip the whole design rests on: export, re-import, no work.
  for (const key of ['clients', 'services', 'products'] as const) {
    const entity = csvEntity(key)!
    const { headers, example } = templateRows(entity)
    const { chosen } = suggestMapping(headers, [example], importableFields(entity))
    for (const field of importableFields(entity)) {
      assert.equal(
        chosen[field.key]?.column,
        headers.indexOf(field.label),
        `${key}.${field.key} should map to its own column`
      )
    }
  }
})

// ── Preparing rows ──────────────────────────────────────────
console.log('\nPreparing rows')

test('a blank cell is absent, not a null that would clear the record', () => {
  const headers = ['First Name', 'Last Name', 'Email', 'Phone']
  const rows = [['Maria', 'Vega', 'maria@example.com', '']]
  const { rows: prepared, problems } = prepare(clients, headers, rows, {
    first_name: 0,
    last_name: 1,
    email: 2,
    phone: 3,
  })
  assert.equal(problems.length, 0)
  assert.equal('phone' in prepared[0].values, false, 'phone is absent, not null')
  assert.equal(prepared[0].values.email, 'maria@example.com')
})

test('a missing required column rejects the row and says which', () => {
  const { problems } = prepare(clients, ['Email'], [['maria@example.com']], { email: 0 })
  assert.ok(problems.some((p) => p.field === 'first_name'))
  assert.ok(problems.some((p) => p.message.includes('required')))
})

// This asserted the opposite until 051 gave the studio somewhere to put a
// client it knows and cannot sign up. A name with no email and no phone is the
// eight-year regular nobody ever asked for an address; rejecting the row left
// the studio holding a paper list it could not type in. It is kept now and
// becomes a client_stub — a contact record, invited later, claimed rather than
// duplicated when the invitation is accepted.
test('a client with neither email nor phone is kept, to become a stub', () => {
  const { rows, problems } = prepare(clients, ['First Name', 'Last Name'], [['Maria', 'Vega']], {
    first_name: 0,
    last_name: 1,
  })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].values.first_name, 'Maria')
  // Nothing to match on is not a defect in the row; it is the case the stub
  // exists for, so it must not be reported as a problem.
  assert.equal(problems.length, 0)
})

test('row numbers match the spreadsheet, header counted as row 1', () => {
  const { problems } = prepare(
    clients,
    ['First Name', 'Last Name', 'Email'],
    [
      ['Maria', 'Vega', 'maria@example.com'],
      ['Jo', 'Ng', 'not-an-email'],
    ],
    { first_name: 0, last_name: 1, email: 2 }
  )
  assert.equal(problems[0].line, 3, 'the second data row is row 3')
})

test('money in a service row lands as integer cents', () => {
  const services = csvEntity('services')!
  const { rows } = prepare(
    services,
    ['Name', 'Category', 'Price'],
    [['Signature Facial', 'Facials', '$125.00']],
    { name: 0, category: 1, price_cents: 2 }
  )
  assert.equal(rows[0].values.price_cents, 12500)
})

test('unmapped file columns are reported rather than dropped in silence', () => {
  const { ignoredColumns } = prepare(
    clients,
    ['First Name', 'Last Name', 'Email', 'Loyalty Points'],
    [['Maria', 'Vega', 'maria@example.com', '400']],
    { first_name: 0, last_name: 1, email: 2 }
  )
  assert.deepEqual(ignoredColumns, ['Loyalty Points'])
})

// ── The definitions themselves ──────────────────────────────
console.log('\nEntity definitions')

test('every entity has unique field keys and labels', () => {
  for (const key of ['clients', 'services', 'products', 'sales', 'appointments'] as const) {
    const entity = csvEntity(key)!
    const keys = entity.fields.map((f) => f.key)
    const labels = entity.fields.map((f) => f.label)
    assert.equal(new Set(keys).size, keys.length, `${key} has a duplicate field key`)
    assert.equal(new Set(labels).size, labels.length, `${key} has a duplicate label`)
  }
})

test('every example value parses as its own type', () => {
  for (const key of ['clients', 'services', 'products'] as const) {
    const entity = csvEntity(key)!
    const { headers, example } = templateRows(entity)
    const { problems } = prepare(
      entity,
      headers,
      [example],
      Object.fromEntries(importableFields(entity).map((f, i) => [f.key, i]))
    )
    assert.equal(
      problems.length,
      0,
      `${key} template does not import: ${problems.map((p) => p.message).join('; ')}`
    )
  }
})

test('read-only fields never appear in a template', () => {
  for (const key of ['clients', 'services', 'products'] as const) {
    const entity = csvEntity(key)!
    const { headers } = templateRows(entity)
    for (const field of entity.fields) {
      if (field.readOnly) assert.ok(!headers.includes(field.label), `${key}.${field.key} leaked`)
    }
  }
})

test('every read-only field says why it is read-only', () => {
  for (const key of ['clients', 'services', 'products'] as const) {
    for (const field of csvEntity(key)!.fields) {
      if (field.readOnly) assert.ok(field.readOnlyBecause, `${key}.${field.key} has no reason`)
    }
  }
})

test('an export-only entity says why it cannot be imported', () => {
  for (const key of ['sales', 'appointments'] as const) {
    const entity = csvEntity(key)!
    assert.equal(entity.importing, null)
    assert.ok(entity.notImportable && entity.notImportable.length > 40)
  }
})

test('no gate guarded by services_guard_gates is importable', () => {
  // The list is migration 022's, not a preference. If a field here becomes
  // importable, this import will fail at the database rather than in the form.
  const guarded = [
    'is_intimate',
    'requires_age_verification',
    'min_age',
    'requires_consultation',
    'patch_test_hours',
    'deposit_cents',
    'cancellation_window_hours',
  ]
  const importable = importableFields(csvEntity('services')!).map((f) => f.key)
  for (const gate of guarded) {
    assert.ok(!importable.includes(gate), `${gate} must not be importable`)
  }
})

test('no clinical column is exportable or importable, in any entity', () => {
  // AGENTS.md rule 5. `services.requires_intake` is deliberately not on this
  // list — it is a flag on the menu saying a form is needed, not the form.
  const forbidden = [
    'client_notes',
    'staff_notes',
    'notes',
    'intake_submission',
    'intake_answers',
    'consent',
    'body_snapshot',
    'patch_test',
    'treatment_photo',
    'photo_url',
    'age_attested_at',
    'age_verified_at',
  ]
  for (const key of ['clients', 'services', 'products', 'sales', 'appointments'] as const) {
    for (const field of csvEntity(key)!.fields) {
      assert.ok(
        !forbidden.includes(field.key),
        `${key}.${field.key} is health information and must not be in a CSV`
      )
    }
  }
})

// ── The spreadsheet formula guard ───────────────────────────
console.log('\nThe spreadsheet formula guard')

test('a cell that would run as a formula is made inert on the way out', () => {
  for (const hostile of [
    "=cmd|' /C calc'!A0",
    '@SUM(1+1)',
    '+HYPERLINK("http://evil.example/","Click")',
    '-2+3+cmd|\' /C calc\'!A0',
    '\tleading tab',
    '\rleading carriage return',
  ]) {
    assert.equal(guardFormula(hostile), `'${hostile}`, hostile)
  }
})

test('a number is still a number, so a spreadsheet can still sum the column', () => {
  for (const number of ['-4.00', '-1', '125.00', '0', '+15595550134']) {
    assert.equal(guardFormula(number), number, number)
  }
})

test('the guard never fires on ordinary text', () => {
  for (const value of ['Maria Vega', "O’Neil", 'Signature Facial', '(559) 555-0134', '']) {
    assert.equal(guardFormula(value), value, value)
  }
})

test('the guard is exactly reversible, so export → import is unchanged', () => {
  const values = [
    "=cmd|' /C calc'!A0",
    '@SUM(1+1)',
    '-4.00',
    'Maria Vega',
    // Apostrophes people actually type survive untouched: the guard is only
    // undone in front of the characters that would have put it there.
    "'86 Camaro",
    "O'Neil",
  ]
  for (const value of values) {
    assert.equal(unguardFormula(guardFormula(value)), value, value)
  }
})

test('a guarded export re-imports as the value it started as', () => {
  const written = toCsv(['First Name', 'Last Name', 'Email'], [['=Maria', 'Vega', 'maria@example.com']])
  const read = parseCsv(written)
  assert.equal(read.rows[0][0], "'=Maria", 'it travels guarded')
  const { rows } = prepare(clients, read.headers, read.rows, {
    first_name: 0,
    last_name: 1,
    email: 2,
  })
  assert.equal(rows[0].values.first_name, '=Maria', 'and lands as itself')
})

test('no template example is disturbed by the guard', () => {
  for (const key of ['clients', 'services', 'products'] as const) {
    const { headers, example } = templateRows(csvEntity(key)!)
    for (const cell of [...headers, ...example]) {
      assert.equal(guardFormula(cell), cell, `${key}: ${cell}`)
    }
  }
})

// ── A file saved without its header row ─────────────────────
console.log('\nA file saved without its header row')

test('a top row of values is spotted, since it would silently lose a record', () => {
  const found = headersLookLikeData(['Maria', 'Vega', 'maria@example.com', '(559) 555-0134'])
  assert.deepEqual(found, ['maria@example.com', '(559) 555-0134'])
})

test('a real header row raises nothing', () => {
  for (const key of ['clients', 'services', 'products'] as const) {
    assert.deepEqual(headersLookLikeData(templateRows(csvEntity(key)!).headers), [], key)
  }
  assert.deepEqual(headersLookLikeData(['Notes (2024)', 'Price ($)', 'Date of Birth']), [])
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
