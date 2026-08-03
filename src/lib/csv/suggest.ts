/**
 * Guessing which of her columns is which of our fields.
 *
 * The brief was specific: look for signals to see what kind of information is
 * in a column and suggest where it goes. So this reads two things and weighs
 * them against each other.
 *
 * THE HEADER, normalised until "First Name", "first_name", "FIRSTNAME" and
 * "fname" are the same string. Punctuation and case are stripped, common
 * abbreviations are expanded, and what is left is compared both as a set of
 * words and as a bag of character pairs — the second is what lets "firstname"
 * match "first name" when the first has nothing to split on.
 *
 * THE VALUES, which are the more reliable signal and the reason this is worth
 * writing at all. A header can say "Field7"; the column underneath still knows
 * what it is. A column of strings containing "@" is an email. Ten or eleven
 * digits after the punctuation comes off is a phone number. Slash- or
 * dash-separated numbers are dates. Digits with exactly two decimal places are
 * money. Two distinct values across a hundred rows is a yes/no.
 *
 * Both are scored 0..1, combined, and the best pairing is taken greedily so
 * that one strong match cannot be stolen by a weaker one later in the list.
 *
 * THE SUGGESTION IS NEVER THE DECISION. Everything here produces a
 * pre-selection and a sentence saying why — "the values look like email
 * addresses" — and the mapper always renders a dropdown she can change. A guess
 * presented as a fact is worse than no guess, because a wrong one that explains
 * itself gets caught and a wrong one that does not gets imported.
 */

import type { CsvField, CsvFieldType } from '@/lib/csv/schema'
import { phoneDigits } from '@/lib/csv/values'

/** How many rows to look at. Enough to be sure; cheap enough to run on typing. */
export const SAMPLE_SIZE = 60

/* ── Reading a header ─────────────────────────────────────── */

/** Everything that is not a letter or a digit becomes a single space. */
export function normaliseHeader(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

// What people actually type in a spreadsheet header.
const ABBREVIATIONS: Record<string, string> = {
  fname: 'first name',
  firstname: 'first name',
  lname: 'last name',
  lastname: 'last name',
  nm: 'name',
  em: 'email',
  mail: 'email',
  ph: 'phone',
  tel: 'phone',
  telephone: 'phone',
  mobile: 'phone',
  cell: 'phone',
  dob: 'date of birth',
  bday: 'date of birth',
  birthday: 'date of birth',
  qty: 'quantity',
  amt: 'amount',
  amount: 'price',
  desc: 'description',
  descr: 'description',
  num: 'number',
  no: 'number',
  addr: 'address',
  cat: 'category',
  mins: 'minutes',
  min: 'minutes',
  cost: 'price',
  uom: 'unit',
  active: 'active',
}

function expand(value: string): string[] {
  const out: string[] = []
  for (const token of normaliseHeader(value).split(' ')) {
    if (!token) continue
    const expansion = ABBREVIATIONS[token]
    if (expansion) out.push(...expansion.split(' '))
    else out.push(token)
  }
  return out
}

/** Dice coefficient over two sets of words. */
function tokenSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0
  const left = new Set(a)
  const right = new Set(b)
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return (2 * shared) / (left.size + right.size)
}

/** Dice coefficient over character pairs — catches "firstname" vs "first name". */
function bigramSimilarity(a: string, b: string): number {
  const pairs = (s: string) => {
    const flat = s.replace(/ /g, '')
    const out: string[] = []
    for (let i = 0; i < flat.length - 1; i++) out.push(flat.slice(i, i + 2))
    return out
  }
  const left = pairs(a)
  const right = pairs(b)
  if (left.length === 0 || right.length === 0) return a === b ? 1 : 0
  const pool = [...right]
  let shared = 0
  for (const pair of left) {
    const at = pool.indexOf(pair)
    if (at >= 0) {
      pool.splice(at, 1)
      shared++
    }
  }
  return (2 * shared) / (left.length + right.length)
}

