import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { syncAppointmentToCalendar } from '@/lib/calendar-push'

export const dynamic = 'force-dynamic'

const DeleteSchema = z.object({
  // The UI makes them type this. Checked here too, so a stray POST — a
  // mis-fired fetch, a curious request against the API — cannot erase an
  // account on its own.
  confirm: z.literal('DELETE'),
})

/**
 * Delete my account.
 *
 * The scrub itself is `anonymise_account()` in migration 030, called with the
 * client's OWN session rather than the service role, so the guard inside it is
 * genuinely doing the work: a tampered request naming someone else's uuid is
 * rejected by the database, not by this file.
 *
 * Three things the database cannot do for itself happen here afterwards, in
 * order of how much it matters that they succeed:
 *
 *   1. Object storage. Treatment photographs live in a private bucket, and SQL
 *      cannot reach it. The RPC deletes the rows and hands back the paths.
 *   2. Google Calendar. The provider's calendar holds "<client name> —
 *      <service>" for every synced booking, which no amount of SQL will touch.
 *   3. GoTrue. Scrubbing auth.users from SQL depends on privileges a hosted
 *      project may not grant, so the admin API finishes the job.
 *
 * All three are best-effort and none of them fails the request. The data scrub
 * is committed by the time we get here; telling someone their deletion failed
 * because Google was slow would be false, and would invite them to press the
 * button again expecting a different outcome.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const parsed = DeleteSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'confirmation_required' }, { status: 400 })
  }

  // Read the photo paths and the calendar events BEFORE the scrub. The RPC
  // deletes the photo rows, and it returns the paths for exactly this reason,
  // but reading them here as the signed-in user means a failure of the RPC
  // leaves nothing half-done.
  const { data: appointments } = await supabase
    .from('appointments')
    .select('id, google_event_id')
    .eq('client_id', user.id)
    .not('google_event_id', 'is', null)

  const { data: scrub, error: scrubError } = await supabase.rpc('anonymise_account', {
    p_client: user.id,
  })

  if (scrubError || !scrub) {
    console.error('account anonymisation failed', user.id, scrubError)
    return NextResponse.json(
      {
        error: 'delete_failed',
        message: 'We could not complete that. Please call the studio and we will do it for you.',
      },
      { status: 500 }
    )
  }

  const admin = createAdminClient()

  // ── 1. The photographs ──────────────────────────────────────
  const paths = Array.isArray(scrub.storage_paths) ? scrub.storage_paths : []
  if (paths.length > 0) {
    const { error: storageError } = await admin.storage.from('treatment').remove(paths)
    if (storageError) {
      // The paths stay on the tombstone, so a retry — or the studio — can
      // finish it. Losing them here is what would make the objects
      // unreachable, and that is the case this is guarding against.
      console.error('treatment photo purge failed', user.id, storageError)
    } else {
      await admin
        .from('deleted_accounts')
        .update({ storage_purged_at: new Date().toISOString(), pending_storage_paths: [] })
        .eq('profile_id', user.id)
    }
  }

  // ── 2. The provider's calendar ──────────────────────────────
  // Re-pushing rather than deleting: the provider still needs the booking, and
  // syncAppointmentToCalendar rebuilds the title from the profile — which now
  // reads "Deleted Account". Deleting the events instead would erase the name
  // and the appointment along with it.
  for (const appt of appointments ?? []) {
    await syncAppointmentToCalendar(appt.id)
  }

  // ── 3. The auth identity ────────────────────────────────────
  // `auth_scrubbed` is false when the SQL function could not write to the auth
  // schema, which is the normal case on a hosted project.
  if (!scrub.auth_scrubbed) {
    const { error: authError } = await admin.auth.admin.updateUserById(user.id, {
      // RFC 2606 reserves .invalid, so this can never be delivered to. It also
      // frees their real address: someone who deletes an account and later
      // changes their mind can sign up again from scratch.
      email: `deleted-${user.id.replace(/-/g, '')}@deleted.invalid`,
      email_confirm: true,
      user_metadata: {},
      // 100 years. Stops the old identity signing back in to an empty shell.
      ban_duration: '876000h',
    })
    if (authError) console.error('auth identity scrub failed', user.id, authError)

    // The email rewrite frees their ADDRESS, but an OAuth identity binds by
    // provider id, not email — left in place, Google kept resolving that
    // person to this banned shell forever, and every later "Sign in with
    // Google" died with "User is banned". Unlink every social identity so
    // deleting an account really does let someone start over. Straight to the
    // admin REST endpoint: the JS client has no admin-side unlink.
    try {
      const { data: fresh } = await admin.auth.admin.getUserById(user.id)
      for (const identity of fresh?.user?.identities ?? []) {
        if (identity.provider === 'email') continue
        await fetch(
          `${process.env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${user.id}/identities/${identity.identity_id}`,
          {
            method: 'DELETE',
            headers: {
              apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
              Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY!}`,
            },
          }
        )
      }
    } catch (err) {
      console.error('social identity unlink failed', user.id, err)
    }
  }

  // Kill every session everywhere, not just this browser. Their tokens should
  // not outlive the account on a phone they signed in on months ago.
  await supabase.auth.signOut({ scope: 'global' })

  return NextResponse.json({ ok: true, kept: scrub.kept, removed: scrub.removed })
}
