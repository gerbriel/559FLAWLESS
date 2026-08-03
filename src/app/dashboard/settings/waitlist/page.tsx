import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertTriangle, Check, Clock } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { isAdmin } from '@/types/database'
import type { WaitlistSettings } from '@/types/resources'
import { WaitlistRulesForm } from '@/app/dashboard/settings/waitlist/WaitlistRulesForm'

export const dynamic = 'force-dynamic'

/** The pg_cron job 044 schedules for the waitlist. */
const JOB_NAME = '559-waitlist'

/**
 * The waitlist rules — admin only.
 *
 * 037 makes `waitlist_settings` readable by staff and writable only by an admin,
 * on the reasoning that how long one person is made to wait before the next one
 * is told is booking policy, and booking policy is admin-only everywhere else in
 * this schema. The gate here mirrors that; the SQL is what enforces it.
 *
 * Until this page existed the row could only be changed in SQL, and the Waitlist
 * page linked at /dashboard/settings, which has never carried these controls.
 */
export default async function WaitlistSettingsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/settings/waitlist')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || !isAdmin(profile.role)) redirect('/dashboard/settings')

  // `scheduled_job_status()` returns no rows when pg_cron is not enabled — a
  // setup state, not an error, and the same thing the Settings index renders as
  // "not scheduled yet".
  const [{ data: settings }, { data: jobs }, { count: waiting }, { count: holding }] =
    await Promise.all([
      supabase
        // One string literal: postgrest-js parses the select at the type level,
        // and 'a' + 'b' widens to `string`, collapsing the result to
        // SelectQueryError.
        .from('waitlist_settings')
        .select(
          'id, auto_notify, batch_size, claim_window_minutes, urgent_within_hours, max_offers_per_entry, default_expiry_days, urgent_max_recipients, updated_at'
        )
        .eq('id', 1)
        .maybeSingle(),
      supabase.rpc('scheduled_job_status'),
      supabase
        .from('waitlist_entries')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'waiting'),
      supabase
        .from('waitlist_entries')
        .select('id', { count: 'exact', head: true })
        .eq('status', 'notified'),
    ])

  const job = (jobs ?? []).find((j) => j.jobname === JOB_NAME) ?? null
  const jobFailed = Boolean(job?.last_status && job.last_status !== 'succeeded')

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Waitlist rules</h1>
        <Link
          href="/dashboard/waitlist"
          className="label-caps text-[var(--color-muted)] hover:text-[var(--color-accent)]"
        >
          The waitlist
        </Link>
      </div>

      <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
        A cancelled appointment is a chair going empty and a client who wanted that
        time. These decide who is told about it, how many of them at once, and how
        long the person at the front is given before the next one hears.
      </p>

      <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-[var(--color-muted)]">
        <span>
          {waiting ?? 0} {waiting === 1 ? 'person is' : 'people are'} waiting right now
        </span>
        {(holding ?? 0) > 0 && (
          <Badge tone="accent">{holding} holding an offer</Badge>
        )}
      </p>

      {/* What actually applies these rules. Two different mechanisms, and the
          difference matters when pg_cron is off: the offer at the moment of
          cancellation is a trigger on `appointments` and runs regardless, while
          everything after it — releasing a claim that ran out, passing the slot
          to the next person — only happens when the sweep runs. */}
      <section className="mt-8">
        {job ? (
          <div className="flex flex-wrap items-center justify-between gap-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <div className="min-w-0">
              <p className="text-sm">Offering freed slots to whoever is waiting</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--color-muted)]">
                <Clock className="h-3 w-3" strokeWidth={1.75} />
                <span className="tabular-nums">{job.schedule}</span>
                <span aria-hidden>·</span>
                {job.last_run
                  ? `last ran ${new Date(job.last_run).toLocaleString('en-US', {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}`
                  : 'not run yet'}
              </p>
            </div>
            {!job.active ? (
              <Badge tone="warning">Paused</Badge>
            ) : jobFailed ? (
              <Badge tone="danger">
                <AlertTriangle className="h-3 w-3" strokeWidth={2} />
                {job.last_status}
              </Badge>
            ) : (
              <Badge tone="success">
                <Check className="h-3 w-3" strokeWidth={2.5} />
                Running
              </Badge>
            )}
          </div>
        ) : (
          <div className="border-l-2 border-amber-500 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-transparent dark:text-amber-300">
            <p className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
              <span>
                Not scheduled yet. Turn on <strong>pg_cron</strong> under Database →
                Extensions in Supabase, then re-run migration 044. Until then the offer
                sent at the moment of cancellation still goes out — that one is a
                trigger, and it follows the first switch below — but nothing moves after
                it: a claim that runs out is never released, and the next person in line
                is never told until someone presses &ldquo;Check for openings&rdquo; on
                the Waitlist page.
              </span>
            </p>
          </div>
        )}
        <p className="mt-3 max-w-prose text-xs leading-relaxed text-[var(--color-muted)]">
          These rules are applied by a job inside the database — every ten minutes, as
          migration 044 sets it up. Each pass releases the claims that have run out and
          passes every open slot to the next person in line. Nothing here needs
          pressing; the button on the Waitlist page runs the same sweep by hand.
        </p>
      </section>

      <section className="mt-10">
        {settings ? (
          <WaitlistRulesForm settings={settings as WaitlistSettings} />
        ) : (
          <p className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
            No waitlist settings row — run migration 037.
          </p>
        )}
      </section>

      <section className="mt-14">
        <h2 className="display text-2xl">What none of this changes</h2>
        <ul className="mt-5 space-y-3 text-sm text-[var(--color-muted)]">
          <li>
            <span className="text-[var(--color-foreground)]">The order of the queue</span>{' '}
            &mdash; first come, first served, by the time the request was made. It is not
            configurable, and editing a request would move someone up it, so a client can
            withdraw and rejoin but never edit.
          </li>
          <li>
            <span className="text-[var(--color-foreground)]">Who matches a slot</span>{' '}
            &mdash; the client&rsquo;s own dates, days, times, chosen services and named
            provider, all read in the location&rsquo;s own timezone. Whoever cancelled is
            never offered their own slot back.
          </li>
          <li>
            <span className="text-[var(--color-foreground)]">How they hear</span> &mdash; a
            message thread on their record, so a reply of &ldquo;yes please&rdquo; or
            &ldquo;could you do half an hour later&rdquo; comes back as an ordinary
            conversation, plus a notification carrying the booking link.
          </li>
          <li>
            <span className="text-[var(--color-foreground)]">
              Five open requests per client
            </span>{' '}
            &mdash; a waitlist is a queue, not a ticket you buy in bulk.
          </li>
        </ul>
      </section>
    </div>
  )
}
