import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ScheduleEditor } from '@/components/shared/ScheduleEditor'
import { Badge } from '@/components/ui/badge'

export const dynamic = 'force-dynamic'

export default async function SchedulePage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: profile }, { data: schedules }, { data: blocks }, { data: services }] =
    await Promise.all([
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
    ])

  if (profile?.role !== 'provider') {
    return (
      <div>
        <h1 className="display text-3xl">My hours</h1>
        <p className="mt-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          Only providers keep a bookable calendar. Studio-wide closures and booking
          policy live under Settings.
        </p>
      </div>
    )
  }

  const activeServices = (services ?? []).filter((s) => s.is_active)

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
