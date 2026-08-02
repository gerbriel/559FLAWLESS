import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

/**
 * Timesheets moved to /dashboard/calendar/timesheets.
 *
 * This stub is not optional and is not just for bookmarks. `send_time_clock_reminders()`
 * (migration 035) writes '/dashboard/timesheets?remind=' || kind straight into
 * `notifications.link`, NotificationBell renders that column verbatim, and rows
 * already in the database cannot be rewritten from application code. Every
 * clock-in and clock-out reminder ever sent lands here, and keeps landing here
 * until a migration changes what that function emits.
 *
 * So the query string is carried through intact: `remind` is what draws the
 * banner on the other side, and from/to/staff/location are what a shared filter
 * link is for.
 */
export default async function TimesheetsMoved({ searchParams }: Props) {
  const params = await searchParams

  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) for (const v of value) query.append(key, v)
    else if (value !== undefined) query.append(key, value)
  }

  const qs = query.toString()
  redirect(qs ? `/dashboard/calendar/timesheets?${qs}` : '/dashboard/calendar/timesheets')
}
