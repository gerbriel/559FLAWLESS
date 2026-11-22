import Link from 'next/link'
import { GiveBackSession } from '@/components/shared/GiveBackSession'
import { BadgeCheck } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ClientMembershipControls, type EnrolPlan } from '@/components/shared/ClientMembershipControls'
import { MemberRenewalToggle } from '@/components/shared/MemberRenewalToggle'
import { formatMoney } from '@/lib/utils'
import {
  ChargeActions,
  RecordPerkUseForm,
  RecordSessionForm,
  RemovePerkUse,
  type CoveredTreatment,
} from '@/components/shared/MembershipUsageControls'
import {
  dateKeyInTimeZone,
  dayLabelForDateKey,
  formatDateInTimeZone,
  zonedTimeToUtc,
} from '@/lib/time'
import {
  MEMBERSHIP_CHARGE_STATUS_LABELS,
  MEMBERSHIP_STATUS_LABELS,
  allowancesLeftLabel,
  describeIncluded,
  describeProductPerk,
  includedAllowances,
  membershipIsCurrent,
  membershipPeriodLabel,
  type ClientMembership,
  type Membership,
  type MembershipCharge,
  type MembershipChargeMethod,
  type MembershipChargeStatus,
  type MembershipProductPerk,
} from '@/types/memberships'

const METHOD_LABELS: Record<MembershipChargeMethod, string> = {
  card: 'Card',
  cash: 'Cash',
  stripe: 'Stripe',
  other: 'Other',
}

const CHARGE_TONES: Record<MembershipChargeStatus, 'success' | 'warning' | 'danger' | 'neutral'> = {
  paid: 'success',
  due: 'warning',
  failed: 'danger',
  refunded: 'neutral',
  void: 'neutral',
}

