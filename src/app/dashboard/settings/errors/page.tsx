import { redirect } from 'next/navigation'
import { AlertTriangle, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { requestNow, formatDateTimeInTimeZone } from '@/lib/time'
import { Badge } from '@/components/ui/badge'
import { isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * The incident log — migration 058.
 *
 * The answer to "a client phoned saying booking failed yesterday afternoon".
 * Vercel keeps about an hour of logs; these rows keep thirty days. Each is a
 * failure the server thought worth recording: a booking insert that was
 * refused, a Stripe write that will be retried, a calendar push that means a
 * provider's phone is missing an appointment.
 */
export default async function ErrorsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/settings/errors')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, timezone')
    .eq('id', user.id)
    .maybeSingle()

  if (!isManager((profile?.role ?? 'provider') as UserRole)) redirect('/dashboard/settings')

  const timeZone = profile?.timezone ?? 'America/Los_Angeles'

  // This page practises what 058 preaches: its own read error is shown as an
  // outage, not as a comfortingly empty log.
  const { data: rows, error: readError } = await supabase
    .from('app_errors')
    .select('id, scope, message, context, digest, created_at')
    .order('created_at', { ascending: false })
    .limit(200)

  const dayAgo = requestNow() - 86_400_000
  const lastDay = (rows ?? []).filter((r) => new Date(r.created_at).getTime() > dayAgo).length

  return (
    <div>
      <h1 className="display text-3xl">What went wrong</h1>
      <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
        Failures the server recorded in the last thirty days — the place to look when a
        client says something did not work. A quiet page is a healthy studio. References
        here match the code shown on error screens.
      </p>

      {readError ? (
        <p className="mt-10 flex items-start gap-2 border-l-2 border-amber-600 bg-amber-50 p-4 text-sm text-amber-900 dark:bg-transparent dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
          <span>
            The log itself could not be read just now — which is a finding of its own, not
            an empty log. If migration 058 has not been run yet, this page has nothing to
            read from.
          </span>
        </p>
      ) : (rows ?? []).length === 0 ? (
        <div className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
          <Check className="mx-auto h-6 w-6 text-[var(--color-accent)]" strokeWidth={1.5} />
          <p className="mt-3 text-sm">Nothing recorded in the last thirty days.</p>
        </div>
      ) : (
        <>
          {lastDay > 0 && (
            <p className="mt-8">
              <Badge tone="warning">
                <AlertTriangle className="h-3 w-3" strokeWidth={2} />
                {lastDay} in the last 24 hours
              </Badge>
            </p>
          )}
          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {(rows ?? []).map((r) => (
              <li key={r.id} className="py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{r.scope}</Badge>
                  <span className="text-xs text-[var(--color-muted)]">
                    {formatDateTimeInTimeZone(new Date(r.created_at), timeZone)}
                  </span>
                  {r.digest && (
                    <span className="font-mono text-xs text-[var(--color-muted)]">{r.digest}</span>
                  )}
                </div>
                <p className="mt-1.5 break-words font-mono text-sm">{r.message}</p>
                {r.context && Object.keys(r.context as object).length > 0 && (
                  <p className="mt-1 break-words text-xs text-[var(--color-muted)]">
                    {Object.entries(r.context as Record<string, unknown>)
                      .map(([k, v]) => `${k}: ${String(v)}`)
                      .join(' · ')}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  )
}
