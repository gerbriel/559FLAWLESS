import Link from 'next/link'
import { AlertTriangle, Ticket } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { requestNow, DAY_MS } from '@/lib/time'
import { PackageRedeem } from '@/components/shared/PackageRedeem'

/**
 * What a client has prepaid, and what is left of it.
 *
 * A card for the client record. `client_packages` is `client_id = auth.uid()`
 * for a client and `is_front_desk()` for staff (008), so this runs as whoever
 * is looking and shows nothing it should not — there is no service-role client
 * anywhere near it.
 *
 * Sessions are the unit, not money. A package is bought once and drawn down in
 * treatments; quoting a dollar value for "what is left" would mean dividing the
 * price by the sessions, and that figure is not what anybody is owed.
 *
 * Expiry is shown because nothing in the schema enforces it — `expires_at` is
 * a plain nullable column with no trigger behind it, and the only thing that
 * refuses an expired balance is `redeemSession`. A date the desk can see is
 * how a client gets told before it lapses rather than after.
 */
export async function PackageBalanceCard({
  clientId,
  timeZone,
  canRedeem = false,
  now = requestNow(),
}: {
  clientId: string
  timeZone: string
  /** Front desk and up. A provider sees the balance but does not spend it. */
  canRedeem?: boolean
  now?: number
}) {
  const supabase = await createClient()

  const { data: held } = await supabase
    .from('client_packages')
    .select(
      'id, sessions_total, sessions_remaining, purchased_at, expires_at, order_id, service_packages(id, name, service_id, session_count, services(name))'
    )
    .eq('client_id', clientId)
    .order('purchased_at', { ascending: false })

  const rows = held ?? []

  return (
    <section
      data-ui="panel"
      className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <h3 className="label-caps mb-5 text-[var(--color-accent)]">Prepaid packages</h3>

      {rows.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Nothing prepaid.{' '}
          <Link href="/dashboard/sell" className="underline underline-offset-4">
            Sell a package
          </Link>{' '}
          at the till.
        </p>
      ) : (
        <ul className="space-y-5">
          {rows.map((row) => {
            const definition = row.service_packages as unknown as {
              id: number
              name: string
              service_id: number | null
              session_count: number
              services: { name: string } | null
            } | null

            const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null
            const expired = expiresAt !== null && expiresAt <= now
            const expiringSoon =
              expiresAt !== null && !expired && expiresAt - now <= 30 * DAY_MS
            const expiryLabel =
              expiresAt === null
                ? ''
                : new Date(expiresAt).toLocaleDateString('en-US', { timeZone })
            const spent = row.sessions_total - row.sessions_remaining
            const live = row.sessions_remaining > 0 && !expired

            return (
              <li key={row.id}>
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <span className="text-sm">{definition?.name ?? 'Package'}</span>
                  <span className="shrink-0 text-sm tabular-nums">
                    {row.sessions_remaining} of {row.sessions_total} left
                  </span>
                </div>

                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {definition?.services?.name ?? 'Any service'}
                  {spent > 0 && ` · ${spent} used`}
                  {' · bought '}
                  {new Date(row.purchased_at).toLocaleDateString('en-US', { timeZone })}
                </p>

                {/* The bar is the whole point of the card at a glance: how much
                    of what they paid for is still theirs. */}
                <div
                  className="mt-2 h-1 w-full bg-[var(--color-border)]"
                  role="img"
                  aria-label={`${row.sessions_remaining} of ${row.sessions_total} sessions left`}
                >
                  <div
                    className={live ? 'h-1 bg-[var(--color-accent)]' : 'h-1 bg-[var(--color-muted)]'}
                    style={{
                      width: `${Math.round((row.sessions_remaining / Math.max(row.sessions_total, 1)) * 100)}%`,
                    }}
                  />
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {expired && (
                    <Badge tone="danger" size="sm">
                      <AlertTriangle className="h-3 w-3" strokeWidth={2} />
                      Expired {expiryLabel}
                    </Badge>
                  )}
                  {expiringSoon && (
                    <Badge tone="warning" size="sm">Expires {expiryLabel}</Badge>
                  )}
                  {!expired && row.sessions_remaining === 0 && (
                    <Badge tone="neutral" size="sm">
                      <Ticket className="h-3 w-3" strokeWidth={2} />
                      Fully used
                    </Badge>
                  )}
                </div>

                {canRedeem && live && (
                  <div className="mt-3">
                    <PackageRedeem
                      clientPackageId={row.id}
                      clientId={clientId}
                      packageName={definition?.name ?? 'Package'}
                      packageServiceId={definition?.service_id ?? null}
                      sessionsRemaining={row.sessions_remaining}
                      timeZone={timeZone}
                    />
                  </div>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
