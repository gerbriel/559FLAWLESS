import type { Metadata } from 'next'
import { AlertCircle, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { ButtonLink } from '@/components/ui/button'
import { MembershipJoinButton } from '@/components/shared/MembershipJoinButton'
import { MembershipSelfService } from '@/components/shared/MembershipSelfService'
import { formatMoney } from '@/lib/utils'
import { requestNow } from '@/lib/time'
import {
  allowancesLeftLabel,
  describeIncluded,
  describeProductPerk,
  eachPeriodPhrase,
  includedAllowances,
  includedSessionsLeft,
  includedWorthCents,
  membershipIsCurrent,
  membershipPeriodLabel,
  poolDearestCents,
  type MembershipProductPerk,
} from '@/types/memberships'

// Who is looking changes the page (join, or your membership), so it is never cached.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Membership',
  description: 'A season of corrective facials at 559 Flawless, paid once or renewing.',
}

const STUDIO_TZ = 'America/Los_Angeles'

/** Said wherever the page talks about visits: "paid" can read as "booked". */
const VISITS_CONFIRMED =
  'Visits are booked separately, and each one is confirmed by the studio before it is on the calendar.'

/** A perk row with the names it is scoped to, as the embeds return it. */
type NamedPerk = MembershipProductPerk & {
  products: { name: string } | null
  product_categories: { name: string } | null
}

/** A scope row with its treatment's name, as the embeds return it (088). */
type NamedScope = {
  service_id: number
  sessions_per_period: number | null
  services: { name: string; price_cents?: number } | null
}

/** The scope rows in the shape includedAllowances() reads. */
function scopeWithNames(rows: NamedScope[] | null) {
  return (rows ?? []).map((r) => ({
    service_id: r.service_id,
    sessions_per_period: r.sessions_per_period,
    name: r.services?.name ?? null,
  }))
}

/** The sentence a perk prints: its own label, or the plain description. */
function perkLine(perk: NamedPerk): string {
  return (
    perk.label?.trim() ||
    describeProductPerk(perk, {
      product: perk.products?.name,
      category: perk.product_categories?.name,
    })
  )
}

interface Props {
  searchParams: Promise<{ joined?: string; later?: string }>
}

/**
 * The public membership page (078, renewing option 083).
 *
 * Lists the plans marked "sell online". A signed-in client pays through
 * Stripe, either once for one period or on a renewing subscription when the
 * plan offers it. Someone already holding a membership sees it instead: what
 * is left this period, whether and when it renews, and (for a subscription)
 * the controls to stop renewing or update the card. Visits are booked through
 * the normal booking flow and confirmed by the studio; the page says so.
 */
