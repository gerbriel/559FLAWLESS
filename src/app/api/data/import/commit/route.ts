import { NextResponse } from 'next/server'
import { resolveImport } from '@/app/api/data/import/shared'
import { commitImport } from '@/lib/csv/apply'
import { createAdminClient } from '@/lib/supabase/admin'
import { summariseProblems } from '@/lib/csv/prepare'

export const dynamic = 'force-dynamic'
/**
 * A 500-row import re-validates and writes in chunks; on Hobby the default
 * 10 seconds could cut it off mid-commit — a truncated import that looks
 * finished. 60 is the plan's ceiling.
 */
export const maxDuration = 60

/**
 * Write it.
 *
 * Reaches this line only after `resolveImport` has authenticated the caller,
 * checked their role against the entity's own requirement, re-coerced every
 * cell and re-matched every row. Nothing the browser said about any of that is
 * taken on trust; the browser sent strings and this derived the rest.
 *
 * SERVICE ROLE, FOR CLIENTS ONLY, AND ONLY HERE. `profiles.id` is foreign-keyed
 * to `auth.users` and the sole INSERT policy on `profiles` is `id = auth.uid()`,
 * so no policy exists under which a manager creates a client — RLS is not
 * merely inconvenient here, there is no path through it. The route therefore
 * does the job the policy would have: authenticate, then require admin, which
 * is what migration 001 asks of anyone changing another person's profile. The
 * key is minted after that check and never before.
 *
 * Services and products take `viewer.supabase` — the caller's own client — so
 * every write is subject to row-level security as her. If a policy would refuse
 * it, it is refused, and the row is reported.
 *
 * PARTIAL FAILURE, stated on the screen before the button is pressed and
 * implemented to match: rows that fail validation are never attempted, and rows
 * that fail at the database leave everything already written in place. Re-run
 * the corrected file — matching means the second pass updates what the first
 * pass created rather than duplicating it.
 */
export async function POST(request: Request) {
  const resolved = await resolveImport(request)
  if (resolved instanceof NextResponse) return resolved

  const { viewer, entity, prepared, plan } = resolved
  const problems = [...prepared.problems, ...plan.problems]

  const admin = entity.importing?.role === 'admin' ? createAdminClient() : null

  let outcome
  try {
    outcome = await commitImport(viewer.supabase, admin, entity, plan, viewer.id)
  } catch (error) {
    console.error(`[data] import of '${entity.key}' failed`, error)
    return NextResponse.json(
      {
        error: 'import_failed',
        message:
          'The import stopped partway. Anything already written stayed written — run the preview again to see where it got to.',
      },
      { status: 500 }
    )
  }

  // One line in the activity log per import, against the person who ran it.
  // Reuses log_user_activity rather than adding a table: what matters is that a
  // bulk write to the studio's records has a name and a time against it.
  await viewer.supabase.rpc('log_user_activity', {
    p_user_id: viewer.id,
    p_action: 'data_import',
    p_details: {
      entity: entity.key,
      created: outcome.created,
      updated: outcome.updated,
      // The contacts are logged apart from the accounts, and the batch is
      // logged with them: `client_stubs.import_batch` carries the same
      // reference, so this line is what ties a batch of rows to the person who
      // brought them in and the minute they did it.
      contacts_created: outcome.contactsCreated,
      contacts_updated: outcome.contactsUpdated,
      import_batch: outcome.importBatch,
      failed: outcome.failed,
      rejected: new Set(problems.map((p) => p.line)).size,
    },
    p_performed_by: viewer.id,
  })

  return NextResponse.json({
    entity: entity.key,
    created: outcome.created,
    updated: outcome.updated,
    contactsCreated: outcome.contactsCreated,
    contactsUpdated: outcome.contactsUpdated,
    importBatch: outcome.importBatch,
    failed: outcome.failed,
    rejected: new Set(problems.map((p) => p.line)).size,
    failures: outcome.failures.slice(0, 50),
    problems: summariseProblems(problems),
  })
}
