import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ButtonLink } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone, requestNow } from '@/lib/time'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

/**
 * The referral programme, from the referrer's side: their code, every friend
 * it has brought in, and where each reward stands. A reward is earned only
 * when the friend's first visit is complete and paid in full (069) — this
 * page says so plainly, because "why isn't my $20 here yet" should be
 * answerable by reading it.
 *
 * Loyalty points accrue in the background (067) but are deliberately not
 * shown — the studio decided clients see referrals, not points.
 */
export default async function RewardsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: code }, { data: referrals }, { data: rewardRows }] = await Promise.all([
    // Minted on first visit to this page — one per client, forever (068).
    supabase.rpc('get_or_create_referral_code', { p_client: user.id }),
    supabase
      .from('referral_redemptions')
      .select('id, reward_status, reward_cents, reward_percent, created_at, applied_at')
      .eq('referrer_id', user.id)
      .order('created_at', { ascending: false })
      .limit(50),
    // What the programme currently pays, for the copy below.
    supabase
      .from('promotions')
      .select('amount_cents, percent_off, starts_at, ends_at, is_active')
      .eq('kind', 'referral')
      .eq('is_active', true),
  ])

  const now = requestNow()
  const rewardConfig = (rewardRows ?? []).find((r) => {
    if (r.starts_at && new Date(r.starts_at).getTime() > now) return false
    if (r.ends_at && new Date(r.ends_at).getTime() < now) return false
    return true
  })
  const rewardLabel = rewardConfig?.amount_cents
    ? formatMoney(rewardConfig.amount_cents)
    : rewardConfig?.percent_off
      ? `${rewardConfig.percent_off}%`
      : null

  const referred = referrals ?? []
  const ready = referred.filter((r) => r.reward_status === 'earned')
  const readyCents = ready.reduce((n, r) => n + (r.reward_cents ?? 0), 0)

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Rewards</h1>
        <ButtonLink href="/book" size="sm">
          Book a visit
        </ButtonLink>
      </div>

      <div className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
        <p className="label-caps mb-4 text-[var(--color-accent)]">Refer a friend</p>
        <p className="text-sm text-[var(--color-muted)]">Your code</p>
        <p className="display mt-1 text-4xl tracking-wide">{code ?? '—'}</p>
        <p className="mt-5 max-w-prose text-sm leading-relaxed text-[var(--color-muted)]">
          {rewardLabel
            ? `Give it to a friend who has not been in before. Once their first visit is complete and paid, ${rewardLabel} off comes to you — mention it at the desk on your next visit. Rewards add up: three friends is three rewards, and they can all come off one visit.`
            : 'Give it to a friend who has not been in before — their first completed visit is counted to you.'}
        </p>
        {ready.length > 0 && (
          <p className="mt-4 text-sm text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]">
            {ready.length === 1
              ? `A reward is ready${readyCents > 0 ? ` — ${formatMoney(readyCents)} off your next visit` : ''}.`
              : `${ready.length} rewards are ready${readyCents > 0 ? ` — ${formatMoney(readyCents)} off your next visit` : ''}.`}
          </p>
        )}
      </div>

      <section className="mt-14">
        <h2 className="label-caps mb-4 text-[var(--color-accent)]">Your referrals</h2>
        {referred.length === 0 ? (
          <p className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
            Nobody yet. When a friend books their first visit with your code, they show
            up here — and your reward follows once their visit is done.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {referred.map((r) => {
              const value = r.reward_cents
                ? formatMoney(r.reward_cents)
                : r.reward_percent
                  ? `${r.reward_percent}%`
                  : null
              return (
                <li
                  key={r.id}
                  className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 py-5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">A friend joined with your code</p>
                    <p className="mt-1 text-sm text-[var(--color-muted)]">
                      {formatDateTimeInTimeZone(new Date(r.created_at), STUDIO_TZ)}
                    </p>
                  </div>
                  <Badge
                    tone={
                      r.reward_status === 'earned'
                        ? 'success'
                        : r.reward_status === 'applied'
                          ? 'neutral'
                          : r.reward_status === 'void'
                            ? 'danger'
                            : 'info'
                    }
                  >
                    {r.reward_status === 'pending'
                      ? 'After their first visit'
                      : r.reward_status === 'earned'
                        ? `${value ? `${value} ` : ''}ready`
                        : r.reward_status === 'applied'
                          ? `${value ? `${value} ` : ''}used${r.applied_at ? ` · ${new Date(r.applied_at).toLocaleDateString()}` : ''}`
                          : 'Void'}
                  </Badge>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