/** A perk use as the panel reads it (087, hand-recorded ones from 089). */
type PerkUse = {
  id: number
  perk_id: number | null
  order_id: number | null
  discount_cents: number
  used_on: string | null
  note: string | null
  created_at: string
  orders: unknown
}

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
        'id, client_id, membership_id, status, price_cents_snapshot, started_at, current_period_start, current_period_end, cancel_at_period_end, cancelled_at, ended_at, note, auto_renew, stripe_subscription_id, memberships!client_memberships_membership_id_fkey(id, name, slug, description, price_cents, period_months, service_discount_pct, included_sessions_per_period, is_active, sort_order, membership_services(service_id, sessions_per_period, services(name)))'
      )
      .eq('client_id', clientId)
      .order('started_at', { ascending: false })
      .limit(5),
    canManage
      ? supabase
          .from('memberships')
          .select(
            'id, name, slug, description, price_cents, period_months, service_discount_pct, included_sessions_per_period, stripe_price_id, is_active, sort_order, created_at, updated_at, membership_services(service_id, sessions_per_period, services(name))'
          )
          .eq('is_active', true)
          .order('sort_order')
          .order('id')
      : Promise.resolve({ data: [] as EnrolPlan[] }),
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
    | 'auto_renew'
    | 'stripe_subscription_id'
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
          .select(
            'id, service_id, sessions, value_cents, redeemed_for_period_start, appointment_id, used_on, note, appointments!membership_redemptions_appointment_id_fkey(id, starts_at, status), services!membership_redemptions_service_id_fkey(name)'
          )
          .eq('client_membership_id', live.id)
          .eq('redeemed_for_period_start', live.current_period_start)
          .order('created_at')
      : Promise.resolve({ data: [] }),
  ])

  const chargeRows = (charges ?? []) as Pick<
    MembershipCharge,
    'id' | 'period_start' | 'period_end' | 'amount_cents' | 'status' | 'method' | 'paid_at' | 'note'
  >[]

  const plan = live ? (live.memberships as unknown as Membership | null) : null
  // Each allowance this period, per treatment or the shared pool (088).
  const planScope = (live?.memberships as unknown as {
    membership_services:
      | { service_id: number; sessions_per_period: number | null; services: { name: string } | null }[]
      | null
  } | null)?.membership_services ?? []
  // Today and the period's first day as calendar days in the studio's zone:
  // the date pickers' bounds and the perk windows are counted in those.
  const todayKey = dateKeyInTimeZone(new Date(now), timeZone)
  const periodStartKey = live
    ? dateKeyInTimeZone(new Date(live.current_period_start), timeZone)
    : todayKey
  const monthStartKey = `${todayKey.slice(0, 7)}-01`

  // A scope with no rows means any treatment may be spent from the pool, so
  // the "record a visit" picker needs the menu. Only then, and only for a
  // manager, is it read.
  const poolSize = plan?.included_sessions_per_period ?? 0
  const needMenu = canManage && !!live && planScope.length === 0 && poolSize > 0

  const [{ data: perkRows }, { data: perkUseRows }, { data: menu }] = await Promise.all([
    live
      ? supabase
          .from('membership_product_perks')
          .select(
            'id, membership_id, kind, percent_off, buy_qty, product_id, category_id, label, sort_order, max_uses, uses_window, max_units_per_use, products!membership_product_perks_product_id_fkey(name), product_categories!membership_product_perks_category_id_fkey(name)'
          )
          .eq('membership_id', live.membership_id)
          .order('sort_order')
          .order('id')
      : Promise.resolve({ data: [] }),
    live
      ? supabase
          .from('membership_perk_redemptions')
          .select(
            'id, perk_id, order_id, discount_cents, used_on, note, created_at, orders!membership_perk_redemptions_order_id_fkey(id, order_number, status)'
          )
          .eq('client_membership_id', live.id)
          .order('created_at', { ascending: false })
          .limit(200)
      : Promise.resolve({ data: [] }),
    needMenu
      ? supabase.from('services').select('id, name').eq('is_active', true).order('name')
      : Promise.resolve({ data: [] as { id: number; name: string }[] }),
  ])

  // What a hand-recorded visit may be spent on: per-treatment allowances
  // first, then the treatments the pool covers, or the whole menu when the
  // pool covers anything. The database checks cover again on the insert.
  const coveredTreatments: CoveredTreatment[] = []
  if (live && plan) {
    const seen = new Set<number>()
    const push = (id: number, name: string | null | undefined) => {
      if (seen.has(id)) return
      seen.add(id)
      coveredTreatments.push({ id, name: name?.trim() || 'Treatment' })
    }
    for (const r of planScope) if (r.sessions_per_period !== null) push(r.service_id, r.services?.name)
    if (poolSize > 0) {
      for (const r of planScope) if (r.sessions_per_period === null) push(r.service_id, r.services?.name)
      for (const m of (menu ?? []) as { id: number; name: string }[]) push(m.id, m.name)
    }
  }

  // Each perk with its uses inside its own window, the same counting as
  // perk_uses_so_far() in 089: an order's use stops counting once the order
  // is cancelled; 'period' counts by created_at; 'month' counts a hand row
  // by its used_on and anything else by created_at.
  const periodStartMs = live ? Date.parse(live.current_period_start) : 0
  const monthStartMs = zonedTimeToUtc(monthStartKey, '00:00', timeZone).getTime()
  const perkUses = (perkUseRows ?? []) as unknown as PerkUse[]
  const perks = ((perkRows ?? []) as unknown as (MembershipProductPerk & {
    products: { name: string } | null
    product_categories: { name: string } | null
  })[]).map((perk) => {
    const monthly = perk.uses_window === 'month'
    const windowKey = monthly ? monthStartKey : periodStartKey
    const windowMs = monthly ? monthStartMs : periodStartMs
    const uses = perkUses.filter((u) => {
      if (u.perk_id !== perk.id) return false
      if (u.order_id !== null) {
        const order = u.orders as { status: string } | null
        if (order && (order.status === 'cart' || order.status === 'cancelled')) return false
      }
      if (monthly && u.used_on) return u.used_on >= windowKey
      return Date.parse(u.created_at) >= windowMs
    })
    return {
      perk,
      line: describeProductPerk(perk, {
        product: perk.products?.name ?? null,
        category: perk.product_categories?.name ?? null,
      }),
      windowLabel: monthly ? 'this month' : 'this period',
      windowKey,
      uses,
    }
  })

  const allowances =
    live && plan
      ? includedAllowances(
          plan,
          planScope.map((r) => ({
            service_id: r.service_id,
            sessions_per_period: r.sessions_per_period,
            name: r.services?.name ?? null,
          })),
          ((spent ?? []) as { service_id: number | null; sessions: number; redeemed_for_period_start: string }[]),
          live.current_period_start
        )
      : []
  const leftLine = allowancesLeftLabel(allowances)
  const includedLine = plan
    ? describeIncluded(
        allowances,
        membershipPeriodLabel(plan.period_months),
        planScope.filter((r) => r.sessions_per_period === null).map((r) => r.services?.name ?? '')
      )
    : ''
  const benefitLine = plan
    ? [
        includedLine,
        plan.service_discount_pct > 0
          ? includedLine
            ? `${plan.service_discount_pct}% off the rest of the visit`
            : `${plan.service_discount_pct}% off every visit`
          : '',
      ]
        .filter(Boolean)
        .join(' · ')
    : ''
  const lapsed = held.find((h) => !membershipIsCurrent(h, now)) ?? null
  // A card Stripe could not charge. Not current (the benefit is paused), but
  // not over either: Stripe retries, and the member can fix the card.
  const failing = live ? null : (held.find((h) => h.status === 'past_due') ?? null)
  const failingPlan = failing ? (failing.memberships as unknown as Membership | null) : null
  // Still 'active' but its period has passed and the sweep has not reached it.
  // It holds the one-live index too, so it gets the controls, not the enrol form.
  const stale =
    live || failing ? null : (held.find((h) => h.status === 'active') ?? null)
  const controlled = live ?? failing ?? stale

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

          {benefitLine && (
            <p className="text-xs text-[var(--color-muted)]">{benefitLine}</p>
          )}

          {leftLine && (
            <p className="text-xs text-[var(--color-muted)]">{leftLine} this period.</p>
          )}

          {/* Which visits used them: a booked one links to its appointment, a
              hand-recorded one (089, no appointment) says so. For a manager
              either can be handed back (079). */}
          {(spent ?? []).length > 0 && (
            <ul className="space-y-1.5 border-t border-[var(--color-border)] pt-3 text-xs">
              {(spent ?? []).map((r) => {
                const appt = r.appointments as unknown as {
                  id: string
                  starts_at: string
                  status: string
                } | null
                const svc = r.services as unknown as { name: string } | null
                const byHand = r.appointment_id === null
                return (
                  <li key={r.id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
                    {appt ? (
                      <Link
                        href={`/dashboard/appointments/${appt.id}`}
                        className="min-w-0 flex-1 truncate underline-offset-4 hover:underline"
                      >
                        {svc?.name ?? 'Treatment'} ·{' '}
                        {formatDateInTimeZone(new Date(appt.starts_at), timeZone)}
                        {appt.status === 'no_show' && ' · no-show'}
                      </Link>
                    ) : byHand ? (
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">
                          {svc?.name ?? 'Treatment'}
                          {r.used_on && <> · {dayLabelForDateKey(r.used_on)}</>} · recorded by
                          staff
                        </span>
                        {r.note && (
                          <span className="block text-[var(--color-muted)]">{r.note}</span>
                        )}
                      </span>
                    ) : (
                      <span className="min-w-0 flex-1 truncate">{svc?.name ?? 'Treatment'}</span>
                    )}
                    {canManage && (
                      <GiveBackSession
                        redemptionId={r.id}
                        upcoming={
                          !!appt && ['pending', 'confirmed', 'checked_in'].includes(appt.status)
                        }
                      />
                    )}
                  </li>
                )
              })}
            </ul>
          )}

          {canManage && coveredTreatments.length > 0 && (
            <RecordSessionForm
              clientMembershipId={live.id}
              treatments={coveredTreatments}
              todayKey={todayKey}
              periodStartKey={periodStartKey}
            />
          )}

          {/* Retail perks on the plan (086), each with its uses inside its
              own window (087) and any recorded by hand (089). */}
          {perks.length > 0 && (
            <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
              <p className="label-caps text-[var(--color-muted)]">Perks</p>
              <ul className="space-y-3 text-xs">
                {perks.map(({ perk, line, windowLabel, windowKey, uses }) => (
                  <li key={perk.id} className="space-y-1.5">
                    <p>
                      {perk.label?.trim() || line}
                      {perk.label?.trim() && (
                        <span className="block text-[var(--color-muted)]">{line}</span>
                      )}
                    </p>
                    <p className="tabular-nums text-[var(--color-muted)]">
                      {perk.max_uses != null
                        ? `${uses.length} of ${perk.max_uses} used ${windowLabel}.`
                        : `Used ${uses.length} ${uses.length === 1 ? 'time' : 'times'} ${windowLabel}.`}
                    </p>
                    {uses.length > 0 && (
                      <ul className="space-y-1 pl-3">
                        {uses.map((u) => {
                          const order = u.orders as {
                            id: number
                            order_number: string | null
                          } | null
                          return (
                            <li
                              key={u.id}
                              className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1"
                            >
                              <span className="min-w-0 flex-1">
                                <span className="block">
                                  {u.used_on
                                    ? dayLabelForDateKey(u.used_on)
                                    : formatDateInTimeZone(new Date(u.created_at), timeZone)}
                                  {u.discount_cents > 0 && (
                                    <span className="tabular-nums">
                                      {' '}
                                      · {formatMoney(u.discount_cents)} off
                                    </span>
                                  )}{' '}
                                  ·{' '}
                                  {u.order_id !== null
                                    ? `from order #${order?.order_number ?? u.order_id}`
                                    : 'recorded by staff'}
                                </span>
                                {u.note && (
                                  <span className="block text-[var(--color-muted)]">{u.note}</span>
                                )}
                              </span>
                              {canManage && u.order_id === null && <RemovePerkUse redemptionId={u.id} />}
                            </li>
                          )
                        })}
                      </ul>
                    )}
                    {canManage && (
                      <RecordPerkUseForm
                        perkId={perk.id}
                        clientMembershipId={live.id}
                        todayKey={todayKey}
                        minKey={windowKey}
                      />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-xs text-[var(--color-muted)]">
            {live.auto_renew && !live.cancel_at_period_end ? (
              <>
                Renews automatically on{' '}
                {formatDateInTimeZone(new Date(live.current_period_end), timeZone)}. Stripe
                charges the card on file.
              </>
            ) : live.cancel_at_period_end ? (
              <>
                Stops at period end, on{' '}
                {formatDateInTimeZone(new Date(live.current_period_end), timeZone)}.
              </>
            ) : (
              <>
                Paid once. Ends{' '}
                {formatDateInTimeZone(new Date(live.current_period_end), timeZone)}. The
                benefit stops that day unless it is renewed.
              </>
            )}
          </p>

          {canManage && live.stripe_subscription_id && (
            <MemberRenewalToggle
              clientMembershipId={live.id}
              renewing={live.auto_renew && !live.cancel_at_period_end}
            />
          )}

          {chargeRows.length > 0 && (
            <div className="space-y-3 border-t border-[var(--color-border)] pt-3">
              <p className="label-caps text-[var(--color-muted)]">Charges</p>
              <ul className="space-y-3 text-xs">
                {chargeRows.map((c) => (
                  <li key={c.id} className="space-y-1.5">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                      <span className="text-[var(--color-muted)]">
                        {formatDateInTimeZone(new Date(c.period_start), timeZone)} to{' '}
                        {formatDateInTimeZone(new Date(c.period_end), timeZone)}
                      </span>
                      <span className="flex items-center gap-2.5">
                        <span className="tabular-nums">{formatMoney(c.amount_cents)}</span>
                        <Badge size="sm" tone={CHARGE_TONES[c.status]}>
                          {MEMBERSHIP_CHARGE_STATUS_LABELS[c.status]}
                        </Badge>
                      </span>
                    </div>
                    {(c.status === 'paid' || c.status === 'refunded') && (
                      <p className="text-[var(--color-muted)]">
                        {METHOD_LABELS[c.method]}
                        {c.paid_at && (
                          <>, paid {formatDateInTimeZone(new Date(c.paid_at), timeZone)}</>
                        )}
                      </p>
                    )}
                    {c.note && <p className="text-[var(--color-muted)]">{c.note}</p>}
                    {canManage && (
                      <ChargeActions chargeId={c.id} status={c.status} method={c.method} />
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {live.note && (
            <p className="border-t border-[var(--color-border)] pt-3 text-xs text-[var(--color-muted)]">
              {live.note}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-2 text-sm text-[var(--color-muted)]">
          {failing ? (
            <>
              <p className="flex flex-wrap items-center gap-2.5 text-[var(--color-foreground)]">
                <span>{failingPlan?.name ?? 'Membership'}</span>
                <Badge tone="danger">{MEMBERSHIP_STATUS_LABELS.past_due}</Badge>
              </p>
              <p className="text-xs">
                Stripe could not take the renewal. The benefit is paused until the card
                is updated and the payment goes through.
              </p>
              {/* Stop, resume and end-now for this row come from the
                  controls below, which are handed the past_due id. */}
            </>
          ) : (
            <p>No membership.</p>
          )}
          {lapsed && !failing && (
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
            // A past_due row, or an active one whose period has run out, still
            // holds 050's one-live index, so the enrol form would only meet a
            // raw unique-violation error. The controls get that row instead.
            liveMembershipId={controlled?.id ?? null}
            plans={(plans ?? []) as unknown as EnrolPlan[]}
            timeZone={timeZone}
            todayKey={todayKey}
            cancelAtPeriodEnd={controlled?.cancel_at_period_end ?? false}
            stripeSubscriptionId={controlled?.stripe_subscription_id ?? null}
            periodOver={!!stale}
          />
        </div>
      )}
    </section>
  )
}
