/**
 * A CSV reader, written here rather than installed.
 *
 * The studio has no CSV parser and no CSV dependency, and this is not the place
 * to add one: the file that decides whether a studio's entire client list lands
 * correctly should be code we can read, test, and blame. It is about a hundred
 * lines and `scripts/csv.test.ts` covers every case below.
 *
 * WHAT IT HANDLES, because a `split(',')` handles none of it:
 *
 *  - Quoted fields, so `"Vega, Maria"` is ONE name and not two columns.
 *  - Newlines inside quotes, so an address typed over two lines stays one row.
 *  - `""` as the escape for a literal quote — RFC 4180's rule, and what every
 *    spreadsheet emits.
 *  - A UTF-8 BOM. Excel writes one on every CSV it saves; left in place it
 *    becomes part of the first header, and `﻿First Name` matches nothing.
 *  - CRLF, LF and lone CR line endings, mixed in the same file.
 *  - Semicolon, tab and pipe delimiters, sniffed from the first line. A CSV
 *    saved on a machine with a comma decimal separator is semicolon-delimited,
 *    and it is not worth a support conversation to discover that.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it never looks at what a value means. Types
 * are `src/lib/csv/values.ts`'s job and mapping is `suggest.ts`'s. Everything
 * that comes out of here is a string exactly as it was written.
 *
 * The counterpart writer is `src/lib/reports/csv.ts` — `escapeCsv` there is the
 * inverse of the quoting rules here and there is no second copy of it. See
 * `serialize.ts`.
 */

export type CsvDelimiter = ',' | ';' | '\t' | '|'

const CANDIDATE_DELIMITERS: readonly CsvDelimiter[] = [',', ';', '\t', '|']

/** U+FEFF. Excel writes it; every reader has to strip it. */
const BOM = 0xfeff

export type CsvRows = {
  rows: string[][]
  delimiter: CsvDelimiter
  /** True when `maxRows` stopped us and there was more file left. */
  truncated: boolean
}

export type ParsedCsv = {
  /** The first non-blank row, trimmed. May contain duplicates or blanks. */
  headers: string[]
  /** Every later row, padded or clipped to the header width. */
  rows: string[][]
  delimiter: CsvDelimiter
  truncated: boolean
  /** How many rows arrived with the wrong number of cells. Reported, not fatal. */
  ragged: number
}

/**
 * Which character separates the columns.
 *
 * Counted across the first line only, and only outside quotes — a comma inside
 * `"Vega, Maria"` is data, and counting it is how a semicolon file gets read as
 * a comma file with two columns. Ties go to the comma, which is the name of the
 * format.
 */
export function sniffDelimiter(text: string): CsvDelimiter {
  const counts = new Map<string, number>()
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++
        else quoted = false
      }
      continue
    }
    if (ch === '"') {
      quoted = true
      continue
    }
    if (ch === '\n' || ch === '\r') break
    if ((CANDIDATE_DELIMITERS as readonly string[]).includes(ch)) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1)
    }
  }

  let best: CsvDelimiter = ','
  let bestCount = 0
  for (const candidate of CANDIDATE_DELIMITERS) {
    const count = counts.get(candidate) ?? 0
    if (count > bestCount) {
      best = candidate
      bestCount = count
    }
  }
  return best
}

/**
 * The state machine. Returns every row including the header.
 *
 * Rows where every cell is blank are dropped, wherever they appear. A trailing
 * newline is the normal way to end a file and must not produce a phantom last
 * client; a blank line in the middle is noise for the same reason.
 *
 * A stray quote in the middle of an unquoted field (`5" x 7"`) is kept as a
 * literal character rather than treated as an error. Being strict there would
 * reject a real file over a punctuation mark.
 */
export function parseCsvRows(
  text: string,
  options: { delimiter?: CsvDelimiter; maxRows?: number } = {}
): CsvRows {
  const body = text.charCodeAt(0) === BOM ? text.slice(1) : text
  const delimiter = options.delimiter ?? sniffDelimiter(body)
  const maxRows = options.maxRows ?? Number.POSITIVE_INFINITY

  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  // Nothing has been written to the current field yet, so a `"` here opens a
  // quoted field rather than being a literal.
  let atFieldStart = true
  let truncated = false

  const endField = () => {
    row.push(field)
    field = ''
    quoted = false
    atFieldStart = true
  }

  const endRow = () => {
    endField()
    if (row.some((cell) => cell.trim() !== '')) rows.push(row)
    row = []
  }

  let i = 0
  while (i < body.length) {
    const ch = body[i]

    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }

    if (ch === '"' && atFieldStart) {
      quoted = true
      atFieldStart = false
      i++
      continue
    }

    if (ch === delimiter) {
      endField()
      i++
      continue
    }

    if (ch === '\r' || ch === '\n') {
      // CRLF is one line ending, not two.
      i += ch === '\r' && body[i + 1] === '\n' ? 2 : 1
      endRow()
      if (rows.length >= maxRows) {
        truncated = /\S/.test(body.slice(i))
        break
      }
      continue
    }

    field += ch
    atFieldStart = false
    i++
  }

  // The last row, when the file does not end with a newline. If it does, the
  // buffers are already empty and nothing is added.
  if (field !== '' || row.length > 0) endRow()

  return { rows, delimiter, truncated }
}

/**
 * A whole file: header row, then the data rows squared off to the header width.
 *
 * Ragged rows are padded with empty strings and over-long rows are clipped,
 * with a count returned rather than an exception. A file with one row that has
 * a stray comma should import the other nine hundred and tell her about the
 * one, not refuse the lot.
 *
 * `maxDataRows` bounds the work: parsing is linear but the caller still has to
 * hold the result, and an accidental 200MB export should fail as a sentence
 * rather than as a timeout.
 */
export function parseCsv(
  text: string,
  options: { delimiter?: CsvDelimiter; maxDataRows?: number } = {}
): ParsedCsv {
  const maxRows =
    options.maxDataRows === undefined ? undefined : options.maxDataRows + 1

  const { rows, delimiter, truncated } = parseCsvRows(text, {
    delimiter: options.delimiter,
    maxRows,
  })

  if (rows.length === 0) {
    return { headers: [], rows: [], delimiter, truncated: false, ragged: 0 }
  }

  const headers = rows[0].map((h) => h.trim())
  const width = headers.length
  let ragged = 0

  const data = rows.slice(1).map((cells) => {
    if (cells.length !== width) ragged++
    const squared = cells.slice(0, width)
    while (squared.length < width) squared.push('')
    return squared
  })

  return { headers, rows: data, delimiter, truncated, ragged }
}

/** How a delimiter reads on screen. */
export function delimiterLabel(delimiter: CsvDelimiter): string {
  if (delimiter === ',') return 'comma'
  if (delimiter === ';') return 'semicolon'
  if (delimiter === '\t') return 'tab'
  return 'pipe'
}