export default async function MembershipsPage({ searchParams }: Props) {
  const { joined, later } = await searchParams
  const supabase = await createClient()
  const now = requestNow()

  const [
    {
      data: { user },
    },
    { data: plans },
  ] = await Promise.all([
    supabase.auth.getUser(),
    supabase
      .from('memberships')
      .select(
        'id, name, description, price_cents, period_months, included_sessions_per_period, auto_renew_offered, membership_services(service_id, sessions_per_period, services(name, price_cents)), membership_member_prices(price_cents, services(name, price_cents)), membership_product_perks(id, membership_id, kind, percent_off, buy_qty, product_id, category_id, label, sort_order, max_uses, uses_window, max_units_per_use, products(name), product_categories(name))'
      )
      .eq('is_active', true)
      .eq('sell_online', true)
      .order('sort_order')
      .order('id'),
  ])

  // Active or past due: a failed renewal still belongs on this page, with a
  // way to fix the card, rather than vanishing as if they never joined. The
  // latest period wins; an active row whose period has ended is not shown.
  const { data: latest } = user
    ? await supabase
        .from('client_memberships')
        .select(
          'id, status, current_period_start, current_period_end, auto_renew, cancel_at_period_end, stripe_subscription_id, memberships!client_memberships_membership_id_fkey(name, included_sessions_per_period, membership_services(service_id, sessions_per_period, services(name)), membership_member_prices(services(name)), membership_product_perks(id, membership_id, kind, percent_off, buy_qty, product_id, category_id, label, sort_order, max_uses, uses_window, max_units_per_use, products(name), product_categories(name))), membership_redemptions(service_id, sessions, redeemed_for_period_start)'
        )
        .eq('client_id', user.id)
        .in('status', ['active', 'past_due'])
        .order('current_period_end', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null }

  const mine =
    latest && (latest.status === 'past_due' || membershipIsCurrent(latest, now)) ? latest : null
  const pastDue = mine?.status === 'past_due'

  const minePlan = mine?.memberships as unknown as
    | {
        name: string
        included_sessions_per_period: number
        membership_services: NamedScope[] | null
        membership_member_prices: { services: { name: string } | null }[] | null
        membership_product_perks: NamedPerk[] | null
      }
    | null
  // Each allowance this period: one per treatment with its own number, or
  // the shared pool. "1 of 1 Custom Corrective Facial and 0 of 1 Full
  // Brazilian left".
  const mineAllowances =
    mine && minePlan
      ? includedAllowances(
          minePlan,
          scopeWithNames(minePlan.membership_services),
          (mine.membership_redemptions ?? []) as {
            service_id: number | null
            sessions: number
            redeemed_for_period_start: string
          }[],
          mine.current_period_start
        )
      : []
  const left = includedSessionsLeft(mineAllowances)
  const leftLine = allowancesLeftLabel(mineAllowances)
  // Treatments this plan sells at a member price, named, for the how-to line.
  // None, and the line says nothing about member prices.
  const memberPriceNames = [
    ...new Set(
      (minePlan?.membership_member_prices ?? [])
        .map((m) => m.services?.name?.trim())
        .filter((n): n is string => !!n)
    ),
  ]
  const memberPriceLine =
    memberPriceNames.length === 0
      ? ''
      : memberPriceNames.length === 1
        ? `Add ${memberPriceNames[0]} to any visit at the member price.`
        : `Add ${memberPriceNames.slice(0, -1).join(', ')} or ${memberPriceNames[memberPriceNames.length - 1]} to any visit at the member price.`

  // The holder's own retail perks, each limited one with what is left of it
  // this window. A failed count shows no figure rather than a wrong one.
  const minePerks = await Promise.all(
    [...(minePlan?.membership_product_perks ?? [])]
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      .map(async (perk) => {
        if (!mine || perk.max_uses === null) return { perk, usesLine: null }
        const { data: uses, error } = await supabase.rpc('perk_uses_so_far', {
          p_client_membership: mine.id,
          p_perk: perk.id,
          p_window: perk.uses_window,
          p_period_start: mine.current_period_start,
        })
        if (error || typeof uses !== 'number') return { perk, usesLine: null }
        const span = perk.uses_window === 'month' ? 'this month' : 'this period'
        const remaining = Math.max(perk.max_uses - uses, 0)
        return {
          perk,
          usesLine:
            remaining === 0
              ? `Used ${span}`
              : `${remaining} of ${perk.max_uses} ${perk.max_uses === 1 ? 'use' : 'uses'} left ${span}`,
        }
      })
  )

  // A pool that may be spent on anything is worth the dearest treatment on
  // the menu. Asked once for the page, and only when a plan needs it.
  const needsMenuDearest = (plans ?? []).some(
    (p) => p.included_sessions_per_period > 0 && (p.membership_services ?? []).length === 0
  )
  const { data: dearestRow } = needsMenuDearest
    ? await supabase
        .from('services')
        .select('price_cents')
        .eq('is_active', true)
        .order('price_cents', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null }
  const menuDearestCents = dearestRow?.price_cents ?? 0

  const dateLabel = (iso: string) =>
    new Date(iso).toLocaleDateString('en-US', {
      timeZone: STUDIO_TZ,
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    })

  const subscribed = Boolean(mine?.stripe_subscription_id)
  const renewing = subscribed && Boolean(mine?.auto_renew) && !mine?.cancel_at_period_end
  const endLabel = mine ? dateLabel(mine.current_period_end) : ''
  const renewalLine = !mine
    ? ''
    : renewing
      ? `Renews automatically on ${endLabel}`
      : subscribed
        ? `Ends on ${endLabel}`
        : `Paid once, runs until ${endLabel}`

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow="Membership"
          title="A season of good skin."
          lede={`Corrective facials across a season, paid once or renewing. ${VISITS_CONFIRMED}`}
        />

        {joined && !mine && (
          <p className="mt-10 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-5 text-sm dark:bg-transparent">
            Thank you, your payment went through. Your membership appears here as soon as
            the payment is confirmed, usually within a minute. Refresh if it has not yet.
          </p>
        )}

        {later && (
          <p className="mt-10 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-5 text-sm dark:bg-transparent">
            Noted. Book whenever you are ready: come back here or go straight to booking.{' '}
            {VISITS_CONFIRMED}
          </p>
        )}

        {mine && minePlan && (
          <div className="mt-12 border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
            <p className="label-caps flex items-center gap-2 text-[var(--color-accent)]">
              <Check className="h-4 w-4" strokeWidth={2} />
              Your membership
            </p>
            <p className="display mt-3 text-3xl">{minePlan.name}</p>

            {pastDue && (
              <p className="mt-5 flex gap-2.5 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm dark:bg-transparent">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={2} />
                Your last payment did not go through. Update your card to keep your
                membership.
              </p>
            )}

            <p className="mt-3 text-sm">
              {leftLine ? (
                <>
                  <strong className="tabular-nums">{leftLine}</strong> · {renewalLine}
                </>
              ) : (
                renewalLine
              )}
            </p>
            <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
              {mineAllowances.length > 0 &&
                'Book an included treatment as usual and it is covered automatically once the studio confirms it. '}
              {memberPriceLine && `${memberPriceLine} `}
              {VISITS_CONFIRMED}
            </p>

            {minePerks.length > 0 && (
              <ul className="mt-4 space-y-1.5 text-sm">
                {minePerks.map(({ perk, usesLine }) => (
                  <li key={perk.id} className="flex gap-2.5">
                    <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={2} />
                    <span>
                      {perkLine(perk)}
                      {usesLine && (
                        <span className="text-[var(--color-muted)]"> · {usesLine}</span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            )}

            {!pastDue && (
              <ButtonLink href={left > 0 ? '/book?membership=1' : '/book'} className="mt-6">
                {left > 0 ? 'Book a covered visit' : 'Book a visit'}
              </ButtonLink>
            )}

            {subscribed && (
              <MembershipSelfService renewing={renewing} periodEndLabel={endLabel} />
            )}
          </div>
        )}

        {(plans ?? []).length === 0 ? (
          !mine && (
            <p className="mt-12 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
              Memberships are not open online right now. Ask at the studio.
            </p>
          )
        ) : (
          <ul className="mt-14 grid gap-8 lg:grid-cols-2">
            {(plans ?? []).map((p) => {
              const scopeRows = (p.membership_services ?? []) as unknown as NamedScope[]
              const allowances = includedAllowances(p, scopeWithNames(scopeRows), [], '')
              // What the included treatments cost at the menu price. Member
              // prices and product perks are not counted. Shown only when it
              // beats the plan price: a zero saving is never advertised.
              const menuPrice = (serviceId: number) =>
                scopeRows.find((s) => s.service_id === serviceId)?.services?.price_cents ?? 0
              const worthCents = includedWorthCents(
                allowances,
                menuPrice,
                poolDearestCents(
                  scopeRows.map((s) => ({
                    sessions_per_period: s.sessions_per_period,
                    price_cents: s.services?.price_cents ?? 0,
                  })),
                  menuDearestCents
                )
              )
              const savingCents = worthCents - p.price_cents
              const includedLine = describeIncluded(
                allowances,
                membershipPeriodLabel(p.period_months),
                scopeRows
                  .filter((s) => s.sessions_per_period === null)
                  .map((s) => s.services?.name ?? '')
              )
              const memberPrices = (p.membership_member_prices ?? []) as unknown as {
                price_cents: number
                services: { name: string; price_cents: number } | null
              }[]
              const productPerks = ((p.membership_product_perks ?? []) as unknown as NamedPerk[])
                .slice()
                .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
              const months = p.period_months === 1 ? 'month' : `${p.period_months} months`
              const forMonths = p.period_months === 1 ? '1 month' : `${p.period_months} months`

              return (
                <li
                  key={p.id}
                  className="flex flex-col border border-[var(--color-border)] bg-[var(--color-surface)] p-8"
                >
                  <h2 className="display text-3xl">{p.name}</h2>
                  <p className="mt-4">
                    <span className="display text-4xl tabular-nums">
                      {formatMoney(p.price_cents)}
                    </span>
                    <span className="ml-2 text-sm text-[var(--color-muted)]">
                      {p.auto_renew_offered
                        ? `every ${months}, or once`
                        : `for ${months}, paid up front`}
                    </span>
                  </p>
                  {savingCents > 0 && (
                    <p className="mt-3 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm tabular-nums">
                      <span>
                        <span className="label-caps mr-1.5 text-[var(--color-muted)]">Menu value</span>
                        <span className="text-red-700 line-through dark:text-red-400">
                          {formatMoney(worthCents)}
                        </span>
                      </span>
                      <span>
                        <span className="label-caps mr-1.5 text-[var(--color-muted)]">Member price</span>
                        <span className="text-emerald-800 dark:text-emerald-400">
                          {formatMoney(p.price_cents)}
                        </span>
                      </span>
                      <span className="text-emerald-800 dark:text-emerald-400">
                        You save {formatMoney(savingCents)} {eachPeriodPhrase(p.period_months)}
                      </span>
                    </p>
                  )}
                  {p.description && (
                    <p className="mt-4 text-sm text-[var(--color-muted)]">{p.description}</p>
                  )}

                  <ul className="mt-6 space-y-2.5 text-sm">
                    {includedLine && (
                      <li className="flex gap-2.5">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={2} />
                        <span>{includedLine}</span>
                      </li>
                    )}
                    {memberPrices.map((m, i) => (
                      <li key={i} className="flex gap-2.5">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={2} />
                        <span>
                          {m.services?.name ?? 'Service'} on any visit for{' '}
                          {formatMoney(m.price_cents)}
                          {m.services && (
                            <span className="text-[var(--color-muted)]">
                              {' '}
                              (usually {formatMoney(m.services.price_cents)}), paid at the visit
                            </span>
                          )}
                        </span>
                      </li>
                    ))}
                    {productPerks.map((perk) => (
                      <li key={`perk-${perk.id}`} className="flex gap-2.5">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={2} />
                        <span>
                          {perkLine(perk)}
                        </span>
                      </li>
                    ))}
                    <li className="flex gap-2.5">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={2} />
                      <span>{VISITS_CONFIRMED}</span>
                    </li>
                  </ul>

                  <div className="mt-auto pt-8">
                    {mine ? null : user ? (
                      <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap">
                        <MembershipJoinButton
                          membershipId={p.id}
                          autoRenew={false}
                          variant={p.auto_renew_offered ? 'outline' : 'primary'}
                          label={`Pay once for ${forMonths}`}
                        />
                        {p.auto_renew_offered && (
                          <MembershipJoinButton
                            membershipId={p.id}
                            autoRenew
                            label={`Renew every ${months}, cancel anytime`}
                          />
                        )}
                      </div>
                    ) : (
                      <ButtonLink href="/login?next=/memberships">Sign in to join</ButtonLink>
                    )}
                    {!mine && p.auto_renew_offered && (
                      <p className="mt-4 text-xs text-[var(--color-muted)]">
                        Renewing charges {formatMoney(p.price_cents)} every {months} until
                        you stop it. Stop from this page at any time and it runs to the end of
                        the period you paid for. Paying once ends after {forMonths}.
                      </p>
                    )}
                  </div>
                  {productPerks.length > 0 && (
                    <p className="mt-4 text-xs text-[var(--color-muted)]">
                      Product perks apply in the online shop and at the studio while your
                      membership is current. Savings never stack: the best single discount
                      on your order applies, whether that is a perk, a multibuy deal or a
                      promo code.
                    </p>
                  )}
                  <p className="mt-4 text-xs text-[var(--color-muted)]">
                    Prefer to pay in person? Ask at your next visit and we will set it up at
                    the counter. Unused included treatments do not carry past the end date.
                  </p>
                </li>
              )
            })}
          </ul>
        )}
      </Container>
    </Section>
  )
}
