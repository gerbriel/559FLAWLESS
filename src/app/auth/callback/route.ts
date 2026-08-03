import { NextResponse, type NextRequest } from 'next/server'
import { isProfileComplete } from '@/lib/profile'
import { createClient } from '@/lib/supabase/server'
import { isStaff } from '@/types/database'

/**
 * Exchanges the emailed code — or the Google OAuth code — for a session, then
 * routes by role and by whether the account is usable yet.
 *
 * `next` is validated as a same-origin path before use — an open redirect here
 * would let a crafted confirmation link bounce a freshly signed-in user to an
 * attacker's page.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const rawNext = searchParams.get('next')

  // A provider reports a refusal here rather than by failing the exchange.
  const oauthError = searchParams.get('error')
  if (oauthError) {
    console.error('oauth returned an error', oauthError, searchParams.get('error_description'))
    return NextResponse.redirect(`${origin}/login?error=oauth_denied`)
  }

  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : null

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data.user) {
    return NextResponse.redirect(`${origin}/login?error=invalid_code`)
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name, last_name, phone, date_of_birth')
    .eq('id', data.user.id)
    .maybeSingle()

  if (isStaff(profile?.role)) {
    return NextResponse.redirect(`${origin}${next ?? '/dashboard'}`)
  }

  // Google gives a name and an email but never a phone number or a date of
  // birth, and a booking needs both. Collect them here rather than discovering
  // the gap at the point of booking — `next` is preserved, so someone who came
  // from a half-finished booking is returned to it afterwards.
  if (!isProfileComplete(profile)) {
    const complete = new URL('/account/complete', origin)
    if (next) complete.searchParams.set('next', next)
    return NextResponse.redirect(complete)
  }

  return NextResponse.redirect(`${origin}${next ?? '/account'}`)
}
