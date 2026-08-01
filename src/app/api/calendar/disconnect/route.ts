import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { accessTokenFor } from '@/lib/google-calendar'
import { isStaff } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Disconnect a calendar.
 *
 * Revokes the grant at Google as well as forgetting it here — leaving a live
 * refresh token behind after someone has pressed "disconnect" is not what they
 * asked for. Cached busy time goes too, or slots would stay blocked by a
 * calendar nobody is reading any more.
 */
export async function POST() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || profile.suspended_at || !isStaff(profile.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Best effort — if Google is unreachable we still forget the token locally.
  try {
    const token = await accessTokenFor(user.id)
    if (token) {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${token}`, { method: 'POST' })
    }
  } catch (err) {
    console.error('token revoke failed', err)
  }

  const admin = createAdminClient()
  await admin.from('calendar_busy').delete().eq('provider_id', user.id).eq('source', 'google')
  await admin.from('calendar_connections').delete().eq('provider_id', user.id)

  return NextResponse.json({ ok: true })
}
