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
  /**
   * Added in 051: the `client_stubs` row this invitation is for, when the
   * person being invited is already on the studio's list. Absent for every
   * other invitation, which is why nothing about the staff path below changes.
   */
  client_stub_id: z.number().int().positive().nullish(),
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
 *
 * `client_stub_id` (051) is the only addition since: an invitation may name
 * somebody already on the studio's list, and accepting it claims that record
 * rather than creating a second one for the same person. Omit it and this
 * route behaves exactly as it did — the staff invitation path runs through the
 * same lines it always has.
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

  // ── Inviting somebody the studio already has on its list ────────────────
  //
  // Read as the caller, so the staff-read policy on `client_stubs` (051) is
  // what decides whether this row is theirs to see. Everything below is about
  // giving a readable answer before the database gives an opaque one; the
  // check constraint added in 053 refuses a non-client stub invitation
  // whatever this route believes.
  let stub: {
    id: number
    first_name: string
    last_name: string | null
    email: string | null
    claimed_by: string | null
  } | null = null

  if (body.client_stub_id) {
    if (body.role !== 'client') {
      return NextResponse.json(
        {
          error: 'invalid_request',
          message: 'Someone on the client list can only be invited as a client.',
        },
        { status: 400 }
      )
    }

    const { data: found } = await supabase
      .from('client_stubs')
      .select('id, first_name, last_name, email, claimed_by')
      .eq('id', body.client_stub_id)
      .maybeSingle()

    if (!found) {
      return NextResponse.json(
        { error: 'not_found', message: 'That client is no longer on the list.' },
        { status: 404 }
      )
    }

    if (found.claimed_by) {
      return NextResponse.json(
        {
          error: 'already_claimed',
          message: `${found.first_name} has already set up an account. Open their record instead.`,
        },
        { status: 409 }
      )
    }

    stub = found
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
    // Two different situations wearing the same 409. From User Management the
    // answer is "change their role"; from somebody's record on the client list
    // it is "this is them, they are already here" — and the id goes back with
    // it so the screen can offer the way there.
    return NextResponse.json(
      {
        error: 'already_exists',
        clientId: existing.id,
        message: stub
          ? `${name || 'Someone'} already has an account with that email. Open their client record instead — this list is for people who have none.`
          : `${name || 'Someone'} already has an account with that email. Change their role from the list below instead.`,
      },
      { status: 409 }
    )
  }

  // Often the studio is typing this address in for the first time — the whole
  // reason the person is a stub is that nobody ever asked them for one. Keep
  // it, so the list stops being a list of people nobody can reach, and keep it
  // before the invitation exists: if the address turns out to belong to
  // somebody else the dedupe trigger from 051 refuses here, with a sentence
  // written to be read by a person.
  if (stub && (stub.email ?? '').trim().toLowerCase() !== email) {
    const { error: stubEmailError } = await supabase
      .from('client_stubs')
      .update({ email })
      .eq('id', stub.id)

    if (stubEmailError) {
      console.error('invitation create: could not save the stub email', stubEmailError)
      return NextResponse.json(
        { error: 'stub_email_failed', message: stubEmailError.message },
        { status: 409 }
      )
    }
  }

  // Two live links for one person is the duplicate this whole feature exists to
  // avoid, and 031's "one live invitation per email" cannot see it: maria@old
  // and maria@new are two addresses and one woman. So the older link is
  // withdrawn first, which is also what the unique index in 053 insists on.
  //
  // Done as its own statement rather than inside the insert the way 031
  // supersedes an address, because PostgREST has no transaction to put them in.
  // It runs last, after every check above, so the only thing that can fail
  // between here and the insert is a genuine race.
  if (stub) {
    await supabase
      .from('invitations')
      .update({ revoked_at: new Date().toISOString(), revoked_by: user.id })
      .eq('client_stub_id', stub.id)
      .is('accepted_at', null)
      .is('revoked_at', null)
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
      // The studio's own note about who this is, so the accept page can greet
      // them by name without the staff member retyping it.
      first_name: body.first_name || stub?.first_name || null,
      last_name: body.last_name || stub?.last_name || null,
      note: body.note || null,
      role: body.role,
      invited_by: user.id,
      token_hash: tokenHash,
      expires_at: expiresAt,
      client_stub_id: stub?.id ?? null,
    })
    .select(
      'id, email, first_name, last_name, note, role, expires_at, created_at, client_stub_id'
    )
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
