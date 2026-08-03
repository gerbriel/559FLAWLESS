import { BadgeCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ClientMembershipControls } from '@/components/shared/ClientMembershipControls'
import { formatMoney } from '@/lib/utils'
import { formatDateInTimeZone } from '@/lib/time'
import {
  MEMBERSHIP_CHARGE_STATUS_LABELS,
  MEMBERSHIP_STATUS_LABELS,
  describeMembershipBenefit,
  membershipIsCurrent,
  membershipPeriodLabel,
  type ClientMembership,
  type Membership,
  type MembershipCharge,
} from '@/types/memberships'

/**
 * The membership on a client's record.
 *
 * A server component that reads with the VIEWER'S own client, so RLS decides
 * what it can see rather than this file. Staff read every membership; the
 * client themself reads their own and nothing here writes on their behalf —
 * there is no client INSERT or UPDATE policy on `client_memberships` at all.
 *
 * It fetches for itself rather than taking props from the client page. That
 * page already runs sixteen queries in two batches to keep postgrest-js's
 * type-level select parsing under TS2589, and adding three more to the
 * destructure is how that limit is found again.
 *
 * The panel states the period end plainly, in the studio's zone, because that
 * date is the only thing that decides whether the benefit applies. Not the
 * status badge — the date.
 */
