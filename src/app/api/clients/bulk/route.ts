import { NextResponse, type NextRequest } from 'next/server'
import { randomBytes, createHash } from 'crypto'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isAdmin, isFrontDesk, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * Doing one thing to many clients at once.
 *
 * Every action here exists as a single-record action somewhere else, and this
 * route is deliberately not a shortcut past any of them: it runs the same
 * writes, under the same policies, as the screen that does one. What it adds is
 * a selection and a count.
 *
 * The bar rises with the blast radius rather than sitting at one level for the
 * whole route, because these are not equally serious. Tagging forty people is
 * forty rows in a join table. Deleting forty people is irreversible and takes
 * their name, their email, their phone and every photograph of them with it.
 *
 *   tag / untag / marketing opt-out / invite   front desk and above
 *   send sign-in link                          front desk and above
 *   archive / restore                          admin — 001's trigger refuses
 *                                              a non-admin writing suspended_at
 *                                              anyway, so this matches it
 *   delete                                     admin — anonymise_account() (030)
 *                                              refuses anyone else regardless
 *
 * The two admin actions are enforced twice on purpose. The check here gives a
 * sentence a person can read; the database's own refusal is what makes it true.
 *
 * Two of these actions wear one button. "Invite" on the Not-signed-up screen
 * and "Invite" on the Clients roster are different operations underneath —
 * `invite` mints an invitation that CREATES an account, `send_sign_in_link`
 * hands over the account that already exists — and the difference is not a
 * detail the studio should have to hold in their head. See each case below.
 */

/** Bounded so a mis-click cannot start an hour-long job. */
const MAX = 200

const Body = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('tag'),
    clientIds: z.array(z.string().uuid()).min(1).max(MAX),
    tagId: z.number().int().positive(),
  }),
  z.object({
    action: z.literal('untag'),
    clientIds: z.array(z.string().uuid()).min(1).max(MAX),
    tagId: z.number().int().positive(),
  }),
  z.object({
    action: z.literal('marketing_opt_out'),
    clientIds: z.array(z.string().uuid()).min(1).max(MAX),
  }),
  z.object({
    action: z.literal('archive'),
    clientIds: z.array(z.string().uuid()).min(1).max(MAX),
  }),
  z.object({
    action: z.literal('restore'),
    clientIds: z.array(z.string().uuid()).min(1).max(MAX),
  }),
  z.object({
    action: z.literal('delete'),
    clientIds: z.array(z.string().uuid()).min(1).max(MAX),
    /** Typed by the person doing it. Cheap, and it is the last stop. */
    confirm: z.literal('DELETE'),
  }),
  z.object({
    action: z.literal('delete_stubs'),
    stubIds: z.array(z.number().int().positive()).min(1).max(MAX),
    confirm: z.literal('DELETE'),
  }),
  z.object({
    action: z.literal('invite'),
    stubIds: z.array(z.number().int().positive()).min(1).max(MAX),
    expires_in_days: z.number().int().min(1).max(60).default(14),
  }),
  /**
   * The roster's Invite. A separate action rather than a second shape of
   * `invite`, because it is a separate operation and naming it after what it
   * actually does is the only thing stopping the two being confused later —
   * by a reader, by a caller, or by whoever adds the third one.
   *
   * No `expires_in_days`: the lifetime of a sign-in link is Supabase's, set on
   * the project, and an option here would be a number this route pretends to
   * honour and cannot.
   */
  z.object({
    action: z.literal('send_sign_in_link'),
    clientIds: z.array(z.string().uuid()).min(1).max(MAX),
  }),
])

