import { redirect } from 'next/navigation'
import {
  Boxes,
  CalendarDays,
  CircleDollarSign,
  Clock,
  Download,
  FileText,
  Gauge,
  Landmark,
  Percent,
  Receipt,
  ShoppingBag,
  Sparkles,
  TrendingUp,
  UserCheck,
  Users,
  Wallet,
  type LucideIcon,
} from 'lucide-react'
import { listReports, REPORT_GROUPS } from '@/lib/reports/registry'
import { filterQuery, resolveReportShell, type ReportSearchParams } from '@/lib/reports/shell'
import { roleAtLeast } from '@/lib/reports/types'
import { ActionTile, EmptyState, HowItWorks, PageHeader } from '@/components/ui/dashboard'
import { ROLE_LABELS } from '@/types/database'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<ReportSearchParams>
}

/**
 * A face for each report, keyed by its registry key.
 *
 * Icons live here rather than on the module because a report module is a query
 * and its arithmetic — it should not have to import from lucide to be listed.
 * A key with no entry falls back to the plain document, so registering a report
 * never depends on remembering to come back here.
 */
const REPORT_ICONS: Record<string, LucideIcon> = {
  sales: TrendingUp,
  'sales-tax': Landmark,
  'transaction-detail': Receipt,
  expenses: Wallet,
  'retail-sales': ShoppingBag,
  commissions: Percent,
  appointments: CalendarDays,
  'utilisation-retention': Gauge,
  inventory: Boxes,
  'most-valuable-clients': Users,
  'staff-performance': UserCheck,
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

  // Front desk sees one card — Appointments, the only report carrying no money.
  // A single half-width tile in a two-column grid reads like a page that failed
  // to load, so on its own it takes the full width instead.
  const sole = visible.length === 1

  return (
    <div>
      <PageHeader
        title="Reports"
        lede="Pick a report, set the window, export it if you need it in a spreadsheet."
        actions={
          <span className="label-caps rounded-full border border-[var(--color-border)] px-3 py-1.5 text-[var(--color-muted)]">
            {ROLE_LABELS[shell.viewer.role]} view
          </span>
        }
      />

      {/* The builder leads the grid the way the reference's does: same shape as
          a report card, tinted and accent-edged so it reads as the one that
          makes the others. Managers and above only — see the gate on the page
          it links to. */}
      {canBuild && (
        <ActionTile
          icon={Sparkles}
          title="Create a custom report"
          subtitle="Ask for anything the studio records — pick a subject, choose columns, add filters, group and sort. Runs as you, against the same permissions you already have, so it cannot show you anything you could not already open. Save the ones you want back."
          href="/dashboard/reports/custom"
          className="mt-8 border-[var(--color-accent)] bg-[var(--color-clay-soft)] dark:bg-[var(--color-surface)]"
        />
      )}

      {REPORT_GROUPS.map((group) => {
        const inGroup = visible.filter((r) => r.group === group.key)
        if (inGroup.length === 0) return null

        return (
          <section key={group.key} className="mt-10">
            <h2 className="label-caps text-[var(--color-accent)]">{group.title}</h2>
            <p className="mt-2 text-sm text-[var(--color-muted)]">{group.blurb}</p>

            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {inGroup.map(({ report }) => (
                <ActionTile
                  key={report.key}
                  icon={REPORT_ICONS[report.key] ?? FileText}
                  title={report.title}
                  subtitle={report.description}
                  href={`/dashboard/reports/${report.key}?${filterQuery(shell, report.filters)}`}
                  // The only role worth marking on a card is one narrower than
                  // the screen itself: everything here is already manager-and-
                  // above bar Appointments, so saying so on ten of eleven cards
                  // would be noise. An admin-only report is the exception.
                  badge={
                    report.minRole === 'admin' ? (
                      <span className="label-caps rounded-full bg-[var(--color-linen)] px-2.5 py-1 text-[var(--color-muted)] dark:bg-[var(--color-background)]">
                        Admin only
                      </span>
                    ) : undefined
                  }
                  className={sole ? 'md:col-span-2' : undefined}
                />
              ))}
            </div>
          </section>
        )
      })}

      {visible.length === 0 && (
        <EmptyState
          className="mt-10"
          icon={FileText}
          title="No standard reports are registered yet"
          description="The builder above still works — it reaches the same data with the same permissions."
        />
      )}

      <HowItWorks
        className="mt-14"
        title="How these read"
        items={[
          {
            icon: CircleDollarSign,
            title: 'Money taken, not money billed',
            body: 'Every figure counts payments that actually settled. A booked appointment nobody paid for is in the appointment counts and out of the takings.',
          },
          {
            icon: Clock,
            title: 'Studio time, wherever you are',
            body: 'Dates are read in the studio’s own timezone, so "this month" ends when the studio’s month ends and not when yours does.',
          },
          {
            icon: Download,
            title: 'Exports match the screen',
            body: 'Every report exports to CSV with the window and filters you are looking at, and money arrives as a plain number a spreadsheet can add up.',
          },
        ]}
      />
    </div>
  )
}
