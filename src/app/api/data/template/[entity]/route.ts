import { NextResponse, type NextRequest } from 'next/server'
import { csvResponse, safeSlug } from '@/lib/reports/csv'
import { toCsv } from '@/lib/csv/serialize'
import { csvEntity } from '@/lib/csv/entities'
import { templateRows } from '@/lib/csv/schema'
import { requireManager } from '@/app/api/data/guard'

export const dynamic = 'force-dynamic'

/**
 * The blank form: the header row the importer expects, and one example row.
 *
 * Generated from the same field list the importer reads and the reference table
 * on screen renders, so it cannot describe a format the importer does not
 * accept. A template maintained separately from the thing it describes is a
 * template that will eventually be wrong, and it will be wrong quietly.
 *
 * Importable columns only — read-only ones like an id or a stock count would
 * invite her to fill them in and then be ignored. The export carries those;
 * this does not.
 *
 * The example row is real data in the right shape, not `<first name>`. Deleting
 * a row is easier than decoding a placeholder, and it means the file opens as a
 * working example of every format the parser accepts.
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
  if (!entity.importing) {
    return NextResponse.json(
      { error: 'not_importable', message: entity.notImportable },
      { status: 400 }
    )
  }

  const { headers, example } = templateRows(entity)
  return csvResponse(
    toCsv(headers, [example]),
    `559flawless-${safeSlug(entity.key)}-template.csv`
  )
}
