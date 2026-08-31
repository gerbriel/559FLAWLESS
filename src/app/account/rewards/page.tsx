import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ButtonLink } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone } from '@/lib/time'

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

  const [{ data: balance }, { data: entries }] = await Promise.all([
    supabase.rpc('loyalty_balance', { p_client: user.id }),
    supabase
      .from('loyalty_ledger')
      .select('id, points, kind, note, created_at, payment:payments!loyalty_ledger_payment_id_fkey(kind, amount_cents)')
      .eq('client_id', user.id)
      .order('created_at', { ascending: false })
      .limit(100),
  ])

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
