/**
 * Turning a cell of text into a value the database will accept.
 *
 * Every function here takes the raw string exactly as it appeared in the file
 * and returns either a value or a sentence explaining what is wrong with it.
 * The sentence is shown to the owner next to the row number, so it is written
 * for her and not for a log: "not an amount — write it as 12.50", never
 * "ValidationError: NaN".
 *
 * Two rules govern this file.
 *
 * MONEY NEVER TOUCHES A FLOAT. `parseFloat('12.50') * 100` is 1249.9999999999998
 * on some inputs and 1250 on others, and which you get depends on the value.
 * `parseMoneyCents` splits the string on the decimal point and does integer
 * arithmetic on the two halves, so "12.50" is 12 * 100 + 50 and there is no
 * rounding step to get wrong. See AGENTS.md rule 7.
 *
 * DATES NEVER TOUCH A `Date`. Everything importable that looks like a date is a
 * CALENDAR date — a date of birth is the same day in every timezone — so it is
 * parsed as text into a `YYYY-MM-DD` key and validated against a days-in-month
 * table. Constructing a Date would put an instant where a wall-clock date
 * belongs, which is the exact confusion AGENTS.md rule 3 exists to prevent.
 */

export type Coerced<T> = { ok: true; value: T } | { ok: false; error: string }

const ok = <T,>(value: T): Coerced<T> => ({ ok: true, value })
const bad = <T,>(error: string): Coerced<T> => ({ ok: false, error })

/* ── The spreadsheet formula guard ────────────────────────── */

/**
 * A CSV is data. Excel, Numbers and Google Sheets disagree.
 *
 * A cell whose first character is `=`, `+`, `-`, `@`, a tab or a carriage
 * return is read by every one of them as a FORMULA when the file is opened, and
 * quoting the field does not stop it — `"=cmd|' /C calc'!A0"` is still a
 * formula. That is the whole of the CSV injection problem: the studio exports
 * its client list, the manager double-clicks it, and a name somebody typed into
 * the public booking form is executed on her laptop.
 *
 * And it IS somebody else's text. `first_name` comes from the sign-up form and
 * a guest booking's name comes from a stranger, so this is not a hypothetical
 * about staff typing something odd — it is the ordinary path from the internet
 * to a spreadsheet on the owner's machine.
 *
 * The fix is a leading apostrophe, which every spreadsheet reads as "the rest
 * of this is text" and no spreadsheet displays.
 *
 * TWO THINGS IT DELIBERATELY DOES NOT DO:
 *
 *  - It leaves plain numbers alone, so `-4.00` in a money column exports as a
 *    number a spreadsheet can still sum. A leading minus in front of digits is
 *    arithmetic, not a formula call.
 *  - It is exactly reversible. `unguardFormula` strips the apostrophe back off
 *    on import, and only in front of the same characters that put it there, so
 *    "export it, fix a column, import it again" still round-trips to the
 *    identical value. A guard that quietly renamed a product to `'=Total`
 *    would have traded one silent corruption for another.
 */
const FORMULA_LEAD = /^[=+\-@\t\r]/
const PLAIN_NUMBER = /^[-+]?\d+(?:\.\d+)?$/

/** Write side: make a cell inert without changing what it says. */
export function guardFormula(value: string): string {
  if (!FORMULA_LEAD.test(value)) return value
  if (PLAIN_NUMBER.test(value)) return value
  return `'${value}`
}

/** Read side: the exact inverse, so an export re-imports as itself. */
export function unguardFormula(value: string): string {
  return value.startsWith("'") && FORMULA_LEAD.test(value.slice(1)) ? value.slice(1) : value
}

/* ── Money ────────────────────────────────────────────────── */

// Up to twelve whole digits keeps `whole * 100` inside Number.MAX_SAFE_INTEGER
// with room to spare, so the multiplication below is exact integer arithmetic.
const MONEY = /^(\d{1,12})(?:\.(\d{1,2}))?$/
const THOUSANDS = /^\d{1,3}(,\d{3})+(\.\d{1,2})?$/

