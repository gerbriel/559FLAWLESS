import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { isFrontDesk } from '@/types/database'

export const dynamic = 'force-dynamic'

const RevokeSchema = z.object({ id: z.number().int().positive() })

/**
 * Withdraw an invitation that has not been used.
 *
 * Runs as the caller, so the "revoke an invitation" policy from 031 is what
 * decides: an admin may revoke anything unaccepted, front desk may revoke a
 * client invitation, and nobody may revoke one that has already been accepted —
 * that row is a record of what happened.
 *
 * Front desk is deliberately shut out of staff invitations here as well as at
 * insert. Revocation on its own is harmless, but paired with "invite again" it
 * would let a non-admin rotate a pending admin link into one they hold.
 *
 * Rows are never deleted. An invitation that was sent is a fact about who was
 * offered what.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: staff } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!staff || staff.suspended_at || !isFrontDesk(staff.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsed = RevokeSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  const { data: updated, error } = await supabase
    .from('invitations')
    .update({ revoked_at: new Date().toISOString(), revoked_by: user.id })
    .eq('id', parsed.data.id)
    .is('accepted_at', null)
    .is('revoked_at', null)
    .select('id')

  if (error) {
    console.error('invitation revoke failed', error)
    return NextResponse.json(
      { error: 'revoke_failed', message: error.message },
      { status: 400 }
    )
  }

  // RLS filters rather than errors, so an empty result is the answer to both
  // "already gone" and "not yours to revoke".
  if (!updated || updated.length === 0) {
    return NextResponse.json(
      {
        error: 'not_revocable',
        message: 'That invitation has already been used or is not yours to revoke.',
      },
      { status: 404 }
    )
  }

  return NextResponse.json({ ok: true })
}
