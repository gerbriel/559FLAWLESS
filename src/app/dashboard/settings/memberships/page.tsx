import Link from 'next/link'
import { redirect } from 'next/navigation'
import { BadgeCheck, CalendarClock, CreditCard } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { EmptyState, PageHeader, Panel, StatTile } from '@/components/ui/dashboard'
import {
  MembershipEditor,
  type MembershipServiceOption,
} from '@/components/shared/MembershipEditor'
import { formatMoney } from '@/lib/utils'
import { requestNow } from '@/lib/time'
import { isManager } from '@/types/database'
import {
  describeMembershipBenefit,
  membershipIsCurrent,
  membershipPeriodLabel,
  type ClientMembership,
  type Membership,
  type MembershipService,
} from '@/types/memberships'

export const dynamic = 'force-dynamic'

/**
 * Membership plans — manager only.
 *
 * `memberships` is `is_manager()` for writes in migration 050 and this gate
 * mirrors it. The RLS policy is what refuses the write; this decides whether
 * somebody is shown a screen full of controls that would refuse them.
 *
 * The page is deliberately blunt about what the studio has NOT got: nothing
 * here charges a card a second time. Every period is recorded by hand from the
 * client's record. A manager who does not know that will assume renewals are
 * happening, and a membership that silently fails to charge is worse than one
 * that plainly has to be asked for.
 */