/**
 * "12.50" and "$1,234.5" and "(4.00)" into integer cents.
 *
 * Accepts what a spreadsheet actually produces: a currency symbol, thousands
 * separators, one or two decimal places, and accounting parentheses for a
 * negative. Rejects three decimal places rather than rounding them — a price
 * written as "12.505" is a mistake somewhere upstream and silently turning it
 * into $12.50 or $12.51 hides it.
 */
export function parseMoneyCents(raw: string): Coerced<number> {
  let s = raw.trim()
  if (s === '') return bad('no amount')

  let negative = false
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true
    s = s.slice(1, -1).trim()
  }
  if (s.startsWith('-')) {
    negative = !negative
    s = s.slice(1).trim()
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim()
  }

  s = s.replace(/^(\$|USD)\s*/i, '').trim()
  // Only strip commas that sit in real thousands positions. "1,5" is a comma
  // decimal separator from another locale and should be questioned, not read
  // as fifteen.
  if (THOUSANDS.test(s)) s = s.replace(/,/g, '')

  const m = MONEY.exec(s)
  if (!m) {
    return bad(`"${raw.trim()}" is not an amount — write it as 12.50`)
  }

  const whole = Number(m[1])
  // Pad, do not multiply: "12.5" is fifty cents, "12.05" is five.
  const fraction = Number((m[2] ?? '').padEnd(2, '0'))
  const cents = whole * 100 + fraction

  if (!Number.isSafeInteger(cents)) return bad(`"${raw.trim()}" is too large`)
  return ok(negative ? -cents : cents)
}

