import { NextResponse, type NextRequest } from 'next/server'
import { csvResponse, safeSlug } from '@/lib/reports/csv'
import { toCsv } from '@/lib/csv/serialize'
import { csvEntity } from '@/lib/csv/entities'
import { exportEntity, studioTimeZone } from '@/lib/csv/export'
import { requireManager } from '@/app/api/data/guard'
import { dateKeyInTimeZone, requestNow } from '@/lib/time'

export const dynamic = 'force-dynamic'

/**
 * One entity, as a CSV.
 *
 * The query runs on the caller's own client, so row-level security decides what
 * comes back. That is the actual guarantee here — not the manager check above
 * it, which is about who may reach the page at all. If a policy changed
 * tomorrow to hide something, this export would stop containing it without
 * anyone editing this file.
 *
 * The header row is the entity definition's labels, which is the same list the
 * template writes and the importer reads. That is what makes "the file you
 * export is the file you can import" a property of the code rather than a
 * claim in the documentation.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ entity: string }> }
) {
  const { entity: key } = await params

  const viewer = await requireManager()
  if (viewer instanceof NextResponse) return viewer

  const entity = csvEntity(key)
  if (!entity) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  let table
  let timeZone
  try {
    timeZone = await studioTimeZone(viewer.supabase)
    table = await exportEntity(viewer.supabase, entity, timeZone)
  } catch (error) {
    console.error(`[data] export of '${key}' failed`, error)
    return NextResponse.json({ error: 'export_failed' }, { status: 500 })
  }

  const rows = [...table.rows]
  if (table.truncated) {
    // Loud, and on its own line. A truncated export that does not say so is
    // worse than no export, because it looks complete.
    rows.push([
      'This export stopped at the row limit and is not the whole table. Narrow it down or ask for it in parts.',
      ...Array(Math.max(0, table.headers.length - 1)).fill(''),
    ])
  }

  const today = dateKeyInTimeZone(new Date(requestNow()), timeZone)
  return csvResponse(
    toCsv(table.headers, rows),
    `559flawless-${safeSlug(entity.key)}-${today}.csv`
  )
}
