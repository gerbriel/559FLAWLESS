// 559 Flawless — the report module contract.
//
// Every report is a module in `src/lib/reports/<name>.ts` exporting one
// ReportModule. The shell (index page, filter bar, table renderer, CSV export,
// role gate) is built entirely from what the module declares here. A report
// author writes the query and the arithmetic; nothing else.
//
// This file is the interface four report modules were written against
// concurrently. Changing a shape here breaks them silently at the type level,
// so treat it as published API: add optional fields, never repurpose one.

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, UserRole } from '@/types/database'
import { formatMoney, formatDuration } from '@/lib/utils'
import { dateKeyInTimeZone, addDaysToDateKey, zonedTimeToUtc } from '@/lib/time'

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export interface ReportContext {
  supabase: SupabaseClient<Database> // the CALLER's client — RLS applies
  from: string // 'YYYY-MM-DD', inclusive, studio-local
  to: string // 'YYYY-MM-DD', inclusive
  locationId: number | null // null = every location
  providerId: string | null
  timeZone: string // the location's, never hardcoded
  now: number // requestNow()
}

export interface ReportColumn {
  key: string
  label: string
  align?: 'left' | 'right'
  format?: 'money' | 'number' | 'percent' | 'date' | 'duration' | 'text'
  /** Show a total for this column in the footer. */
  total?: 'sum' | 'avg' | null
}

export interface ReportResult {
  columns: ReportColumn[]
  rows: Record<string, string | number | null>[]
  /** Headline figures rendered as tiles above the table. */
  summary?: { label: string; value: string; tone?: 'good' | 'warn' }[]
  /** Optional grouped sub-tables, e.g. per provider. */
  sections?: { title: string; rows: Record<string, string | number | null>[] }[]
  notes?: string[]
}

/** Which controls the shell renders for a report. Anything not listed is hidden. */
export type ReportFilter = 'dateRange' | 'location' | 'provider'

export interface ReportModule {
  key: string
  title: string
  description: string
  /** Lowest role that may run it. 'manager' for anything showing cost or profit. */
  minRole: UserRole
  /** Which filters the shell should render for this report. */
  filters: ReportFilter[]
  run(ctx: ReportContext): Promise<ReportResult>
}

export type ReportRow = ReportResult['rows'][number]
export type ReportSummaryTile = NonNullable<ReportResult['summary']>[number]

// ---------------------------------------------------------------------------
// Role gate
// ---------------------------------------------------------------------------

/**
 * Roles as a total order, so `minRole` is a single comparison.
 *
 * This decides which cards render and which exports answer. It is NOT the
 * security boundary — RLS is. A report runs on the caller's own client, so a
 * front-desk user who somehow reached a manager report would still only see
 * rows their policies allow. The gate exists so the UI doesn't offer a report
 * that would come back mysteriously empty, and so an export route can refuse
 * cleanly rather than streaming a half-visible CSV.
 */
const ROLE_RANK: Record<UserRole, number> = {
  client: 0,
  provider: 1,
  front_desk: 2,
  manager: 3,
  admin: 4,
}

export function roleAtLeast(
  role: string | null | undefined,
  minRole: UserRole
): boolean {
  if (!role || !(role in ROLE_RANK)) return false
  return ROLE_RANK[role as UserRole] >= ROLE_RANK[minRole]
}

// ---------------------------------------------------------------------------
// Date range presets
// ---------------------------------------------------------------------------

export type DateRangePreset =
  | 'this_month'
  | 'last_month'
  | 'this_quarter'
  | 'this_year'
  | 'last_30'
  | 'last_90'
  | 'custom'

export const DATE_RANGE_PRESETS: { value: DateRangePreset; label: string }[] = [
  { value: 'this_month', label: 'This month' },
  { value: 'last_month', label: 'Last month' },
  { value: 'this_quarter', label: 'This quarter' },
  { value: 'this_year', label: 'This year' },
  { value: 'last_30', label: 'Last 30 days' },
  { value: 'last_90', label: 'Last 90 days' },
  { value: 'custom', label: 'Custom' },
]

