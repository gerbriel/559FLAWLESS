import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isStaff } from '@/types/database'

/**
 * Exchanges the emailed code for a session, then routes by role.
 *
 * `next` is validated as a same-origin path before use — an open redirect here
 * would let a crafted confirmation link bounce a freshly signed-in user to an
 * attacker's page.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const code = searchParams.get('code')
  const rawNext = searchParams.get('next')

  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : null

  if (!code) {
    return NextResponse.redirect(`${origin}/login?error=missing_code`)
  }

  const supabase = await createClient()
  const { data, error } = await supabase.auth.exchangeCodeForSession(code)

  if (error || !data.user) {
    return NextResponse.redirect(`${origin}/login?error=invalid_code`)
  }

  if (next) return NextResponse.redirect(`${origin}${next}`)

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', data.user.id)
    .maybeSingle()

  return NextResponse.redirect(`${origin}${isStaff(profile?.role) ? '/dashboard' : '/account'}`)
}
