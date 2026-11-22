import Link from 'next/link'
import { redirect } from 'next/navigation'
import { BadgeCheck, CalendarClock, CreditCard } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { EmptyState, PageHeader, Panel, StatTile } from '@/components/ui/dashboard'
import {
  MembershipEditor,
  type MembershipScopeRow,
  type MembershipServiceOption,
} from '@/components/shared/MembershipEditor'
import { formatMoney } from '@/lib/utils'
import { requestNow } from '@/lib/time'
import { isManager } from '@/types/database'
import {
  describeIncluded,
  includedAllowances,
  membershipIsCurrent,
  membershipPeriodLabel,
  describeProductPerk,
  type ClientMembership,
  type Membership,
  type MembershipProductPerk,
} from '@/types/memberships'

export const dynamic = 'force-dynamic'

/**
 * Membership plans — manager only.
 *
 * `memberships` is `is_manager()` for writes in migration 050 and this gate
 * mirrors it. The RLS policy is what refuses the write; this decides whether
 * somebody is shown a screen full of controls that would refuse them.
 *
 * The page is deliberately blunt about which memberships charge themselves and
 * which do not. Since 083 a member who chose to renew is billed by Stripe every
 * period and the webhook records it; everybody else (pay-once online, enrolled
 * at the counter) is still recorded by hand from the client's record. A
 * manager who does not know which is which will assume renewals are happening
 * for everyone, and a membership that silently fails to charge is worse than
 * one that plainly has to be asked for.
 */
