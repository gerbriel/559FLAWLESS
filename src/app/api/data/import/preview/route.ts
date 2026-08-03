import { NextResponse } from 'next/server'
import { resolveImport } from '@/app/api/data/import/shared'
import { summariseProblems } from '@/lib/csv/prepare'
import { PREVIEW_SAMPLE } from '@/lib/csv/limits'

export const dynamic = 'force-dynamic'

/**
 * What this file would do, without doing any of it.
 *
 * The only route in the feature that is guaranteed to write nothing —
 * `planImport` reads and compares and returns, and there is no write path
 * reachable from here at all. She sees this before the commit button exists.
 *
 * What comes back is three numbers and the reasons behind the third: how many
 * rows would be created, how many would update somebody who is already here,
 * and how many are rejected and why. The rejections are grouped, because
 * "Date of Birth: two-digit year, 214 rows, first at row 3" is one thing to fix
 * and two hundred and fourteen identical lines are not.
 */
export async function POST(request: Request) {
  const resolved = await resolveImport(request)
  if (resolved instanceof NextResponse) return resolved

  const { entity, prepared, plan } = resolved
  const problems = [...prepared.problems, ...plan.problems]
  const rejectedRows = new Set(problems.map((p) => p.line))

  return NextResponse.json({
    entity: entity.key,
    matchRule: entity.importing?.matchRule ?? null,
    onNoMatch: entity.importing?.onNoMatch ?? null,
    create: plan.create,
    update: plan.update,
    reject: rejectedRows.size,
    /** A readable slice, not the lot — the counts above are the whole picture. */
    sample: plan.planned.slice(0, PREVIEW_SAMPLE).map((row) => ({
      line: row.line,
      action: row.action,
      label: row.label,
      matchedBy: row.matchedBy,
      // Read from the record, not from the file. On an update these are two
      // names until she has looked at them, and the point of the sample is to
      // let her look.
      existing: row.existing ?? null,
    })),
    problems: summariseProblems(problems),
    ignoredColumns: prepared.ignoredColumns,
    unmappedFields: prepared.unmappedFields.map((f) => ({
      key: f.key,
      label: f.label,
      required: Boolean(f.required),
    })),
    notes: plan.notes,
  })
}
