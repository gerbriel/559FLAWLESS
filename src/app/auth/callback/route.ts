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
  // The other way in. `exchangeCodeForSession` is the PKCE half and needs a
  // verifier this browser only has if it started the flow here. A link the
  // studio generated with the admin API and handed over in person has no
  // verifier and never will, so it arrives as a one-time token to be redeemed
  // instead. Without this branch those links reach this route and are turned
  // away for a missing code, which is the whole of "the sign-in link does not
  // work".
  const tokenHash = searchParams.get('token_hash')
  const otpType = searchParams.get('type')

  // A provider reports a refusal here rather than by failing the exchange.
  const oauthError = searchParams.get('error')
  if (oauthError) {
    console.error('oauth returned an error', oauthError, searchParams.get('error_description'))
    return NextResponse.redirect(`${origin}/login?error=oauth_denied`)
  }

  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : null

  if (!code && !tokenHash) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const supabase = await createClient()

  // Only the types this app actually issues. An open `type` would let a crafted
  // link redeem a token of a kind nobody here mints.
  const ALLOWED_OTP = ['magiclink', 'recovery', 'invite', 'email'] as const
  type AllowedOtp = (typeof ALLOWED_OTP)[number]

  const { data, error } =
    tokenHash && otpType && (ALLOWED_OTP as readonly string[]).includes(otpType)
      ? await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: otpType as AllowedOtp,
        })
      : code
        ? await supabase.auth.exchangeCodeForSession(code)
        : { data: { user: null }, error: new Error('unsupported link') }

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
