import Link from 'next/link'
import { redirect } from 'next/navigation'
import { SlidersHorizontal } from 'lucide-react'
import { listReports, REPORT_GROUPS } from '@/lib/reports/registry'
import { filterQuery, resolveReportShell, type ReportSearchParams } from '@/lib/reports/shell'
import { roleAtLeast } from '@/lib/reports/types'
import { ROLE_LABELS } from '@/types/database'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<ReportSearchParams>
}

/**
 * The report index.
 *
 * Cards are filtered by the viewer's role using each module's own `minRole`, so
 * a front-desk login is not shown a profit report it would only ever see empty.
 * That is presentation, not protection — RLS decides what the query returns and
 * the export route re-checks the role for itself.
 */
export default async function ReportsPage({ searchParams }: Props) {
  const search = await searchParams
  const shell = await resolveReportShell(search)
  if (!shell) redirect('/login?next=/dashboard/reports')

  const all = await listReports()
  const visible = all.filter((r) => roleAtLeast(shell.viewer.role, r.report.minRole))

  const canBuild = roleAtLeast(shell.viewer.role, 'manager')

  if (visible.length === 0 && !canBuild) redirect('/dashboard')

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Reports</h1>
        <span className="label-caps text-[var(--color-muted)]">
          {ROLE_LABELS[shell.viewer.role]} view
        </span>
      </div>

      <p className="mt-4 max-w-2xl text-sm text-[var(--color-muted)]">
        Every figure below counts money that was actually taken, not money that was billed, and
        reads its dates in the studio&rsquo;s own timezone. Pick a report, set the window, export
        it if you need it in a spreadsheet.
      </p>

      {REPORT_GROUPS.map((group) => {
        const inGroup = visible.filter((r) => r.group === group.key)
        if (inGroup.length === 0) return null

        return (
          <section key={group.key} className="mt-12">
            <h2 className="label-caps text-[var(--color-accent)]">{group.title}</h2>
            <p className="mt-2 text-sm text-[var(--color-muted)]">{group.blurb}</p>

            <div className="mt-5 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-3">
              {inGroup.map(({ report }) => (
                <Link
                  key={report.key}
                  href={`/dashboard/reports/${report.key}?${filterQuery(shell, report.filters)}`}
                  className="group flex flex-col bg-[var(--color-surface)] p-6 transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)]"
                >
                  <span className="text-base group-hover:text-[var(--color-accent)]">
                    {report.title}
                  </span>
                  <span className="mt-2 text-sm text-[var(--color-muted)]">
                    {report.description}
                  </span>
                  {report.minRole === 'admin' && (
                    <span className="label-caps mt-4 text-[var(--color-muted)]">Admin only</span>
                  )}
                </Link>
              ))}
            </div>
          </section>
        )
      })}

      {visible.length === 0 && (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          No standard reports are registered yet. The builder below still works.
        </p>
      )}

      {canBuild && (
        <section className="mt-12">
          <h2 className="label-caps text-[var(--color-accent)]">Build your own</h2>
          <div className="mt-5 border border-[var(--color-border)] bg-[var(--color-surface)]">
            <Link
              href="/dashboard/reports/custom"
              className="group flex items-start gap-5 p-6 transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)]"
            >
              <SlidersHorizontal
                className="mt-0.5 h-5 w-5 shrink-0 text-[var(--color-muted)]"
                strokeWidth={1.5}
              />
              <span>
                <span className="block text-base group-hover:text-[var(--color-accent)]">
                  Custom report
                </span>
                <span className="mt-2 block max-w-2xl text-sm text-[var(--color-muted)]">
                  Pick a subject, choose columns, add filters, group and sort. Runs as you, against
                  the same permissions you already have — it cannot show you anything you could not
                  already open. Save the ones you want back.
                </span>
              </span>
            </Link>
          </div>
        </section>
      )}
    </div>
  )
}
