import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Ticket } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { Avatar, EmptyState, Panel, SearchField, StatTile } from '@/components/ui/dashboard'
import { PackageRedeem } from '@/components/shared/PackageRedeem'
import { requestNow, DAY_MS } from '@/lib/time'
import { isFrontDesk, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

const FALLBACK_TZ = 'America/Los_Angeles'

interface Props {
  searchParams: Promise<{ q?: string; package?: string; show?: string }>
}

/**
 * Every package anybody is still holding.
 *
 * The ledger side of the feature: who paid for what, how much of it is left,
 * and whether it is about to lapse. Sessions rather than money, for the same
 * reason as the catalogue — a package is denominated in treatments.
 *
 * The filter lives in the URL rather than in state, so a list can be refreshed
 * or sent to someone. Searching by client goes through `profiles` first and
 * then narrows `client_packages` by id, because PostgREST cannot filter a row
 * by a column on the table it embeds.
 *
 * Spending a session is possible from here as well as from the visit itself.
 * Both call the same action, and the picker shows what each visit still owes so
 * nobody burns a session on one that is already settled.
 */
export default async function PackageBalancesPage({ searchParams }: Props) {
  const { q, package: packageParam, show } = await searchParams
  const supabase = await createClient()
  const now = requestNow()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/packages/balances')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'provider') as UserRole
  if (!isFrontDesk(role)) redirect('/dashboard')

  const search = q?.trim() ?? ''
  const packageId = Number(packageParam)
  const showAll = show === 'all'

  // Narrow by client first: a filter on an embedded table's column is not
  // something PostgREST can express, so the ids come from `profiles` and the
  // balance query takes them as an `in`.
  let clientIds: string[] | null = null
  if (search) {
    const { data: matches } = await supabase
      .from('profiles')
      .select('id')
      .eq('role', 'client')
      .or(
        `first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`
      )
      .limit(100)
    clientIds = (matches ?? []).map((m) => m.id)
  }

  let query = supabase
    .from('client_packages')
    .select(
      'id, client_id, package_id, sessions_total, sessions_remaining, purchased_at, expires_at, order_id, profiles!client_packages_client_id_fkey(first_name, last_name, email), service_packages(id, name, service_id, services(name))'
    )
    .order('purchased_at', { ascending: false })
    .limit(200)

  if (clientIds !== null) query = query.in('client_id', clientIds)
  if (Number.isInteger(packageId) && packageId > 0) query = query.eq('package_id', packageId)

  const [{ data: held }, { data: locations }] = await Promise.all([
    query,
    supabase.from('locations').select('timezone, is_active, sort_order').order('sort_order'),
  ])

  const sites = locations ?? []
  const timeZone = sites.find((l) => l.is_active)?.timezone ?? sites[0]?.timezone ?? FALLBACK_TZ

  const all = (held ?? []).map((row) => {
    const expiresAt = row.expires_at ? new Date(row.expires_at).getTime() : null
    const expired = expiresAt !== null && expiresAt <= now
    return {
      row,
      expiresAt,
      expired,
      expiringSoon: expiresAt !== null && !expired && expiresAt - now <= 30 * DAY_MS,
      live: row.sessions_remaining > 0 && !expired,
    }
  })

  const shown = showAll ? all : all.filter((b) => b.live)
  const sessionsOutstanding = all
    .filter((b) => b.live)
    .reduce((sum, b) => sum + b.row.sessions_remaining, 0)
  const lapsing = all.filter((b) => b.expiringSoon).length

  const hrefWith = (next: Record<string, string | undefined>) => {
    const params = new URLSearchParams()
    const merged = { q: search || undefined, package: packageParam, show, ...next }
    for (const [key, value] of Object.entries(merged)) {
      if (value) params.set(key, value)
    }
    const qs = params.toString()
    return qs ? `/dashboard/packages/balances?${qs}` : '/dashboard/packages/balances'
  }

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-3">
        <StatTile label="Balances live" value={all.filter((b) => b.live).length} />
        <StatTile label="Sessions owed" value={sessionsOutstanding} />
        <StatTile
          label="Lapsing soon"
          value={lapsing}
          hint="Expiring inside 30 days"
        />
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        <form method="get" className="flex flex-wrap items-center gap-2.5">
          {packageParam && <input type="hidden" name="package" value={packageParam} />}
          {show && <input type="hidden" name="show" value={show} />}
          <SearchField
            label="Search by client"
            name="q"
            defaultValue={search}
            className="w-full sm:w-72"
          />
        </form>

        <div className="flex flex-wrap items-center gap-4">
          {packageParam && (
            <Link href={hrefWith({ package: undefined })} className="label-caps text-[var(--color-muted)]">
              Clear package filter
            </Link>
          )}
          <Link
            href={hrefWith({ show: showAll ? undefined : 'all' })}
            className="label-caps text-[var(--color-muted)]"
          >
            {showAll ? 'Live only' : 'Show used and expired'}
          </Link>
        </div>
      </div>

      {shown.length === 0 ? (
        <EmptyState
          className="mt-8"
          icon={Ticket}
          title={search ? `Nothing for “${search}”` : 'No balances yet'}
          description={
            search
              ? 'That client has not bought a package, or the name is spelled differently on their account.'
              : 'Nobody is holding prepaid sessions. Sell a package at the till and it appears here.'
          }
        />
      ) : (
        <ul className="mt-8 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {shown.map(({ row, expired, expiringSoon, live }) => {
            const person = row.profiles as {
              first_name: string | null
              last_name: string | null
              email: string | null
            } | null
            const name =
              `${person?.first_name ?? ''} ${person?.last_name ?? ''}`.trim() ||
              person?.email ||
              'Client'

            const definition = row.service_packages as unknown as {
              id: number
              name: string
              service_id: number | null
              services: { name: string } | null
            } | null

            const spent = row.sessions_total - row.sessions_remaining
            const expiryLabel =
              row.expires_at === null
                ? 'never expires'
                : new Date(row.expires_at).toLocaleDateString('en-US', { timeZone })

            return (
              <li key={row.id} className="py-6">
                <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
                  <div className="flex min-w-0 flex-1 items-start gap-3.5">
                    <Avatar name={name} />
                    <div className="min-w-0">
                      <Link
                        href={`/dashboard/clients/${row.client_id}`}
                        className="text-base underline-offset-4 hover:underline"
                      >
                        {name}
                      </Link>
                      <p className="mt-1 text-sm text-[var(--color-muted)]">
                        {definition?.name ?? 'Package'} ·{' '}
                        {definition?.services?.name ?? 'any service'}
                      </p>
                      <p className="mt-1 text-xs text-[var(--color-muted)]">
                        Bought{' '}
                        {new Date(row.purchased_at).toLocaleDateString('en-US', { timeZone })}
                        {' · '}
                        {expiryLabel === 'never expires' ? expiryLabel : `expires ${expiryLabel}`}
                        {row.order_id !== null && (
                          <>
                            {' · '}
                            <Link
                              href="/dashboard/orders"
                              className="underline underline-offset-4"
                            >
                              order #{row.order_id}
                            </Link>
                          </>
                        )}
                      </p>
                    </div>
                  </div>

                  <div className="shrink-0 text-right">
                    <p className="display text-xl tabular-nums">
                      {row.sessions_remaining}
                      <span className="text-[var(--color-muted)]"> / {row.sessions_total}</span>
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                      {spent} used
                    </p>
                    <div className="mt-2 flex justify-end gap-2">
                      {expired && <Badge tone="danger" size="sm">Expired</Badge>}
                      {expiringSoon && <Badge tone="warning" size="sm">Lapsing</Badge>}
                      {!expired && row.sessions_remaining === 0 && (
                        <Badge tone="neutral" size="sm">Fully used</Badge>
                      )}
                    </div>
                  </div>
                </div>

                {live && row.client_id && (
                  <div className="mt-3">
                    <PackageRedeem
                      clientPackageId={row.id}
                      clientId={row.client_id}
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

      <Panel className="mt-10 p-6">
        <p className="max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
          Spending a session writes the credit against the visit, so what the client owes
          at the end of the appointment already has it taken off. One visit can only ever
          take one session of the same package — the database refuses the second, whoever
          is pressing the button.
        </p>
      </Panel>
    </div>
  )
}
