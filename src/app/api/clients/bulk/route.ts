import { NextResponse, type NextRequest } from 'next/server'
import { randomBytes, createHash } from 'crypto'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
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
 *   archive / restore                          admin — 001's trigger refuses
 *                                              a non-admin writing suspended_at
 *                                              anyway, so this matches it
 *   delete                                     admin — anonymise_account() (030)
 *                                              refuses anyone else regardless
 *
 * The two admin actions are enforced twice on purpose. The check here gives a
 * sentence a person can read; the database's own refusal is what makes it true.
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
    action: z.literal('invite'),
    stubIds: z.array(z.number().int().positive()).min(1).max(MAX),
    expires_in_days: z.number().int().min(1).max(60).default(14),
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
        done.push(id)
      }
      return NextResponse.json({ ok: true, affected: done.length })
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
  }
}

function failed(message: string) {
  console.error('bulk client action failed', message)
  return NextResponse.json({ error: 'failed', message }, { status: 400 })
}
