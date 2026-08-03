import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertTriangle, TrendingUp, Users, DollarSign } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import { dateKeyInTimeZone, formatTimeInTimeZone, zonedTimeToUtc, addDaysToDateKey , requestNow } from '@/lib/time'
import { isFrontDesk, isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

export default async function DashboardHome() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name, timezone')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'provider') as UserRole
  const tz = profile?.timezone || STUDIO_TZ

  // Day boundaries in the studio's zone, not the server's.
  const todayKey = dateKeyInTimeZone(new Date(), tz)
  const dayStart = zonedTimeToUtc(todayKey, '00:00', tz).toISOString()
  const dayEnd = zonedTimeToUtc(addDaysToDateKey(todayKey, 1), '00:00', tz).toISOString()

  // A provider sees only their own book; front desk and up see everyone's.
  const scoped = <T,>(q: T): T => {
    if (isFrontDesk(role)) return q
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (q as any).eq('provider_id', user.id)
  }

  const [
    { data: today },
    { data: flaggedIntakes },
    { count: weekCount },
    { data: weekRevenue },
    { count: newClients },
  ] = await Promise.all([
    scoped(
      supabase
        .from('appointments')
        .select(
          'id, starts_at, ends_at, status, total_cents, deposit_status, deposit_cents, guest_first_name, guest_last_name, profiles!appointments_client_id_fkey(first_name, last_name), appointment_services(name_snapshot, sort_order)'
        )
        .gte('starts_at', dayStart)
        .lt('starts_at', dayEnd)
        .neq('status', 'cancelled')
        .order('starts_at')
    ),
    supabase
      .from('intake_submissions')
      .select('id, client_id, flags, submitted_at, profiles!intake_submissions_client_id_fkey(first_name, last_name)')
      .is('reviewed_at', null)
      .not('flags', 'eq', '{}')
      .order('submitted_at', { ascending: false })
      .limit(5),
    supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .gte('starts_at', dayStart)
      .lt('starts_at', addDaysToDateKey(todayKey, 7))
      .neq('status', 'cancelled'),
    supabase
      .from('appointments')
      .select('total_cents')
      .eq('status', 'completed')
      .gte('starts_at', new Date(requestNow() - 7 * 86_400_000).toISOString()),
    supabase
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'client')
      .gte('created_at', new Date(requestNow() - 30 * 86_400_000).toISOString()),
  ])

  const revenue = (weekRevenue ?? []).reduce((n, a) => n + a.total_cents, 0)

  return (
    <div>
      <h1 className="display text-3xl">
        Good {greeting()}{profile?.first_name ? `, ${profile.first_name}` : ''}.
      </h1>
      <p className="mt-2 text-sm text-[var(--color-muted)]">
        {new Date().toLocaleDateString('en-US', {
          timeZone: tz,
          weekday: 'long',
          month: 'long',
          day: 'numeric',
        })}
      </p>

      {/* ── Stats ─────────────────────────────────────── */}
      {isManager(role) && (
        <div className="mt-10 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
          <Stat
            icon={<TrendingUp className="h-4 w-4" strokeWidth={1.5} />}
            label="Booked this week"
            value={String(weekCount ?? 0)}
          />
          <Stat
            icon={<DollarSign className="h-4 w-4" strokeWidth={1.5} />}
            label="Revenue, last 7 days"
            value={formatMoney(revenue)}
          />
          <Stat
            icon={<Users className="h-4 w-4" strokeWidth={1.5} />}
            label="New clients, 30 days"
            value={String(newClients ?? 0)}
          />
        </div>
      )}

      {/* ── Flagged intake ────────────────────────────── */}
      {(flaggedIntakes?.length ?? 0) > 0 && (
        <div className="mt-10 border-l-2 border-amber-600 bg-amber-50 p-6 dark:bg-transparent">
          <p className="label-caps mb-4 flex items-center gap-2 text-amber-800 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
            Intake needing review
          </p>
          <ul className="space-y-2.5">
            {(flaggedIntakes ?? []).map((i) => {
              const c = i.profiles as { first_name: string | null; last_name: string | null } | null
              return (
                <li key={i.id} className="text-sm">
                  <Link
                    href={`/dashboard/clients/${i.client_id}`}
                    className="underline underline-offset-4"
                  >
                    {c?.first_name} {c?.last_name}
                  </Link>
                  <span className="ml-2 text-[var(--color-muted)]">
                    {i.flags.join(', ')}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>
      )}

      {/* ── Today's book ──────────────────────────────── */}
      <section className="mt-12">
        <div className="flex items-baseline justify-between gap-4">
          <h2 className="display text-2xl">Today</h2>
          <Link href="/dashboard/calendar" className="label-caps text-[var(--color-muted)]">
            Full calendar →
          </Link>
        </div>

        {(today?.length ?? 0) === 0 ? (
          <p className="mt-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
            Nothing on the book today.
          </p>
        ) : (
          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {(today ?? []).map((a) => {
              const client = a.profiles as {
                first_name: string | null
                last_name: string | null
              } | null
              const name = client
                ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
                : `${a.guest_first_name ?? ''} ${a.guest_last_name ?? ''}`.trim()

              const services = ((a.appointment_services ?? []) as {
                name_snapshot: string
                sort_order: number
              }[])
                .sort((x, y) => x.sort_order - y.sort_order)
                .map((s) => s.name_snapshot)
                .join(' + ')

              return (
                <li key={a.id}>
                  <Link
                    href={`/dashboard/appointments/${a.id}`}
                    className="flex flex-wrap items-baseline gap-x-6 gap-y-2 py-5 transition-colors hover:text-[var(--color-accent)]"
                  >
                    <span className="w-20 shrink-0 tabular-nums">
                      {formatTimeInTimeZone(new Date(a.starts_at), tz)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p>{name || 'Guest'}</p>
                      <p className="mt-0.5 text-sm text-[var(--color-muted)]">{services}</p>
                    </div>
                    <div className="flex items-center gap-3">
                      {a.deposit_cents > 0 && a.deposit_status !== 'paid' && (
                        <Badge tone="warning">Deposit due</Badge>
                      )}
                      {/* A booking nobody has approved is on this list —
                          `pending` holds its slot, so it is genuinely part of
                          today's book — and it used to print the raw enum in
                          the same grey chip as 'confirmed'. Whether the studio
                          has agreed to see this person is the one thing worth
                          reading off a day at a glance, so it gets its own
                          words and the warning tone every other pending
                          surface uses. */}
                      {a.status === 'pending' ? (
                        <Badge tone="warning">Awaiting approval</Badge>
                      ) : (
                        <Badge tone={a.status === 'checked_in' ? 'accent' : 'neutral'}>
                          {a.status.replace('_', ' ')}
                        </Badge>
                      )}
                      <span className="tabular-nums text-sm">{formatMoney(a.total_cents)}</span>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="bg-[var(--color-background)] p-6">
      <p className="label-caps flex items-center gap-2 text-[var(--color-accent)]">
        {icon}
        {label}
      </p>
      <p className="display mt-3 text-3xl tabular-nums">{value}</p>
    </div>
  )
}

function greeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'morning'
  if (hour < 17) return 'afternoon'
  return 'evening'
}
