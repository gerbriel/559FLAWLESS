import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { ArrowLeft, Download } from 'lucide-react'
import { loadReport } from '@/lib/reports/registry'
import {
  canRun,
  filterQuery,
  resolveReportShell,
  type ReportSearchParams,
} from '@/lib/reports/shell'
import { type ReportResult } from '@/lib/reports/types'
import { ReportFilters } from '@/components/shared/ReportFilters'
import { ReportTable } from '@/components/shared/ReportTable'

export const dynamic = 'force-dynamic'

interface Props {
  params: Promise<{ report: string }>
  searchParams: Promise<ReportSearchParams>
}

export default async function ReportPage({ params, searchParams }: Props) {
  const { report: key } = await params
  const search = await searchParams

  const shell = await resolveReportShell(search)
  if (!shell) redirect(`/login?next=/dashboard/reports/${key}`)

  const report = await loadReport(key)
  if (!report) notFound()

  // The role gate is repeated in the export route. Neither is the security
  // boundary — the report runs on the caller's own client, so RLS still decides
  // what comes back — but a report a role cannot use should not open at all.
  if (!canRun(shell, report)) redirect('/dashboard/reports')

  const query = filterQuery(shell, report.filters)

  let result: ReportResult | null = null
  let failure: string | null = null
  try {
    result = await report.run(shell.ctx)
  } catch (error) {
    console.error(`[reports] '${key}' failed`, error)
    failure = error instanceof Error ? error.message : 'Unknown error'
  }

  return (
    <div>
      <Link
        href={`/dashboard/reports?${query}`}
        className="label-caps inline-flex items-center gap-2 text-[var(--color-muted)] hover:text-[var(--color-accent)]"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.5} />
        All reports
      </Link>

      <div className="mt-5 flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="display text-3xl">{report.title}</h1>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">{report.description}</p>
        </div>
        {result && result.rows.length > 0 && (
          <a
            href={`/api/reports/${report.key}/export?${query}`}
            className="label-caps inline-flex items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-2.5 text-[var(--color-foreground)] hover:border-[var(--color-accent)]"
          >
            <Download className="h-3.5 w-3.5" strokeWidth={1.5} />
            Export CSV
          </a>
        )}
      </div>

      <ReportFilters
        filters={report.filters}
        preset={shell.range.preset}
        from={shell.range.from}
        to={shell.range.to}
        timeZone={shell.ctx.timeZone}
        locations={shell.locations}
        locationId={shell.ctx.locationId}
        providers={shell.providers}
        providerId={shell.ctx.providerId}
      />

      {report.filters.includes('dateRange') && (
        <p className="mt-4 text-xs text-[var(--color-muted)]">
          {shell.range.label} · dates read in {shell.ctx.timeZone.replace(/_/g, ' ')}
          {shell.ctx.locationId === null && shell.locations.length > 1 && ' · all locations'}
        </p>
      )}

      {failure && (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm">
          This report could not be run.
          <span className="mt-2 block text-[var(--color-muted)]">{failure}</span>
        </p>
      )}

      {result && (
        <>
          {result.summary && result.summary.length > 0 && (
            <div className="mt-10 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-4">
              {result.summary.map((tile, i) => (
                <div key={`${tile.label}-${i}`} className="bg-[var(--color-surface)] p-6">
                  <p className="label-caps text-[var(--color-muted)]">{tile.label}</p>
                  <p
                    className={`display mt-2 text-3xl tabular-nums ${
                      tile.tone === 'warn'
                        ? 'text-[var(--color-accent)]'
                        : 'text-[var(--color-foreground)]'
                    }`}
                  >
                    {tile.value}
                  </p>
                </div>
              ))}
            </div>
          )}

          {result.rows.length === 0 ? (
            /* An empty table with headers reads as a broken query. Say it plainly. */
            <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
              Nothing to report for {shell.range.label}
              {shell.ctx.providerId ? ' for that provider' : ''}. Try a wider window.
            </p>
          ) : (
            <div className="mt-10">
              <ReportTable
                columns={result.columns}
                rows={result.rows}
                timeZone={shell.ctx.timeZone}
              />
            </div>
          )}

          {result.sections?.map((section) => (
            <section key={section.title} className="mt-12">
              <h2 className="label-caps text-[var(--color-accent)]">{section.title}</h2>
              {section.rows.length === 0 ? (
                <p className="mt-4 text-sm text-[var(--color-muted)]">Nothing in this group.</p>
              ) : (
                <div className="mt-4">
                  <ReportTable
                    columns={result.columns}
                    rows={section.rows}
                    timeZone={shell.ctx.timeZone}
                  />
                </div>
              )}
            </section>
          ))}

          {result.notes && result.notes.length > 0 && (
            <section className="mt-12 max-w-2xl border-t border-[var(--color-border)] pt-6">
              <h2 className="label-caps text-[var(--color-muted)]">How this is counted</h2>
              <ul className="mt-3 space-y-2 text-sm text-[var(--color-muted)]">
                {result.notes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