/** 1 for an exact hit on the label, the key or an alias; less for a near miss. */
export function headerScore(header: string, field: CsvField): number {
  const candidates = [field.label, field.key, ...(field.aliases ?? [])]
  const normalisedHeader = normaliseHeader(header)
  if (!normalisedHeader) return 0

  let best = 0
  const headerTokens = expand(header)

  for (const candidate of candidates) {
    const normalisedCandidate = normaliseHeader(candidate)
    if (normalisedHeader === normalisedCandidate) return 1
    // "firstname" against "first name" once the spaces are gone.
    if (normalisedHeader.replace(/ /g, '') === normalisedCandidate.replace(/ /g, '')) return 1

    const byToken = tokenSimilarity(headerTokens, expand(candidate))
    const byBigram = bigramSimilarity(normalisedHeader, normalisedCandidate) * 0.9
    best = Math.max(best, byToken, byBigram)
  }
  return best
}

/* ── Reading the values ───────────────────────────────────── */

export type ColumnProfile = {
  index: number
  header: string
  /** Non-empty values, up to SAMPLE_SIZE. */
  samples: string[]
  filled: number
  total: number
  distinct: number
  email: number
  phone: number
  date: number
  money: number
  integer: number
  decimal: number
  boolean: number
  url: number
  averageLength: number
}

const LOOKS_EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i
const LOOKS_DATE = /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}([T ]\d{1,2}:\d{2})?/
const LOOKS_MONEY = /^[($]?-?\$?\s?\d{1,3}(,\d{3})*(\.\d{1,2})?\)?$/
const HAS_DECIMALS = /\.\d{2}$/
const LOOKS_INTEGER = /^-?\d{1,12}$/
const LOOKS_DECIMAL = /^-?\d{1,12}\.\d{1,4}$/
const LOOKS_URL = /^https?:\/\//i
const BOOLEAN_WORDS = new Set([
  'true', 'false', 'yes', 'no', 'y', 'n', '1', '0', 't', 'f',
  'active', 'inactive', 'on', 'off', 'enabled', 'disabled',
])

