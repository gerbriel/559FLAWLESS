'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { formatMoney, slugify } from '@/lib/utils'
import {
  describeMembershipBenefit,
  describeProductPerk,
  membershipPeriodLabel,
  type Membership,
  type MembershipProductPerk,
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

export interface MembershipNamedOption {
  id: number
  name: string
}

/**
 * One product perk row as typed. `scope` is the select's value: 'all', or
 * 'c:<category id>', or 'p:<product id>'. Numbers stay strings until save so
 * a half-typed field is not coerced to 0 under somebody's cursor.
 */
type PerkDraft = {
  key: string
  scope: string
  kind: MembershipProductPerk['kind']
  percent: string
  buyQty: string
  label: string
}

function perkScope(p: Pick<MembershipProductPerk, 'product_id' | 'category_id'>): string {
  if (p.product_id !== null) return `p:${p.product_id}`
  if (p.category_id !== null) return `c:${p.category_id}`
  return 'all'
}

function scopeIds(scope: string): { product_id: number | null; category_id: number | null } {
  if (scope.startsWith('p:')) return { product_id: Number(scope.slice(2)), category_id: null }
  if (scope.startsWith('c:')) return { product_id: null, category_id: Number(scope.slice(2)) }
  return { product_id: null, category_id: null }
}

/** A whole number inside [min, max], or null. */
function wholeIn(text: string, min: number, max: number): number | null {
  const n = Number(text.trim())
  if (!text.trim() || !Number.isInteger(n) || n < min || n > max) return null
  return n
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
  sell_online: false,
  auto_renew_offered: false,
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
  memberPrices = [],
  productPerks = [],
  services,
  products,
  categories,
  trigger = 'button',
}: {
  plan?: Membership
  /** Which services this plan's included sessions may be spent on. */
  scopeServiceIds?: number[]
  /** Services a member pays a set price for (078), e.g. the Brazilian at $25. */
  memberPrices?: { service_id: number; price_cents: number }[]
  /** Retail perks this plan already grants (086), loaded like the member prices. */
  productPerks?: MembershipProductPerk[]
  services: MembershipServiceOption[]
  /** Active retail products, for scoping a product perk to one of them. */
  products: MembershipNamedOption[]
  /** Product categories, for scoping a product perk to a whole shelf. */
  categories: MembershipNamedOption[]
  trigger?: 'button' | 'link'
}) {
  const router = useRouter()
  const isNew = !plan
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [form, setForm] = useState<Draft>(plan ?? BLANK)
  const [price, setPrice] = useState(money(plan?.price_cents ?? 0))
  const [scope, setScope] = useState<number[]>(scopeServiceIds)
  const [prices, setPrices] = useState<{ serviceId: number; price: string }[]>(
    memberPrices.map((p) => ({ serviceId: p.service_id, price: money(p.price_cents) }))
  )
  const [perks, setPerks] = useState<PerkDraft[]>(() =>
    [...productPerks]
      .sort((a, b) => a.sort_order - b.sort_order || a.id - b.id)
      .map((p) => ({
        key: `saved-${p.id}`,
        scope: perkScope(p),
        kind: p.kind,
        percent: String(p.percent_off),
        buyQty: p.buy_qty === null ? '' : String(p.buy_qty),
        label: p.label ?? '',
      }))
  )

  function setPerk(i: number, patch: Partial<PerkDraft>) {
    setPerks((cur) => cur.map((x, j) => (j === i ? { ...x, ...patch } : x)))
  }

  function addPerk() {
    setPerks((cur) => [
      ...cur,
      {
        key: `new-${crypto.randomUUID()}`,
        scope: 'all',
        kind: 'percent_off',
        percent: '10',
        buyQty: '',
        label: '',
      },
    ])
  }

  /** The perk's sentence, as the plan card will print it. Null while a field is not yet valid. */
  function perkPreview(p: PerkDraft): string | null {
    const percent = wholeIn(p.percent, 1, 100)
    const buy = p.kind === 'buy_get' ? wholeIn(p.buyQty, 1, 10) : null
    if (percent === null || (p.kind === 'buy_get' && buy === null)) return null
    const ids = scopeIds(p.scope)
    return describeProductPerk(
      { kind: p.kind, percent_off: percent, buy_qty: buy, ...ids },
      {
        product: products.find((x) => x.id === ids.product_id)?.name,
        category: categories.find((x) => x.id === ids.category_id)?.name,
      }
    )
  }

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
    const parsedPrices = prices.map((p) => ({ serviceId: p.serviceId, cents: toCents(p.price) }))
    if (parsedPrices.some((p) => p.cents === null)) {
      toast.error('One of the member prices is not a number.')
      return
    }
    const parsedPerks: {
      kind: PerkDraft['kind']
      percent_off: number
      buy_qty: number | null
      product_id: number | null
      category_id: number | null
      label: string | null
    }[] = []
    for (const p of perks) {
      const percent = wholeIn(p.percent, 1, 100)
      if (percent === null) {
        toast.error('Each product perk needs a percent off, a whole number from 1 to 100.')
        return
      }
      const buy = p.kind === 'buy_get' ? wholeIn(p.buyQty, 1, 10) : null
      if (p.kind === 'buy_get' && buy === null) {
        toast.error('A "buy some, get one cheaper" perk needs how many to buy, from 1 to 10.')
        return
      }
      const ids = scopeIds(p.scope)
      parsedPerks.push({
        kind: p.kind,
        percent_off: percent,
        buy_qty: buy,
        ...ids,
        label: p.label.trim() || null,
      })
    }
    if (
      form.service_discount_pct === 0 &&
      form.included_sessions_per_period === 0 &&
      parsedPrices.length === 0 &&
      parsedPerks.length === 0
    ) {
      toast.error(
        'A membership has to grant something: a member discount, included treatments, a member price, or a product perk.'
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
      // Typed slugs go through slugify too — see ServiceEditor for the '+' story.
      slug: slugify(form.slug.trim() || form.name),
      description: form.description?.trim() || null,
      price_cents: cents,
      period_months: form.period_months,
      service_discount_pct: form.service_discount_pct,
      included_sessions_per_period: form.included_sessions_per_period,
      sell_online: form.sell_online,
      auto_renew_offered: form.auto_renew_offered,
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

    // Member prices, replaced wholesale for the same reason as the scope.
    const { error: clearPricesError } = await supabase
      .from('membership_member_prices')
      .delete()
      .eq('membership_id', saved.id)
    if (!clearPricesError && parsedPrices.length > 0) {
      await supabase.from('membership_member_prices').insert(
        parsedPrices.map((p) => ({
          membership_id: saved.id,
          service_id: p.serviceId,
          price_cents: p.cents ?? 0,
        }))
      )
    }

    // Product perks, replaced wholesale too. Order on the screen is the order
    // on the plan card.
    const { error: clearPerksError } = await supabase
      .from('membership_product_perks')
      .delete()
      .eq('membership_id', saved.id)
    let perksError = clearPerksError
    if (!clearPerksError && parsedPerks.length > 0) {
      const { error: insertPerksError } = await supabase
        .from('membership_product_perks')
        .insert(parsedPerks.map((p, i) => ({ ...p, membership_id: saved.id, sort_order: i })))
      perksError = insertPerksError
    }

    setBusy(false)
    if (perksError) {
      toast.error(perksError.message || 'The plan saved, but its product perks did not.')
      router.refresh()
      return
    }
    toast.success(isNew ? `${payload.name} added.` : 'Saved.')
    setOpen(false)
    if (isNew) {
      setForm(BLANK)
      setPrice('0.00')
      setScope([])
      setPrices([])
      setPerks([])
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
          A standing arrangement, paid once per period. Sold online, the first period
          is paid through Stripe on the website; at the counter, the studio records
          each period as it is paid. Online plans can also offer auto-renew, where
          Stripe charges the member every period until they stop.
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

          <fieldset className="sm:col-span-2">
            <legend className="label-caps text-[var(--color-muted)]">Member prices</legend>
            <p className="mt-2 max-w-prose text-xs text-[var(--color-muted)]">
              A set price a member pays for a service, on any visit while their
              membership is current — e.g. a Brazilian for $25. Never lower than this
              if another deal already applies; never stacked below it.
            </p>
            <ul className="mt-3 space-y-2">
              {prices.map((p, i) => {
                const svc = services.find((s) => s.id === p.serviceId)
                return (
                  <li key={p.serviceId} className="flex items-center gap-3 text-sm">
                    <span className="min-w-0 flex-1 truncate">
                      {svc?.name ?? `Service ${p.serviceId}`}
                      {svc && (
                        <span className="ml-2 text-xs text-[var(--color-muted)]">
                          usually {formatMoney(svc.price_cents)}
                        </span>
                      )}
                    </span>
                    <Input
                      aria-label={`Member price for ${svc?.name ?? 'service'}`}
                      inputMode="decimal"
                      className="w-28"
                      value={p.price}
                      onChange={(e) =>
                        setPrices((cur) =>
                          cur.map((x, j) => (j === i ? { ...x, price: e.target.value } : x))
                        )
                      }
                    />
                    <button
                      type="button"
                      onClick={() => setPrices((cur) => cur.filter((_, j) => j !== i))}
                      className="flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-red-700"
                      aria-label={`Remove member price for ${svc?.name ?? 'service'}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  </li>
                )
              })}
            </ul>
            <Select
              aria-label="Add a member price"
              className="mt-3"
              value=""
              onChange={(e) => {
                const id = Number(e.target.value)
                const svc = services.find((s) => s.id === id)
                if (!svc || prices.some((p) => p.serviceId === id)) return
                setPrices((cur) => [...cur, { serviceId: id, price: money(svc.price_cents) }])
              }}
            >
              <option value="">Add a member price…</option>
              {services
                .filter((s) => !prices.some((p) => p.serviceId === s.id))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </Select>
          </fieldset>

          <fieldset className="sm:col-span-2">
            <legend className="label-caps text-[var(--color-muted)]">Product perks</legend>
            <p className="mt-2 max-w-prose text-xs text-[var(--color-muted)]">
              Savings on retail for a current member, in the online shop and at the studio
              till. They never stack: the shop and the till take the best single discount
              among these, the multibuy deal and a promo code.
            </p>
            {perks.length > 0 && (
              <ul className="mt-3 space-y-3">
                {perks.map((p, i) => {
                  const preview = perkPreview(p)
                  const ids = scopeIds(p.scope)
                  // A saved perk on something since taken out of the shop still
                  // needs an option, or the select would quietly show another.
                  const orphaned =
                    (ids.product_id !== null && !products.some((x) => x.id === ids.product_id)) ||
                    (ids.category_id !== null && !categories.some((x) => x.id === ids.category_id))
                  return (
                    <li
                      key={p.key}
                      data-ui="tile"
                      className="border border-[var(--color-border)] p-4"
                    >
                      <div className="grid gap-3 sm:grid-cols-2">
                        <Field label="Applies to" htmlFor={`perk_scope_${p.key}`}>
                          <Select
                            id={`perk_scope_${p.key}`}
                            value={p.scope}
                            onChange={(e) => setPerk(i, { scope: e.target.value })}
                          >
                            <option value="all">Every retail product</option>
                            {orphaned && (
                              <option value={p.scope}>No longer in the shop</option>
                            )}
                            {categories.length > 0 && (
                              <optgroup label="A category">
                                {categories.map((c) => (
                                  <option key={c.id} value={`c:${c.id}`}>
                                    {c.name}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                            {products.length > 0 && (
                              <optgroup label="A product">
                                {products.map((x) => (
                                  <option key={x.id} value={`p:${x.id}`}>
                                    {x.name}
                                  </option>
                                ))}
                              </optgroup>
                            )}
                          </Select>
                        </Field>
                        <Field label="Kind" htmlFor={`perk_kind_${p.key}`}>
                          <Select
                            id={`perk_kind_${p.key}`}
                            value={p.kind}
                            onChange={(e) =>
                              setPerk(i, {
                                kind: e.target.value === 'buy_get' ? 'buy_get' : 'percent_off',
                                buyQty:
                                  e.target.value === 'buy_get' && !p.buyQty ? '1' : p.buyQty,
                              })
                            }
                          >
                            <option value="percent_off">Percent off</option>
                            <option value="buy_get">Buy some, get one cheaper</option>
                          </Select>
                        </Field>
                        <Field
                          label={p.kind === 'buy_get' ? 'The next one is' : 'Percent off'}
                          htmlFor={`perk_pct_${p.key}`}
                          hint={
                            p.kind === 'buy_get'
                              ? 'Per cent off. 100 means free, 50 means half off.'
                              : 'Off every unit it covers, 1 to 100.'
                          }
                        >
                          <Input
                            id={`perk_pct_${p.key}`}
                            type="number"
                            min={1}
                            max={100}
                            step={1}
                            value={p.percent}
                            onChange={(e) => setPerk(i, { percent: e.target.value })}
                          />
                        </Field>
                        {p.kind === 'buy_get' && (
                          <Field
                            label="Buy this many"
                            htmlFor={`perk_buy_${p.key}`}
                            hint="1 to 10. The cheapest of each group gets the cut."
                          >
                            <Input
                              id={`perk_buy_${p.key}`}
                              type="number"
                              min={1}
                              max={10}
                              step={1}
                              value={p.buyQty}
                              onChange={(e) => setPerk(i, { buyQty: e.target.value })}
                            />
                          </Field>
                        )}
                        <Field
                          label="Label"
                          htmlFor={`perk_label_${p.key}`}
                          hint="Optional. Shown on the plan card instead of the plain sentence."
                          className="sm:col-span-2"
                        >
                          <Input
                            id={`perk_label_${p.key}`}
                            maxLength={120}
                            value={p.label}
                            placeholder={preview ?? ''}
                            onChange={(e) => setPerk(i, { label: e.target.value })}
                          />
                        </Field>
                      </div>
                      <div className="mt-3 flex items-center justify-between gap-3">
                        <p className="min-w-0 text-xs text-[var(--color-muted)]">
                          {preview ?? (
                            <span className="text-amber-700 dark:text-amber-400">
                              Not finished yet
                            </span>
                          )}
                        </p>
                        <button
                          type="button"
                          onClick={() => setPerks((cur) => cur.filter((_, j) => j !== i))}
                          className="flex h-8 shrink-0 items-center gap-1.5 text-xs text-[var(--color-muted)] hover:text-red-700"
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                          Remove
                        </button>
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
            <Button type="button" size="sm" variant="subtle" className="mt-3" onClick={addPerk}>
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              Add a product perk
            </Button>
          </fieldset>

          <label className="flex items-start gap-3 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.sell_online}
              onChange={(e) => set('sell_online', e.target.checked)}
              className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Sell online
              <span className="block text-xs text-[var(--color-muted)]">
                Shows on the website&rsquo;s Membership page, where a signed-in client
                pays the first {period} through Stripe and is enrolled straight away.
              </span>
            </span>
          </label>

          <label className="flex items-start gap-3 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.auto_renew_offered}
              onChange={(e) => set('auto_renew_offered', e.target.checked)}
              className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Offer auto-renew online
              <span className="block text-xs text-[var(--color-muted)]">
                Members who choose it are charged by Stripe every period until they
                stop. Pay once stays available.
              </span>
            </span>
          </label>

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
              {describeMembershipBenefit(form) ||
                (prices.length > 0 && perks.length > 0
                  ? 'Member prices and product perks only'
                  : prices.length > 0
                    ? 'Member prices only'
                    : perks.length > 0
                      ? 'Product perks only'
                      : (
                          <span className="text-amber-700 dark:text-amber-400">Nothing yet</span>
                        ))}
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