export default async function MembershipsPage() {
  const supabase = await createClient()
  const now = requestNow()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/memberships')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || !isManager(profile.role)) redirect('/dashboard')

  const [
    { data: plans },
    { data: scopes },
    { data: services },
    { data: held },
    { data: memberPriceRows },
    { data: productRows },
    { data: categoryRows },
    { data: perkRows },
  ] = await Promise.all([
      supabase
        // One string literal — concatenating widens the select to `string` and
        // collapses the result type to SelectQueryError.
        .from('memberships')
        .select(
          'id, name, slug, description, price_cents, period_months, service_discount_pct, included_sessions_per_period, stripe_price_id, sell_online, auto_renew_offered, is_active, sort_order, created_at, updated_at'
        )
        .order('sort_order')
        .order('id'),
      supabase
        .from('membership_services')
        .select('membership_id, service_id, sessions_per_period, services(name)'),
      supabase
        .from('services')
        .select('id, name, price_cents')
        .eq('is_active', true)
        .order('name'),
      supabase
        .from('client_memberships')
        .select('membership_id, status, current_period_end'),
      supabase.from('membership_member_prices').select('membership_id, service_id, price_cents'),
      // What a product perk can be scoped to: the retail shelf, by product or
      // by category (086).
      supabase
        .from('products')
        .select('id, name')
        .eq('is_active', true)
        .eq('is_retail', true)
        .is('archived_at', null)
        .order('name'),
      supabase.from('product_categories').select('id, name, is_active').order('name'),
      supabase
        .from('membership_product_perks')
        .select('id, membership_id, kind, percent_off, buy_qty, product_id, category_id, label, sort_order, max_uses, uses_window, max_units_per_use')
        .order('sort_order')
        .order('id'),
    ])

  const rows = (plans ?? []) as Membership[]
  const scopeRows = (scopes ?? []) as unknown as (MembershipScopeRow & {
    membership_id: number
    services: { name: string } | null
  })[]
  const serviceOptions = (services ?? []) as MembershipServiceOption[]
  const holders = (held ?? []) as Pick<
    ClientMembership,
    'membership_id' | 'status' | 'current_period_end'
  >[]

  const productOptions = (productRows ?? []) as { id: number; name: string }[]
  const allCategories = (categoryRows ?? []) as { id: number; name: string; is_active: boolean }[]
  // Every category, hidden ones marked, so a perk on a shelf that was since
  // hidden still reads as what it is rather than as a gap.
  const categoryOptions = allCategories.map((c) => ({
    id: c.id,
    name: c.is_active ? c.name : `${c.name} (hidden)`,
  }))
  const perks = (perkRows ?? []) as MembershipProductPerk[]
  const perksFor = (planId: number) => perks.filter((p) => p.membership_id === planId)
  const perkLine = (p: MembershipProductPerk) =>
    p.label?.trim() ||
    describeProductPerk(p, {
      product: productOptions.find((x) => x.id === p.product_id)?.name,
      category: allCategories.find((x) => x.id === p.category_id)?.name,
    })

  const memberPricesFor = (planId: number) =>
    (memberPriceRows ?? []).filter((r) => r.membership_id === planId)

  const scopeFor = (planId: number): MembershipScopeRow[] =>
    scopeRows
      .filter((s) => s.membership_id === planId)
      .map((s) => ({ service_id: s.service_id, sessions_per_period: s.sessions_per_period }))

  // The plan's line, the same sentence the public plan card prints:
  // "1 Custom Corrective Facial and 1 Full Brazilian included each month",
  // then the member percentage.
  const benefitLine = (plan: Membership): string => {
    const rows = scopeRows.filter((s) => s.membership_id === plan.id)
    const allowances = includedAllowances(
      plan,
      rows.map((r) => ({
        service_id: r.service_id,
        sessions_per_period: r.sessions_per_period,
        name: r.services?.name ?? null,
      })),
      [],
      ''
    )
    const included = describeIncluded(
      allowances,
      membershipPeriodLabel(plan.period_months),
      rows
        .filter((r) => r.sessions_per_period === null)
        .map((r) => r.services?.name ?? '')
    )
    const pct = plan.service_discount_pct
    const discount =
      pct > 0 ? (included ? `${pct}% off the rest of the visit` : `${pct}% off every visit`) : ''
    return [included, discount].filter(Boolean).join(' · ')
  }

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
        eyebrow="Catalog"
        title="Memberships"
        lede="A standing arrangement rather than a purchase: the member pays every period and the studio takes the benefit off every visit automatically. What a plan grants is read fresh on each visit; what a member pays is frozen on the day they joined."
        actions={
          <MembershipEditor
            services={serviceOptions}
            products={productOptions}
            categories={categoryOptions}
          />
        }
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
          Who is charged automatically
        </p>
        <p className="max-w-prose text-sm text-[var(--color-muted)]">
          Members who chose to renew are charged by Stripe each period and appear here
          as paid automatically. If a card is declined, the membership is marked as a
          failed payment, its benefit pauses, and you and the member are both told.
        </p>
        <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
          Pay-once members and counter enrolments are still recorded by hand. Each of
          their periods is raised as a charge on the member&rsquo;s record and marked
          paid when the money arrives: at the counter, by transfer, however it happened.
          A membership whose period has run out stops granting its benefit that day, on
          its own, whether or not anybody noticed.
        </p>
      </Panel>

      <div className="mt-10">
        {rows.length === 0 ? (
          <EmptyState
            icon={BadgeCheck}
            title="No memberships yet"
            description="A membership is a price per period plus what it grants — a discount on every visit, some treatments included, or both."
            action={
          <MembershipEditor
            services={serviceOptions}
            products={productOptions}
            categories={categoryOptions}
          />
        }
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
                        {plan.is_active && plan.sell_online && <Badge tone="success">Sold online</Badge>}
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
                      {/* Empty for a plan that grants only member prices or
                          product perks; their own lines below say what it gives. */}
                      {benefitLine(plan) && (
                        <p className="mt-1 text-xs text-[var(--color-muted)]">
                          {benefitLine(plan)}
                        </p>
                      )}
                      {plan.included_sessions_per_period > 0 && scoped.length === 0 && (
                        <p className="mt-1 text-xs text-[var(--color-muted)]">
                          An included treatment can be spent on anything on the menu.
                        </p>
                      )}
                      {memberPricesFor(plan.id).length > 0 && (
                        <p className="mt-1 text-xs text-[var(--color-muted)]">
                          Member prices:{' '}
                          {memberPricesFor(plan.id)
                            .map(
                              (r) =>
                                `${serviceOptions.find((s) => s.id === r.service_id)?.name ?? `#${r.service_id}`} ${formatMoney(r.price_cents)}`
                            )
                            .join(', ')}
                        </p>
                      )}
                      {perksFor(plan.id).length > 0 && (
                        <p className="mt-1 text-xs text-[var(--color-muted)]">
                          Product perks: {perksFor(plan.id).map(perkLine).join('; ')}
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
                        scopeRows={scoped}
                        memberPrices={memberPricesFor(plan.id)}
                        productPerks={perksFor(plan.id)}
                        services={serviceOptions}
                        products={productOptions}
                        categories={categoryOptions}
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
            <span className="text-[var(--color-foreground)]">The period ends</span>.
            A renewing member is charged by Stripe and carries straight on. Anyone else
            stops getting the benefit that day; renewing them by hand raises the next
            charge on their record, and does not take any money.
          </li>
        </ol>

        <Panel className="mt-6 p-5">
          <p className="label-caps mb-2 flex items-center gap-2 text-[var(--color-muted)]">
            <CalendarClock className="h-3.5 w-3.5" strokeWidth={2} />
            What a member is not charged for
          </p>
          <p className="max-w-prose text-sm text-[var(--color-muted)]">
            The deposit on a booking is unchanged by a membership, and the member
            percentage is on treatments only. Retail changes only through a plan&rsquo;s
            product perks, and then only when a perk beats the multibuy deal or a promo
            code: the shop and the till take the best single discount, never two. An included treatment is spent on the
            dearest eligible thing on the visit, which is what a member would choose if
            they were asked.
          </p>
        </Panel>
      </section>
    </div>
  )
}
