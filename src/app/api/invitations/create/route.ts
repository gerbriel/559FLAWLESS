import { createHash, randomBytes } from 'node:crypto'
import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { isAdmin, isFrontDesk } from '@/types/database'

export const dynamic = 'force-dynamic'

const InviteSchema = z.object({
  email: z.string().trim().email().max(254),
  first_name: z.string().trim().max(80).nullish(),
  last_name: z.string().trim().max(80).nullish(),
  note: z.string().trim().max(500).nullish(),
  role: z.enum(['client', 'provider', 'front_desk', 'manager', 'admin']),
  // Bounded again by the invitations_expiry_bounded check constraint.
  expires_in_days: z.number().int().min(1).max(30).default(7),
})

/**
 * Send an invitation.
 *
 * Deliberately uses the caller's own Supabase client, not `createAdminClient()`.
 * The insert is subject to RLS, so the "front desk may invite clients, only an
 * admin may invite staff" rule is decided by the database on the way in — and
 * the trigger in 031 decides it a second time against the stored role of
 * `invited_by`, which is what makes the rule hold even for a service-role
 * caller. The checks below exist to return a readable 403 instead of an opaque
 * RLS rejection, not to be the boundary.
 *
 * There is no email provider wired into this app, so nothing is sent. The
 * response carries the one and only copy of the link; the studio passes it on
 * themselves. See the note in `InviteManager`.
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

  const parsed = InviteSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: 'Please check the details and try again.' },
      { status: 400 }
    )
  }

  const body = parsed.data
  const email = body.email.toLowerCase()

  if (body.role !== 'client' && !isAdmin(staff.role)) {
    return NextResponse.json(
      { error: 'forbidden', message: 'Only an admin can invite a staff member.' },
      { status: 403 }
    )
  }

  // A nicer answer than the trigger's, for the common case of inviting someone
  // who is already here. The trigger still refuses it if this check races.
  const { data: existing } = await supabase
    .from('profiles')
    .select('id, first_name, last_name')
    .ilike('email', email)
    .maybeSingle()

  if (existing) {
    const name = `${existing.first_name ?? ''} ${existing.last_name ?? ''}`.trim()
    return NextResponse.json(
      {
        error: 'already_exists',
        message: `${name || 'Someone'} already has an account with that email. Change their role from the list below instead.`,
      },
      { status: 409 }
    )
  }

  // 32 bytes = 256 bits of entropy. Only the SHA-256 reaches the database, so
  // this string exists here, in the response, and nowhere else — which is why
  // "send a new link" issues a fresh invitation rather than re-showing this one.
  const token = randomBytes(32).toString('base64url')
  const tokenHash = createHash('sha256').update(token).digest('hex')

  const expiresAt = new Date(Date.now() + body.expires_in_days * 86_400_000).toISOString()

  const { data: invitation, error } = await supabase
    .from('invitations')
    .insert({
      email,
      first_name: body.first_name || null,
      last_name: body.last_name || null,
      note: body.note || null,
      role: body.role,
      invited_by: user.id,
      token_hash: tokenHash,
      expires_at: expiresAt,
    })
    .select('id, email, first_name, last_name, note, role, expires_at, created_at')
    .single()

  if (error || !invitation) {
    // The guards in 031 raise messages written to be read by a person, so pass
    // them through rather than replacing them with something vaguer.
    const message =
      error?.code === '42501'
        ? 'You are not allowed to invite someone at that role.'
        : (error?.message ?? 'Could not create that invitation.')
    console.error('invitation create failed', error)
    return NextResponse.json({ error: 'create_failed', message }, { status: 400 })
  }

  const origin = process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin
  const url = `${origin.replace(/\/$/, '')}/invite/${token}`

  return NextResponse.json({ ok: true, invitation, url }, { status: 201 })
}
