import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ScheduleEditor } from '@/components/shared/ScheduleEditor'
import { PauseBookings } from '@/components/shared/PauseBookings'
import {
  CalendarConnection,
  type CalendarConnectionState,
} from '@/components/shared/CalendarConnection'
import { Badge } from '@/components/ui/badge'
import { isManager, type UserRole } from '@/types/database'
import { requestNow, dateKeyInTimeZone, DAY_MS } from '@/lib/time'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ calendar?: string; provider?: string }>
}

/**
 * What the Google round trip left behind.
 *
 * Both /api/calendar/connect and /api/calendar/callback come back to this page
 * as `?calendar=<status>`, with exactly these four values. Until the page took
 * `searchParams` the status was delivered and dropped, so a grant that worked
 * looked identical to one that was refused.
 */
const CALENDAR_FEEDBACK: Record<string, { ok: boolean; message: string } | undefined> = {
  connected: {
    ok: true,
    message:
      'Google Calendar is connected — anything already on it now blocks that time from being booked, and your appointments are written back to it.',
  },
  denied: {
    ok: false,
    message:
      'You declined on Google’s screen, so nothing was connected and nothing about your hours changed; you can start again whenever you like.',
  },
  failed: {
    ok: false,
    message:
      'That did not go through and nothing was connected — try again, and if it keeps failing tell the studio owner so she can check the Google credentials.',
  },
  not_configured: {
    ok: false,
    message:
      'Google Calendar is not set up on this site yet — that is a one-time step for the studio owner, not anything you did wrong.',
  },
}

/** Same pill as FilterPills in dashboard-client, but a link — the switch is a navigation. */
const pill = (active: boolean) =>
  `flex min-h-9 items-center gap-1.5 rounded-full border px-4 text-sm transition-colors ${
    active
      ? 'border-[var(--color-foreground)] bg-[var(--color-foreground)] text-[var(--color-background)]'
      : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-foreground)] hover:border-[var(--color-accent)]'
  }`

interface StaffName {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
}

const staffName = (p: StaffName) =>
  p.display_name ?? ([p.first_name, p.last_name].filter(Boolean).join(' ') || 'Unnamed')

