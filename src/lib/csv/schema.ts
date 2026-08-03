/**
 * What a column IS — the vocabulary the exporter, the template, the mapper and
 * the importer all read from.
 *
 * This is the whole design. Every entity's columns are declared once, in
 * `entities.ts`, in terms of the types here, and nothing anywhere else is
 * allowed to know what a client CSV looks like. The exporter writes the header
 * from this list; the template writes the header AND the example row from this
 * list; the on-screen reference table renders this list; the mapper scores
 * against this list; the importer coerces against this list.
 *
 * The reason is not tidiness. A template is a PROMISE — "save your file like
 * this and it will import" — and a promise made by one list and kept by another
 * is a promise that will be broken by the first person who edits one of them.
 * Defined once, the template cannot start lying, because there is nothing for
 * it to disagree with.
 *
 * This file is deliberately free of Supabase, React and Next imports: it is
 * read in the browser by the mapper and on the server by the routes, and it has
 * to be safe in both.
 */

export type CsvFieldType =
  | 'text'
  | 'email'
  | 'phone'
  | 'date'
  | 'datetime'
  | 'money'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'enum'

export type CsvValue = string | number | boolean | null

export type CsvField = {
  /** Stable id. Never shown; used as the mapping key and by the importer. */
  key: string
  /** The header written to the file, and what the mapper matches against. */
  label: string
  type: CsvFieldType
  /** Sentence shown in the reference table. Written for the owner. */
  description: string
  /** A realistic value. Goes in the template's example row. */
  example: string
  /** Import fails the row without it. */
  required?: boolean
  /**
   * Export-only. It appears in an export and in the reference table, marked,
   * and the importer ignores it. `readOnlyBecause` says why, and that sentence
   * is shown — an unexplained locked column just looks like an oversight.
   */
  readOnly?: boolean
  readOnlyBecause?: string
  /** Extra names the guesser should treat as an exact header hit. */
  aliases?: readonly string[]
  options?: readonly string[]
  maxLength?: number
}

export type CsvEntityKey = 'clients' | 'services' | 'products' | 'sales' | 'appointments'

/** Who may import this entity. Export is gated at manager for everything. */
export type CsvImportRole = 'manager' | 'admin'

export type CsvImportRules = {
  role: CsvImportRole
  /** Why that role and not a lower one. Shown on the page. */
  roleBecause: string
  /** The human sentence: what makes a row in the file "the same" record. */
  matchRule: string
  /** What happens to a row that matches nothing. */
  onNoMatch: string
}

export type CsvEntity = {
  key: CsvEntityKey
  label: string
  /** One line under the title. */
  lede: string
  /** Which table(s) this reads and writes, for the reference table. */
  source: string
  fields: readonly CsvField[]
  /** Null when the entity cannot be imported at all; `notImportable` says why. */
  importing: CsvImportRules | null
  notImportable?: string
  /** Columns a reader would expect and will not find, and the reason. */
  excluded: readonly { column: string; reason: string }[]
}

/* ── Reading a definition ─────────────────────────────────── */

export function importableFields(entity: CsvEntity): CsvField[] {
  return entity.fields.filter((f) => !f.readOnly)
}

export function requiredFields(entity: CsvEntity): CsvField[] {
  return importableFields(entity).filter((f) => f.required)
}

export function fieldByKey(entity: CsvEntity, key: string): CsvField | undefined {
  return entity.fields.find((f) => f.key === key)
}

/**
 * The template: the header row the importer expects, and one example row.
 *
 * Importable columns only. An export carries a few read-only columns as well
 * (an id, a stock count, a created date) because they are worth having in a
 * backup — the importer skips them and the mapper lists them as ignored, so a
 * re-imported export still works. The template stays clean so that what she is
 * asked to fill in is exactly what will be read.
 */
export function templateRows(entity: CsvEntity): { headers: string[]; example: string[] } {
  const fields = importableFields(entity)
  return {
    headers: fields.map((f) => f.label),
    example: fields.map((f) => f.example),
  }
}

/** How a type reads in the reference table and in a guess's explanation. */
export function typeLabel(type: CsvFieldType): string {
  switch (type) {
    case 'text':
      return 'Text'
    case 'email':
      return 'Email address'
    case 'phone':
      return 'Phone number'
    case 'date':
      return 'Date'
    case 'datetime':
      return 'Date and time'
    case 'money':
      return 'Amount'
    case 'integer':
      return 'Whole number'
    case 'decimal':
      return 'Number'
    case 'boolean':
      return 'Yes or no'
    case 'enum':
      return 'One of a set'
  }
}

/** The format note under a column in the reference table. */
export function formatHint(field: CsvField): string {
  switch (field.type) {
    case 'money':
      return 'An amount like 85 or 85.00. A dollar sign and commas are fine.'
    case 'date':
      return 'Best as 1990-03-04. 3/4/1990 is read month-first; two-digit years are rejected.'
    case 'datetime':
      return 'Studio local time.'
    case 'boolean':
      return 'yes / no, true / false, 1 / 0.'
    case 'phone':
      return 'Any punctuation. Ten digits minimum.'
    case 'enum':
      return `One of: ${(field.options ?? []).join(', ')}.`
    case 'integer':
      return 'A whole number.'
    case 'decimal':
      return 'A number; decimals allowed.'
    default:
      return field.maxLength ? `Up to ${field.maxLength} characters.` : 'Free text.'
  }
}
