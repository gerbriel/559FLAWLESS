/**
 * Writing a CSV.
 *
 * There is no writer here, on purpose. `src/lib/reports/csv.ts` already has one
 * and `escapeCsv` there is the exact inverse of the quoting rules in `parse.ts`
 * — RFC 4180, quote the field and double any quote inside it. A second copy
 * would be a second set of edge cases to keep in step, and the first time they
 * disagreed would be the day an apostrophe in a client's name split a row.
 *
 * So this file is two joins over the imported escaper, and `csvResponse` (also
 * from reports/csv) is what turns the text into a download — it already writes
 * the UTF-8 BOM Excel needs to read an accented name correctly.
 */

import { escapeCsv } from '@/lib/reports/csv'
import { guardFormula } from '@/lib/csv/values'

/** Inert first, then quoted. See `guardFormula` for why both are needed. */
const field = (value: string): string => escapeCsv(guardFormula(value))

/**
 * Header row plus data rows, CRLF-separated.
 *
 * CRLF rather than LF because that is what RFC 4180 specifies and what Excel
 * expects; `parse.ts` reads either, so a round trip is unaffected.
 *
 * Every cell passes through `guardFormula` on the way out. `escapeCsv` solves
 * the CSV problem — a comma or a quote inside a value — and nothing else;
 * a value beginning `=` or `@` is perfectly valid CSV and is executed by the
 * spreadsheet that opens it. The two are different problems and both are here.
 * `unguardFormula` in the importer undoes this exactly, so the export the
 * studio edits and sends back still reads as itself.
 */
export function toCsv(
  headers: readonly string[],
  rows: readonly (readonly string[])[]
): string {
  const lines = [headers.map(field).join(',')]
  for (const row of rows) lines.push(row.map(field).join(','))
  return lines.join('\r\n')
}
