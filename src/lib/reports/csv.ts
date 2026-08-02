import { NextResponse } from 'next/server'
import { csvCell, type ReportColumn, type ReportResult, type ReportRow } from '@/lib/reports/types'

/** RFC 4180: quote the field and double any quote inside it. */
export function escapeCsv(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function line(columns: ReportColumn[], row: ReportRow): string {
  return columns.map((c) => escapeCsv(csvCell(row[c.key], c))).join(',')
}

/** Strip anything a filename cannot safely carry. */
export function safeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 60) || 'report'
}

/**
 * A report result as CSV text.
 *
 * Sub-tables are appended below the main one, each after a blank line and its
 * own title, so a report is still a single download. The notes go at the foot
 * for the same reason a report page shows them: a CSV that lands in an
 * accountant's inbox without its denominator is worse than no CSV.
 */
export function resultToCsv(result: ReportResult): string {
  const { columns, rows } = result
  const header = columns.map((c) => escapeCsv(c.label)).join(',')
  const body = [header, ...rows.map((row) => line(columns, row))]

  for (const section of result.sections ?? []) {
    if (section.rows.length === 0) continue
    body.push('', escapeCsv(section.title), header)
    for (const row of section.rows) body.push(line(columns, row))
  }

  if (result.notes && result.notes.length > 0) {
    body.push('')
    for (const note of result.notes) body.push(escapeCsv(note))
  }

  return body.join('\r\n')
}

/** The download response, with the BOM Excel needs to read UTF-8 correctly. */
export function csvResponse(csv: string, filename: string): NextResponse {
  // Without the BOM, Excel reads this as the local codepage and mangles any
  // accented name in it.
  return new NextResponse(`﻿${csv}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
