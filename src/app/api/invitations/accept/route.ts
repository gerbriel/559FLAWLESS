import { NextResponse, type NextRequest } from 'next/server'
import { checkRateLimit, rateLimitedResponse } from '@/lib/rate-limit'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createPublicClient } from '@/lib/supabase/public'
import { isStaff } from '@/types/database'

export const dynamic = 'force-dynamic'

const MIN_PASSWORD = 8

const AcceptSchema = z.object({
  token: z.string().trim().min(16).max(400),
  password: z.string().min(MIN_PASSWORD).max(200),
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  phone: z.string().trim().max(40).nullish(),
  date_of_birth: z
    .union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')])
    .nullish(),
  marketing_opt_in: z.boolean().default(false),
  accepted_terms: z.literal(true),
})

/**
 * Claim an invitation. Public by necessity — the invitee has no account yet, so
 * there is nobody to authenticate. The token is the authorisation, and it is
 * checked by the database, not here.
 *
 * The order matters. The account is created first, as an ordinary client (that
 * is all `handle_new_user` will ever make — see 023), and only then does
 * `redeem_invitation` decide what role it gets, from the invitation row rather
 * than from anything in this request. Nothing in the body names a role. If
 * redemption is refused for any reason the auth user is deleted again, so a
 * burnt link never leaves a half-made account behind.
 *
 * `createAdminClient()` is used because creating an auth user and reading a
 * hashed token are both service-role operations by construction. Authorisation
 * happened before either: possession of an unexpired, unused, unrevoked token
 * that the studio minted.
 *
 * The account is created email-confirmed. The studio chose this address and
 * sent the link to it; requiring a second confirmation email would break the
 * flow outright, since no transactional email provider is wired up.
 *
 * If the invitation named a `client_stub` (051), accepting it also claims that
 * stub: the studio's older note about this person is merged into the account
 * they just made, and the row on the "still to sign up" list is marked done
 * rather than left beside a duplicate. That is the entire reason the stub was
 * allowed to exist.
 */
