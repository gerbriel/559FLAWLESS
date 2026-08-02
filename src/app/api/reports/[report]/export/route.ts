import { NextResponse, type NextRequest } from 'next/server'
import { loadReport } from '@/lib/reports/registry'
import { resolveReportShell, type ReportSearchParams } from '@/lib/reports/shell'
import { csvResponse, resultToCsv, safeSlug } from '@/lib/reports/csv'
import { roleAtLeast } from '@/lib/reports/types'

export const dynamic = 'force-dynamic'

/**
 * One report, same filters, as a CSV.
 *
 * Runs the identical report through the identical shell as the page, so an
 * export can never disagree with what was on screen. Everything is re-derived
 * here from the URL and the session — the role check especially. The UI hiding
 * a card is a courtesy; this is the door.
 *
 * Money and percent columns are written as bare numbers rather than "$1,234.50":
 * a spreadsheet can sum a number and cannot sum a currency string, and an export
 * exists precisely to be summed somewhere else.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ report: string }> }
) {
  const { report: key } = await params
  const url = new URL(request.url)

  const search: ReportSearchParams = {
    preset: url.searchParams.get('preset') ?? undefined,
    from: url.searchParams.get('from') ?? undefined,
    to: url.searchParams.get('to') ?? undefined,
    location: url.searchParams.get('location') ?? undefined,
    provider: url.searchParams.get('provider') ?? undefined,
  }

  const shell = await resolveReportShell(search)
  if (!shell) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const report = await loadReport(key)
  if (!report) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  // Re-checked server-side, deliberately. A hidden card is not a permission,
  // and this URL is guessable from any other report's export link.
  if (!roleAtLeast(shell.viewer.role, report.minRole)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let result
  try {
    result = await report.run(shell.ctx)
  } catch (error) {
    console.error(`[reports] export of '${key}' failed`, error)
    return NextResponse.json({ error: 'export_failed' }, { status: 500 })
  }

  return csvResponse(
    resultToCsv(result),
    `559flawless-${safeSlug(report.key)}-${shell.range.from}-to-${shell.range.to}.csv`
  )
}
