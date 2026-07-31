import Link from 'next/link'
import { redirect } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { StockAdjuster } from '@/components/shared/StockAdjuster'
import { formatMoney } from '@/lib/utils'
import { isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ filter?: string }>
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'retail', label: 'Retail' },
  { key: 'backbar', label: 'Back bar' },
  { key: 'low', label: 'Low stock' },
]

export default async function InventoryPage({ searchParams }: Props) {
  const { filter } = await searchParams
  const active = filter ?? 'all'

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'provider') as UserRole
  const canWriteDirectly = isManager(role)

  let query = supabase
    .from('products')
    .select('id, sku, name, unit, stock_qty, low_stock_threshold, price_cents, cost_cents, is_retail, is_professional, is_active, brands(name)')
    .eq('is_active', true)
    .is('archived_at', null)
    .order('name')

  if (active === 'retail') query = query.eq('is_retail', true)
  if (active === 'backbar') query = query.eq('is_professional', true)

  const { data: products } = await query

  const rows =
    active === 'low'
      ? (products ?? []).filter((p) => Number(p.stock_qty) <= Number(p.low_stock_threshold))
      : (products ?? [])

  const lowCount = (products ?? []).filter(
    (p) => Number(p.stock_qty) <= Number(p.low_stock_threshold)
  ).length

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Inventory</h1>
        {lowCount > 0 && (
          <Link href="/dashboard/inventory?filter=low">
            <Badge tone="warning">
              <AlertTriangle className="h-3 w-3" strokeWidth={2} />
              {lowCount} low
            </Badge>
          </Link>
        )}
      </div>

      <nav className="mt-8 flex flex-wrap gap-x-7 gap-y-2" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/dashboard/inventory?filter=${f.key}`}
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

      {!canWriteDirectly && (
        <p className="mt-8 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm text-[var(--color-muted)] dark:bg-[var(--color-surface)]">
          Your stock changes go to a manager for approval before they take effect.
        </p>
      )}

      {rows.length === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          Nothing here yet.
        </p>
      ) : (
        <div className="mt-8 overflow-x-auto">
          <table className="w-full min-w-3xl text-sm">
            <thead>
              <tr className="border-y border-[var(--color-border)]">
                <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">
                  Product
                </th>
                <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">Use</th>
                <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                  On hand
                </th>
                <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                  Price
                </th>
                {canWriteDirectly && (
                  <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                    Cost
                  </th>
                )}
                <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                  Adjust
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => {
                const brand = p.brands as { name: string } | null
                const low = Number(p.stock_qty) <= Number(p.low_stock_threshold)

                return (
                  <tr key={p.id} className="border-b border-[var(--color-border)]">
                    <td className="px-3 py-3">
                      <span className="block">{p.name}</span>
                      <span className="text-xs text-[var(--color-muted)]">
                        {brand?.name ? `${brand.name} · ` : ''}
                        {p.sku}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <span className="flex flex-wrap gap-1.5">
                        {p.is_retail && <Badge tone="neutral">Retail</Badge>}
                        {p.is_professional && <Badge tone="accent">Back bar</Badge>}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      <span className={low ? 'text-amber-700 dark:text-amber-400' : ''}>
                        {Number(p.stock_qty)} {p.unit}
                      </span>
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {formatMoney(p.price_cents)}
                    </td>
                    {canWriteDirectly && (
                      <td className="px-3 py-3 text-right tabular-nums text-[var(--color-muted)]">
                        {formatMoney(p.cost_cents)}
                      </td>
                    )}
                    <td className="px-3 py-3 text-right">
                      <StockAdjuster
                        productId={p.id}
                        productName={p.name}
                        currentQty={Number(p.stock_qty)}
                        unit={p.unit}
                        canWriteDirectly={canWriteDirectly}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
