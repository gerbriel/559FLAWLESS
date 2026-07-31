import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import type { OrderStatus } from '@/types/database'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ status?: string }>
}

const FILTERS: { key: string; label: string }[] = [
  { key: 'open', label: 'To fulfil' },
  { key: 'paid', label: 'Paid' },
  { key: 'completed', label: 'Completed' },
  { key: 'all', label: 'All' },
]

const OPEN_STATUSES: OrderStatus[] = ['paid', 'fulfilling', 'ready_for_pickup']

export default async function DashboardOrdersPage({ searchParams }: Props) {
  const { status } = await searchParams
  const active = FILTERS.some((f) => f.key === status) ? status! : 'open'

  const supabase = await createClient()

  let query = supabase
    .from('orders')
    .select(
      'id, order_number, status, fulfillment, total_cents, created_at, guest_name, guest_email, profiles!orders_client_id_fkey(first_name, last_name), order_items(id, name_snapshot, qty)'
    )
    .neq('status', 'cart')
    .order('created_at', { ascending: false })
    .limit(100)

  if (active === 'open') query = query.in('status', OPEN_STATUSES)
  else if (active !== 'all') query = query.eq('status', active as OrderStatus)

  const { data: orders } = await query

  return (
    <div>
      <h1 className="display text-3xl">Orders</h1>

      <nav className="mt-8 flex flex-wrap gap-x-7 gap-y-2" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/dashboard/orders?status=${f.key}`}
            className={`label-caps pb-1 ${
              active === f.key
                ? 'border-b border-[var(--color-foreground)]'
                : 'text-[var(--color-muted)]'
            }`}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {(orders?.length ?? 0) === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          Nothing here.
        </p>
      ) : (
        <ul className="mt-8 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {(orders ?? []).map((o) => {
            const client = o.profiles as {
              first_name: string | null
              last_name: string | null
            } | null
            const who = client
              ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
              : (o.guest_name ?? o.guest_email ?? 'Guest')

            const items = (o.order_items ?? []) as {
              id: number
              name_snapshot: string
              qty: number
            }[]

            return (
              <li key={o.id} className="flex flex-wrap items-baseline gap-x-6 gap-y-2 py-5">
                <span className="label-caps w-32 shrink-0 text-[var(--color-muted)]">
                  {o.order_number ?? `#${o.id}`}
                </span>

                <div className="min-w-0 flex-1">
                  <p>{who}</p>
                  <p className="mt-0.5 truncate text-sm text-[var(--color-muted)]">
                    {items.map((i) => `${i.name_snapshot} ×${i.qty}`).join(', ')}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <Badge tone="neutral">
                    {o.fulfillment === 'pickup' ? 'Pickup' : 'Ship'}
                  </Badge>
                  <Badge
                    tone={
                      o.status === 'completed'
                        ? 'success'
                        : o.status === 'cancelled' || o.status === 'refunded'
                          ? 'danger'
                          : 'warning'
                    }
                  >
                    {o.status.replace('_', ' ')}
                  </Badge>
                  <span className="w-20 text-right tabular-nums">
                    {formatMoney(o.total_cents)}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