export default async function SchedulePage({ searchParams }: Props) {
  const { calendar, provider: providerParam } = await searchParams
  // `calendar` is whatever is in the URL bar, so own-key only — a hand-typed
  // `?calendar=constructor` would otherwise resolve to something truthy and
  // paint an empty strip.
  const calendarFeedback =
    calendar && Object.hasOwn(CALENDAR_FEEDBACK, calendar)
      ? CALENDAR_FEEDBACK[calendar]
      : undefined

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // The viewer comes first: whether `?provider=` is honoured depends on their
  // role, so this read cannot join the parallel batch below.
  const { data: viewer } = await supabase
    .from('profiles')
    .select('role, timezone, accepts_online_booking')
    .eq('id', user.id)
    .maybeSingle()
  const manager = isManager(viewer?.role as UserRole)

  // A manager may open any staff member's hours. This mirrors, not replaces,
  // the real gate: 003's policy on provider_schedules is
  // `provider_id = auth.uid() or is_manager()`, so a non-manager who forges the
  // param gets their own page here and a refusal from the database besides.
  type TargetProfile = StaffName & {
    role: UserRole
    timezone: string
    accepts_online_booking: boolean
  }
  let target: TargetProfile | null = null
  if (manager && providerParam && providerParam !== user.id) {
    const { data } = await supabase
      .from('profiles')
      .select('id, role, timezone, accepts_online_booking, first_name, last_name, display_name')
      .eq('id', providerParam)
      .neq('role', 'client')
      .maybeSingle()
    target = data as TargetProfile | null
  }
  const viewingOther = target !== null
  const otherName = target ? staffName(target) : null
  const providerId = target?.id ?? user.id
  const profile = target
    ? {
        role: target.role,
        timezone: target.timezone,
        accepts_online_booking: target.accepts_online_booking,
      }
    : viewer

  const [
    { data: schedules },
    { data: blocks },
    { data: services },
    { data: connection },
    { count: busyCount },
    { data: staffRows },
  ] = await Promise.all([
    supabase
      .from('provider_schedules')
      .select('id, day_of_week, start_time, end_time, slot_interval_minutes, is_active')
      .eq('provider_id', providerId)
      .order('day_of_week'),
    supabase
      .from('availability_blocks')
      .select('id, block_date, start_time, end_time, reason')
      .eq('provider_id', providerId)
      // Deliberately one day wider than needed. `block_date` is wall-clock in
      // the provider's IANA zone, and that zone is being fetched in this very
      // Promise.all, so it cannot be used here. A UTC key is up to a day ahead
      // of Fresno's — from 5pm PDT it already reads tomorrow, which silently
      // dropped this evening's blocked time off the list. Fetching from
      // yesterday guarantees today is in the set whatever the zone, and the
      // exact cut happens below with dateKeyInTimeZone.
      .gte('block_date', new Date(requestNow() - DAY_MS).toISOString().slice(0, 10))
      .order('block_date'),
    supabase
      .from('provider_services')
      .select('service_id, is_active, services(name)')
      .eq('provider_id', providerId),
    // The Google connection is the signed-in person's own — its tokens are
    // RLS-readable by their owner alone, and it is only rendered on the
    // owner's view below.
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
      .gte('ends_at', new Date(requestNow()).toISOString()),
    manager
      ? supabase
          .from('profiles')
          .select('id, first_name, last_name, display_name')
          .in('role', ['provider', 'front_desk', 'manager', 'admin'])
          .is('suspended_at', null)
          .order('first_name')
      : Promise.resolve({ data: null }),
  ])

  // Bookable is `accepts_online_booking`, not `role` — the same solo-operator
  // point migration 020 made in the database. A studio owner is an admin who
  // also does the treatments, and gating this on role locked her out of her own
  // hours page.
  const keepsCalendar = !!profile && profile.role !== 'client'

  // The accurate cut the query above could not make: today in the provider's own
  // zone, not in UTC.
  const todayKey = dateKeyInTimeZone(
    new Date(requestNow()),
    profile?.timezone ?? 'America/Los_Angeles'
  )
  const upcomingBlocks = (blocks ?? []).filter((b) => b.block_date >= todayKey)

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
  const staff = (staffRows ?? []) as StaffName[]
  const others = staff.filter((p) => p.id !== user.id)

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
        <h1 className="display text-3xl">
          {viewingOther ? `${otherName}’s hours` : 'My hours'}
        </h1>
        <Badge tone={profile.accepts_online_booking ? 'success' : 'warning'}>
          {profile.accepts_online_booking ? 'Bookable online' : 'Not bookable online'}
        </Badge>
      </div>

      {manager && others.length > 0 && (
        <nav aria-label="Whose hours" className="mt-5 flex flex-wrap gap-2">
          <Link href="/dashboard/calendar/hours" className={pill(!viewingOther)}>
            My hours
          </Link>
          {others.map((p) => (
            <Link
              key={p.id}
              href={`/dashboard/calendar/hours?provider=${p.id}`}
              className={pill(p.id === providerId)}
            >
              {staffName(p)}
            </Link>
          ))}
        </nav>
      )}

      <p className="mt-3 text-sm text-[var(--color-muted)]">
        Times are wall-clock in {profile.timezone}. Slots are generated from these hours,
        minus blocks, studio closures, and anything already on{' '}
        {viewingOther ? 'their' : 'your'} calendar.
      </p>

      {viewingOther ? (
        // Changes land on the public booking page immediately — said out loud,
        // because the person whose week is being rearranged is not the one
        // clicking. Bookability itself stays on its own admin screen.
        <p className="mt-6 border-l-2 border-[var(--color-accent)] bg-[var(--color-surface)] p-4 text-sm text-[var(--color-muted)]">
          You are editing {otherName}&rsquo;s hours as a manager. Changes apply to
          the booking page immediately — worth a word with them first.
          {!profile.accepts_online_booking && (
            <>
              {' '}
              They are not on the booking page right now; that switch lives under{' '}
              <Link
                href="/dashboard/settings"
                className="underline underline-offset-4 hover:text-[var(--color-accent)]"
              >
                Settings
              </Link>
              .
            </>
          )}
        </p>
      ) : profile.accepts_online_booking ? (
        // Anyone may take themselves off; only an admin may put someone on.
        // That asymmetry is enforced by migration 045, not just here.
        <PauseBookings providerId={user.id} />
      ) : (
        <p className="mt-6 border-l-2 border-amber-600 bg-amber-50 p-4 text-sm text-[var(--color-muted)] dark:bg-transparent">
          You are not on the booking page, so clients cannot reserve your time. An admin
          can put you on it under Settings → Who the public sees. Your hours below are
          saved either way.
        </p>
      )}

      {!viewingOther && (
        <div className="mt-8">
          {calendarFeedback && (
            <p
              className={
                calendarFeedback.ok
                  ? 'mb-4 border-l-2 border-emerald-600 bg-emerald-50 p-4 text-sm text-[var(--color-muted)] dark:bg-transparent'
                  : 'mb-4 border-l-2 border-amber-600 bg-amber-50 p-4 text-sm text-[var(--color-muted)] dark:bg-transparent'
              }
            >
              {calendarFeedback.message}
            </p>
          )}

          <CalendarConnection
            providerId={user.id}
            connection={(connection ?? null) as CalendarConnectionState | null}
            configured={calendarConfigured}
            busyCount={busyCount ?? 0}
          />
        </div>
      )}

      {activeServices.length === 0 && (
        <p className="mt-6 border-l-2 border-amber-600 bg-amber-50 p-4 text-sm text-[var(--color-muted)] dark:bg-transparent">
          {viewingOther ? `${otherName} has` : 'You have'} no services assigned.
          Clients cannot book {viewingOther ? 'them' : 'you'} until at least one service
          is linked to {viewingOther ? 'their' : 'your'} profile, which a manager does on{' '}
          <Link
            href="/dashboard/settings/team"
            className="underline underline-offset-4 hover:text-[var(--color-accent)]"
          >
            Team
          </Link>
          . {viewingOther ? 'Their' : 'Your'} hours below are savable either way — a
          bookable slot needs both.
        </p>
      )}

      <div className="mt-10">
        <ScheduleEditor
          providerId={providerId}
          schedules={schedules ?? []}
          blocks={upcomingBlocks}
        />
      </div>

      {activeServices.length > 0 && (
        <section className="mt-14">
          <h2 className="label-caps mb-4 text-[var(--color-accent)]">
            Services {viewingOther ? 'they perform' : 'you perform'}
          </h2>
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
