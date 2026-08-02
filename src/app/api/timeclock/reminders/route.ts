import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { isManager } from '@/types/database'
import { timeclockDb, type ReminderCandidate } from '@/types/timetracking'

export const dynamic = 'force-dynamic'

/**
 * How late is late.
 *
 * Fifteen minutes is long enough that a client who ran over does not trigger a
 * nudge, and short enough that the punch can still be fixed from memory rather
 * than reconstructed at payroll.
 */
const LATE_IN_MINUTES = 15
const LATE_OUT_MINUTES = 15
/**
 * The backstop for anyone with no roster — front desk and managers usually have
 * none. Twelve hours is past the end of any real shift, so an entry still open
 * at that point is a forgotten punch rather than a long day.
 */
const ORPHAN_HOURS = 12

/**
 * Nudge whoever is late to clock in or out.
 *
 * `send_time_clock_reminders` is idempotent — one nudge per person per kind per
 * local day — so calling this more often than once a day is harmless and
 * getting called twice by a retry is a no-op.
 *
 * NOT WIRED TO A SCHEDULE. `vercel.json` already spends the single daily cron a
 * Hobby plan allows on /api/calendar/sync, and a once-a-day reminder fired at
 * 13:00 UTC would tell people about a shift they either started or missed hours
 * ago. See the note in the report: this wants a fifteen-minute schedule from
 * something that is not Vercel cron, or a call from the existing sweep if a
 * daily digest is genuinely all the studio wants.
 */
async function runSweep() {
  const admin = createAdminClient()
  const db = timeclockDb(admin)

  const { data: sent, error } = await db.rpc('send_time_clock_reminders', {
    p_late_in_minutes: LATE_IN_MINUTES,
    p_late_out_minutes: LATE_OUT_MINUTES,
    p_orphan_hours: ORPHAN_HOURS,
  })

  if (error) throw new Error(error.message)

  return { ok: true, sent: (sent as number | null) ?? 0 }
}

/**
 * The scheduled sweep. Same shape as /api/calendar/sync: a GET, authorised by
 * nothing but the CRON_SECRET bearer token.
 */
export async function GET(request: NextRequest) {
  const secret = process.env.CRON_SECRET
  if (!secret || request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  try {
    return NextResponse.json(await runSweep())
  } catch (err) {
    console.error('scheduled time clock reminders failed', err)
    return NextResponse.json({ error: 'sweep_failed' }, { status: 500 })
  }
}

/**
 * "Who is late right now?", asked by a manager from the dashboard.
 *
 * Returns the candidates as well as the count, because the useful answer to
 * "did that do anything?" is the list of names, and reading it writes nothing.
 */
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
    // The caller's own client, so the manager check in the function sees a real
    // auth.uid() rather than the service role's absence of one.
    const { data: candidates } = await timeclockDb(supabase).rpc(
      'time_clock_reminder_candidates',
      {
        p_late_in_minutes: LATE_IN_MINUTES,
        p_late_out_minutes: LATE_OUT_MINUTES,
        p_orphan_hours: ORPHAN_HOURS,
      }
    )

    const result = await runSweep()

    return NextResponse.json({
      ...result,
      candidates: ((candidates ?? []) as ReminderCandidate[]).map((c) => ({
        staffId: c.staff_id,
        kind: c.kind,
        shiftStart: c.shift_start,
        shiftEnd: c.shift_end,
      })),
    })
  } catch (err) {
    console.error('manual time clock reminders failed', err)
    return NextResponse.json({ error: 'sweep_failed' }, { status: 500 })
  }
}