export async function POST(request: NextRequest) {
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

  if (!profile || profile.suspended_at || !isFrontDesk(profile.role as UserRole)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid', message: 'That selection or action was not understood.' },
      { status: 400 }
    )
  }
  const body = parsed.data
  const admin = isAdmin(profile.role as UserRole)

  if ((body.action === 'archive' || body.action === 'restore') && !admin) {
    return NextResponse.json(
      {
        error: 'forbidden',
        message:
          'Archiving a client is an admin action — the database refuses a change to suspended_at from anyone else.',
      },
      { status: 403 }
    )
  }

  if (body.action === 'delete' && !admin) {
    return NextResponse.json(
      {
        error: 'forbidden',
        message: 'Deleting a client account is an admin action.',
      },
      { status: 403 }
    )
  }

  switch (body.action) {
    /* ── Tags ────────────────────────────────────────────── */
    case 'tag': {
      // upsert, not insert: re-tagging somebody who already carries the tag is
      // a no-op the studio should never see an error for.
      const { error } = await supabase
        .from('client_tag_links')
        .upsert(
          body.clientIds.map((client_id) => ({ client_id, tag_id: body.tagId })),
          { onConflict: 'client_id,tag_id', ignoreDuplicates: true }
        )
      if (error) return failed(error.message)
      return NextResponse.json({ ok: true, affected: body.clientIds.length })
    }

    case 'untag': {
      const { error } = await supabase
        .from('client_tag_links')
        .delete()
        .eq('tag_id', body.tagId)
        .in('client_id', body.clientIds)
      if (error) return failed(error.message)
      return NextResponse.json({ ok: true, affected: body.clientIds.length })
    }

    /* ── Marketing ───────────────────────────────────────── */
    case 'marketing_opt_out': {
      // Opting OUT in bulk only. There is no opt-in here and there will not be:
      // 016's trigger writes a consent_audit_log row from this update, and that
      // log exists to prove consent was *given*. A checkbox that manufactures
      // forty of those is the one thing in this file that could turn a record
      // which protects the studio into one that indicts it.
      const { error } = await supabase
        .from('profiles')
        .update({ marketing_opt_in: false, sms_opt_in: false })
        .in('id', body.clientIds)
        .eq('role', 'client')
      if (error) return failed(error.message)
      return NextResponse.json({ ok: true, affected: body.clientIds.length })
    }

    /* ── Archive ─────────────────────────────────────────── */
    case 'archive':
    case 'restore': {
      const { error } = await supabase
        .from('profiles')
        .update({ suspended_at: body.action === 'archive' ? new Date().toISOString() : null })
        .in('id', body.clientIds)
        .eq('role', 'client')
      if (error) return failed(error.message)
      return NextResponse.json({ ok: true, affected: body.clientIds.length })
    }

    /* ── Delete ──────────────────────────────────────────── */
    case 'delete': {
      // One call per account, because that is the shape of the function 030
      // wrote and it returns a report of what it kept. Sequential rather than
      // parallel: forty concurrent SECURITY DEFINER scrubs, each touching ten
      // tables and storage, is not a load anyone asked this database to take.
      //
      // A failure stops the run rather than pressing on. Half a bulk delete is
      // recoverable — you can see which names are still there. A run that
      // limped past six failures and reported success is not.
      const done: string[] = []
      // Anonymised but still on the roster, because something tangible points
      // at the row. Named in the response so "deleted" never quietly means two
      // different things.
      let shells = 0
      for (const id of body.clientIds) {
        const { error } = await supabase.rpc('anonymise_account', { p_client: id })
        if (error) {
          return NextResponse.json(
            {
              error: 'partial',
              message:
                done.length === 0
                  ? `Nothing was deleted. ${error.message}`
                  : `${done.length} of ${body.clientIds.length} were deleted, then this stopped it: ${error.message}`,
              affected: done.length,
            },
            { status: 400 }
          )
        }

        // ── Then the shell itself, when it stands for nothing ──
        //
        // 056: purge_empty_profile deletes the anonymised row ONLY when no
        // appointment, signature, intake, photo or gift card references it,
        // and refuses with a sentence otherwise. A refusal is not a failure
        // of this run — it is the shell doing its job — so it is counted,
        // not surfaced as an error.
        //
        // The auth user goes strictly AFTER the purge commits, never before:
        // profiles.id is ON DELETE CASCADE from auth.users, so deleting the
        // login first would cascade the profile away around the very checks
        // the function exists to make.
        const { error: purgeRefused } = await supabase.rpc('purge_empty_profile', {
          p_profile: id,
        })
        if (purgeRefused) {
          shells++
        } else {
          const wipe = createAdminClient()
          const { error: authError } = await wipe.auth.admin.deleteUser(id)
          // The profile row is already gone; a stale auth row is invisible to
          // every screen and harmless. Log rather than fail a delete that has
          // in every user-visible sense succeeded.
          if (authError) console.error('auth cleanup failed for', id, authError.message)
        }

        done.push(id)
      }
      return NextResponse.json({ ok: true, affected: done.length, shells })
    }

    /* ── Delete stubs ────────────────────────────────────── */
    case 'delete_stubs': {
      // A stub is a contact and an intention — 051's words — with no clinical
      // record, no money and no appointments possible, so this is the one
      // delete in the app that is genuinely just a delete. RLS already scopes
      // it: "front desk writes client stubs" is the policy, and this runs as
      // the signed-in user, so the database is the thing refusing a provider.
      //
      // `claimed_by is null` matches what the screen shows. A claimed stub is
      // the record of where an account came from; the Not-signed-up list does
      // not show it and this action does not reach it.
      const { data: removed, error } = await supabase
        .from('client_stubs')
        .delete()
        .in('id', body.stubIds)
        .is('claimed_by', null)
        .select('id')

      if (error) {
        return NextResponse.json(
          { error: 'failed', message: `Nothing was removed. ${error.message}` },
          { status: 400 }
        )
      }
      return NextResponse.json({ ok: true, affected: removed?.length ?? 0 })
    }

    /* ── Invite ──────────────────────────────────────────── */
    case 'invite': {
      // Only for people who are not accounts yet — see `client_stubs` (051).
      // Everyone on the Clients roster already has one, which is why this
      // action does not appear there.
      const { data: stubs, error: readError } = await supabase
        .from('client_stubs')
        .select('id, first_name, last_name, email, claimed_by')
        .in('id', body.stubIds)
      if (readError) return failed(readError.message)

      const invitable = (stubs ?? []).filter((s) => s.email && !s.claimed_by)
      const skipped = (stubs ?? []).length - invitable.length

      if (invitable.length === 0) {
        return NextResponse.json({
          ok: true,
          affected: 0,
          skipped,
          links: [],
          message:
            'None of those could be invited — an invitation needs an email address, and someone who has already signed up does not need one.',
        })
      }

      const expiresAt = new Date(
        Date.now() + body.expires_in_days * 86_400_000
      ).toISOString()
      const origin = process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin
      const links: { name: string; email: string; url: string }[] = []

      for (const stub of invitable) {
        // 053 holds one live invitation per stub, so an earlier one is
        // withdrawn rather than colliding with the index.
        await supabase
          .from('invitations')
          .update({ revoked_at: new Date().toISOString() })
          .eq('client_stub_id', stub.id)
          .is('accepted_at', null)
          .is('revoked_at', null)

        const token = randomBytes(32).toString('base64url')
        const tokenHash = createHash('sha256').update(token).digest('hex')

        const { error } = await supabase.from('invitations').insert({
          email: stub.email!.toLowerCase(),
          first_name: stub.first_name,
          last_name: stub.last_name,
          role: 'client',
          invited_by: user.id,
          token_hash: tokenHash,
          expires_at: expiresAt,
          client_stub_id: stub.id,
        })

        // One address already holding a live invitation, or already an account,
        // is a reason to skip that person — not to abandon the other thirty.
        if (error) continue

        links.push({
          name: `${stub.first_name} ${stub.last_name ?? ''}`.trim(),
          email: stub.email!,
          url: `${origin.replace(/\/$/, '')}/invite/${token}`,
        })
      }

      return NextResponse.json({
        ok: true,
        affected: links.length,
        skipped: skipped + (invitable.length - links.length),
        links,
      })
    }

    /* ── A sign-in link, for an account nobody ever claimed ─── */
    case 'send_sign_in_link': {
      // The roster's version of Invite, and NOT the branch above with a
      // different id type.
      //
      // A stub has no auth user, so an invitation is a promise that one will
      // exist: 053's link is redeemed, `redeem_invitation` creates the account
      // and `claim_client_stub` ties the studio's old record to it. Everything
      // about that flow assumes there is nobody there yet.
      //
      // Everyone on this roster already has an auth user — `profiles.id`
      // references it, so a profile IS an account (051 says this at length).
      // Two things follow, and both of them are the trap:
      //
      //   * `inviteUserByEmail` fails outright on an address that already has
      //     a user, so the obvious call is not available.
      //   * writing an `invitations` row for them would be worse than failing.
      //     It would look like it worked, and redeeming it would try to mint a
      //     SECOND account for an address that already has one — the exact
      //     duplicate 051 exists to prevent, arriving through the door 053
      //     built.
      //
      // So: a link into the account that exists. `generateLink` with type
      // 'magiclink' rather than 'recovery', because what these people lack is
      // not a password, it is a way in. A recovery link would land them on
      // "choose a new password" for a password that was never set — which
      // reads as a reset for something they have no memory of, and finishes by
      // making them memorise a credential they did not ask for. A sign-in link
      // is the same door /login already offers as "email me a sign-in link",
      // and it is the door `api/admin/clients/create` names in its own comment
      // as how a staff-made account gets claimed. This hands that door over,
      // for the person who never received the invitation to walk through it.
      //
      // `role = 'client'` on the read is load-bearing, not tidiness. A sign-in
      // link is a bearer credential to whatever account it names, so a front
      // desk hire posting an admin's profile id at this route would otherwise
      // be handed a way into it. 055 filters to clients as well, so an id that
      // is not a client's is refused twice and reported as skipped.
      const { data: people, error: readError } = await supabase
        .from('profiles')
        .select('id, first_name, last_name, email, suspended_at')
        .eq('role', 'client')
        .in('id', body.clientIds)
      if (readError) return failed(readError.message)

      // Whether an account has ever been signed into lives in auth.users,
      // which PostgREST does not expose and must not. 055 answers it as two
      // booleans keyed by profile id, and refuses anyone below front desk.
      const { data: claims, error: claimError } = await supabase.rpc('client_claim_status', {
        p_ids: body.clientIds,
      })
      if (claimError) return failed(claimError.message)

      const claimById = new Map((claims ?? []).map((c) => [c.profile_id, c]))

      // Skipping is reported, never fatal. A batch of thirty that refuses all
      // thirty because one of them has no email address is a worse tool than
      // one that sends twenty-nine and says why the last was left out.
      const skippedRows: { name: string; reason: string }[] = []
      const eligible: { id: string; name: string; email: string }[] = []

      const found = new Set((people ?? []).map((p) => p.id))
      const missing = body.clientIds.filter((id) => !found.has(id)).length
      if (missing > 0) {
        skippedRows.push({
          name: missing === 1 ? 'One selected row' : `${missing} selected rows`,
          reason: 'no longer on the roster',
        })
      }

      for (const person of people ?? []) {
        const name =
          `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim() ||
          person.email ||
          'Unnamed client'

        if (person.suspended_at) {
          // Archived. Not because the link would fail — 030 is explicit that
          // `suspended_at` does not stop a client signing in — but because
          // archiving is the studio saying "not this person, for now", and a
          // bulk action that quietly hands them a way in is that decision
          // being undone by a checkbox. Restore them first, deliberately.
          skippedRows.push({ name, reason: 'archived' })
          continue
        }
        if (!person.email) {
          skippedRows.push({ name, reason: 'no email address on file' })
          continue
        }

        const claim = claimById.get(person.id)
        if (!claim) {
          skippedRows.push({ name, reason: 'could not check whether they have signed in' })
          continue
        }
        if (claim.has_signed_in) {
          skippedRows.push({ name, reason: 'has signed in before — the account is theirs already' })
          continue
        }
        if (claim.invitation_pending) {
          // A live invitation is already out for that address. Two links for
          // one person is how somebody ends up holding the one that no longer
          // works and being told it is their fault.
          skippedRows.push({ name, reason: 'already has an invitation waiting' })
          continue
        }

        eligible.push({ id: person.id, name, email: person.email })
      }

      if (eligible.length === 0) {
        return NextResponse.json({
          ok: true,
          affected: 0,
          skipped: skippedRows.length,
          skippedDetail: skippedRows,
          links: [],
          message:
            'None of those needed a sign-in link — an account that has been signed into before is already theirs.',
        })
      }

      // Authorised at the top of this route, twice: a session, and a stored
      // role re-read rather than trusted from the token. Only then the service
      // role, and only for the auth admin API — every read above went through
      // RLS as the caller.
      const admin = createAdminClient()
      const origin = (process.env.NEXT_PUBLIC_SITE_URL || request.nextUrl.origin).replace(/\/$/, '')
      // The same landing the studio's own sign-in link uses. `/account` rather
      // than the dashboard: these are clients, and the callback routes by role
      // regardless.
      const redirectTo = `${origin}/auth/callback?next=/account`

      const signInLinks: { name: string; email: string; url: string }[] = []

      // Sequential, like the delete branch and for the same reason: two hundred
      // concurrent calls at the auth admin API is a rate limit, not a feature.
      for (const person of eligible) {
        // The address is read from the ACCOUNT, never from `profiles.email`,
        // and the difference is not pedantry — it is the whole safety of this
        // branch.
        //
        // `generateLink` is documented to create the user for `magiclink` as
        // well as `signup` and `invite`: an address it does not recognise is
        // signed up rather than refused. So it is only "a link into the account
        // that exists" while the address handed to it is that account's own,
        // and `profiles.email` is not guaranteed to be. User Management's edit
        // form writes `profiles.email` alone (it does not touch auth), so an
        // admin correcting a mistyped address — on exactly this population,
        // where a typo is why nobody ever signed in — leaves the two disagreeing.
        //
        // Passing the corrected address would then mint a SECOND auth user for
        // it, `handle_new_user` (001) would give that user a second profile,
        // and the link would sign the client into the empty duplicate while the
        // activity log named the original. That is 051's duplicate arriving
        // through the one door left open, and it is silent.
        //
        // Looking the user up by id makes it impossible: whatever comes back is
        // by construction an address that already has an account, so there is
        // nothing for `generateLink` to create. The link is a bearer token in a
        // URL rather than something delivered to a mailbox, so the studio still
        // sends it wherever they know to — the sheet keeps showing the name and
        // the address on file, which is who it is for.
        const { data: account, error: lookupError } = await admin.auth.admin.getUserById(person.id)

        if (lookupError || !account?.user?.email) {
          skippedRows.push({
            name: person.name,
            reason: 'their sign-in address could not be read',
          })
          continue
        }

        const { data: link, error } = await admin.auth.admin.generateLink({
          type: 'magiclink',
          email: account.user.email,
          options: { redirectTo },
        })

        if (error || !link?.properties?.hashed_token) {
          skippedRows.push({ name: person.name, reason: 'no link could be issued for that address' })
          continue
        }

        signInLinks.push({
          name: person.name,
          email: person.email,
          // Built here from the one-time token rather than handed over as
          // `action_link`. That property points at Supabase's own verify
          // endpoint, which redirects to `redirectTo` carrying the token in a
          // way this app's callback cannot read — it only knew how to exchange
          // a PKCE code, and a link generated by the admin API has no verifier
          // for one. So the link goes straight to our callback with the token
          // to redeem, which is the branch added alongside this.
          url: `${origin}/auth/callback?token_hash=${encodeURIComponent(
            link.properties.hashed_token
          )}&type=magiclink&next=%2Faccount`,
        })

        // A sign-in link is a bearer credential to somebody's account, and who
        // handed one out is the sort of thing that has to be answerable later.
        // Same trail the admin password reset writes (014).
        await admin.rpc('log_user_activity', {
          p_user_id: person.id,
          p_action: 'sign_in_link_issued_by_staff',
          p_details: { issued_by: user.id },
          p_performed_by: user.id,
        })
      }

      return NextResponse.json({
        ok: true,
        affected: signInLinks.length,
        skipped: skippedRows.length,
        skippedDetail: skippedRows,
        links: signInLinks,
      })
    }
  }
}

function failed(message: string) {
  console.error('bulk client action failed', message)
  return NextResponse.json({ error: 'failed', message }, { status: 400 })
}
