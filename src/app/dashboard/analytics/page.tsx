import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { requestNow } from '@/lib/time'
import { AnalyticsCharts } from '@/components/shared/AnalyticsCharts'
import { formatMoney } from '@/lib/utils'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ days?: string; segment?: string }>
}

const RANGES = [7, 30, 90, 365]
const SEGMENTS = [
  { key: 'all', label: 'Everyone' },
  { key: 'anonymous', label: 'Visitors' },
  { key: 'client', label: 'Clients' },
  { key: 'staff', label: 'Staff' },
]

const STAFF_ROLES = new Set(['provider', 'front_desk', 'manager', 'admin'])

export default async function AnalyticsPage({ searchParams }: Props) {
  const { days: daysParam, segment: segParam } = await searchParams
  const days = RANGES.includes(Number(daysParam)) ? Number(daysParam) : 30
  const segment = SEGMENTS.some((s) => s.key === segParam) ? segParam! : 'all'

  const supabase = await createClient()
  const cutoff = new Date(requestNow() - days * 86_400_000).toISOString()

  const [{ data: events }, { data: appointments }, { data: orders }, { data: topServices }] =
    await Promise.all([
      supabase
        .from('analytics_events')
        .select('path, event, session_id, user_role, created_at, referrer')
        .gte('created_at', cutoff)
        .limit(5000),
      supabase
        .from('appointments')
        .select('id, status, total_cents, created_at, starts_at, source')
        .gte('created_at', cutoff),
      supabase
        .from('orders')
        .select('id, status, total_cents, created_at')
        .gte('created_at', cutoff)
        .neq('status', 'cart'),
      supabase
        .from('appointment_services')
        .select('name_snapshot, price_cents, appointments!inner(created_at, status)')
        .gte('appointments.created_at', cutoff)
        .limit(2000),
    ])

  // ── Traffic ──────────────────────────────────────────
  const inSegment = (role: string | null) => {
    if (segment === 'all') return true
    if (segment === 'anonymous') return !role || role === 'anonymous'
    if (segment === 'client') return role === 'client'
    return !!role && STAFF_ROLES.has(role)
  }

  const all = events ?? []
  const pageviews = all.filter((e) => e.event === 'pageview')
  const filtered = pageviews.filter((e) => inSegment(e.user_role))
  const sessions = new Set(filtered.map((e) => e.session_id)).size

  const byPath = new Map<string, number>()
  for (const e of filtered) byPath.set(e.path, (byPath.get(e.path) ?? 0) + 1)
  const topPages = Array.from(byPath.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)

  const byReferrer = new Map<string, number>()
  for (const e of filtered) {
    if (!e.referrer) continue
    try {
      const host = new URL(e.referrer).hostname.replace(/^www\./, '')
      byReferrer.set(host, (byReferrer.get(host) ?? 0) + 1)
    } catch {
      // Malformed referrer — skip rather than crash the whole page.
    }
  }
  const topReferrers = Array.from(byReferrer.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)

  // ── Booking funnel ───────────────────────────────────
  const funnelSteps = [
    { key: 'service_selected', label: 'Chose a service' },
    { key: 'booking_started', label: 'Started booking' },
    { key: 'provider_selected', label: 'Picked a provider' },
    { key: 'slot_selected', label: 'Picked a time' },
    { key: 'booking_completed', label: 'Completed' },
  ]
  const funnel = funnelSteps.map((s) => ({
    label: s.label,
    count: new Set(all.filter((e) => e.event === s.key).map((e) => e.session_id)).size,
  }))

  // ── Money ────────────────────────────────────────────
  const completed = (appointments ?? []).filter((a) => a.status === 'completed')
  const serviceRevenue = completed.reduce((n, a) => n + a.total_cents, 0)
  const paidOrders = (orders ?? []).filter((o) =>
    ['paid', 'fulfilling', 'ready_for_pickup', 'shipped', 'completed'].includes(o.status)
  )
  const productRevenue = paidOrders.reduce((n, o) => n + o.total_cents, 0)

  const cancelled = (appointments ?? []).filter((a) => a.status === 'cancelled').length
  const noShows = (appointments ?? []).filter((a) => a.status === 'no_show').length
  const totalAppointments = appointments?.length ?? 0

  // ── Daily series for the chart ───────────────────────
  const dailyMap = new Map<string, { views: number; bookings: number }>()
  for (let i = days - 1; i >= 0; i--) {
    const key = new Date(requestNow() - i * 86_400_000).toISOString().slice(0, 10)
    dailyMap.set(key, { views: 0, bookings: 0 })
  }
  for (const e of filtered) {
    const key = e.created_at.slice(0, 10)
    const row = dailyMap.get(key)
    if (row) row.views += 1
  }
  for (const a of appointments ?? []) {
    const key = a.created_at.slice(0, 10)
    const row = dailyMap.get(key)
    if (row) row.bookings += 1
  }
  const daily = Array.from(dailyMap.entries()).map(([date, v]) => ({ date, ...v }))

  // ── Service mix ──────────────────────────────────────
  const serviceMix = new Map<string, { count: number; revenue: number }>()
  for (const line of topServices ?? []) {
    const current = serviceMix.get(line.name_snapshot) ?? { count: 0, revenue: 0 }
    current.count += 1
    current.revenue += line.price_cents
    serviceMix.set(line.name_snapshot, current)
  }
  const topServiceRows = Array.from(serviceMix.entries())
    .sort((a, b) => b[1].revenue - a[1].revenue)
    .slice(0, 8)

  return (
    <div>
      <h1 className="display text-3xl">Analytics</h1>

      <div className="mt-8 flex flex-wrap gap-x-8 gap-y-4">
        <nav className="flex gap-5" aria-label="Date range">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`/dashboard/analytics?days=${r}&segment=${segment}`}
              className={`label-caps pb-1 ${
                days === r ? 'border-b border-[var(--color-foreground)]' : 'text-[var(--color-muted)]'
              }`}
            >
              {r === 365 ? '1 year' : `${r} days`}
            </Link>
          ))}
        </nav>

        <nav className="flex gap-5" aria-label="Segment">
          {SEGMENTS.map((s) => (
            <Link
              key={s.key}
              href={`/dashboard/analytics?days=${days}&segment=${s.key}`}
              className={`label-caps pb-1 ${
                segment === s.key
                  ? 'border-b border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'text-[var(--color-muted)]'
              }`}
            >
              {s.label}
            </Link>
          ))}
        </nav>
      </div>

      {/* ── Headline numbers ──────────────────────────── */}
      <div className="mt-10 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Service revenue" value={formatMoney(serviceRevenue)} />
        <Stat label="Product revenue" value={formatMoney(productRevenue)} />
        <Stat label="Appointments" value={String(totalAppointments)} />
        <Stat
          label="Sessions"
          value={String(sessions)}
          hint={`${filtered.length} pageviews`}
        />
      </div>

      <div className="mt-px grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
        <Stat
          label="Cancellations"
          value={
            totalAppointments > 0
              ? `${Math.round((cancelled / totalAppointments) * 100)}%`
              : '—'
          }
          hint={`${cancelled} of ${totalAppointments}`}
        />
        <Stat
          label="No-shows"
          value={
            totalAppointments > 0 ? `${Math.round((noShows / totalAppointments) * 100)}%` : '—'
          }
          hint={`${noShows} of ${totalAppointments}`}
        />
        <Stat
          label="Average ticket"
          value={completed.length > 0 ? formatMoney(serviceRevenue / completed.length) : '—'}
        />
      </div>

      <div className="mt-12">
        <AnalyticsCharts daily={daily} funnel={funnel} />
      </div>

      {/* ── Tables ────────────────────────────────────── */}
      <div className="mt-12 grid gap-10 lg:grid-cols-2">
        <Panel title="Top services by revenue">
          {topServiceRows.length === 0 ? (
            <Empty />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {topServiceRows.map(([name, v]) => (
                <li key={name} className="flex justify-between gap-4 py-3 text-sm">
                  <span className="truncate">
                    {name}
                    <span className="ml-2 text-[var(--color-muted)]">×{v.count}</span>
                  </span>
                  <span className="shrink-0 tabular-nums">{formatMoney(v.revenue)}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Most visited pages">
          {topPages.length === 0 ? (
            <Empty />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {topPages.map(([path, count]) => (
                <li key={path} className="flex justify-between gap-4 py-3 text-sm">
                  <span className="truncate text-[var(--color-muted)]">{path}</span>
                  <span className="shrink-0 tabular-nums">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Where people came from">
          {topReferrers.length === 0 ? (
            <Empty note="Mostly direct traffic." />
          ) : (
            <ul className="divide-y divide-[var(--color-border)]">
              {topReferrers.map(([host, count]) => (
                <li key={host} className="flex justify-between gap-4 py-3 text-sm">
                  <span className="truncate text-[var(--color-muted)]">{host}</span>
                  <span className="shrink-0 tabular-nums">{count}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="How bookings were made">
          <ul className="divide-y divide-[var(--color-border)]">
            {['online', 'staff', 'phone', 'walk_in'].map((source) => {
              const count = (appointments ?? []).filter((a) => a.source === source).length
              return (
                <li key={source} className="flex justify-between gap-4 py-3 text-sm">
                  <span className="capitalize text-[var(--color-muted)]">
                    {source.replace('_', ' ')}
                  </span>
                  <span className="tabular-nums">{count}</span>
                </li>
              )
            })}
          </ul>
        </Panel>
      </div>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="bg-[var(--color-background)] p-6">
      <p className="label-caps text-[var(--color-muted)]">{label}</p>
      <p className="display mt-2 text-3xl tabular-nums">{value}</p>
      {hint && <p className="mt-1 text-xs text-[var(--color-muted)]">{hint}</p>}
    </div>
  )
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="label-caps mb-4 text-[var(--color-accent)]">{title}</h2>
      <div className="border-y border-[var(--color-border)]">{children}</div>
    </section>
  )
}

function Empty({ note }: { note?: string }) {
  return (
    <p className="py-6 text-sm text-[var(--color-muted)]">{note ?? 'No data for this range.'}</p>
  )
}
