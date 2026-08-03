import 'server-only'

/**
 * Everything the preview and the commit both do.
 *
 * They do a great deal both: authenticate, authorise, check the bounds,
 * coerce every cell, and work out for each row whether it matches something
 * that already exists. The commit adds writing and nothing else.
 *
 * That is deliberate and it is the reason the preview can be believed. If the
 * browser told the commit what the preview had decided, the commit would be
 * trusting a number it did not produce — and the client is a place where
 * numbers can be edited. Instead the browser re-sends the same rows, the server
 * re-derives the same plan, and the screen she approved is the screen that runs.
 */

import { NextResponse } from 'next/server'
import { z } from 'zod'
import { csvEntity } from '@/lib/csv/entities'
import { prepare, type FieldMapping } from '@/lib/csv/prepare'
import { planImport, type ImportPlan } from '@/lib/csv/apply'
import { MAX_FILE_BYTES, MAX_IMPORT_ROWS, LIMIT_MESSAGES } from '@/lib/csv/limits'
import { requireImportRole, requireManager, type Viewer } from '@/app/api/data/guard'
import type { CsvEntity } from '@/lib/csv/schema'
import type { PrepareResult } from '@/lib/csv/prepare'

const Body = z.object({
  entity: z.string().min(1).max(40),
  headers: z.array(z.string().max(300)).min(1).max(200),
  rows: z.array(z.array(z.string().max(20_000)).max(200)).max(MAX_IMPORT_ROWS),
  mapping: z.record(z.string(), z.number().int().min(-1).max(199).nullable()),
})

export type ImportContext = {
  viewer: Viewer
  entity: CsvEntity
  prepared: PrepareResult
  plan: ImportPlan
}

/**
 * Everything up to the point of writing. Returns a response instead when the
 * request should not get that far.
 */
export async function resolveImport(request: Request): Promise<ImportContext | NextResponse> {
  // Cheap first: refuse an oversized body before reading it into memory.
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
    return NextResponse.json({ error: 'too_large', message: LIMIT_MESSAGES.fileTooLarge }, { status: 413 })
  }

  const viewer = await requireManager()
  if (viewer instanceof NextResponse) return viewer

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_request',
        message:
          'That file could not be read. It may have more than the row limit in it, or more than two hundred columns.',
      },
      { status: 400 }
    )
  }

  const entity = csvEntity(parsed.data.entity)
  if (!entity) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  if (!entity.importing) {
    return NextResponse.json(
      { error: 'not_importable', message: entity.notImportable },
      { status: 400 }
    )
  }

  const denied = requireImportRole(viewer, entity.importing.role)
  if (denied) return denied

  const { headers, rows } = parsed.data
  if (rows.length === 0) {
    return NextResponse.json({ error: 'empty', message: LIMIT_MESSAGES.empty }, { status: 400 })
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    return NextResponse.json({ error: 'too_many_rows', message: LIMIT_MESSAGES.tooManyRows }, { status: 413 })
  }

  const mapping: FieldMapping = {}
  for (const [field, index] of Object.entries(parsed.data.mapping)) {
    mapping[field] = index === null || index < 0 ? null : index
  }

  const prepared = prepare(entity, headers, rows, mapping)

  let plan: ImportPlan
  try {
    // Reads only. Nothing has been written at this point and, on the preview
    // path, nothing ever will be.
    plan = await planImport(viewer.supabase, entity, prepared.rows)
  } catch (error) {
    console.error(`[data] planning an import of '${entity.key}' failed`, error)
    return NextResponse.json(
      { error: 'plan_failed', message: 'The studio’s records could not be read to compare against.' },
      { status: 500 }
    )
  }

  return { viewer, entity, prepared, plan }
}