export default async function MembershipsSettingsPage() {
  const supabase = await createClient()
  const now = requestNow()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/settings/memberships')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || !isManager(profile.role)) redirect('/dashboard/settings')

  const [{ data: plans }, { data: scopes }, { data: services }, { data: held }] =
    await Promise.all([
      supabase
        // One string literal — concatenating widens the select to `string` and
        // collapses the result type to SelectQueryError.
        .from('memberships')
        .select(
          'id, name, slug, description, price_cents, period_months, service_discount_pct, included_sessions_per_period, stripe_price_id, is_active, sort_order, created_at, updated_at'
        )
        .order('sort_order')
        .order('id'),
      supabase.from('membership_services').select('membership_id, service_id'),
      supabase
        .from('services')
        .select('id, name, price_cents')
        .eq('is_active', true)
        .order('name'),
      supabase
        .from('client_memberships')
        .select('membership_id, status, current_period_end'),
    ])

  const rows = (plans ?? []) as Membership[]
  const scopeRows = (scopes ?? []) as MembershipService[]
  const serviceOptions = (services ?? []) as MembershipServiceOption[]
  const holders = (held ?? []) as Pick<
    ClientMembership,
    'membership_id' | 'status' | 'current_period_end'
  >[]

  const scopeFor = (planId: number) =>
    scopeRows.filter((s) => s.membership_id === planId).map((s) => s.service_id)

  const liveHolders = holders.filter((h) => membershipIsCurrent(h, now))
  const countFor = (planId: number) =>
    liveHolders.filter((h) => h.membership_id === planId).length

  // Recurring revenue as the studio would state it: what every live membership
  // is worth in a month, in integer cents. A yearly plan is divided down —
  // display only, and floored rather than rounded so the figure never flatters.
  const monthlyCents = liveHolders.reduce((sum, holder) => {
    const plan = rows.find((p) => p.id === holder.membership_id)
    if (!plan) return sum
    return sum + Math.floor(plan.price_cents / plan.period_months)
  }, 0)

  return (
    <div className="max-w-4xl">
      <PageHeader
        eyebrow="Settings"
        title="Memberships"
        lede="A standing arrangement rather than a purchase: the member pays every period and the studio takes the benefit off every visit automatically. What a plan grants is read fresh on each visit; what a member pays is frozen on the day they joined."
        actions={<MembershipEditor services={serviceOptions} />}
      />

      <div className="mt-8 grid gap-4 sm:grid-cols-3">
        <StatTile label="Plans" value={rows.filter((p) => p.is_active).length} hint="Open to new members" />
        <StatTile label="Members" value={liveHolders.length} hint="Paid up and current" />
        <StatTile
          label="Per month"
          value={formatMoney(monthlyCents)}
          hint="What the live memberships are worth, annual plans divided down"
        />
      </div>

      <Panel className="mt-8 border-l-2 border-l-[var(--color-accent)] p-5">
        <p className="label-caps mb-2 flex items-center gap-2 text-[var(--color-accent)]">
          <CreditCard className="h-3.5 w-3.5" strokeWidth={2} />
          Nothing here charges a card
        </p>
        <p className="max-w-prose text-sm text-[var(--color-muted)]">
          The studio is not billing these automatically. Each period is raised as a
          charge on the member&rsquo;s record and marked paid when the money arrives —
          at the counter, by transfer, however it happened. A membership whose period
          has run out stops granting its benefit that day, on its own, whether or not
          anybody noticed. That is the safe way round while renewals are manual.
        </p>
      </Panel>

      <div className="mt-10">
        {rows.length === 0 ? (
          <EmptyState
            icon={BadgeCheck}
            title="No memberships yet"
            description="A membership is a price per period plus what it grants — a discount on every visit, some treatments included, or both."
            action={<MembershipEditor services={serviceOptions} />}
          />
        ) : (
          <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {rows.map((plan) => {
              const scoped = scopeFor(plan.id)
              const members = countFor(plan.id)
              return (
                <li key={plan.id} className="py-5">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2.5">
                        <span className="text-base">{plan.name}</span>
                        {!plan.is_active && <Badge tone="neutral">Closed</Badge>}
                        {members > 0 && (
                          <Badge tone="accent">
                            {members} {members === 1 ? 'member' : 'members'}
                          </Badge>
                        )}
                      </p>
                      <p className="mt-1 text-sm tabular-nums">
                        {formatMoney(plan.price_cents)} /{' '}
                        {membershipPeriodLabel(plan.period_months)}
                      </p>
                      <p className="mt-1 text-xs text-[var(--color-muted)]">
                        {describeMembershipBenefit(plan)}
                      </p>
                      {plan.included_sessions_per_period > 0 && (
                        <p className="mt-1 text-xs text-[var(--color-muted)]">
                          {scoped.length === 0
                            ? 'An included treatment can be spent on anything on the menu.'
                            : `Included treatments: ${scoped
                                .map(
                                  (id) =>
                                    serviceOptions.find((s) => s.id === id)?.name ?? `#${id}`
                                )
                                .join(', ')}`}
                        </p>
                      )}
                      {plan.description && (
                        <p className="mt-2 max-w-prose text-xs text-[var(--color-muted)]">
                          {plan.description}
                        </p>
                      )}
                    </div>

                    <div className="shrink-0">
                      <MembershipEditor
                        plan={plan}
                        scopeServiceIds={scoped}
                        services={serviceOptions}
                        trigger="link"
                      />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      <section className="mt-14">
        <h2 className="display text-2xl">How a membership reaches a visit</h2>
        <ol className="mt-5 space-y-4 text-sm text-[var(--color-muted)]">
          <li>
            <span className="text-[var(--color-foreground)]">Somebody is enrolled</span>{' '}
            &mdash; from their record under{' '}
            <Link href="/dashboard/clients" className="underline underline-offset-4">
              Clients
            </Link>
            . The price is taken from the plan, never typed in, and frozen there.
          </li>
          <li>
            <span className="text-[var(--color-foreground)]">They book</span> &mdash;
            online or at the desk, it makes no difference. After the appointment is made,
            an included treatment is claimed from the database and the member percentage
            comes off the rest. Both land on the appointment in integer cents, and the
            total the client sees is the discounted one.
          </li>
          <li>
            <span className="text-[var(--color-foreground)]">The period ends</span> &mdash;
            and the benefit stops that day. Renewing raises the next charge on their
            record; it does not take any money.
          </li>
        </ol>

        <Panel className="mt-6 p-5">
          <p className="label-caps mb-2 flex items-center gap-2 text-[var(--color-muted)]">
            <CalendarClock className="h-3.5 w-3.5" strokeWidth={2} />
            What a member is not charged for
          </p>
          <p className="max-w-prose text-sm text-[var(--color-muted)]">
            The deposit on a booking is unchanged by a membership, and retail is unchanged
            too — the discount is on treatments. An included treatment is spent on the
            dearest eligible thing on the visit, which is what a member would choose if
            they were asked.
          </p>
        </Panel>
      </section>
    </div>
  )
}