export function profileColumn(
  header: string,
  index: number,
  values: readonly string[]
): ColumnProfile {
  const trimmed = values.map((v) => v.trim())
  const filled = trimmed.filter((v) => v !== '')
  const samples = filled.slice(0, SAMPLE_SIZE)

  const counts = { email: 0, phone: 0, date: 0, money: 0, integer: 0, decimal: 0, boolean: 0, url: 0 }
  let lengthTotal = 0

  for (const value of samples) {
    lengthTotal += value.length
    if (LOOKS_EMAIL.test(value)) counts.email++
    if (LOOKS_URL.test(value)) counts.url++
    if (BOOLEAN_WORDS.has(value.toLowerCase())) counts.boolean++

    const digits = phoneDigits(value)
    // A phone number is mostly punctuation and digits. "2026" is not one, and
    // neither is a sentence with a number in it.
    if (
      (digits.length === 10 || (digits.length === 11 && digits.startsWith('1'))) &&
      /^[\d\s()+.-]+$/.test(value)
    ) {
      counts.phone++
    }

    if (LOOKS_DATE.test(value)) counts.date++
    if (LOOKS_INTEGER.test(value)) counts.integer++
    if (LOOKS_DECIMAL.test(value)) counts.decimal++
    // Money is a number that has bothered to carry two decimal places, or is
    // wearing a currency symbol. A bare "12" is a number and could be anything.
    if (LOOKS_MONEY.test(value) && (HAS_DECIMALS.test(value) || /[$(]/.test(value))) {
      counts.money++
    }
  }

  const n = samples.length || 1
  return {
    index,
    header,
    samples,
    filled: filled.length,
    total: trimmed.length,
    distinct: new Set(filled.map((v) => v.toLowerCase())).size,
    email: counts.email / n,
    phone: counts.phone / n,
    date: counts.date / n,
    money: counts.money / n,
    integer: counts.integer / n,
    decimal: counts.decimal / n,
    boolean: counts.boolean / n,
    url: counts.url / n,
    averageLength: lengthTotal / n,
  }
}

/**
 * How much the column's contents look like the field's type, 0..1.
 *
 * Text scores low on purpose and drops to nothing when the column is clearly
 * something else — otherwise "Notes" would happily claim the email column on
 * the strength of it being made of characters.
 */
export function valueScore(profile: ColumnProfile, type: CsvFieldType): number {
  if (profile.samples.length === 0) return 0

  const strongOther = Math.max(profile.email, profile.phone, profile.money, profile.date)

  switch (type) {
    case 'email':
      return profile.email
    case 'phone':
      return profile.phone
    case 'date':
    case 'datetime':
      return profile.date
    case 'money':
      // A column of plain integers can still be a price, just less obviously.
      return Math.max(profile.money, profile.integer * 0.4, profile.decimal * 0.5)
    case 'integer':
      return Math.max(profile.integer - profile.money * 0.5, 0)
    case 'decimal':
      return Math.max(profile.integer, profile.decimal) - profile.money * 0.3
    case 'boolean': {
      // Two distinct values across a filled column is the giveaway, even when
      // they are words this file has never seen.
      const binary = profile.distinct > 0 && profile.distinct <= 2 && profile.filled >= 4 ? 0.7 : 0
      return Math.max(profile.boolean, binary)
    }
    case 'enum':
      return profile.distinct <= 8 ? 0.5 : 0.1
    case 'text':
      return Math.max(0.3 * (1 - strongOther), 0)
  }
}

/* ── Putting the two together ─────────────────────────────── */

export type MappingSuggestion = {
  /** Index into the file's columns. */
  column: number
  /** 0..1. Anything under MIN_SCORE is not offered. */
  score: number
  /** Shown next to the dropdown, so a lucky guess is distinguishable from a good one. */
  reason: string
  confidence: 'strong' | 'likely' | 'possible'
}

/** Below this, no pre-selection is made — a blank is more honest than a shrug. */
export const MIN_SCORE = 0.45

const HEADER_WEIGHT = 0.55
const VALUE_WEIGHT = 0.45

/**
 * Types whose values are distinctive enough to identify a column on their own.
 *
 * A column of things containing "@" is an email whatever it is called, and a
 * file exported from another system is full of columns called "Field 7". Text
 * is not on this list, and neither is a plain number: "a column of words" and
 * "a column of digits" describe half the file.
 */
const SELF_EVIDENT = new Set<CsvFieldType>(['email', 'phone', 'date', 'datetime', 'money'])
/** What such a column scores with no help at all from its name. */
const SELF_EVIDENT_FLOOR = 0.55

function typeEvidence(type: CsvFieldType): string {
  switch (type) {
    case 'email':
      return 'the values look like email addresses'
    case 'phone':
      return 'the values look like phone numbers'
    case 'date':
    case 'datetime':
      return 'the values look like dates'
    case 'money':
      return 'the values look like amounts of money'
    case 'boolean':
      return 'the column only holds two different values'
    case 'integer':
    case 'decimal':
      return 'the values are numbers'
    case 'enum':
      return 'the values repeat from a short list'
    case 'text':
      return 'the values are free text'
  }
}

function explain(header: string, field: CsvField, header01: number, value01: number): string {
  const named = `the column is named “${header}”`
  if (header01 >= 0.99) {
    return value01 >= 0.5 ? `${named}, and ${typeEvidence(field.type)}` : named
  }
  if (value01 >= 0.6 && header01 >= 0.45) {
    return `“${header}” is close to “${field.label}”, and ${typeEvidence(field.type)}`
  }
  if (value01 >= 0.6) return `${typeEvidence(field.type)}`
  if (header01 >= 0.45) return `“${header}” is close to “${field.label}”`
  return `a weak match on the name and the values`
}

export function scorePair(
  profile: ColumnProfile,
  field: CsvField
): { score: number; reason: string } {
  const header01 = headerScore(profile.header, field)
  const value01 = valueScore(profile, field.type)

  let score = header01 * HEADER_WEIGHT + value01 * VALUE_WEIGHT

  // Agreement is worth more than the sum of its parts: a column called "Email"
  // full of addresses should outrank a column called "Email" full of names.
  if (header01 >= 0.5 && value01 >= 0.5) score = Math.min(1, score + 0.1)

  // The values alone are enough when they are this distinctive. Without this a
  // column of email addresses headed "Field 7" would be left unmapped, which is
  // exactly the case the guesser exists for.
  if (value01 >= 0.85 && SELF_EVIDENT.has(field.type)) {
    score = Math.max(score, SELF_EVIDENT_FLOOR)
  }

  // An empty column offers no evidence about its contents, so it is judged on
  // its name alone rather than penalised for being empty — an export's own
  // "External Link" column is usually blank and still belongs where it says.
  if (profile.filled === 0) score = header01 * HEADER_WEIGHT

  return { score, reason: explain(profile.header, field, header01, value01) }
}

export type SuggestedMapping = {
  /** field key -> the suggestion, or undefined when nothing scored well enough. */
  chosen: Record<string, MappingSuggestion | undefined>
  /** field key -> the runners-up, so the reason can name what else was considered. */
  alternatives: Record<string, MappingSuggestion[]>
  profiles: ColumnProfile[]
}

function confidenceOf(score: number): MappingSuggestion['confidence'] {
  if (score >= 0.8) return 'strong'
  if (score >= 0.6) return 'likely'
  return 'possible'
}

/**
 * The mapping this screen opens with.
 *
 * Greedy over every (field, column) pair sorted by score: the best pairing in
 * the whole file is taken first, then the best of what is left, and so on. A
 * simple first-field-wins pass would let "Name" claim the column that "First
 * Name" was about to match perfectly, purely because it appears earlier in the
 * list.
 *
 * One column maps to one field. If she needs the same column twice, the
 * dropdowns let her say so.
 */
export function suggestMapping(
  headers: readonly string[],
  rows: readonly string[][],
  fields: readonly CsvField[]
): SuggestedMapping {
  const profiles = headers.map((header, index) =>
    profileColumn(header, index, rows.slice(0, SAMPLE_SIZE).map((row) => row[index] ?? ''))
  )

  const pairs: { field: string; column: number; score: number; reason: string }[] = []
  for (const field of fields) {
    for (const profile of profiles) {
      const { score, reason } = scorePair(profile, field)
      if (score >= MIN_SCORE) pairs.push({ field: field.key, column: profile.index, score, reason })
    }
  }

  pairs.sort((a, b) => b.score - a.score)

  const chosen: Record<string, MappingSuggestion | undefined> = {}
  const alternatives: Record<string, MappingSuggestion[]> = {}
  const takenColumns = new Set<number>()

  for (const pair of pairs) {
    const suggestion: MappingSuggestion = {
      column: pair.column,
      score: pair.score,
      reason: pair.reason,
      confidence: confidenceOf(pair.score),
    }

    if (!chosen[pair.field] && !takenColumns.has(pair.column)) {
      chosen[pair.field] = suggestion
      takenColumns.add(pair.column)
      continue
    }

    const list = alternatives[pair.field] ?? []
    if (list.length < 2 && chosen[pair.field]?.column !== pair.column) {
      list.push(suggestion)
      alternatives[pair.field] = list
    }
  }

  return { chosen, alternatives, profiles }
}

/**
 * Header cells that look like somebody's details rather than a column name.
 *
 * A file saved without its header row is not an error anywhere: `parseCsv`
 * takes the first row as the header because a CSV has no way of saying it has
 * none, so the first CLIENT in the file quietly becomes a set of column names
 * and is never imported. Nothing else in the flow can notice — the row counter
 * says "312 rows" and it is telling the truth about what it was handed.
 *
 * So it is guessed, from the only evidence there is: a header that is an email
 * address, a phone number, an amount or a date is almost certainly a value.
 * Deliberately narrow — those four are hard to mistake for a column name, and a
 * false alarm here costs nothing but a sentence, while a false silence costs a
 * client.
 */
export function headersLookLikeData(headers: readonly string[]): string[] {
  return headers.filter((header) => {
    const profile = profileColumn(header, 0, [header])
    return profile.email + profile.phone + profile.money + profile.date > 0
  })
}
