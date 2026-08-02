'use client'

import { useState } from 'react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'
import {
  CommissionPlanEditor,
  type CommissionNamedRow,
} from '@/components/shared/CommissionPlanEditor'
import {
  formatRate,
  type CommissionCategoryRate,
  type CommissionPlan,
  type CommissionServiceRate,
  type CommissionTier,
} from '@/types/staff'

/**
 * The studio's rate cards.
 *
 * A card that has been in force is shown read-only with a Duplicate beside it,
 * because the database will refuse to change its rates — see 034. That is not
 * an obstacle to work around: it is the only reason a payout from March can
 * still be recomputed in September and come out the same.
 */
export function CommissionPlanList({
  plans,
  categoryRates,
  serviceRates,
  tiers,
  categories,
  services,
  inForcePlanIds,
}: {
  plans: CommissionPlan[]
  categoryRates: CommissionCategoryRate[]
  serviceRates: CommissionServiceRate[]
  tiers: CommissionTier[]
  categories: CommissionNamedRow[]
  services: CommissionNamedRow[]
  /** Plans somebody has already been paid on. Their rates are frozen. */
  inForcePlanIds: number[]
}) {
  // null = nothing open; 0 = a blank new card; n = editing or duplicating n.
  const [editing, setEditing] = useState<number | null>(null)

  const frozen = new Set(inForcePlanIds)
  const seed = editing && editing > 0 ? plans.find((p) => p.id === editing) : undefined

  const categoryName = (id: number) => categories.find((c) => c.id === id)?.name ?? `#${id}`
  const serviceName = (id: number) => services.find((s) => s.id === id)?.name ?? `#${id}`

  return (
    <div>
      {editing === null ? (
        <Button variant="subtle" size="sm" onClick={() => setEditing(0)}>
          New rate card
        </Button>
      ) : (
        <CommissionPlanEditor
          plan={seed}
          categoryRates={seed ? categoryRates.filter((r) => r.plan_id === seed.id) : []}
          serviceRates={seed ? serviceRates.filter((r) => r.plan_id === seed.id) : []}
          tiers={seed ? tiers.filter((t) => t.plan_id === seed.id) : []}
          categories={categories}
          services={services}
          inForce={seed ? frozen.has(seed.id) : false}
          onDone={() => setEditing(null)}
        />
      )}

      {plans.length === 0 ? (
        <p className="mt-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          No rate cards yet.
        </p>
      ) : (
        <ul className="mt-10 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {plans.map((p) => {
            const cats = categoryRates.filter((r) => r.plan_id === p.id)
            const svcs = serviceRates.filter((r) => r.plan_id === p.id)
            const bands = tiers.filter((t) => t.plan_id === p.id)

            return (
              <li key={p.id} className="flex flex-wrap items-start justify-between gap-6 py-5">
                <div className="max-w-xl">
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    {p.name}
                    {frozen.has(p.id) && <Badge tone="neutral">In force</Badge>}
                    {!p.is_active && <Badge tone="warning">Retired</Badge>}
                  </p>

                  <p className="mt-1 text-xs tabular-nums text-[var(--color-muted)]">
                    {formatRate(p.service_rate_bp)} services · {formatRate(p.retail_rate_bp)} retail
                    {p.service_flat_cents > 0 &&
                      ` · plus ${formatMoney(p.service_flat_cents)} a service`}
                  </p>

                  {p.description && (
                    <p className="mt-2 text-xs text-[var(--color-muted)]">{p.description}</p>
                  )}

                  {(cats.length > 0 || svcs.length > 0 || bands.length > 0) && (
                    <ul className="mt-3 space-y-1 text-xs text-[var(--color-muted)]">
                      {cats.map((r) => (
                        <li key={`c${r.category_id}`}>
                          {categoryName(r.category_id)} —{' '}
                          {r.rate_bp !== null ? formatRate(r.rate_bp) : 'plan rate'}
                          {r.flat_cents ? ` plus ${formatMoney(r.flat_cents)}` : ''}
                        </li>
                      ))}
                      {svcs.map((r) => (
                        <li key={`s${r.service_id}`}>
                          {serviceName(r.service_id)} —{' '}
                          {r.rate_bp !== null ? formatRate(r.rate_bp) : 'plan rate'}
                          {r.flat_cents ? ` plus ${formatMoney(r.flat_cents)}` : ''}
                        </li>
                      ))}
                      {bands.map((t) => (
                        <li key={t.id}>
                          {t.applies_to === 'service' ? 'Services' : 'Retail'} from{' '}
                          {formatMoney(t.min_period_cents)} a month — {formatRate(t.rate_bp)}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                <Button variant="ghost" size="sm" onClick={() => setEditing(p.id)}>
                  {frozen.has(p.id) ? 'Duplicate' : 'Edit'}
                </Button>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
