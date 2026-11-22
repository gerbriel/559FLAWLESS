import type { Metadata } from 'next'
import { AlertCircle, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { ButtonLink } from '@/components/ui/button'
import { MembershipJoinButton } from '@/components/shared/MembershipJoinButton'
import { MembershipSelfService } from '@/components/shared/MembershipSelfService'
import { formatMoney } from '@/lib/utils'
import { requestNow } from '@/lib/time'
import { membershipIsCurrent } from '@/types/memberships'

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
        'id, name, description, price_cents, period_months, included_sessions_per_period, auto_renew_offered, membership_services(services(name)), membership_member_prices(price_cents, services(name, price_cents))'
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
          'id, status, current_period_start, current_period_end, auto_renew, cancel_at_period_end, stripe_subscription_id, memberships!client_memberships_membership_id_fkey(name, included_sessions_per_period), membership_redemptions(sessions, redeemed_for_period_start)'
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
    | { name: string; included_sessions_per_period: number }
    | null
  const used = ((mine?.membership_redemptions ?? []) as {
    sessions: number
    redeemed_for_period_start: string
  }[])
    .filter((r) => r.redeemed_for_period_start === mine?.current_period_start)
    .reduce((n, r) => n + r.sessions, 0)
  const left = minePlan ? Math.max(minePlan.included_sessions_per_period - used, 0) : 0

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
              <strong className="tabular-nums">{left}</strong> of{' '}
              {minePlan.included_sessions_per_period} facials left · {renewalLine}
            </p>
            <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
              Book a corrective facial as usual and it is covered automatically once the
              studio confirms it. Add a Brazilian to any visit at the member price.{' '}
              {VISITS_CONFIRMED}
            </p>

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
              const covers = ((p.membership_services ?? []) as unknown as {
                services: { name: string } | null
              }[])
                .map((s) => s.services?.name)
                .filter(Boolean) as string[]
              const memberPrices = (p.membership_member_prices ?? []) as unknown as {
                price_cents: number
                services: { name: string; price_cents: number } | null
              }[]
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
                  {p.description && (
                    <p className="mt-4 text-sm text-[var(--color-muted)]">{p.description}</p>
                  )}

                  <ul className="mt-6 space-y-2.5 text-sm">
                    {p.included_sessions_per_period > 0 && (
                      <li className="flex gap-2.5">
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={2} />
                        <span>
                          {p.included_sessions_per_period} included:{' '}
                          {covers.length > 0 ? covers.join(' or ') : 'any treatment'}
                        </span>
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
                  <p className="mt-4 text-xs text-[var(--color-muted)]">
                    Prefer to pay in person? Ask at your next visit and we will set it up at
                    the counter. Unused facials do not carry past the end date.
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
