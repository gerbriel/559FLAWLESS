import { cookies } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CalendarClient } from '@/components/shared/CalendarClient'
import { addDaysToDateKey, dateKeyInTimeZone, requestNow, zonedTimeToUtc } from '@/lib/time'
import { isFrontDesk, isManager, type UserRole } from '@/types/database'
import type { CalendarView } from '@/components/shared/CalendarView'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

/**
 * Whose book the diary was last left showing.
 *
 * A cookie rather than localStorage, for the same reason the sidebar's width is
 * one (see `NAV_COOKIE` in `DashboardNav`): this decides what is drawn on the
 * *first* paint. Read localStorage during render and the server and the browser
 * disagree; read it in an effect and you are calling setState from an effect,
 * which this repo's React Compiler lint rejects — and either way the whole
 * studio's week flashes up before collapsing to one person's.
 *
 * The value is `<whose preference this is>:<all | comma-separated profile ids>`.
 *
 * The owner's id is the first half because a cookie belongs to a BROWSER and a
 * preference belongs to a PERSON, and a single-room studio shares machines. Left
 * unstamped, the front-desk hire signs in at the shared iPad and opens on
 * whoever used it last — and a provider, who has no staff control to undo it
 * with (see `seesWholeStudio`), opens on a colleague's id, which their own query
 * can never return, and so on a permanently empty week for as long as the cookie
 * lives. Stamped, a value written under another account simply isn't this
 * person's preference and is ignored.
 *
 * The id half is validated against the staff list below before it is believed:
 * a cookie naming somebody who has since left would otherwise filter every
 * appointment away and leave a calendar that looks broken, which is the exact
 * failure this whole change is about. The name is repeated in `CalendarClient`,
 * which is what writes it — a `'use client'` module's exports are client
 * references on the server, so this string cannot be imported from there.
 */
const STAFF_COOKIE = 'dash_cal_staff'

interface Props {
  searchParams: Promise<{ from?: string; view?: string }>
}

