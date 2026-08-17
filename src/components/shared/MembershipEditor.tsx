'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { formatMoney } from '@/lib/utils'
import {
  describeMembershipBenefit,
  membershipPeriodLabel,
  type Membership,
} from '@/types/memberships'

export interface MembershipServiceOption {
  id: number
  name: string
  price_cents: number
}

/** "$89.00" → 8900. Null if it isn't a number. */
function toCents(dollars: string): number | null {
  const n = Number(dollars.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

const money = (cents: number) => (cents / 100).toFixed(2)

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

type Draft = Omit<Membership, 'id' | 'created_at' | 'updated_at' | 'stripe_price_id'>

const BLANK: Draft = {
  name: '',
  slug: '',
  description: null,
  price_cents: 0,
  period_months: 1,
  service_discount_pct: 10,
  included_sessions_per_period: 0,
  is_active: true,
  sort_order: 0,
}

/** The periods a studio actually sells. Not a limit — the column takes 1–24. */
const PERIODS = [1, 3, 6, 12]

/**
 * Create or edit one membership plan.
 *
 * `memberships` is `is_manager()` for writes in 050, and RLS is what actually
 * holds — the page hiding this button is a courtesy.
 *
 * Two things this screen says out loud because they are surprising:
 *
 *   • Changing what a plan GRANTS changes it for everyone already in it. The
 *     benefits are read live at booking time.
 *   • Changing what it COSTS does not. Every member carries the price they
 *     joined at, frozen by a trigger at enrolment, for the same reason a signed
 *     consent form keeps the words that were on the screen.
 *
 * The scope list narrows only the INCLUDED SESSIONS. The percentage is a member
 * discount and applies to the whole visit; ticking nothing leaves a session
 * spendable on any treatment, which is what a plan that has not been narrowed
 * yet means.
 */
export function MembershipEditor({
  plan,
  scopeServiceIds = [],
  services,
  trigger = 'button',
}: {
  plan?: Membership
  /** Which services this plan's included sessions may be spent on. */
  scopeServiceIds?: number[]
  services: MembershipServiceOption[]
  trigger?: 'button' | 'link'
}) {
  const router = useRouter()
  const isNew = !plan
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [form, setForm] = useState<Draft>(plan ?? BLANK)
  const [price, setPrice] = useState(money(plan?.price_cents ?? 0))
  const [scope, setScope] = useState<number[]>(scopeServiceIds)

  function set<K extends keyof Draft>(key: K, value: Draft[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const priceCents = toCents(price) ?? 0
  const period = membershipPeriodLabel(form.period_months)

  // What the included treatments are worth at the menu price. The benefit is
  // spent dearest-first (src/lib/memberships.ts), so the dearest in scope is
  // the honest figure — and with nothing in scope, any treatment qualifies, so
  // it is the dearest on the menu.
  const inScope = scope.length > 0 ? services.filter((s) => scope.includes(s.id)) : services
  const dearestCents = inScope.reduce((n, s) => Math.max(n, s.price_cents), 0)
  const includedListCents = dearestCents * form.included_sessions_per_period
  const underwater = includedListCents > 0 && includedListCents > priceCents

  async function save(e: React.FormEvent) {
    e.preventDefault()

    const cents = toCents(price)
    if (cents === null) {
      toast.error('That price is not a number.')
      return
    }
    if (!form.name.trim()) {
      toast.error('Give the membership a name.')
      return
    }
    if (form.service_discount_pct === 0 && form.included_sessions_per_period === 0) {
      toast.error(
        'A membership has to grant something — a discount, some included treatments, or both.'
      )
      return
    }
    if (form.service_discount_pct < 0 || form.service_discount_pct > 90) {
      toast.error('The member discount is a percentage between 0 and 90.')
      return
    }
    if (form.included_sessions_per_period < 0 || form.included_sessions_per_period > 31) {
      toast.error('Included treatments has to be a whole number, and 31 is already absurd.')
      return
    }

    const payload = {
      name: form.name.trim(),
      slug: form.slug.trim() || slugify(form.name),
      description: form.description?.trim() || null,
      price_cents: cents,
      period_months: form.period_months,
      service_discount_pct: form.service_discount_pct,
      included_sessions_per_period: form.included_sessions_per_period,
      is_active: form.is_active,
      sort_order: form.sort_order,
    }

    setBusy(true)
    const supabase = createClient()

    const { data: saved, error } = isNew
      ? await supabase.from('memberships').insert(payload).select('id').single()
      : await supabase.from('memberships').update(payload).eq('id', plan.id).select('id').single()

    if (error || !saved) {
      setBusy(false)
      toast.error(
        error?.code === '23505'
          ? 'Another membership already uses that name. Try a slightly different one.'
          : error?.message || 'Could not save that membership.'
      )
      return
    }

    // Replace the scope wholesale. Two statements rather than a diff: the list
    // is a handful of rows, and "what is ticked now" is easier to be sure of
    // than "what changed".
    const wanted = form.included_sessions_per_period > 0 ? scope : []
    const { error: clearError } = await supabase
      .from('membership_services')
      .delete()
      .eq('membership_id', saved.id)

    if (!clearError && wanted.length > 0) {
      await supabase
        .from('membership_services')
        .insert(wanted.map((serviceId) => ({ membership_id: saved.id, service_id: serviceId })))
    }

    setBusy(false)
    toast.success(isNew ? `${payload.name} added.` : 'Saved.')
    setOpen(false)
    if (isNew) {
      setForm(BLANK)
      setPrice('0.00')
      setScope([])
    }
    router.refresh()
  }

  async function remove() {
    if (!plan) return
    if (
      !confirm(
        `Delete "${plan.name}"? Anyone already enrolled keeps what they are paying for — but if it has ever been sold, switching it off is the honest move.`
      )
    ) {
      return
    }

    setBusy(true)
    const { error } = await createClient().from('memberships').delete().eq('id', plan.id)
    setBusy(false)

    if (error) {
      toast.error(
        // client_memberships.membership_id is ON DELETE RESTRICT, so a plan
        // somebody holds cannot be deleted at all. Say that rather than
        // repeating Postgres at them.
        error.code === '23503'
          ? 'Clients still hold this membership, so it cannot be deleted. Switch it off instead — nobody in it is affected.'
          : error.message || 'Could not delete that membership.'
      )
      return
    }
    toast.success(`${plan.name} deleted.`)
    setOpen(false)
    router.refresh()
  }

  if (!open) {
    if (trigger === 'link') {
      return (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="label-caps text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)]"
        >
          Edit
        </button>
      )
    }
    return (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" strokeWidth={1.75} />
        New membership
      </Button>
    )
  }

  return (
    <Modal
      label={isNew ? 'Add a membership' : `Edit ${plan.name}`}
      title={isNew ? 'New membership' : plan.name}
      onClose={() => setOpen(false)}
      busy={busy}
      onSubmit={save}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2.5">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Saving…' : isNew ? 'Add membership' : 'Save'}
            </Button>
            <Button type="button" size="sm" variant="subtle" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>

          {!isNew && (
            <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={remove}>
              <Trash2 className="h-4 w-4" strokeWidth={1.75} />
              Delete
            </Button>
          )}
        </div>
      }
    >
        <p className="max-w-prose text-sm text-[var(--color-muted)]">
          A standing arrangement, charged again every period. Nothing here takes a
          card — the studio records each period as it is paid.
        </p>

        <div className="mt-7 grid gap-5 sm:grid-cols-2">
          <Field label="Name" htmlFor="mem_name" className="sm:col-span-2">
            <Input
              id="mem_name"
              required
              maxLength={120}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Glow Club"
            />
          </Field>

          <Field
            label="Description"
            htmlFor="mem_description"
            hint="What the member gets, in the studio's own words."
            className="sm:col-span-2"
          >
            <Textarea
              id="mem_description"
              maxLength={600}
              value={form.description ?? ''}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>

          <Field label="Price" htmlFor="mem_price" hint={`In dollars, per ${period}.`}>
            <Input
              id="mem_price"
              inputMode="decimal"
              required
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>

          <Field label="Charged every" htmlFor="mem_period">
            <Select
              id="mem_period"
              value={String(form.period_months)}
              onChange={(e) => set('period_months', Number(e.target.value))}
            >
              {PERIODS.map((m) => (
                <option key={m} value={m}>
                  {m === 1 ? 'Month' : m === 12 ? 'Year' : `${m} months`}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Member discount"
            htmlFor="mem_discount"
            hint="Per cent off the whole visit. 0 for none."
          >
            <Input
              id="mem_discount"
              type="number"
              min={0}
              max={90}
              step={1}
              required
              value={form.service_discount_pct}
              onChange={(e) => set('service_discount_pct', Number(e.target.value))}
            />
          </Field>

          <Field
            label="Treatments included"
            htmlFor="mem_sessions"
            hint={`How many are covered each ${period}. 0 for none.`}
          >
            <Input
              id="mem_sessions"
              type="number"
              min={0}
              max={31}
              step={1}
              required
              value={form.included_sessions_per_period}
              onChange={(e) => set('included_sessions_per_period', Number(e.target.value))}
            />
          </Field>

          {form.included_sessions_per_period > 0 && (
            <fieldset className="sm:col-span-2">
              <legend className="label-caps text-[var(--color-muted)]">
                Which treatments a session covers
              </legend>
              <p className="mt-2 max-w-prose text-xs text-[var(--color-muted)]">
                Tick nothing and an included treatment can be spent on anything on the
                menu. The member discount is not narrowed by this — it applies to the
                whole visit either way.
              </p>
              <div className="mt-3 max-h-56 overflow-y-auto border border-[var(--color-border)] p-3">
                {services.length === 0 ? (
                  <p className="text-sm text-[var(--color-muted)]">
                    No services on the menu yet.
                  </p>
                ) : (
                  <ul className="space-y-1.5">
                    {services.map((s) => (
                      <li key={s.id}>
                        <label className="flex cursor-pointer items-center gap-2.5 text-sm">
                          <input
                            type="checkbox"
                            className="h-4 w-4 accent-[var(--color-accent)]"
                            checked={scope.includes(s.id)}
                            onChange={(e) =>
                              setScope((current) =>
                                e.target.checked
                                  ? [...current, s.id]
                                  : current.filter((id) => id !== s.id)
                              )
                            }
                          />
                          <span className="min-w-0 flex-1 truncate">{s.name}</span>
                          <span className="tabular-nums text-xs text-[var(--color-muted)]">
                            {formatMoney(s.price_cents)}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </fieldset>
          )}

          <Field label="Sort order" htmlFor="mem_sort" hint="Lower shows first.">
            <Input
              id="mem_sort"
              type="number"
              step={1}
              value={form.sort_order}
              onChange={(e) => set('sort_order', Number(e.target.value))}
            />
          </Field>

          <label className="flex items-center gap-3 self-end pb-2 text-sm">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => set('is_active', e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            Open to new members
          </label>
        </div>

        <dl
          data-ui="tile"
          className="mt-7 flex flex-wrap gap-x-10 gap-y-3 bg-[var(--color-linen)] p-5 text-sm dark:bg-[var(--color-background)]"
        >
          <div>
            <dt className="label-caps text-[var(--color-muted)]">A member pays</dt>
            <dd className="mt-1 tabular-nums">
              {priceCents > 0 ? `${formatMoney(priceCents)} / ${period}` : 'Nothing'}
            </dd>
          </div>
          <div>
            <dt className="label-caps text-[var(--color-muted)]">And gets</dt>
            <dd className="mt-1">
              {describeMembershipBenefit(form) || (
                <span className="text-amber-700 dark:text-amber-400">Nothing yet</span>
              )}
            </dd>
          </div>
          {form.included_sessions_per_period > 0 && (
            <div>
              <dt className="label-caps text-[var(--color-muted)]">Included, at menu price</dt>
              <dd className="mt-1 tabular-nums">
                {includedListCents > 0 ? formatMoney(includedListCents) : '—'}
              </dd>
            </div>
          )}
        </dl>

        {underwater && (
          <p className="mt-4 border-l-2 border-amber-600 bg-amber-50 p-4 text-sm text-amber-800 dark:bg-transparent dark:text-amber-400">
            The treatments this includes are worth more at menu price than the membership
            costs, before the member discount is applied to anything else. That can be
            deliberate — it is how a membership buys loyalty — but it should be on
            purpose.
          </p>
        )}

        <p className="mt-5 max-w-prose text-xs text-[var(--color-muted)]">
          Changing what this plan <em>grants</em> changes it for everyone already in it —
          the benefits are read fresh on every visit. Changing what it <em>costs</em> does
          not: each member keeps the price they joined at.
        </p>

    </Modal>
  )
}
