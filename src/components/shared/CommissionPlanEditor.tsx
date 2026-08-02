'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { formatMoney } from '@/lib/utils'
import {
  dollarsToCents,
  rateToBp,
  type CommissionCategoryRate,
  type CommissionPlan,
  type CommissionServiceRate,
  type CommissionTier,
} from '@/types/staff'

export type CommissionNamedRow = { id: number; name: string }

type DraftCategoryRate = { category_id: string; percent: string; flat: string }
type DraftServiceRate = { service_id: string; percent: string; flat: string }
type DraftTier = { applies_to: 'service' | 'retail'; from: string; percent: string }

const bp = (v: number) => (v / 100).toString()

/**
 * A rate card.
 *
 * Everything on a plan is written before anyone is assigned to it, because a
 * plan that has been in force is frozen in the database — see 034. Editing a
 * rate under a plan somebody was already paid on would silently restate what
 * they were owed, and the studio would have no way of noticing. The remedy is
 * the one the assignment table exists for: duplicate the card at the new rate
 * and assign it from a date.
 */
export function CommissionPlanEditor({
  plan,
  categoryRates,
  serviceRates,
  tiers,
  categories,
  services,
  inForce,
  onDone,
}: {
  /** Omitted for a new card; supplied to edit one, or to seed a duplicate. */
  plan?: CommissionPlan
  categoryRates?: CommissionCategoryRate[]
  serviceRates?: CommissionServiceRate[]
  tiers?: CommissionTier[]
  categories: CommissionNamedRow[]
  services: CommissionNamedRow[]
  /** True once someone has been assigned to it from a date already past. */
  inForce?: boolean
  onDone?: () => void
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState(plan ? `${plan.name} (new rate)` : '')
  const [description, setDescription] = useState(plan?.description ?? '')
  const [servicePercent, setServicePercent] = useState(plan ? bp(plan.service_rate_bp) : '40')
  const [retailPercent, setRetailPercent] = useState(plan ? bp(plan.retail_rate_bp) : '10')
  const [serviceFlat, setServiceFlat] = useState(
    plan ? (plan.service_flat_cents / 100).toFixed(2) : '0'
  )

  const [catRates, setCatRates] = useState<DraftCategoryRate[]>(
    (categoryRates ?? []).map((r) => ({
      category_id: String(r.category_id),
      percent: r.rate_bp === null ? '' : bp(r.rate_bp),
      flat: r.flat_cents === null ? '' : (r.flat_cents / 100).toFixed(2),
    }))
  )
  const [svcRates, setSvcRates] = useState<DraftServiceRate[]>(
    (serviceRates ?? []).map((r) => ({
      service_id: String(r.service_id),
      percent: r.rate_bp === null ? '' : bp(r.rate_bp),
      flat: r.flat_cents === null ? '' : (r.flat_cents / 100).toFixed(2),
    }))
  )
  const [tierRows, setTierRows] = useState<DraftTier[]>(
    (tiers ?? []).map((t) => ({
      applies_to: t.applies_to,
      from: (t.min_period_cents / 100).toFixed(0),
      percent: bp(t.rate_bp),
    }))
  )

  async function save() {
    if (!name.trim()) {
      toast.error('Give the card a name — "Provider standard", "Weekend cover".')
      return
    }

    const serviceBp = rateToBp(servicePercent)
    const retailBp = rateToBp(retailPercent)
    const flatCents = dollarsToCents(serviceFlat)

    if (serviceBp === null) {
      toast.error('The service rate has to be a percentage between 0 and 100.')
      return
    }
    if (retailBp === null) {
      toast.error('The retail rate has to be a percentage between 0 and 100.')
      return
    }
    if (flatCents === null) {
      toast.error('The flat amount per service is not a number.')
      return
    }

    // Validate the exceptions before writing anything, so a bad row cannot
    // leave a half-built card behind.
    const catPayload: Omit<CommissionCategoryRate, 'plan_id'>[] = []
    for (const r of catRates) {
      if (!r.category_id) continue
      const rate = r.percent.trim() === '' ? null : rateToBp(r.percent)
      const flat = r.flat.trim() === '' ? null : dollarsToCents(r.flat)
      if (rate === null && flat === null) {
        toast.error('A category exception has to say a rate, an amount, or both.')
        return
      }
      catPayload.push({ category_id: Number(r.category_id), rate_bp: rate, flat_cents: flat })
    }

    const svcPayload: Omit<CommissionServiceRate, 'plan_id'>[] = []
    for (const r of svcRates) {
      if (!r.service_id) continue
      const rate = r.percent.trim() === '' ? null : rateToBp(r.percent)
      const flat = r.flat.trim() === '' ? null : dollarsToCents(r.flat)
      if (rate === null && flat === null) {
        toast.error('A service exception has to say a rate, an amount, or both.')
        return
      }
      svcPayload.push({ service_id: Number(r.service_id), rate_bp: rate, flat_cents: flat })
    }

    const tierPayload: Omit<CommissionTier, 'id' | 'plan_id'>[] = []
    for (const t of tierRows) {
      const rate = rateToBp(t.percent)
      const from = dollarsToCents(t.from)
      if (rate === null || from === null) {
        toast.error('A tier needs a threshold in dollars and a rate as a percentage.')
        return
      }
      tierPayload.push({ applies_to: t.applies_to, min_period_cents: from, rate_bp: rate })
    }

    setBusy(true)
    const supabase = createClient()

    // Editing an existing, not-yet-in-force card; otherwise a new one.
    let planId = plan && !inForce ? plan.id : null

    if (planId === null) {
      const { data, error } = await supabase
        .from('commission_plans')
        .insert({
          name: name.trim(),
          description: description.trim() || null,
          service_rate_bp: serviceBp,
          retail_rate_bp: retailBp,
          service_flat_cents: flatCents,
        })
        .select('id')
        .single()

      if (error || !data) {
        setBusy(false)
        toast.error(error?.message || 'Could not save that rate card.')
        return
      }
      planId = data.id
    } else {
      const { error } = await supabase
        .from('commission_plans')
        .update({
          name: name.trim(),
          description: description.trim() || null,
          service_rate_bp: serviceBp,
          retail_rate_bp: retailBp,
          service_flat_cents: flatCents,
        })
        .eq('id', planId)

      if (error) {
        setBusy(false)
        toast.error(error.message || 'Could not save that rate card.')
        return
      }

      await supabase.from('commission_category_rates').delete().eq('plan_id', planId)
      await supabase.from('commission_service_rates').delete().eq('plan_id', planId)
      await supabase.from('commission_tiers').delete().eq('plan_id', planId)
    }

    if (catPayload.length > 0) {
      const { error } = await supabase
        .from('commission_category_rates')
        .insert(catPayload.map((r) => ({ ...r, plan_id: planId })))
      if (error) {
        setBusy(false)
        toast.error(error.message || 'Could not save the category exceptions.')
        return
      }
    }

    if (svcPayload.length > 0) {
      const { error } = await supabase
        .from('commission_service_rates')
        .insert(svcPayload.map((r) => ({ ...r, plan_id: planId })))
      if (error) {
        setBusy(false)
        toast.error(error.message || 'Could not save the service exceptions.')
        return
      }
    }

    if (tierPayload.length > 0) {
      const { error } = await supabase
        .from('commission_tiers')
        .insert(tierPayload.map((t) => ({ ...t, plan_id: planId })))
      if (error) {
        setBusy(false)
        toast.error(error.message || 'Could not save the tiers.')
        return
      }
    }

    setBusy(false)
    toast.success(`${name.trim()} saved.`)
    onDone?.()
    router.refresh()
  }

  return (
    <div className="space-y-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      {inForce && plan && (
        <p className="border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm text-[var(--color-muted)] dark:bg-[var(--color-background)]">
          {plan.name} has already been in force, so its rates are fixed — what
          somebody was paid last month has to stay what they were paid. Saving
          this makes a new card; assign it from a date and the old one stops
          applying that day.
        </p>
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" htmlFor="plan_name" className="sm:col-span-2">
          <Input
            id="plan_name"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="Provider standard"
          />
        </Field>

        <Field label="Note" htmlFor="plan_desc" className="sm:col-span-2" hint="Optional.">
          <Textarea
            id="plan_desc"
            value={description}
            maxLength={300}
            onChange={(e) => setDescription(e.target.value)}
          />
        </Field>

        <Field
          label="Services"
          htmlFor="plan_service_rate"
          hint="Percentage of what was actually collected."
        >
          <Input
            id="plan_service_rate"
            inputMode="decimal"
            value={servicePercent}
            onChange={(e) => setServicePercent(e.target.value)}
          />
        </Field>

        <Field label="Retail" htmlFor="plan_retail_rate" hint="On the goods, never on the tax.">
          <Input
            id="plan_retail_rate"
            inputMode="decimal"
            value={retailPercent}
            onChange={(e) => setRetailPercent(e.target.value)}
          />
        </Field>

        <Field
          label="Plus, per service"
          htmlFor="plan_flat"
          hint="A flat amount on top, in dollars. Add-ons do not attract it."
        >
          <Input
            id="plan_flat"
            inputMode="decimal"
            value={serviceFlat}
            onChange={(e) => setServiceFlat(e.target.value)}
          />
        </Field>
      </div>

      {/* ── Category exceptions ── */}
      <div className="space-y-3 border-t border-[var(--color-border)] pt-6">
        <p className="label-caps text-[var(--color-muted)]">By category</p>
        <p className="max-w-prose text-xs text-[var(--color-muted)]">
          Anything left off pays the rate above. Peels at 45% while everything
          else stays at 40% goes here.
        </p>

        {catRates.map((r, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3">
            <Select
              aria-label="Category"
              value={r.category_id}
              className="w-56"
              onChange={(e) =>
                setCatRates((rows) =>
                  rows.map((row, j) => (i === j ? { ...row, category_id: e.target.value } : row))
                )
              }
            >
              <option value="">Choose a category</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
            <Input
              aria-label="Rate"
              className="w-24"
              inputMode="decimal"
              placeholder="%"
              value={r.percent}
              onChange={(e) =>
                setCatRates((rows) =>
                  rows.map((row, j) => (i === j ? { ...row, percent: e.target.value } : row))
                )
              }
            />
            <Input
              aria-label="Flat amount"
              className="w-24"
              inputMode="decimal"
              placeholder="$"
              value={r.flat}
              onChange={(e) =>
                setCatRates((rows) =>
                  rows.map((row, j) => (i === j ? { ...row, flat: e.target.value } : row))
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove"
              onClick={() => setCatRates((rows) => rows.filter((_, j) => j !== i))}
            >
              <X className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </div>
        ))}

        <Button
          type="button"
          variant="subtle"
          size="sm"
          onClick={() =>
            setCatRates((rows) => [...rows, { category_id: '', percent: '', flat: '' }])
          }
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          Category
        </Button>
      </div>

      {/* ── Service exceptions ── */}
      <div className="space-y-3 border-t border-[var(--color-border)] pt-6">
        <p className="label-caps text-[var(--color-muted)]">By service</p>
        <p className="max-w-prose text-xs text-[var(--color-muted)]">
          The most specific thing you can say, so it wins over the category and
          over any tier.
        </p>

        {svcRates.map((r, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3">
            <Select
              aria-label="Service"
              value={r.service_id}
              className="w-56"
              onChange={(e) =>
                setSvcRates((rows) =>
                  rows.map((row, j) => (i === j ? { ...row, service_id: e.target.value } : row))
                )
              }
            >
              <option value="">Choose a service</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
            <Input
              aria-label="Rate"
              className="w-24"
              inputMode="decimal"
              placeholder="%"
              value={r.percent}
              onChange={(e) =>
                setSvcRates((rows) =>
                  rows.map((row, j) => (i === j ? { ...row, percent: e.target.value } : row))
                )
              }
            />
            <Input
              aria-label="Flat amount"
              className="w-24"
              inputMode="decimal"
              placeholder="$"
              value={r.flat}
              onChange={(e) =>
                setSvcRates((rows) =>
                  rows.map((row, j) => (i === j ? { ...row, flat: e.target.value } : row))
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove"
              onClick={() => setSvcRates((rows) => rows.filter((_, j) => j !== i))}
            >
              <X className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </div>
        ))}

        <Button
          type="button"
          variant="subtle"
          size="sm"
          onClick={() => setSvcRates((rows) => [...rows, { service_id: '', percent: '', flat: '' }])}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          Service
        </Button>
      </div>

      {/* ── Tiers ── */}
      <div className="space-y-3 border-t border-[var(--color-border)] pt-6">
        <p className="label-caps text-[var(--color-muted)]">Tiers</p>
        <p className="max-w-prose text-xs text-[var(--color-muted)]">
          The rate improves once the calendar month clears a number. Measured on
          what actually came in that month at that site, so a figure asked for
          mid-month moves as the month fills.
        </p>

        {tierRows.map((t, i) => (
          <div key={i} className="flex flex-wrap items-end gap-3">
            <Select
              aria-label="Applies to"
              value={t.applies_to}
              className="w-40"
              onChange={(e) =>
                setTierRows((rows) =>
                  rows.map((row, j) =>
                    i === j
                      ? { ...row, applies_to: e.target.value as 'service' | 'retail' }
                      : row
                  )
                )
              }
            >
              <option value="service">Services</option>
              <option value="retail">Retail</option>
            </Select>
            <Input
              aria-label="From"
              className="w-32"
              inputMode="decimal"
              placeholder="$ from"
              value={t.from}
              onChange={(e) =>
                setTierRows((rows) =>
                  rows.map((row, j) => (i === j ? { ...row, from: e.target.value } : row))
                )
              }
            />
            <Input
              aria-label="Rate"
              className="w-24"
              inputMode="decimal"
              placeholder="%"
              value={t.percent}
              onChange={(e) =>
                setTierRows((rows) =>
                  rows.map((row, j) => (i === j ? { ...row, percent: e.target.value } : row))
                )
              }
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label="Remove"
              onClick={() => setTierRows((rows) => rows.filter((_, j) => j !== i))}
            >
              <X className="h-4 w-4" strokeWidth={1.5} />
            </Button>
          </div>
        ))}

        <Button
          type="button"
          variant="subtle"
          size="sm"
          onClick={() =>
            setTierRows((rows) => [
              ...rows,
              { applies_to: 'service', from: '', percent: '' },
            ])
          }
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.5} />
          Tier
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-6">
        <Button type="button" size="sm" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : plan && !inForce ? 'Save card' : 'Create card'}
        </Button>
        {onDone && (
          <Button type="button" size="sm" variant="ghost" onClick={onDone} disabled={busy}>
            Cancel
          </Button>
        )}
        {dollarsToCents(serviceFlat) ? (
          <span className="text-xs text-[var(--color-muted)]">
            {servicePercent}% plus {formatMoney(dollarsToCents(serviceFlat) ?? 0)} a service
          </span>
        ) : null}
      </div>
    </div>
  )
}
