import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { connectUrl, calendarSyncConfigured } from '@/lib/google-calendar'
import { isStaff } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Send a staff member to Google to grant calendar access.
 *
 * This is a separate grant from signing in with Google: that one identifies a
 * client, this one hands the studio write access to somebody's calendar. Asking
 * for both at sign-in would mean every client being asked for their calendar.
 */
export async function GET(request: NextRequest) {
  const { origin } = request.nextUrl

  if (!calendarSyncConfigured()) {
    return NextResponse.redirect(`${origin}/dashboard/calendar/hours?calendar=not_configured`)
  }

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.redirect(`${origin}/login?next=/dashboard/calendar/hours`)

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || profile.suspended_at || !isStaff(profile.role)) {
    return NextResponse.redirect(`${origin}/account`)
  }

  // The user id round-trips through Google as `state`, which is also the CSRF
  // guard: the callback checks it against the session rather than trusting it.
  return NextResponse.redirect(connectUrl(origin, user.id))
}