export async function ClientMembershipPanel({
  clientId,
  canManage,
  timeZone,
  now,
}: {
  clientId: string
  /** Managers see the controls. Everyone else sees the facts. */
  canManage: boolean
  timeZone: string
  /** From requestNow() in the page — one clock reading per request. */
  now: number
}) {
  const supabase = await createClient()

  const [{ data: rows }, { data: plans }] = await Promise.all([
    supabase
      // One string literal: postgrest-js parses the select at the type level,
      // and `'a' + 'b'` widens to `string`, collapsing the result type.
      .from('client_memberships')
      .select(
        'id, client_id, membership_id, status, price_cents_snapshot, started_at, current_period_start, current_period_end, cancel_at_period_end, cancelled_at, ended_at, note, memberships!client_memberships_membership_id_fkey(id, name, slug, description, price_cents, period_months, service_discount_pct, included_sessions_per_period, is_active, sort_order)'
      )
      .eq('client_id', clientId)
      .order('started_at', { ascending: false })
      .limit(5),
    canManage
      ? supabase
          .from('memberships')
          .select(
            'id, name, slug, description, price_cents, period_months, service_discount_pct, included_sessions_per_period, stripe_price_id, is_active, sort_order, created_at, updated_at'
          )
          .eq('is_active', true)
          .order('sort_order')
          .order('id')
      : Promise.resolve({ data: [] as Membership[] }),
  ])

  const held = (rows ?? []) as (Pick<
    ClientMembership,
    | 'id'
    | 'client_id'
    | 'membership_id'
    | 'status'
    | 'price_cents_snapshot'
    | 'started_at'
    | 'current_period_start'
    | 'current_period_end'
    | 'cancel_at_period_end'
    | 'cancelled_at'
    | 'ended_at'
    | 'note'
  > & { memberships: unknown })[]

  // At most one is live — a partial unique index in 050 makes sure of it.
  const live = held.find((h) => membershipIsCurrent(h, now)) ?? null

  const [{ data: charges }, { data: spent }] = await Promise.all([
    live
      ? supabase
          .from('membership_charges')
          .select(
            'id, client_membership_id, period_start, period_end, amount_cents, status, method, paid_at, note'
          )
          .eq('client_membership_id', live.id)
          .order('period_start', { ascending: false })
          .limit(6)
      : Promise.resolve({ data: [] as MembershipCharge[] }),
    live
      ? supabase
          .from('membership_redemptions')
          .select('sessions')
          .eq('client_membership_id', live.id)
          .eq('redeemed_for_period_start', live.current_period_start)
      : Promise.resolve({ data: [] as { sessions: number }[] }),
  ])

  const chargeRows = (charges ?? []) as Pick<
    MembershipCharge,
    'id' | 'period_start' | 'period_end' | 'amount_cents' | 'status' | 'method' | 'paid_at'
  >[]
  const dueChargeIds = chargeRows
    .filter((c) => c.status === 'due')
    .sort((a, b) => a.period_start.localeCompare(b.period_start))
    .map((c) => c.id)

  const plan = live ? (live.memberships as unknown as Membership | null) : null
  const sessionsSpent = (spent ?? []).reduce((n, r) => n + r.sessions, 0)
  const lapsed = held.find((h) => !membershipIsCurrent(h, now)) ?? null

  return (
    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h3 className="label-caps mb-5 flex items-center gap-2 text-[var(--color-accent)]">
        <BadgeCheck className="h-3.5 w-3.5" strokeWidth={2} />
        Membership
      </h3>

      {live && plan ? (
        <div className="space-y-3 text-sm">
          <p className="flex flex-wrap items-center gap-2.5">
            <span>{plan.name}</span>
            <Badge tone={live.cancel_at_period_end ? 'warning' : 'success'}>
              {live.cancel_at_period_end ? 'Ending' : MEMBERSHIP_STATUS_LABELS[live.status]}
            </Badge>
          </p>

          <p className="tabular-nums text-[var(--color-muted)]">
            {formatMoney(live.price_cents_snapshot)} /{' '}
            {membershipPeriodLabel(plan.period_months)}
            {live.price_cents_snapshot !== plan.price_cents && (
              <span className="ml-2 text-xs">
                (joined before the price changed to {formatMoney(plan.price_cents)})
              </span>
            )}
          </p>

          <p className="text-xs text-[var(--color-muted)]">
            {describeMembershipBenefit(plan)}
          </p>

          {plan.included_sessions_per_period > 0 && (
            <p className="text-xs text-[var(--color-muted)]">
              {sessionsSpent} of {plan.included_sessions_per_period} used this period.
            </p>
          )}

          <p className="text-xs text-[var(--color-muted)]">
            {live.cancel_at_period_end ? 'Ends' : 'Renews'}{' '}
            {formatDateInTimeZone(new Date(live.current_period_end), timeZone)}. The
            benefit stops that day whether or not anyone renews it.
          </p>

          {chargeRows.length > 0 && (
            <ul className="space-y-1.5 border-t border-[var(--color-border)] pt-3 text-xs">
              {chargeRows.map((c) => (
                <li key={c.id} className="flex items-baseline justify-between gap-3">
                  <span className="text-[var(--color-muted)]">
                    {formatDateInTimeZone(new Date(c.period_start), timeZone)}
                  </span>
                  <span className="tabular-nums">{formatMoney(c.amount_cents)}</span>
                  <span
                    className={
                      c.status === 'due' || c.status === 'failed'
                        ? 'text-amber-700 dark:text-amber-400'
                        : 'text-[var(--color-muted)]'
                    }
                  >
                    {MEMBERSHIP_CHARGE_STATUS_LABELS[c.status]}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {live.note && (
            <p className="border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-muted)]">
              {live.note}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2 text-sm text-[var(--color-muted)]">
          <p>No membership.</p>
          {lapsed && (
            <p className="text-xs">
              Last one {MEMBERSHIP_STATUS_LABELS[lapsed.status].toLowerCase()}, period
              ended {formatDateInTimeZone(new Date(lapsed.current_period_end), timeZone)}.
            </p>
          )}
        </div>
      )}

      {canManage && (
        <div className="mt-5 border-t border-[var(--color-border)] pt-5">
          <ClientMembershipControls
            clientId={clientId}
            liveMembershipId={live?.id ?? null}
            plans={(plans ?? []) as Membership[]}
            dueChargeIds={dueChargeIds}
            cancelAtPeriodEnd={live?.cancel_at_period_end ?? false}
          />
        </div>
      )}
    </section>
  )
}