export interface ResolvedRange {
  preset: DateRangePreset
  from: string
  to: string
  label: string
}

const DATE_KEY = /^\d{4}-\d{2}-\d{2}$/

export function isDateKey(value: unknown): value is string {
  return typeof value === 'string' && DATE_KEY.test(value)
}

/** Calendar arithmetic on the key itself — a date key is already wall-clock. */
function keyParts(dateKey: string): [number, number, number] {
  const [y, m, d] = dateKey.split('-').map(Number)
  return [y, m, d]
}

function makeKey(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function startOfMonth(dateKey: string): string {
  const [y, m] = keyParts(dateKey)
  return makeKey(y, m, 1)
}

function endOfMonth(dateKey: string): string {
  const [y, m] = keyParts(dateKey)
  // Day 0 of next month is the last day of this one. Date.UTC handles the roll.
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return makeKey(y, m, last)
}

function addMonths(dateKey: string, months: number): string {
  const [y, m, d] = keyParts(dateKey)
  const t = new Date(Date.UTC(y, m - 1 + months, 1))
  const ny = t.getUTCFullYear()
  const nm = t.getUTCMonth() + 1
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate()
  return makeKey(ny, nm, Math.min(d, lastDay))
}

/**
 * Resolve a preset into an inclusive studio-local date range.
 *
 * "Today" is whatever day it is *in the studio's zone*, not the server's or the
 * viewer's — a manager in another state pulling "this month" at 11pm on the 31st
 * must get the month the studio just finished, per correctness rule 4.
 */
export function resolveDateRange(
  preset: DateRangePreset,
  timeZone: string,
  now: number,
  custom?: { from?: string | null; to?: string | null }
): ResolvedRange {
  const today = dateKeyInTimeZone(new Date(now), timeZone)

  switch (preset) {
    case 'last_month': {
      const prev = addMonths(startOfMonth(today), -1)
      return range('last_month', startOfMonth(prev), endOfMonth(prev))
    }
    case 'this_quarter': {
      const [y, m] = keyParts(today)
      const firstMonth = m - ((m - 1) % 3)
      return range(
        'this_quarter',
        makeKey(y, firstMonth, 1),
        endOfMonth(makeKey(y, firstMonth + 2, 1))
      )
    }
    case 'this_year': {
      const [y] = keyParts(today)
      return range('this_year', makeKey(y, 1, 1), makeKey(y, 12, 31))
    }
    // Inclusive of today, so "last 30 days" is 30 days of data, not 31.
    case 'last_30':
      return range('last_30', addDaysToDateKey(today, -29), today)
    case 'last_90':
      return range('last_90', addDaysToDateKey(today, -89), today)
    case 'custom': {
      const from = isDateKey(custom?.from) ? custom.from : startOfMonth(today)
      const to = isDateKey(custom?.to) ? custom.to : today
      // A backwards range returns nothing and looks like a broken report.
      return from <= to ? range('custom', from, to) : range('custom', to, from)
    }
    case 'this_month':
    default:
      return range('this_month', startOfMonth(today), endOfMonth(today))
  }
}

function range(preset: DateRangePreset, from: string, to: string): ResolvedRange {
  return { preset, from, to, label: `${shortDate(from)} – ${shortDate(to)}` }
}

export function parsePreset(value: string | undefined | null): DateRangePreset {
  const found = DATE_RANGE_PRESETS.find((p) => p.value === value)
  return found ? found.value : 'this_month'
}

/**
 * Half-open UTC bounds for a studio-local, inclusive date range.
 *
 * Reports filter `timestamptz` columns, so the local range has to become
 * instants. `to` is exclusive at the *start of the following day*: an 11:59pm
 * sale on the last day is inside the range, and a `< end` comparison never has
 * to reason about the fractional seconds Postgres actually stored.
 */
export function rangeToInstants(
  from: string,
  to: string,
  timeZone: string
): { startIso: string; endIso: string } {
  return {
    startIso: zonedTimeToUtc(from, '00:00', timeZone).toISOString(),
    endIso: zonedTimeToUtc(addDaysToDateKey(to, 1), '00:00', timeZone).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Cell formatting — shared by the table renderer and the CSV export
// ---------------------------------------------------------------------------

/**
 * Cents to a plain decimal string, integer arithmetic only.
 *
 * `formatMoney` is the one place cents become a *display* string; this is the
 * machine-readable counterpart for CSV, where "$1,234.50" is a text cell a
 * spreadsheet cannot sum. No division of the cents value — sign, whole part and
 * remainder are taken separately so nothing ever touches a float.
 */
export function centsToDecimalString(cents: number): string {
  const n = Math.trunc(cents)
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, '0')}`
}

/** Money, deferring to the single formatter. Rows carry integer cents. */
export function money(cents: number | null | undefined): string {
  return formatMoney(cents)
}

/** Percent values travel as 0–100, not 0–1. */
export function percent(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—'
  return `${value.toFixed(digits)}%`
}

/**
 * Ratio to a percent value, with the denominator guarded.
 *
 * Report maths divides by counts constantly (utilisation, retention, no-show
 * rate) and an empty period is the normal case, not an error — a zero
 * denominator must yield null, never NaN or Infinity in a table cell.
 */
export function ratioToPercent(numerator: number, denominator: number): number | null {
  if (!denominator) return null
  return (numerator / denominator) * 100
}

export function shortDate(dateKey: string): string {
  if (!isDateKey(dateKey)) return dateKey
  const [y, m, d] = keyParts(dateKey)
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/**
 * Render one cell for display.
 *
 * Strings pass through verbatim whatever the column's declared format. A module
 * that formatted its own value keeps it; only raw numbers get interpreted. That
 * makes the format hint an affordance rather than a trap, at the cost of the
 * footer total (which needs a number and skips strings).
 */
export function formatCell(
  value: string | number | null | undefined,
  column: ReportColumn,
  timeZone: string
): string {
  if (value == null || value === '') return '—'
  if (typeof value === 'string') {
    return column.format === 'date' && isDateKey(value) ? shortDate(value) : value
  }
  if (!Number.isFinite(value)) return '—'

  switch (column.format) {
    case 'money':
      return money(value)
    case 'percent':
      return percent(value)
    case 'duration':
      return formatDuration(Math.round(value))
    case 'number':
      return value.toLocaleString('en-US', {
        maximumFractionDigits: Number.isInteger(value) ? 0 : 2,
      })
    case 'date': {
      const asDate = new Date(value)
      return Number.isNaN(asDate.getTime())
        ? String(value)
        : shortDate(dateKeyInTimeZone(asDate, timeZone))
    }
    default:
      return String(value)
  }
}

/** Machine-readable cell for CSV: money and percent become bare numbers. */
export function csvCell(
  value: string | number | null | undefined,
  column: ReportColumn
): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (!Number.isFinite(value)) return ''
  if (column.format === 'money') return centsToDecimalString(value)
  if (column.format === 'percent') return value.toFixed(2)
  return String(value)
}

/**
 * Footer total for a column, or null when there is nothing to total.
 *
 * Averages divide by the count of *numeric* cells, not the row count — a
 * column with blanks would otherwise average toward zero and quietly understate
 * itself. Money sums stay in integer cents right up to the formatter.
 */
export function columnTotal(
  rows: ReportRow[],
  column: ReportColumn
): number | null {
  if (!column.total) return null
  let sum = 0
  let n = 0
  for (const row of rows) {
    const v = row[column.key]
    if (typeof v === 'number' && Number.isFinite(v)) {
      sum += v
      n += 1
    }
  }
  if (n === 0) return null
  if (column.total === 'avg') return sum / n
  return column.format === 'money' ? Math.round(sum) : sum
}

/** Right-align numbers unless the module said otherwise. */
export function columnAlign(column: ReportColumn): 'left' | 'right' {
  if (column.align) return column.align
  const numeric = column.format === 'money' || column.format === 'number' ||
    column.format === 'percent' || column.format === 'duration'
  return numeric ? 'right' : 'left'
}

/** Numbers need tabular figures to line up column-wise. */
export function isNumericColumn(column: ReportColumn): boolean {
  return columnAlign(column) === 'right'
}
