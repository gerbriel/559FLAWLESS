import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isManager } from '@/types/database'
import type { DispatchSummary } from '@/types/notifications'

export const dynamic = 'force-dynamic'
// Materialising and delivering a sweep is a handful of round trips, but a
// backlog after an outage is not, and a half-finished sweep is a half-sent
// batch. Give it room.
export const maxDuration = 60

/**
 * How far ahead of the moment to reach.
 *
 * Anything due in the next hour goes out on this run. A reminder arriving up to
 * an hour early is unremarkable; one arriving after the appointment is useless,
 * which is what a horizon of zero produces when the sweep runs hourly.
 */
const HORIZON_MINUTES = 60

/**
 * How far back to catch up.
 *
 * Deliberately finite. A dispatcher that has been down for a fortnight must not
 * mark the occasion by sending a fortnight of reminders — it sends what came due
 * in the last two days and lets the rest go. Anything older is not a reminder
 * any more.
 */
const LOOKBACK_MINUTES = 2880

/** Ceiling on one sweep, so a backlog is drained over several runs, not one. */
const BATCH_LIMIT = 200

/**
 * Materialise everything the schedules say is due, then deliver it in-app.
 *
 * Safe to call as often as you like and safe to call twice at once: every row
 * the dispatcher would create is keyed on (recipient, kind, channel, subject,
 * scheduled_for), and `scheduled_for` is derived from the appointment, never
 * from the clock. The second run collides and writes nothing.
 *
 * Service role, because the queue has no write policy for anyone — the whole
 * table is written by SECURITY DEFINER functions and read by managers.
 */
async function runDispatch(): Promise<DispatchSummary> {
  const admin = createAdminClient()

  const { data, error } = await admin.rpc('dispatch_notifications', {
    p_horizon_minutes: HORIZON_MINUTES,
    p_lookback_minutes: LOOKBACK_MINUTES,
    p_limit: BATCH_LIMIT,
  })

  if (error) throw new Error(error.message)

  return data as unknown as DispatchSummary
}

/**
 * The scheduled sweep.
 *
 * Vercel cron issues a GET and, when CRON_SECRET is set, presents it as a
 * bearer token — which is the only thing authorising this. Same shape as
 * /api/calendar/sync.
 *
 * NOTE: this is not wired into vercel.json. Hobby allows one cron job and the
 * calendar sync has it. Until the plan changes, either point an external
 * scheduler at this URL with the same bearer token, or fold this call into the
 * calendar sync's daily run — with the caveat that a daily sweep makes "two
 * hours before" mean "some time on the day".
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    return NextResponse.json({ ok: true, ...(await runDispatch()) })
  } catch (err) {
    console.error('scheduled notification dispatch failed', err)
    return NextResponse.json({ error: 'dispatch_failed' }, { status: 500 })
  }
}

/** "Send anything due now", pressed by a manager in Settings. */
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

  if (!profile || profile.suspended_at || !isManager(profile.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    return NextResponse.json({ ok: true, ...(await runDispatch()) })
  } catch (err) {
    console.error('manual notification dispatch failed', err)
    return NextResponse.json({ error: 'dispatch_failed' }, { status: 500 })
  }
}
