import type { Metadata } from 'next'
import { Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { ButtonLink } from '@/components/ui/button'
import { MembershipJoinButton } from '@/components/shared/MembershipJoinButton'
import { formatMoney } from '@/lib/utils'
import { requestNow } from '@/lib/time'

// Who is looking changes the page (join, or your membership), so it is never cached.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Membership',
  description: 'A season of corrective facials at 559 Flawless, paid up front.',
}

const STUDIO_TZ = 'America/Los_Angeles'

interface Props {
  searchParams: Promise<{ joined?: string }>
}

/**
 * The public membership page (078).
 *
 * Lists the plans marked "sell online". A signed-in client pays through
 * Stripe; someone already holding a membership sees it instead — what is left
 * this period and when it ends. Visits are booked through the normal booking
 * flow and confirmed by the studio; the page says so, because "paid" can read
 * as "booked".
 */
export default async function MembershipsPage({ searchParams }: Props) {
  const { joined } = await searchParams
  const supabase = await createClient()
  const nowIso = new Date(requestNow()).toISOString()

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
        'id, name, description, price_cents, period_months, included_sessions_per_period, membership_services(services(name)), membership_member_prices(price_cents, services(name, price_cents))'
      )
      .eq('is_active', true)
      .eq('sell_online', true)
      .order('sort_order')
      .order('id'),
  ])

  const { data: mine } = user
    ? await supabase
        .from('client_memberships')
        .select(
          'id, current_period_start, current_period_end, memberships!client_memberships_membership_id_fkey(name, included_sessions_per_period), membership_redemptions(sessions, redeemed_for_period_start)'
        )
        .eq('client_id', user.id)
        .eq('status', 'active')
        .gt('current_period_end', nowIso)
        .maybeSingle()
    : { data: null }

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

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow="Membership"
          title="A season of good skin."
          lede="Corrective facials across three months, paid once up front. You book each visit when it suits you, and the studio confirms it."
        />

        {joined && !mine && (
          <p className="mt-10 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-5 text-sm dark:bg-transparent">
            Thank you — your payment went through. Your membership appears here as soon as
            the payment is confirmed, usually within a minute. Refresh if it has not yet.
          </p>
        )}

        {mine && minePlan && (
          <div className="mt-12 border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
            <p className="label-caps flex items-center gap-2 text-[var(--color-accent)]">
              <Check className="h-4 w-4" strokeWidth={2} />
              Your membership
            </p>
            <p className="display mt-3 text-3xl">{minePlan.name}</p>
            <p className="mt-3 text-sm">
              <strong className="tabular-nums">{left}</strong> of{' '}
              {minePlan.included_sessions_per_period} facials left · runs until{' '}
              {dateLabel(mine.current_period_end)}
            </p>
            <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
              Book a corrective facial as usual and it is covered automatically once the
              studio confirms it. Add a Brazilian to any visit at the member price.
            </p>
            <ButtonLink href="/book" className="mt-6">
              Book a visit
            </ButtonLink>
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
                      for {months}, paid up front
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
                      <span>Book each visit when it suits you; the studio confirms it</span>
                    </li>
                  </ul>

                  <div className="mt-auto">
                    {mine ? null : user ? (
                      <MembershipJoinButton membershipId={p.id} label={`Join — ${formatMoney(p.price_cents)}`} />
                    ) : (
                      <ButtonLink href="/login?next=/memberships" className="mt-8">
                        Sign in to join
                      </ButtonLink>
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
