import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { resolveReportShell, type ReportSearchParams } from '@/lib/reports/shell'
import { csvResponse, resultToCsv, safeSlug } from '@/lib/reports/csv'
import { roleAtLeast } from '@/lib/reports/types'
import { findSubject, runCustomQuery, sanitiseDefinition } from '@/lib/reports/custom'

export const dynamic = 'force-dynamic'

/**
 * The custom builder's export.
 *
 * A static route segment, so it takes precedence over `[report]` — 'custom' is
 * not a registered module and would otherwise 404 there.
 *
 * The definition arrives in the query string and is put through
 * `sanitiseDefinition` again before anything is compiled. That is the same
 * allow-list the page uses and it is not a formality: this URL is hand-editable,
 * and a column name typed into it that the builder does not offer must simply
 * not exist rather than be escaped and passed along.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url)
  const p = url.searchParams

  const search: ReportSearchParams = {
    preset: p.get('preset') ?? undefined,
    from: p.get('from') ?? undefined,
    to: p.get('to') ?? undefined,
    location: p.get('location') ?? undefined,
    provider: p.get('provider') ?? undefined,
  }

  const shell = await resolveReportShell(search)
  if (!shell) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  // Same gate as the builder page, re-checked rather than assumed.
  if (!roleAtLeast(shell.viewer.role, 'manager')) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const subject = findSubject(p.get('subject'))
  if (!subject) return NextResponse.json({ error: 'unknown_subject' }, { status: 400 })
  if (!roleAtLeast(shell.viewer.role, subject.minRole)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const filters: Record<string, string> = {}
  for (const f of subject.filters) {
    const value = p.get(`f_${f.key}`)
    if (value) filters[f.key] = value
  }

  const definition = sanitiseDefinition({
    subject: subject.key,
    columns: p.getAll('cols'),
    filters,
    groupBy: p.get('group'),
    sort: p.get('sort'),
    sortDir: p.get('dir') === 'asc' ? 'asc' : 'desc',
  })
  if (!definition) return NextResponse.json({ error: 'bad_definition' }, { status: 400 })

  const supabase = await createClient()
  const compiled = await runCustomQuery(supabase, subject, definition, {
    from: shell.ctx.from,
    to: shell.ctx.to,
    timeZone: shell.ctx.timeZone,
    locationId: shell.ctx.locationId,
    providerId: shell.ctx.providerId,
  })

  if (compiled.error) {
    console.error('[reports] custom export failed', compiled.error)
    return NextResponse.json({ error: 'export_failed' }, { status: 500 })
  }

  const notes = [
    `Subject: ${subject.label}. Window: ${shell.range.from} to ${shell.range.to} (${shell.ctx.timeZone}).`,
  ]
  if (definition.groupBy) notes.push(`Grouped by ${definition.groupBy}.`)
  if (compiled.truncated) {
    // A partial total that does not announce itself is the worst thing a report
    // can hand an accountant.
    notes.push('TRUNCATED: more rows matched than could be fetched. Totals are partial.')
  }

  return csvResponse(
    resultToCsv({ columns: compiled.columns, rows: compiled.rows, notes }),
    `559flawless-custom-${safeSlug(subject.key)}-${shell.range.from}-to-${shell.range.to}.csv`
  )
}