/* ── Dates ────────────────────────────────────────────────── */

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
    return leap ? 29 : 28
  }
  return [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

const ISO_DATE = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/
const US_DATE = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/
const SHORT_YEAR = /^\d{1,2}[-/]\d{1,2}[-/]\d{2}$/

/**
 * A calendar date, as `YYYY-MM-DD`.
 *
 * `1990-03-04` is unambiguous and preferred. `3/4/1990` is read the American
 * way — month first — because the studio is in Fresno and that is what the
 * machines around it write. `25/12/1990` is REJECTED rather than guessed at:
 * a column can be day-first, and quietly reading a quarter of it one way and
 * the rest the other is worse than asking.
 *
 * Two-digit years are rejected for the same reason. On a date of birth column
 * "85" is 1985 to a person and 2085 to a rule, and there is no rule that gets
 * both that and a child's birthday right.
 */
export function parseDateKey(raw: string): Coerced<string> {
  const s = raw.trim()
  if (s === '') return bad('no date')

  if (SHORT_YEAR.test(s)) {
    return bad(`"${s}" has a two-digit year — write the year in full, as 1990-03-04`)
  }

  let year: number
  let month: number
  let day: number

  const iso = ISO_DATE.exec(s)
  const us = iso ? null : US_DATE.exec(s)

  if (iso) {
    year = Number(iso[1])
    month = Number(iso[2])
    day = Number(iso[3])
  } else if (us) {
    month = Number(us[1])
    day = Number(us[2])
    year = Number(us[3])
    if (month > 12 && day <= 12) {
      return bad(
        `"${s}" looks like day/month/year — write it as ${us[3]}-${String(day).padStart(2, '0')}-${String(month).padStart(2, '0')}`
      )
    }
  } else {
    return bad(`"${s}" is not a date — write it as 1990-03-04`)
  }

  if (month < 1 || month > 12) return bad(`"${s}" has no month ${month}`)
  if (year < 1900 || year > 2200) return bad(`"${s}" has an implausible year`)
  if (day < 1 || day > daysInMonth(year, month)) {
    return bad(`"${s}" is not a real date`)
  }

  return ok(
    `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  )
}

/* ── Booleans ─────────────────────────────────────────────── */

const TRUTHY = new Set(['true', 'yes', 'y', '1', 'x', 't', 'on', 'active', '✓', '✔'])
const FALSY = new Set(['false', 'no', 'n', '0', 'f', 'off', 'inactive', '-'])

export function parseBoolean(raw: string): Coerced<boolean> {
  const s = raw.trim().toLowerCase()
  if (TRUTHY.has(s)) return ok(true)
  if (FALSY.has(s)) return ok(false)
  return bad(`"${raw.trim()}" is not yes or no`)
}

/* ── Numbers ──────────────────────────────────────────────── */

export function parseInteger(raw: string): Coerced<number> {
  const s = raw.trim().replace(/,/g, '')
  if (s === '') return bad('no number')
  // ".0" is what a spreadsheet writes when it has decided a column is numeric.
  const m = /^(-?\d{1,12})(?:\.0+)?$/.exec(s)
  if (!m) return bad(`"${raw.trim()}" is not a whole number`)
  return ok(Number(m[1]))
}

export function parseDecimal(raw: string): Coerced<number> {
  const s = raw.trim().replace(/,/g, '')
  if (s === '') return bad('no number')
  if (!/^-?\d{1,12}(\.\d{1,4})?$/.test(s)) {
    return bad(`"${raw.trim()}" is not a number`)
  }
  return ok(Number(s))
}

/* ── Contact details ──────────────────────────────────────── */

// Deliberately loose. This exists to catch "maria at gmail" and a stray column
// of first names, not to adjudicate RFC 5322 — the address is confirmed by
// sending to it, not by a regular expression.
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/i

export function parseEmail(raw: string): Coerced<string> {
  const s = raw.trim().toLowerCase()
  if (s === '') return bad('no email address')
  if (s.length > 254) return bad('that email address is too long')
  if (!EMAIL.test(s)) return bad(`"${raw.trim()}" is not an email address`)
  return ok(s)
}

/** Just the digits — how `appointment_match_client` compares two numbers. */
export function phoneDigits(raw: string): string {
  return raw.replace(/\D/g, '')
}

/**
 * A phone number, kept as text the way the rest of the app keeps it.
 *
 * Ten digits are formatted; eleven starting with a 1 lose the 1 and are
 * formatted; anything else that is long enough is stored as it was typed, since
 * an international number is not ours to reformat. Fewer than ten digits is not
 * a phone number and is rejected — matching on it would be matching on noise,
 * and the database's own rule (004) refuses to match below ten.
 */
export function parsePhone(raw: string): Coerced<string> {
  const s = raw.trim()
  if (s === '') return bad('no phone number')
  const digits = phoneDigits(s)

  if (digits.length === 11 && digits.startsWith('1')) {
    const d = digits.slice(1)
    return ok(`(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`)
  }
  if (digits.length === 10) {
    return ok(`(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`)
  }
  if (digits.length > 11 && digits.length <= 15) return ok(s)
  return bad(`"${s}" is not a phone number — it needs at least ten digits`)
}

/* ── Text ─────────────────────────────────────────────────── */

export function parseText(raw: string, maxLength?: number): Coerced<string> {
  const s = raw.trim()
  if (maxLength !== undefined && s.length > maxLength) {
    return bad(`too long — ${s.length} characters, the limit is ${maxLength}`)
  }
  return ok(s)
}

/** Matched case- and punctuation-insensitively, so "Add-Ons" finds "add ons". */
export function parseEnum(raw: string, options: readonly string[]): Coerced<string> {
  const s = raw.trim()
  const loose = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, '')
  const hit = options.find((option) => loose(option) === loose(s))
  if (!hit) {
    return bad(`"${s}" is not one of: ${options.join(', ')}`)
  }
  return ok(hit)
}

/**
 * The slug a name would get, matching how the catalogue already reads.
 *
 * Used only to fill a slug that was not supplied. A slug present in the file is
 * taken as written, because it is probably already a URL somewhere.
 */
export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80)
}
