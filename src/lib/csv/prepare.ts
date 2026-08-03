/**
 * Turning a mapped file into typed rows, or into reasons why not.
 *
 * This runs TWICE on every import — once for the preview and once again for the
 * commit — and that is the point. The preview is only trustworthy if the commit
 * reaches its conclusions the same way, so rather than passing a verdict from
 * one to the other, both call this with the same input and derive it. The
 * browser's copy of the answer is never trusted for anything except drawing the
 * screen.
 *
 * Pure: no database, no clock, no network. Everything it knows comes from the
 * entity definition and the strings in the file.
 */

import type { CsvEntity, CsvField, CsvValue } from '@/lib/csv/schema'
import { importableFields } from '@/lib/csv/schema'
import {
  parseBoolean,
  parseDateKey,
  parseDecimal,
  parseEmail,
  parseEnum,
  parseInteger,
  parseMoneyCents,
  parsePhone,
  parseText,
  unguardFormula,
  type Coerced,
} from '@/lib/csv/values'

/** field key -> index into the file's columns, or null for "not mapped". */
export type FieldMapping = Record<string, number | null>

export type PreparedRow = {
  /** The row number as it appears in the spreadsheet, header counted as row 1. */
  line: number
  /** Only the fields she actually mapped AND filled in. */
  values: Record<string, CsvValue>
  /** The raw strings behind them, for showing her what a row was. */
  raw: Record<string, string>
}

export type RowProblem = {
  line: number
  /** The header of the offending column, or null for a whole-row problem. */
  column: string | null
  field: string | null
  message: string
}

export type PrepareResult = {
  rows: PreparedRow[]
  problems: RowProblem[]
  /** File columns nothing was mapped to. Listed so nothing vanishes silently. */
  ignoredColumns: string[]
  /** Importable fields with no column behind them. */
  unmappedFields: CsvField[]
}

function coerce(field: CsvField, raw: string): Coerced<CsvValue> {
  switch (field.type) {
    case 'email':
      return parseEmail(raw)
    case 'phone':
      return parsePhone(raw)
    case 'date':
    case 'datetime':
      return parseDateKey(raw)
    case 'money':
      return parseMoneyCents(raw)
    case 'integer':
      return parseInteger(raw)
    case 'decimal':
      return parseDecimal(raw)
    case 'boolean':
      return parseBoolean(raw)
    case 'enum':
      return parseEnum(raw, field.options ?? [])
    case 'text':
      return parseText(raw, field.maxLength)
  }
}

/**
 * A BLANK CELL MEANS "LEAVE IT ALONE", NOT "CLEAR IT".
 *
 * This is the single most consequential rule in the file and it is worth being
 * explicit about. A spreadsheet exported from an old system will have gaps in
 * it, and the whole point of matching an existing record is that the import
 * fills in what it knows. If a blank overwrote, then importing a two-column
 * list of emails and new phone numbers would erase every date of birth in the
 * studio. So a blank is simply absent: it is not in `values`, the importer does
 * not send that column, and the existing value survives.
 *
 * A blank in a REQUIRED column is a different thing, and it rejects the row.
 * To actually clear a field, clear it on the record.
 */
export function prepare(
  entity: CsvEntity,
  headers: readonly string[],
  rows: readonly string[][],
  mapping: FieldMapping
): PrepareResult {
  const fields = importableFields(entity)
  const prepared: PreparedRow[] = []
  const problems: RowProblem[] = []

  const mappedColumns = new Set(
    Object.values(mapping).filter((index): index is number => index !== null && index >= 0)
  )
  const ignoredColumns = headers.filter((_, index) => !mappedColumns.has(index))
  const unmappedFields = fields.filter((field) => {
    const at = mapping[field.key]
    return at === null || at === undefined || at < 0 || at >= headers.length
  })

  rows.forEach((cells, rowIndex) => {
    // +2: the header is row 1, and the first data row is row 2, which is what
    // the spreadsheet's own row numbers say.
    const line = rowIndex + 2
    const values: Record<string, CsvValue> = {}
    const raw: Record<string, string> = {}
    const rowProblems: RowProblem[] = []

    for (const field of fields) {
      const at = mapping[field.key]
      if (at === null || at === undefined || at < 0 || at >= headers.length) {
        if (field.required) {
          rowProblems.push({
            line,
            column: null,
            field: field.key,
            message: `${field.label} is required and no column is mapped to it`,
          })
        }
        continue
      }

      // `unguardFormula` first, then trim: an export of ours neutralises a cell
      // that starts with `=` by putting an apostrophe in front of it, and this
      // is the only place that takes it back off. Anything else keeps its
      // apostrophe, because an apostrophe is a character people type.
      const cell = unguardFormula(cells[at] ?? '').trim()
      raw[field.key] = cell

      if (cell === '') {
        if (field.required) {
          rowProblems.push({
            line,
            column: headers[at] || `column ${at + 1}`,
            field: field.key,
            message: `${field.label} is empty`,
          })
        }
        continue
      }

      const result = coerce(field, cell)
      if (!result.ok) {
        rowProblems.push({
          line,
          column: headers[at] || `column ${at + 1}`,
          field: field.key,
          message: `${field.label}: ${result.error}`,
        })
        continue
      }
      values[field.key] = result.value
    }

    // Whatever the entity itself needs true of a whole row — a client with no
    // way of being identified, say. Declared in entities.ts, checked here.
    if (rowProblems.length === 0) {
      const objection = entityObjection(entity, values)
      if (objection) {
        rowProblems.push({ line, column: null, field: null, message: objection })
      }
    }

    if (rowProblems.length > 0) problems.push(...rowProblems)
    else prepared.push({ line, values, raw })
  })

  return { rows: prepared, problems, ignoredColumns, unmappedFields }
}

/**
 * Row-level rules that no single column can express.
 *
 * Kept next to `prepare` rather than in `entities.ts` because it is logic and
 * that file is data, but it is short enough that the two do not drift.
 */
function entityObjection(entity: CsvEntity, values: Record<string, CsvValue>): string | null {
  if (entity.key === 'clients') {
    if (!values.email && !values.phone) {
      return 'no email address and no phone number — there is nothing to match this person on'
    }
  }
  // Products have exactly one rule of this kind — products_external_has_no_stock,
  // which forbids an externally fulfilled item from holding stock — and it is
  // deliberately NOT re-implemented here. Stock is not importable, so a new row
  // can never break it, and on an existing row the current count is the studio's
  // and not this file's. It is left to the database, and `readable()` in apply.ts
  // turns the constraint name into a sentence. Guessing at a rule the database
  // already owns is how the two end up disagreeing.
  return null
}

/** Problems collapsed into "this went wrong, N times, first at row X". */
export type ProblemSummary = {
  message: string
  column: string | null
  count: number
  lines: number[]
}

export function summariseProblems(problems: readonly RowProblem[]): ProblemSummary[] {
  const groups = new Map<string, ProblemSummary>()
  for (const problem of problems) {
    const key = `${problem.column ?? ''}|${problem.message}`
    const existing = groups.get(key)
    if (existing) {
      existing.count++
      if (existing.lines.length < 5) existing.lines.push(problem.line)
    } else {
      groups.set(key, {
        message: problem.message,
        column: problem.column,
        count: 1,
        lines: [problem.line],
      })
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}

/** Rows that had at least one problem, so "rejected" counts people not faults. */
export function rejectedLineCount(problems: readonly RowProblem[]): number {
  return new Set(problems.map((p) => p.line)).size
}