export async function POST(request: NextRequest) {
  // A stranger's route: budgeted per address, failing open. See lib/rate-limit.
  if (!(await checkRateLimit(request, 'inviteAccept')).allowed) {
    return rateLimitedResponse('inviteAccept')
  }

  const parsed = AcceptSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_request',
        message: `Please check the details — passwords need at least ${MIN_PASSWORD} characters.`,
      },
      { status: 400 }
    )
  }

  const body = parsed.data

  // Read it as `anon` would: this is the same view the accept page rendered,
  // and it proves the token is live before an account is created for nothing.
  const preview = createPublicClient()
  const { data: rows } = await preview.rpc('invitation_preview', { p_token: body.token })
  const invitation = rows?.[0]

  if (!invitation || invitation.status !== 'pending') {
    return NextResponse.json(
      {
        error: 'invalid_invitation',
        message:
          invitation?.status === 'expired'
            ? 'This invitation has expired. Ask the studio for a new link.'
            : invitation?.status === 'accepted'
              ? 'This invitation has already been used. Try signing in instead.'
              : 'This invitation link is no longer valid.',
      },
      { status: 410 }
    )
  }

  const admin = createAdminClient()

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    // From the invitation, never from the request — the invitee cannot redirect
    // an invitation to an address the studio did not choose.
    email: invitation.email,
    password: body.password,
    email_confirm: true,
    user_metadata: {
      first_name: body.first_name,
      last_name: body.last_name,
      phone: body.phone ?? null,
    },
  })

  if (createError || !created.user) {
    // Someone signed up with this address between the invitation and now.
    const taken = /already|registered|exists/i.test(createError?.message ?? '')
    console.error('invitation accept: account creation failed', createError)
    return NextResponse.json(
      {
        error: taken ? 'already_exists' : 'create_failed',
        message: taken
          ? 'An account already exists for that email. Sign in, and ask the studio to set your role.'
          : 'Could not create that account. Please try again.',
      },
      { status: taken ? 409 : 500 }
    )
  }

  const userId = created.user.id

  const { data: role, error: redeemError } = await admin.rpc('redeem_invitation', {
    p_token: body.token,
    p_user: userId,
  })

  if (redeemError || !role) {
    // The invitation was revoked, expired or used in the moment between the
    // preview above and now. Undo the account rather than leave one stranded.
    await admin.auth.admin.deleteUser(userId)
    console.error('invitation accept: redeem failed', redeemError)
    return NextResponse.json(
      {
        error: 'invalid_invitation',
        message: redeemError?.message ?? 'This invitation link is no longer valid.',
      },
      { status: 410 }
    )
  }

  const now = new Date().toISOString()
  const staff = isStaff(role)

  // Who to credit the client record to, and whether this invitation was aimed
  // at somebody the studio already had on its list. Read after redemption
  // rather than from the anon preview, which deliberately exposes neither a
  // staff member's id nor the existence of a stub.
  const { data: accepted } = await admin
    .from('invitations')
    .select('invited_by, client_stub_id')
    .eq('accepted_by', userId)
    .maybeSingle()

  // A client owes a phone number and a date of birth before they can book; 023
  // put that behind `/account/complete`. Filling both in here means they never
  // see that step. A staff invitee is out of scope for it entirely —
  // `profile_needs_completion` only looks at clients — so the marker stays null.
  const completedAt =
    !staff && !!body.phone?.trim() && !!body.date_of_birth ? now : null

  const { error: profileError } = await admin
    .from('profiles')
    .update({
      first_name: body.first_name,
      last_name: body.last_name,
      phone: body.phone || null,
      date_of_birth: body.date_of_birth || null,
      marketing_opt_in: staff ? false : body.marketing_opt_in,
      marketing_consent_at: !staff && body.marketing_opt_in ? now : null,
      terms_accepted_at: now,
      terms_version_accepted: 1,
      privacy_accepted_at: now,
      created_by_staff_id: staff ? null : (accepted?.invited_by ?? null),
      profile_completed_at: completedAt,
    })
    .eq('id', userId)

  if (profileError) {
    // The account and the role are already real, so this is not fatal — the
    // details can be filled in from the account page. Log it and carry on.
    console.error('invitation accept: profile details failed', profileError)
  }

  // ── The stub stops being a stub ─────────────────────────────────────────
  //
  // Deliberately after the profile update, not before it. `claim_client_stub`
  // (051) fills in what the profile is *missing* — so running it last means it
  // fills exactly the gaps this form left, and a client who skipped the phone
  // field ends up with the number the studio has had on paper for eight years.
  // Run first, that number would be overwritten with the null just above.
  //
  // A failure here is not a reason to undo an account that already exists and
  // already has its role: the person is signed up either way, and the worst
  // case is a stub left on the studio's list for someone to tidy. The one
  // failure worth naming is a stub claimed by somebody else, which means two
  // people were sent links for the same record — the function refuses, and it
  // is right to.
  let claimedStub = false
  if (!staff && accepted?.client_stub_id) {
    const { error: claimError } = await admin.rpc('claim_client_stub', {
      p_stub: accepted.client_stub_id,
      p_profile: userId,
    })
    if (claimError) {
      console.error('invitation accept: could not claim the client stub', claimError)
    } else {
      claimedStub = true
    }
  }

  // Somewhere for the CRM to hang notes and stats before the first visit, the
  // same as a walk-in created by staff.
  if (!staff) {
    await admin.from('client_records').upsert({ client_id: userId }, { onConflict: 'client_id' })
  }

  // Whether to walk them through the rest of their profile once they are in.
  // For everyone but a claimant this is what the form already told us; for a
  // claimant the phone number may have arrived from the stub a moment ago, so
  // the profile itself is asked rather than the request body.
  let needsProfile = !staff && !completedAt
  if (claimedStub) {
    const { data: claimed } = await admin
      .from('profiles')
      .select('phone, date_of_birth')
      .eq('id', userId)
      .maybeSingle()

    const complete = !!claimed?.phone?.trim() && !!claimed?.date_of_birth
    needsProfile = !complete
    if (complete && !completedAt) {
      await admin.from('profiles').update({ profile_completed_at: now }).eq('id', userId)
    }
  }

  return NextResponse.json({
    ok: true,
    role,
    email: invitation.email,
    needs_profile: needsProfile,
  })
}
