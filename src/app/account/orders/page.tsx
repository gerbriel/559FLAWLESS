import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'

export const dynamic = 'force-dynamic'

export default async function OrdersPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: orders } = await supabase
    .from('orders')
    .select('id, order_number, status, fulfillment, total_cents, created_at, order_items(id, name_snapshot, qty, line_total_cents)')
    .eq('client_id', user.id)
    .neq('status', 'cart')
    .order('created_at', { ascending: false })

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Orders</h1>
        <ButtonLink href="/shop" size="sm" variant="subtle">
          Shop
        </ButtonLink>
      </div>

      {(orders?.length ?? 0) === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          No orders yet.
        </p>
      ) : (
        <div className="mt-10 space-y-5">
          {(orders ?? []).map((o) => {
            const items = (o.order_items ?? []) as {
              id: number
              name_snapshot: string
              qty: number
              line_total_cents: number
            }[]

            return (
              <div key={o.id} className="border border-[var(--color-border)] bg-[var(--color-surface)]">
                <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[var(--color-border)] px-6 py-4">
                  <div>
                    <p className="label-caps text-[var(--color-muted)]">
                      {o.order_number ?? `Order ${o.id}`}
                    </p>
                    <p className="mt-1 text-sm text-[var(--color-muted)]">
                      {new Date(o.created_at).toLocaleDateString('en-US', {
                        month: 'long',
                        day: 'numeric',
                        year: 'numeric',
                      })}
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    <Badge
                      tone={
                        o.status === 'completed' || o.status === 'paid'
                          ? 'success'
                          : o.status === 'cancelled' || o.status === 'refunded'
                            ? 'danger'
                            : 'warning'
                      }
                    >
                      {o.status.replace('_', ' ')}
                    </Badge>
                    <span className="tabular-nums">{formatMoney(o.total_cents)}</span>
                  </div>
                </div>

                <ul className="divide-y divide-[var(--color-border)]">
                  {items.map((it) => (
                    <li key={it.id} className="flex justify-between gap-6 px-6 py-3 text-sm">
                      <span>
                        {it.name_snapshot}
                        <span className="ml-2 text-[var(--color-muted)]">× {it.qty}</span>
                      </span>
                      <span className="tabular-nums text-[var(--color-muted)]">
                        {formatMoney(it.line_total_cents)}
                      </span>
                    </li>
                  ))}
                </ul>

                <p className="px-6 py-3 text-xs text-[var(--color-muted)]">
                  {o.fulfillment === 'pickup' ? 'Pick up at the studio' : 'Shipping'}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
