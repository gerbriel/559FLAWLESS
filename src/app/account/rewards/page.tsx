import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ButtonLink } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone, requestNow } from '@/lib/time'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

/**
 * Points, shown the way they accrue: a balance that is the sum of a ledger,
 * and the ledger itself underneath so "where did my points go?" is always
 * answerable. One point per dollar actually paid — earned when money moves
 * (067), which is why a booked-but-unpaid visit shows nothing yet.
 */

/** What a ledger row is called, from the payment behind it. */
function entryLabel(entry: {
  kind: string
  note: string | null
  payment: { kind: string } | null
}): string {
  if (entry.kind === 'adjustment') return entry.note ?? 'From the studio'
  const paymentKind = entry.payment?.kind
  const label =
    paymentKind === 'product'
      ? 'Shop order'
      : paymentKind === 'gift_card'
        ? 'Gift card purchase'
        : paymentKind === 'package'
          ? 'Package purchase'
          : paymentKind === 'refund'
            ? 'Refund'
            : 'Visit payment'
  return entry.kind === 'reversal' && paymentKind !== 'refund' ? `${label} — reversed` : label
}

export default async function RewardsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: balance }, { data: entries }, { data: code }, { data: referrals }, { data: rewardRows }] =
    await Promise.all([
      supabase.rpc('loyalty_balance', { p_client: user.id }),
      supabase
        .from('loyalty_ledger')
        .select('id, points, kind, note, created_at, payment:payments!loyalty_ledger_payment_id_fkey(kind, amount_cents)')
        .eq('client_id', user.id)
        .order('created_at', { ascending: false })
        .limit(100),
      // Minted on first visit to this page — one per client, forever (068).
      supabase.rpc('get_or_create_referral_code', { p_client: user.id }),
      supabase
        .from('referral_redemptions')
        .select('id, reward_status, reward_cents, reward_percent, created_at')
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
  const waiting = referred.filter((r) => r.reward_status === 'earned').length

  const history = ((entries ?? []) as unknown as {
    id: number
    points: number
    kind: string
    note: string | null
    created_at: string
    payment: { kind: string; amount_cents: number } | null
  }[])

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Rewards</h1>
        <ButtonLink href="/book" size="sm">
          Book a visit
        </ButtonLink>
      </div>

      <div className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
        <p className="label-caps mb-4 text-[var(--color-accent)]">Your points</p>
        <p className="display text-4xl tabular-nums">{(balance ?? 0).toLocaleString()}</p>
        <p className="mt-4 max-w-prose text-sm text-[var(--color-muted)]">
          You earn one point for every dollar you spend with us — treatments and
          shop orders alike, counted when the payment goes through. Redeeming
          them is coming soon; your points are building in the meantime, and
          they are yours.
        </p>
      </div>

      <section className="mt-14">
        <h2 className="label-caps mb-4 text-[var(--color-accent)]">Refer a friend</h2>
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
          <p className="text-sm text-[var(--color-muted)]">Your code</p>
          <p className="display mt-1 text-3xl tracking-wide">{code ?? '—'}</p>
          <p className="mt-4 max-w-prose text-sm text-[var(--color-muted)]">
            {rewardLabel
              ? `Give it to a friend who has not been in before. When they book their first visit with it, ${rewardLabel} off comes to you — just mention it at the desk on your next visit.`
              : 'Give it to a friend who has not been in before — their first booking is counted to you.'}
          </p>
          {referred.length > 0 && (
            <p className="mt-4 text-sm">
              You have brought in{' '}
              <span className="tabular-nums">{referred.length}</span>{' '}
              {referred.length === 1 ? 'person' : 'people'}
              {waiting > 0 && (
                <span className="text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]">
                  {' '}
                  — {waiting} reward{waiting === 1 ? '' : 's'} waiting for your next visit
                </span>
              )}
              .
            </p>
          )}
        </div>
      </section>

      <section className="mt-14">
        <h2 className="label-caps mb-4 text-[var(--color-accent)]">History</h2>
        {history.length === 0 ? (
          <p className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
            Nothing yet. Points appear here as soon as a payment does.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {history.map((e) => (
              <li
                key={e.id}
                className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 py-5"
              >
                <div className="min-w-0 flex-1">
                  <p className="text-sm">{entryLabel(e)}</p>
                  <p className="mt-1 text-sm text-[var(--color-muted)]">
                    {formatDateTimeInTimeZone(new Date(e.created_at), STUDIO_TZ)}
                    {e.payment && ` · ${formatMoney(Math.abs(e.payment.amount_cents))}`}
                  </p>
                </div>
                <span className="shrink-0 tabular-nums text-sm">
                  {e.points > 0 ? `+${e.points.toLocaleString()}` : e.points.toLocaleString()}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
