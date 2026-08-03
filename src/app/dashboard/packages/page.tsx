import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Layers, ScanLine, Ticket } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { EmptyState, HowItWorks, Panel, StatTile } from '@/components/ui/dashboard'
import {
  PackageEditor,
  type EditablePackage,
  type PackageServiceOption,
} from '@/components/shared/PackageEditor'
import { formatMoney } from '@/lib/utils'
import { requestNow } from '@/lib/time'
import { isAdmin, isFrontDesk, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * The catalogue: what a package IS, before anybody has bought one.
 *
 * Writes to `service_packages` are `is_admin()` in 008 — a manager may price a
 * single service but not a course of them — so the editor only appears for an
 * admin. Everybody front desk and up can read the list, because selling one at
 * the till means knowing what is on it.
 *
 * The three figures at the top are counts, not money. "What the studio still
 * owes in treatments" is genuinely useful and genuinely not a dollar amount:
 * getting there means dividing a package price by its sessions, and that
 * quotient is not a sum anyone is owed. Sessions are the unit a package is
 * denominated in, so sessions are what gets counted.
 */
export default async function PackagesCataloguePage() {
  const supabase = await createClient()
  const now = requestNow()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/packages')

  const [{ data: profile }, { data: packages }, { data: services }, { data: held }] =
    await Promise.all([
      supabase.from('profiles').select('role').eq('id', user.id).maybeSingle(),
      supabase
        .from('service_packages')
        .select(
          'id, name, slug, description, service_id, session_count, price_cents, valid_days, is_active, sort_order, services(name, price_cents)'
        )
        .order('sort_order')
        .order('name'),
      supabase
        .from('services')
        .select('id, name, price_cents')
        .eq('is_active', true)
        .order('sort_order')
        .order('name'),
      supabase
        .from('client_packages')
        .select('id, package_id, sessions_total, sessions_remaining, expires_at'),
    ])

  const role = (profile?.role ?? 'provider') as UserRole
  if (!isFrontDesk(role)) redirect('/dashboard')
  const canEdit = isAdmin(role)

  const rows = packages ?? []
  const balances = held ?? []

  // Live = still has sessions on it and has not lapsed. Nothing in the schema
  // enforces the expiry, so it is applied here — see PackageBalanceCard.
  const live = balances.filter(
    (b) =>
      b.sessions_remaining > 0 &&
      (!b.expires_at || new Date(b.expires_at).getTime() > now)
  )
  const sessionsOutstanding = live.reduce((sum, b) => sum + b.sessions_remaining, 0)
  const liveIds = new Set(live.map((b) => b.id))

  const soldByPackage = new Map<number, { sold: number; outstanding: number }>()
  for (const b of balances) {
    const entry = soldByPackage.get(b.package_id) ?? { sold: 0, outstanding: 0 }
    entry.sold += 1
    if (liveIds.has(b.id)) entry.outstanding += b.sessions_remaining
    soldByPackage.set(b.package_id, entry)
  }

  const serviceOptions: PackageServiceOption[] = (services ?? []).map((s) => ({
    id: s.id,
    name: s.name,
    price_cents: s.price_cents,
  }))

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <p className="label-caps text-[var(--color-muted)]">
          {rows.filter((p) => p.is_active).length} sellable · {rows.length} total
        </p>
        <div className="flex flex-wrap items-center gap-2.5">
          <ButtonLink href="/gift-cards" target="_blank" rel="noreferrer" variant="outline" size="sm">
            View public page
          </ButtonLink>
          {canEdit && <PackageEditor services={serviceOptions} />}
        </div>
      </div>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <StatTile label="On the list" value={rows.filter((p) => p.is_active).length} />
        <StatTile
          label="Balances held"
          value={live.length}
          hint={balances.length > live.length ? `${balances.length} bought all told` : undefined}
        />
        <StatTile
          label="Sessions owed"
          value={sessionsOutstanding}
          hint="Treatments already paid for and not yet given"
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          className="mt-10"
          icon={Layers}
          title="No packages yet"
          description={
            canEdit
              ? 'A package is a service, a number of sessions, and one price. Add one and it appears at the till and on the public gift cards page.'
              : 'Nothing is set up to sell yet. Pricing a course is an admin job — ask them to add one.'
          }
          action={canEdit ? <PackageEditor services={serviceOptions} /> : undefined}
        />
      ) : (
        <ul className="mt-10 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {rows.map((p) => {
            const service = p.services as { name: string; price_cents: number } | null
            const counts = soldByPackage.get(p.id) ?? { sold: 0, outstanding: 0 }
            const sessions = Math.max(p.session_count, 1)
            // Display only, never charged: what one session works out at, and
            // what the course saves against buying them singly. Both derived
            // from integer cents; `price_cents` is the only figure that moves.
            const perSessionCents = Math.round(p.price_cents / sessions)
            const listCents = service ? service.price_cents * sessions : 0
            const savingCents = listCents - p.price_cents

            const editable: EditablePackage = {
              id: p.id,
              name: p.name,
              slug: p.slug,
              description: p.description,
              service_id: p.service_id,
              session_count: p.session_count,
              price_cents: p.price_cents,
              valid_days: p.valid_days,
              is_active: p.is_active,
              sort_order: p.sort_order,
            }

            return (
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-x-8 gap-y-3 py-6">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2.5">
                    <h2 className="text-base">{p.name}</h2>
                    {!p.is_active && <Badge tone="neutral" size="sm">Off</Badge>}
                    {listCents > 0 && savingCents > 0 && (
                      <Badge tone="accent" size="sm">Saves {formatMoney(savingCents)}</Badge>
                    )}
                  </div>

                  <p className="mt-1.5 text-sm text-[var(--color-muted)]">
                    {p.session_count} × {service?.name ?? 'any service'}
                    {' · '}
                    {p.valid_days > 0 ? `valid ${p.valid_days} days` : 'never expires'}
                  </p>

                  {p.description && (
                    <p className="mt-2 max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
                      {p.description}
                    </p>
                  )}

                  <p className="mt-2 text-xs text-[var(--color-muted)]">
                    {counts.sold === 0 ? (
                      'None sold yet'
                    ) : (
                      <>
                        {counts.sold} sold ·{' '}
                        <Link
                          href={`/dashboard/packages/balances?package=${p.id}`}
                          className="underline underline-offset-4"
                        >
                          {counts.outstanding} sessions outstanding
                        </Link>
                      </>
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 items-start gap-6">
                  <div className="text-right">
                    <p className="display text-xl tabular-nums">{formatMoney(p.price_cents)}</p>
                    <p className="mt-0.5 text-xs tabular-nums text-[var(--color-muted)]">
                      {formatMoney(perSessionCents)} a session
                    </p>
                  </div>
                  {canEdit && (
                    <PackageEditor pkg={editable} services={serviceOptions} trigger="link" />
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}

      <HowItWorks
        className="mt-16"
        title="How a package runs"
        items={[
          {
            icon: Layers,
            title: 'Price the course',
            body: 'A service, how many sessions, and one price for the lot. Admin only — a course is a pricing decision, not a menu edit.',
          },
          {
            icon: ScanLine,
            title: 'Sell it at the till',
            body: (
              <>
                <Link href="/dashboard/sell" className="underline underline-offset-4">
                  Sell
                </Link>{' '}
                takes the money once and opens the balance. It has to go to a client
                account — a balance is something a person holds, so a walk-in name will
                not do.
              </>
            ),
          },
          {
            icon: Ticket,
            title: 'Spend it at checkout',
            body: 'On the visit, one session comes off the balance and the same amount comes off what is owed. The client does not pay twice, and one visit can never take two sessions of the same package.',
          },
        ]}
      />

      <Panel className="mt-8 p-6">
        <p className="max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
          Deleting a package that anyone has bought is refused by the database — their
          sessions point at it. Switch it off instead: it leaves the till and the public
          page, and every balance already sold carries on working.
        </p>
      </Panel>
    </div>
  )
}
