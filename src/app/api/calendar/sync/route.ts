import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchBusy, calendarSyncConfigured } from '@/lib/google-calendar'
import { isStaff } from '@/types/database'
import { DAY_MS } from '@/lib/time'

export const dynamic = 'force-dynamic'
// Reading several weeks of a calendar and writing them back takes longer than
// the default budget on a cold start.
export const maxDuration = 60

/** How far ahead to mirror. Booking opens 90 days out by default. */
const SYNC_DAYS_AHEAD = 90
/** A little history, so a running-late appointment still blocks today. */
const SYNC_DAYS_BEHIND = 1

/**
 * Pull connected calendars into `calendar_busy`, which the availability engine
 * already consults when generating slots.
 *
 * Replaces the synced window rather than accumulating, so it is safe to call as
 * often as you like. `providerFilter` scopes it: a staff member pressing "Sync
 * now" syncs only their own calendar; the scheduled sweep does everyone.
 */
async function runSync(providerFilter: string | null) {
  const admin = createAdminClient()

  let query = admin
    .from('calendar_connections')
    .select('provider_id, calendar_id, pull_busy')
    .is('revoked_at', null)
    .eq('pull_busy', true)

  if (providerFilter) query = query.eq('provider_id', providerFilter)

  const { data: connections, error } = await query
  if (error) throw new Error(error.message)

  if (!connections?.length) {
    return { ok: true, synced: 0, failed: 0, results: [], message: 'No connected calendars.' }
  }

  const from = new Date(Date.now() - SYNC_DAYS_BEHIND * DAY_MS)
  const to = new Date(Date.now() + SYNC_DAYS_AHEAD * DAY_MS)

  const results = await Promise.all(
    connections.map(async (conn) => {
      try {
        const events = await fetchBusy(conn.provider_id, conn.calendar_id ?? 'primary', from, to)

        const { error: writeError } = await admin.rpc('replace_calendar_busy', {
          p_provider: conn.provider_id,
          p_from: from.toISOString(),
          p_to: to.toISOString(),
          p_events: events,
        })

        if (writeError) throw new Error(writeError.message)
        return { provider: conn.provider_id, events: events.length }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Sync failed'
        // One broken calendar must not fail the sweep for the others.
        await admin
          .from('calendar_connections')
          .update({ last_sync_error: message })
          .eq('provider_id', conn.provider_id)
        console.error('calendar sync failed', conn.provider_id, message)
        return { provider: conn.provider_id, error: message }
      }
    })
  )

  return {
    ok: true,
    synced: results.filter((r) => !('error' in r)).length,
    failed: results.filter((r) => 'error' in r).length,
    results,
  }
}

const notConfigured = () =>
  NextResponse.json(
    { error: 'not_configured', message: 'Google Calendar is not set up on this deployment.' },
    { status: 503 }
  )

/**
 * The scheduled sweep. Vercel cron issues a GET and, when CRON_SECRET is set,
 * presents it as a bearer token — which is the only thing authorising this.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }
  if (!calendarSyncConfigured()) return notConfigured()

  try {
    return NextResponse.json(await runSync(null))
  } catch (err) {
    console.error('scheduled calendar sync failed', err)
    return NextResponse.json({ error: 'sync_failed' }, { status: 500 })
  }
}

/** "Sync now", pressed by a staff member for their own calendar. */
export async function POST() {
  if (!calendarSyncConfigured()) return notConfigured()

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

  try {
    return NextResponse.json(await runSync(user.id))
  } catch (err) {
    console.error('manual calendar sync failed', err)
    return NextResponse.json({ error: 'sync_failed' }, { status: 500 })
  }
}
