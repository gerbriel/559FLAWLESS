import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
  formatTimeInTimeZone,
  zonedTimeToUtc,
} from '@/lib/time'
import { isFrontDesk, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

interface Props {
  searchParams: Promise<{ from?: string }>
}

export default async function CalendarPage({ searchParams }: Props) {
  const { from } = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, timezone')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'provider') as UserRole
  const tz = profile?.timezone || STUDIO_TZ

  const todayKey = dateKeyInTimeZone(new Date(), tz)
  const startKey = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from! : todayKey
  const endKey = addDaysToDateKey(startKey, 7)

  let query = supabase
    .from('appointments')
    .select(
      'id, starts_at, ends_at, status, total_cents, guest_first_name, guest_last_name, profiles!appointments_client_id_fkey(first_name, last_name), appointment_services(name_snapshot, sort_order)'
    )
    .gte('starts_at', zonedTimeToUtc(startKey, '00:00', tz).toISOString())
    .lt('starts_at', zonedTimeToUtc(endKey, '00:00', tz).toISOString())
    .neq('status', 'cancelled')
    .order('starts_at')

  // Providers see their own book only.
  if (!isFrontDesk(role)) query = query.eq('provider_id', user.id)

  const { data: appointments } = await query

  const days = Array.from({ length: 7 }, (_, i) => addDaysToDateKey(startKey, i))

  const byDay = new Map<string, NonNullable<typeof appointments>>()
  for (const a of appointments ?? []) {
    const key = dateKeyInTimeZone(new Date(a.starts_at), tz)
    byDay.set(key, [...(byDay.get(key) ?? []), a])
  }

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="display text-3xl">Calendar</h1>
        <div className="flex items-center gap-3">
          <Link
            href={`/dashboard/calendar?from=${addDaysToDateKey(startKey, -7)}`}
            className="label-caps flex items-center gap-1.5 border border-[var(--color-border)] px-4 py-2 hover:border-[var(--color-accent)]"
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
            Prev
          </Link>
          <Link
            href="/dashboard/calendar"
            className="label-caps border border-[var(--color-border)] px-4 py-2 hover:border-[var(--color-accent)]"
          >
            Today
          </Link>
          <Link
            href={`/dashboard/calendar?from=${addDaysToDateKey(startKey, 7)}`}
            className="label-caps flex items-center gap-1.5 border border-[var(--color-border)] px-4 py-2 hover:border-[var(--color-accent)]"
          >
            Next
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
          </Link>
        </div>
      </div>

      <div className="mt-10 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] md:grid-cols-2 xl:grid-cols-7">
        {days.map((key) => {
          const list = byDay.get(key) ?? []
          const [y, m, d] = key.split('-').map(Number)
          const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay()
          const isToday = key === todayKey

          return (
            <div
              key={key}
              className="min-h-48 bg-[var(--color-background)] p-3"
            >
              <p
                className={`label-caps mb-3 flex items-baseline justify-between ${
                  isToday ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'
                }`}
              >
                <span>{DAY_NAMES[dow]}</span>
                <span className="text-sm tracking-normal">{d}</span>
              </p>

              {list.length === 0 ? (
                <p className="text-xs text-[var(--color-muted)]">—</p>
              ) : (
                <ul className="space-y-2">
                  {list.map((a) => {
                    const client = a.profiles as {
                      first_name: string | null
                      last_name: string | null
                    } | null
                    const name = client
                      ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
                      : `${a.guest_first_name ?? ''} ${a.guest_last_name ?? ''}`.trim()
                    const service = ((a.appointment_services ?? []) as {
                      name_snapshot: string
                      sort_order: number
                    }[])
                      .sort((x, z) => x.sort_order - z.sort_order)[0]?.name_snapshot

                    return (
                      <li key={a.id}>
                        <Link
                          href={`/dashboard/appointments/${a.id}`}
                          className="block border-l-2 border-[var(--color-accent)] bg-[var(--color-linen)] p-2 text-xs transition-colors hover:bg-[var(--color-clay-soft)] dark:bg-[var(--color-surface)]"
                        >
                          <span className="block tabular-nums">
                            {formatTimeInTimeZone(new Date(a.starts_at), tz)}
                          </span>
                          <span className="mt-0.5 block truncate">{name || 'Guest'}</span>
                          <span className="mt-0.5 block truncate text-[var(--color-muted)]">
                            {service}
                          </span>
                        </Link>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )
        })}
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-6 text-sm text-[var(--color-muted)]">
        <span>{appointments?.length ?? 0} appointments this week</span>
        <span className="tabular-nums">
          {formatMoney((appointments ?? []).reduce((n, a) => n + a.total_cents, 0))} booked
        </span>
        <Badge tone="neutral">Times in {tz.split('/')[1]?.replace('_', ' ')}</Badge>
      </div>
    </div>
  )
}
