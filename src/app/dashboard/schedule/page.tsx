import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ScheduleEditor } from '@/components/shared/ScheduleEditor'
import {
  CalendarConnection,
  type CalendarConnectionState,
} from '@/components/shared/CalendarConnection'
import { Badge } from '@/components/ui/badge'

export const dynamic = 'force-dynamic'

export default async function SchedulePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [
    { data: profile },
    { data: schedules },
    { data: blocks },
    { data: services },
    { data: connection },
    { count: busyCount },
  ] = await Promise.all([
      supabase
        .from('profiles')
        .select('role, timezone, accepts_online_booking')
        .eq('id', user.id)
        .maybeSingle(),
      supabase
        .from('provider_schedules')
        .select('id, day_of_week, start_time, end_time, slot_interval_minutes, is_active')
        .eq('provider_id', user.id)
        .order('day_of_week'),
      supabase
        .from('availability_blocks')
        .select('id, block_date, start_time, end_time, reason')
        .eq('provider_id', user.id)
        .gte('block_date', new Date().toISOString().slice(0, 10))
        .order('block_date'),
      supabase
        .from('provider_services')
        .select('service_id, is_active, services(name)')
        .eq('provider_id', user.id),
      supabase
        .from('calendar_connections')
        .select(
          'google_email, calendar_id, last_synced_at, last_sync_error, revoked_at, push_appointments, pull_busy'
        )
        .eq('provider_id', user.id)
        .maybeSingle(),
      supabase
        .from('calendar_busy')
        .select('id', { count: 'exact', head: true })
        .eq('provider_id', user.id)
        .gte('ends_at', new Date().toISOString()),
    ])

  // Bookable is `accepts_online_booking`, not `role` — the same solo-operator
  // point migration 020 made in the database. A studio owner is an admin who
  // also does the treatments, and gating this on role locked her out of her own
  // hours page.
  const keepsCalendar = !!profile && profile.role !== 'client'

  if (!keepsCalendar) {
    return (
      <div>
        <h1 className="display text-3xl">My hours</h1>
        <p className="mt-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          Only staff who treat clients keep a bookable calendar. Studio-wide closures
          and booking policy live under Settings.
        </p>
      </div>
    )
  }

  const activeServices = (services ?? []).filter((s) => s.is_active)

  // Whether this deployment has calendar credentials at all. Checked here so
  // the client component learns only the boolean, never the variable names.
  const calendarConfigured = !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.CALENDAR_TOKEN_KEY
  )

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="display text-3xl">My hours</h1>
        <Badge tone={profile.accepts_online_booking ? 'success' : 'warning'}>
          {profile.accepts_online_booking ? 'Bookable online' : 'Not bookable online'}
        </Badge>
      </div>

      <p className="mt-3 text-sm text-[var(--color-muted)]">
        Times are wall-clock in {profile.timezone}. Slots are generated from these hours,
        minus blocks, studio closures, and anything already on your calendar.
      </p>

      {!profile.accepts_online_booking && (
        <p className="mt-6 border-l-2 border-amber-600 bg-amber-50 p-4 text-sm text-[var(--color-muted)] dark:bg-transparent">
          Your calendar will not appear on the booking page until an admin marks you as
          accepting online bookings.
        </p>
      )}

      <div className="mt-8">
        <CalendarConnection
          providerId={user.id}
          connection={(connection ?? null) as CalendarConnectionState | null}
          configured={calendarConfigured}
          busyCount={busyCount ?? 0}
        />
      </div>

      {activeServices.length === 0 && (
        <p className="mt-6 border-l-2 border-amber-600 bg-amber-50 p-4 text-sm text-[var(--color-muted)] dark:bg-transparent">
          You have no services assigned. Clients cannot book you until an admin links at
          least one service to your profile.
        </p>
      )}

      <div className="mt-10">
        <ScheduleEditor
          providerId={user.id}
          schedules={schedules ?? []}
          blocks={blocks ?? []}
        />
      </div>

      {activeServices.length > 0 && (
        <section className="mt-14">
          <h2 className="label-caps mb-4 text-[var(--color-accent)]">Services you perform</h2>
          <ul className="flex flex-wrap gap-2">
            {activeServices.map((s) => (
              <li key={s.service_id}>
                <Badge tone="neutral">
                  {(s.services as { name: string } | null)?.name ?? `#${s.service_id}`}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
