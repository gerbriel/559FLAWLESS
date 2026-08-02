import { Clock, AlertTriangle, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'

/** What each job is for, in the studio's terms rather than the function's. */
const JOBS: Record<string, string> = {
  '559-notifications': 'Appointment reminders and rebooking nudges',
  '559-waitlist': 'Offering freed slots to whoever is waiting',
  '559-timeclock': 'Nudging staff who forgot to clock in or out',
  '559-licences': 'Warning before a licence expires',
  '559-recurring-expenses': 'Posting rent, software and other regular costs',
}

/**
 * Whether the background jobs are actually running.
 *
 * These are the things nobody presses a button for, which is exactly why they
 * fail quietly — a reminder that stops going out looks identical to a week when
 * nothing was due. Showing the last run turns that into something visible.
 */
export async function ScheduledJobs() {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('scheduled_job_status')

  // No rows means pg_cron is not enabled — a setup state, not a failure.
  const jobs = error ? [] : (data ?? [])

  return (
    <section className="mt-14">
      <h2 className="display text-2xl">Background jobs</h2>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
        Reminders, the waitlist and recurring costs run on a schedule inside the
        database. Nothing here needs pressing — this is just so you can see it is
        working.
      </p>

      {jobs.length === 0 ? (
        <div className="mt-6 border-l-2 border-amber-500 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-transparent dark:text-amber-300">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
            <span>
              Not scheduled yet. Turn on <strong>pg_cron</strong> under Database →
              Extensions in Supabase, then re-run migration 044. Until then reminders,
              waitlist offers and recurring expenses only happen when someone presses
              the button on the relevant page.
            </span>
          </p>
        </div>
      ) : (
        <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {jobs.map((j) => {
            const failed = j.last_status && j.last_status !== 'succeeded'
            return (
              <li
                key={j.jobname}
                className="flex flex-wrap items-center justify-between gap-4 py-4"
              >
                <div className="min-w-0">
                  <p className="text-sm">{JOBS[j.jobname] ?? j.jobname}</p>
                  <p className="mt-0.5 flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
                    <Clock className="h-3 w-3" strokeWidth={1.75} />
                    <span className="tabular-nums">{j.schedule}</span>
                    <span aria-hidden>·</span>
                    {j.last_run
                      ? `last ran ${new Date(j.last_run).toLocaleString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          hour: 'numeric',
                          minute: '2-digit',
                        })}`
                      : 'not run yet'}
                  </p>
                </div>

                {!j.active ? (
                  <Badge tone="warning">Paused</Badge>
                ) : failed ? (
                  <Badge tone="danger">
                    <AlertTriangle className="h-3 w-3" strokeWidth={2} />
                    {j.last_status}
                  </Badge>
                ) : (
                  <Badge tone="success">
                    <Check className="h-3 w-3" strokeWidth={2.5} />
                    Running
                  </Badge>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <p className="mt-4 max-w-prose text-xs text-[var(--color-muted)]">
        Google Calendar is the exception — it has to reach Google, so it syncs from
        the website instead: once a day, and whenever someone opens the booking page
        and your calendar has not been read in the last ten minutes.
      </p>
    </section>
  )
}
