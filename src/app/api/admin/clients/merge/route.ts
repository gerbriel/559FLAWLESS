import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAdmin } from '@/types/database'

export const dynamic = 'force-dynamic'

const MergeSchema = z.object({
  survivorId: z.string().uuid(),
  loserId: z.string().uuid(),
  reason: z.string().trim().max(500).nullish(),
})

/**
 * Fold a duplicate client account into the real one.
 *
 * The work happens in merge_client_accounts (074), called with the CALLER'S
 * session — SECURITY DEFINER gives the function its reach, auth.uid() keeps
 * the admin on the audit trail, and the privilege trigger on profiles sees an
 * admin when the tombstone is written. The one thing SQL cannot do is revoke
 * the losing login, so the service role bans it here afterwards; if that step
 * fails, the account is already suspended and pointed at its survivor, which
 * is the part that matters.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: me } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  // The function refuses non-admins too; this exists to answer in words.
  if (!me || me.suspended_at || !isAdmin(me.role)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'Only an admin can merge accounts.' },
      { status: 403 }
    )
  }

  const parsed = MergeSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  const { survivorId, loserId, reason } = parsed.data

  const { data, error } = await supabase.rpc('merge_client_accounts', {
    p_loser: loserId,
    p_survivor: survivorId,
    p_reason: reason ?? null,
  })

  if (error) {
    // 42883: the function does not exist — migration 074 has not been applied.
    const message =
      error.code === '42883'
        ? 'The merge function is not installed yet — apply migration 074 in the Supabase SQL editor first.'
        : error.message
    return NextResponse.json({ error: 'merge_failed', message }, { status: 400 })
  }

  // Revoke the losing login. Best-effort: the profile is already suspended and
  // tombstoned by the function, so a failure here costs nothing irreversible.
  try {
    await createAdminClient().auth.admin.updateUserById(loserId, {
      ban_duration: '876000h',
    })
  } catch (err) {
    console.error('merge: could not ban the losing login', err, { loserId })
  }

  return NextResponse.json({ ok: true, result: data })
}
