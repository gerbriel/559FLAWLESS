import { redirect } from 'next/navigation'
import { Download, FileSpreadsheet, Lock } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { isAdmin, isManager } from '@/types/database'
import { ButtonLink } from '@/components/ui/button'
import { PageHeader, Panel } from '@/components/ui/dashboard'
import { CsvImportWizard } from '@/components/shared/CsvImportWizard'
import { CsvSchemaTable } from '@/components/shared/CsvSchemaTable'
import { CSV_ENTITIES } from '@/lib/csv/entities'

export const dynamic = 'force-dynamic'

/**
 * Import and export, as spreadsheets.
 *
 * MANAGER FOR THE PAGE. Front desk can already look up any client on screen —
 * that is the job. But "can look someone up" and "can walk out with the whole
 * client list in one file" are different powers, and the second is the one that
 * ends up on somebody's personal laptop. Manager is where the studio already
 * puts bulk client data: analytics and marketing both live there. It is also
 * where the writes already live — services are `is_manager()` (022) and product
 * creation is `is_manager()` (021) — so the page and the policies agree without
 * anyone having to remember that they should.
 *
 * Importing CLIENTS is admin, one level up, and the page says so rather than
 * hiding the section. `profiles` has exactly one INSERT policy, `id =
 * auth.uid()`, so no manager can create somebody else's profile through
 * row-level security at all; that import goes through the service role, and a
 * route standing in for a policy is held to what the database asks — admin.
 *
 * The redirect here is a courtesy. Every route under /api/data re-checks, on
 * its own, from the session — those URLs are guessable and a hidden link has
 * never been a permission.
 */
export default async function DataPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/settings/data')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || profile.suspended_at || !isManager(profile.role)) {
    redirect('/dashboard/settings')
  }

  const viewerIsAdmin = isAdmin(profile.role)
  const importable = CSV_ENTITIES.filter((entity) => entity.importing !== null)
  const allowedToImport = importable.filter(
    (entity) => entity.importing?.role !== 'admin' || viewerIsAdmin
  )
  const blockedFromImport = importable.filter(
    (entity) => entity.importing?.role === 'admin' && !viewerIsAdmin
  )

  return (
    <div className="max-w-5xl">
      <PageHeader
        eyebrow="Settings"
        title="Import & export"
        lede="Take the studio's records out as a spreadsheet, or bring records in from one. Everything downloads and uploads as CSV, which every spreadsheet program reads."
      />

      {/* ── Export ─────────────────────────────────────────── */}
      <section className="mt-12">
        <h2 className="display text-2xl">Export</h2>
        <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
          An export contains only what you could read on screen — the same
          row-level security applies to the file as to the page, so it cannot
          contain anything you are not already allowed to see.
        </p>

        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {CSV_ENTITIES.map((entity) => (
            <Panel key={entity.key} className="flex flex-col gap-3 p-5">
              <div>
                <h3 className="text-base">{entity.label}</h3>
                <p className="mt-1 text-sm text-[var(--color-muted)]">{entity.lede}</p>
              </div>
              <div className="mt-auto flex flex-wrap gap-2.5 pt-2">
                <ButtonLink
                  href={`/api/data/export/${entity.key}`}
                  variant="subtle"
                  size="sm"
                  prefetch={false}
                >
                  <Download className="h-4 w-4" strokeWidth={1.5} aria-hidden />
                  Export
                </ButtonLink>
                {entity.importing && (
                  <ButtonLink
                    href={`/api/data/template/${entity.key}`}
                    variant="ghost"
                    size="sm"
                    prefetch={false}
                  >
                    <FileSpreadsheet className="h-4 w-4" strokeWidth={1.5} aria-hidden />
                    Blank template
                  </ButtonLink>
                )}
              </div>
            </Panel>
          ))}
        </div>

        <Panel className="mt-6 p-5">
          <h3 className="text-base">What is deliberately not in any export</h3>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            Clinical notes, intake answers, signed consent, patch tests and
            treatment photographs. That is health information, and the reasons it
            is kept behind the login do not stop applying because it would be
            convenient to have a copy: a file has no expiry, no audit and no way
            to be recalled. The photographs live in a private bucket reachable
            only through short-lived signed links precisely so that a copy cannot
            escape, and putting the notes in a CSV would undo that reasoning one
            table over. A client asking for their own record has a path to it in
            their account, which is the right shape for that request.
          </p>
        </Panel>
      </section>

      {/* ── Import ─────────────────────────────────────────── */}
      <section className="mt-16">
        <h2 className="display text-2xl">Import</h2>
        <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
          Bring in a file from another system, or a corrected export from this
          one. Nothing is written until you have seen exactly what would happen —
          how many records would be created, how many updated, and how many
          rejected and why.
        </p>

        {blockedFromImport.length > 0 && (
          <Panel className="mt-6 p-5">
            <p className="flex items-start gap-2 text-sm">
              <Lock
                className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-muted)]"
                strokeWidth={1.5}
                aria-hidden
              />
              <span>
                <span className="text-[var(--color-foreground)]">
                  Importing {blockedFromImport.map((e) => e.label.toLowerCase()).join(' and ')}{' '}
                  needs an admin.
                </span>{' '}
                <span className="text-[var(--color-muted)]">
                  {blockedFromImport[0].importing?.roleBecause}
                </span>
              </span>
            </p>
          </Panel>
        )}

        {allowedToImport.length > 0 ? (
          <div className="mt-8">
            {/* Plain data, so it crosses the client boundary as-is. */}
            <CsvImportWizard entities={allowedToImport.map((entity) => ({ ...entity }))} />
          </div>
        ) : (
          <Panel className="mt-6 p-5">
            <p className="text-sm text-[var(--color-muted)]">
              There is nothing here you can import at your access level.
            </p>
          </Panel>
        )}
      </section>

      {/* ── The formats ────────────────────────────────────── */}
      <section className="mt-16">
        <h2 className="display text-2xl">What the columns mean</h2>
        <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
          This is the same list the blank templates are written from and the same
          list the importer reads, so it cannot describe a format that will not
          work. Column names do not have to match — the mapping step will find
          them — but these are what the templates use.
        </p>

        <div className="mt-8 space-y-14">
          {CSV_ENTITIES.map((entity) => (
            <div key={entity.key}>
              <div className="flex flex-wrap items-baseline justify-between gap-3">
                <h3 className="display text-xl">{entity.label}</h3>
                <p className="label-caps text-[var(--color-muted)]">{entity.source}</p>
              </div>

              {entity.importing ? (
                <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
                  <span className="text-[var(--color-foreground)]">Matched on:</span>{' '}
                  {entity.importing.matchRule}
                </p>
              ) : (
                <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
                  <span className="text-[var(--color-foreground)]">
                    Exports, but cannot be imported.
                  </span>{' '}
                  {entity.notImportable}
                </p>
              )}

              <div className="mt-5">
                <CsvSchemaTable entity={entity} />
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  )
}
