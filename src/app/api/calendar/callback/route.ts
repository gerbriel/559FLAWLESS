import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { exchangeCode, encryptToken } from '@/lib/google-calendar'
import { isStaff } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Store the calendar grant.
 *
 * Tokens are encrypted here, in the route, and written with the service-role
 * client — nothing reads them back through PostgREST, and RLS on
 * `calendar_connections` does not expose them to the browser either.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl
  const done = (status: string) =>
    NextResponse.redirect(`${origin}/dashboard/schedule?calendar=${status}`)

  if (searchParams.get('error')) return done('denied')

  const code = searchParams.get('code')
  const state = searchParams.get('state')
  if (!code || !state) return done('failed')

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.redirect(`${origin}/login?next=/dashboard/schedule`)

  // `state` came back from Google, so it is attacker-influencable. It must match
  // the signed-in user or this is a grant being planted on someone else's account.
  if (state !== user.id) return done('failed')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || profile.suspended_at || !isStaff(profile.role)) {
    return NextResponse.redirect(`${origin}/account`)
  }

  try {
    const tokens = await exchangeCode(code, origin)
    const admin = createAdminClient()

    // Google withholds the refresh token when a grant already exists. We ask
    // for `prompt=consent` to force one, but keep any stored token if it still
    // does not arrive — overwriting it with null would break sync silently.
    const patch: Record<string, unknown> = {
      provider_id: user.id,
      access_token_enc: encryptToken(tokens.access_token),
      expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString(),
      revoked_at: null,
      last_sync_error: null,
    }
    if (tokens.refresh_token) {
      patch.refresh_token_enc = encryptToken(tokens.refresh_token)
    }

    const { error } = await admin
      .from('calendar_connections')
      .upsert(patch, { onConflict: 'provider_id' })

    if (error) {
      console.error('calendar connection save failed', error)
      return done('failed')
    }

    return done('connected')
  } catch (err) {
    console.error('calendar callback failed', err)
    return done('failed')
  }
}