export default async function CalendarPage({ searchParams }: Props) {
  const { from, view: viewParam } = await searchParams

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

  // requestNow() rather than a bare Date.now(): one named seam for the clock,
  // and it keeps React's purity lint honest about a Server Component.
  const todayKey = dateKeyInTimeZone(new Date(requestNow()), tz)
  const startKey = /^\d{4}-\d{2}-\d{2}$/.test(from ?? '') ? from! : todayKey
  
  // Determine view and date range
  const view = (viewParam === 'day' || viewParam === 'week' || viewParam === 'month') 
    ? viewParam as CalendarView 
    : 'week'

  // Calculate date range based on view
  let endKey: string
  if (view === 'day') {
    endKey = addDaysToDateKey(startKey, 1)
  } else if (view === 'week') {
    endKey = addDaysToDateKey(startKey, 7)
  } else {
    // Month view - fetch entire month plus a week on each side
    const [year, month] = startKey.split('-').map(Number)
    const firstDay = `${year}-${String(month).padStart(2, '0')}-01`
    const nextMonth = month === 12 ? 1 : month + 1
    const nextYear = month === 12 ? year + 1 : year
    const lastDay = `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`
    
    endKey = addDaysToDateKey(lastDay, 7)
  }

  // Fetch appointments for the calculated range
  let appointmentsQuery = supabase
    .from('appointments')
    .select(
      'id, starts_at, ends_at, status, total_cents, deposit_cents, provider_id, client_id, client_notes, staff_notes, guest_first_name, guest_last_name, guest_email, guest_phone, client:profiles!appointments_client_id_fkey(first_name, last_name, email, phone), provider:profiles!appointments_provider_id_fkey(first_name, last_name, display_name), appointment_services(name_snapshot, price_cents, duration_minutes, sort_order)'
    )
    .gte('starts_at', zonedTimeToUtc(startKey, '00:00', tz).toISOString())
    .lt('starts_at', zonedTimeToUtc(endKey, '00:00', tz).toISOString())
    .neq('status', 'cancelled')
    .order('starts_at')

  /**
   * Whether this viewer's diary is the studio's or only their own.
   *
   * One boolean, named once, because it has to decide two things that must not
   * drift apart: which appointments are fetched, and whether the toolbar offers
   * a staff filter at all. A provider is sent their own bookings and nobody
   * else's — so a "Show everyone" control on their screen would clear the
   * filter, redraw the identical week, and label it "All staff". The filter can
   * only be offered where there is something else to filter to.
   */
  const seesWholeStudio = isFrontDesk(role)

  // Providers see their own appointments only
  if (!seesWholeStudio) {
    appointmentsQuery = appointmentsQuery.eq('provider_id', user.id)
  }

  const { data: appointments } = await appointmentsQuery

  // Fetch all active providers for filtering
  const { data: providers } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, display_name')
    .in('role', ['provider', 'front_desk', 'manager', 'admin'])
    .is('suspended_at', null)
    .order('display_name')

  // Everything that makes a time unbookable, so the calendar can SHOW it rather
  // than just silently omitting the slot. Working hours are included because
  // "why is nothing bookable on Sunday" should be answerable by looking.
  const rangeStart = zonedTimeToUtc(startKey, '00:00', tz).toISOString()
  const rangeEnd = zonedTimeToUtc(endKey, '00:00', tz).toISOString()

  const [{ data: schedules }, { data: blocks }, { data: busy }, { data: closures }] =
    await Promise.all([
      supabase
        .from('provider_schedules')
        .select('provider_id, day_of_week, start_time, end_time, is_active')
        .eq('is_active', true),
      supabase
        .from('availability_blocks')
        .select('id, provider_id, block_date, start_time, end_time, reason')
        .gte('block_date', startKey)
        .lt('block_date', endKey),
      supabase
        .from('calendar_busy')
        .select('id, provider_id, starts_at, ends_at, summary')
        .lt('starts_at', rangeEnd)
        .gt('ends_at', rangeStart),
      supabase
        .from('closures')
        .select('closure_date, reason')
        .gte('closure_date', startKey)
        .lt('closure_date', endKey),
    ])

  // ── Whose book does this person open on? ─────────────────────────────────
  //
  // Everyone used to open on the whole studio, which is the wrong answer for
  // the person who actually works the room: her own day is what she came to
  // look at, and it was three taps down a filter menu.
  //
  // But "just me" is only right for somebody who *has* a me. A front-desk hire
  // has no diary of their own, so defaulting them to themselves would open an
  // empty week that reads as a bug rather than as a filter.
  //
  // `accepts_online_booking` is not the test. It answers a different question —
  // whether the public booking page offers this person's time (020, 045) — and
  // an admin may switch someone off it while their diary stays full for weeks.
  // Two facts that survive that:
  //
  //   role === 'provider'  The role whose entire remit is "own calendar and
  //                        hours, treat clients". True on day one, before any
  //                        service is attached or any appointment is booked,
  //                        which is what keeps a brand-new provider off the
  //                        studio-wide view.
  //   evidence             For every other staff role — the solo owner who is
  //                        an admin and also does the treatments (020), a
  //                        manager who still takes clients — the data says it:
  //                        a live row in `provider_services` (the studio has
  //                        declared they perform something), or any appointment
  //                        ever booked against them as provider_id.
  //
  // Front desk with neither falls through to the studio's book, which is the
  // right screen for the job. The probe is skipped entirely for `provider`,
  // where the role has already answered.
  //
  // Only asked where the answer is used at all: somebody who is sent nothing
  // but their own book is pinned to it below whatever the probe would have said.
  let opensOnOwnBook = role === 'provider'
  if (seesWholeStudio && !opensOnOwnBook) {
    const [{ count: offeredServices }, { count: everTreated }] = await Promise.all([
      supabase
        .from('provider_services')
        .select('provider_id', { count: 'exact', head: true })
        .eq('provider_id', user.id)
        .eq('is_active', true),
      supabase
        .from('appointments')
        .select('id', { count: 'exact', head: true })
        .eq('provider_id', user.id),
    ])
    opensOnOwnBook = (offeredServices ?? 0) > 0 || (everTreated ?? 0) > 0
  }

  // A remembered choice wins over the computed one — someone who runs the floor
  // and always wants Everyone should not have to say so every morning. Ids that
  // no longer name visible staff are dropped, and a cookie that survives only
  // dead ids falls back to the default rather than to an empty calendar.
  //
  // Believed only if it was written by THIS account. See STAFF_COOKIE: the
  // cookie is per browser and the studio shares them.
  const savedCookie = (await cookies()).get(STAFF_COOKIE)?.value ?? ''
  const stamp = savedCookie.indexOf(':')
  const savedStaff =
    stamp !== -1 && savedCookie.slice(0, stamp) === user.id
      ? savedCookie.slice(stamp + 1)
      : undefined

  const staffIds = new Set((providers || []).map((p) => p.id))
  const savedSelection = savedStaff
    ? savedStaff.split(',').filter((id) => staffIds.has(id))
    : []

  // Empty is the filter's existing meaning of "everyone", which is why `all` is
  // spelled out in the cookie: an empty string could not say it.
  //
  // Somebody who is only ever sent their own book is pinned to it rather than
  // consulted: the toolbar hides the staff control for them, so any other value
  // here would be one they could not see the cause of or undo. It is also the
  // value that makes their own working hours the ones shaded on the grid —
  // `focusProvider` / `shadingFor` key off a selection of exactly one.
  const initialProviders = !seesWholeStudio
    ? [user.id]
    : savedStaff === 'all'
      ? []
      : savedSelection.length > 0
        ? savedSelection
        : opensOnOwnBook
          ? [user.id]
          : []

  // Format appointments data for the client component
  const formattedAppointments = (appointments || []).map(appt => ({
    ...appt,
    profiles: appt.client || null,
    provider: appt.provider || null,
  })) as any

  return (
    // No *visible* heading: the section tab bar directly above already says
    // "Calendar", and unlike My hours / Timesheets there is no badge or scope
    // label to hang one off. The heading still exists for the document outline —
    // CalendarClient renders no heading of its own, and the tab bar is a <nav>,
    // so without this the diary would be the one dashboard page with none.
    //
    // The mt-10 collapses with the layout's own wrapper margin rather than
    // adding to it — the gap is 40px either way, matching the sibling tabs.
    // Kept only so this page reads the same as its siblings in isolation.
    <div className="mt-10">
      <h1 className="sr-only">Calendar</h1>

      <CalendarClient
        initialAppointments={formattedAppointments}
        providers={(providers || []) as any}
        timezone={tz}
        schedules={schedules ?? []}
        blocks={blocks ?? []}
        busy={busy ?? []}
        closures={closures ?? []}
        initialDate={startKey}
        initialView={view}
        // Read once, here, through requestNow(). The grids used to each call
        // `new Date()` during their own render, which the browser repeats on
        // hydration — two clocks for one question, and a mismatch every time a
        // request and its hydration land either side of midnight in the
        // studio's zone. The current-time line keeps its own ticking clock;
        // this is the day the page was drawn for.
        todayKey={todayKey}
        // The diary opens on this person's own book where they have one — see
        // the block above for who does. Deliberately NOT also narrowed in the
        // query: the appointments fetched are the whole range this viewer is
        // allowed to see, and the filter stays a client-side one. Narrowing the
        // query would save a handful of rows in a single-room studio and cost a
        // round trip every time somebody switched back to Everyone, which is
        // instant today. The provider branch above already narrows by identity
        // for anyone below front desk, so nobody is fetching rows they may not
        // read either way.
        viewerId={user.id}
        initialProviders={initialProviders}
        canSeeOtherBooks={seesWholeStudio}
        // Where the toolbar's gear goes. The studio's scheduling rules are
        // manager-and-above and bounce anyone below to the Settings index, so
        // everyone else gets the one scheduling page they can always open:
        // their own hours, the tab next door.
        settingsHref={
          isManager(role) ? '/dashboard/settings/scheduling' : '/dashboard/calendar/hours'
        }
        // The same gate /dashboard/appointments/book-for-client enforces on the
        // server. The diary is visible to every staff member, but only front
        // desk and above may book on someone else's behalf — so for a provider
        // an empty slot is inert rather than a one-way trip to /dashboard.
        //
        // Same gate as `seesWholeStudio` today, and still a separate prop: one
        // is about writing to somebody else's book, the other about reading it.
        // Should either ever move, the calendar should not have to guess which.
        canBookForClients={isFrontDesk(role)}
      />
    </div>
  )
}
