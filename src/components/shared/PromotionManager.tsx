'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Pause, Play, Pencil, Plus, Trash2, Users, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input, Select, Label } from '@/components/ui/field'
import { Panel, StatTile } from '@/components/ui/dashboard'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import { PROMOTION_KIND_LABELS, promotionIsLive, type PromotionRule } from '@/lib/promotions'
import type { Promotion, PromotionKind } from '@/types/database'

/**
 * The deal board, editable. Renders straight from props — router.refresh()
 * after every write is what updates the list (the announcement editor's
 * stale-copy lesson, learned once).
 *
 * The form only offers the fields the chosen kind reads; everything else is
 * saved as null so a row never carries values its kind would ignore. Writes
 * are direct browser writes under the admin RLS policy (068) — this component
 * only renders for an admin, and the policy is what actually refuses others.
 */

export interface PromotionUsage {
  uses: number
  cents: number
}

interface ServiceRow {
  id: number
  name: string
  category_id: number
  is_active: boolean
  price_cents: number
}

interface ReferralRow {
  id: number
  status: string
  rewardCents: number | null
  rewardPercent: number | null
  createdAt: string
  referrer: string
}

const KINDS: PromotionKind[] = [
  'service_sale',
  'second_service',
  'product_multibuy',
  'new_client',
  'referral',
]

const BLANK = {
  name: '',
  kind: 'service_sale' as PromotionKind,
  percent: '',
  amount: '',
  salePrice: '',
  minItems: '3',
  serviceIds: [] as number[],
  startsAt: '',
  endsAt: '',
  isActive: true,
}

/** Dollars in, integer cents out — refuses anything that does not read as money. */
function parseMoney(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const [whole, frac = ''] = cleaned.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0') || 0)
}

function windowLabel(p: Promotion): string {
  const fmt = (iso: string) => new Date(iso).toLocaleDateString()
  if (p.starts_at && p.ends_at) return `${fmt(p.starts_at)} – ${fmt(p.ends_at)}`
  if (p.ends_at) return `until ${fmt(p.ends_at)}`
  if (p.starts_at) return `from ${fmt(p.starts_at)}`
  return 'no end date'
}

function valueSummary(p: Promotion): string {
  switch (p.kind) {
    case 'service_sale':
      return p.sale_price_cents !== null
        ? `${formatMoney(p.sale_price_cents)} sale price · ${p.service_ids.length} service${p.service_ids.length === 1 ? '' : 's'}`
        : `${p.percent_off}% off · ${p.service_ids.length} service${p.service_ids.length === 1 ? '' : 's'}`
    case 'second_service':
      return `cheapest second service ${p.percent_off}% off`
    case 'product_multibuy':
      return `every ${p.min_items} products, cheapest ${p.percent_off}% off`
    case 'new_client':
      return `${p.percent_off}% off a first visit`
    case 'referral':
      return p.amount_cents
        ? `referrer earns ${formatMoney(p.amount_cents)} off a visit`
        : `referrer earns ${p.percent_off}% off a visit`
  }
}

export function PromotionManager({
  promotions,
  usage,
  services,
  categories,
  referrals,
}: {
  promotions: Promotion[]
  usage: Record<number, PromotionUsage>
  services: ServiceRow[]
  categories: { id: number; name: string }[]
  referrals: ReferralRow[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState(BLANK)

  const catName = new Map(categories.map((c) => [c.id, c.name]))
  // Read once at mount: a list of badges must not flicker between renders,
  // and the engine re-checks every window server-side anyway.
  const [nowMs] = useState(() => Date.now())

  const startEdit = (p: Promotion) => {
    setForm({
      name: p.name,
      kind: p.kind,
      percent: p.percent_off === null ? '' : String(p.percent_off),
      amount: p.amount_cents === null ? '' : (p.amount_cents / 100).toFixed(2),
      salePrice: p.sale_price_cents === null ? '' : (p.sale_price_cents / 100).toFixed(2),
      minItems: p.min_items === null ? '3' : String(p.min_items),
      serviceIds: [...p.service_ids],
      startsAt: p.starts_at ? p.starts_at.split('T')[0] : '',
      endsAt: p.ends_at ? p.ends_at.split('T')[0] : '',
      isActive: p.is_active,
    })
    setEditing(p.id)
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!form.name.trim()) return void toast.error('Name the deal — it shows on receipts.')

    const percent = form.percent === '' ? null : Number(form.percent)
    if (percent !== null && (!Number.isInteger(percent) || percent < 1 || percent > 100)) {
      return void toast.error('Percent off must be a whole number from 1 to 100.')
    }
    const salePrice = form.salePrice === '' ? null : parseMoney(form.salePrice)
    if (form.salePrice !== '' && salePrice === null) {
      return void toast.error('That sale price does not read as money.')
    }
    const amount = form.amount === '' ? null : parseMoney(form.amount)
    if (form.amount !== '' && amount === null) {
      return void toast.error('That reward does not read as money.')
    }
    const minItems = Number(form.minItems)

    // Per-kind sanity, said before the save rather than as a DB error.
    if (form.kind === 'service_sale') {
      if (form.serviceIds.length === 0) return void toast.error('A sale names its services — tick at least one.')
      if (salePrice === null && percent === null)
        return void toast.error('Give the sale a price or a percent.')
    }
    if (['second_service', 'new_client'].includes(form.kind) && percent === null) {
      return void toast.error('This deal needs a percent.')
    }
    if (form.kind === 'product_multibuy') {
      if (percent === null) return void toast.error('This deal needs a percent.')
      if (!Number.isInteger(minItems) || minItems < 2 || minItems > 20)
        return void toast.error('Group size must be 2–20. Three means "buy 2, get the 3rd".')
    }
    if (form.kind === 'referral' && amount === null && percent === null) {
      return void toast.error('Set the reward — dollars or a percent.')
    }
    if (form.startsAt && form.endsAt && form.startsAt > form.endsAt) {
      return void toast.error('The deal ends before it starts.')
    }

    const row = {
      name: form.name.trim(),
      kind: form.kind,
      percent_off: percent,
      amount_cents: form.kind === 'referral' ? amount : null,
      sale_price_cents: form.kind === 'service_sale' ? salePrice : null,
      min_items: form.kind === 'product_multibuy' ? minItems : null,
      service_ids: form.kind === 'service_sale' ? form.serviceIds : [],
      starts_at: form.startsAt ? new Date(form.startsAt).toISOString() : null,
      // The end date is inclusive — "until the end of the month" means the
      // 31st still counts, so the bound is the end of that day.
      ends_at: form.endsAt ? new Date(`${form.endsAt}T23:59:59`).toISOString() : null,
      is_active: form.isActive,
    }

    setBusy(true)
    const supabase = createClient()
    const { error } =
      editing === 'new'
        ? await supabase.from('promotions').insert(row)
        : await supabase.from('promotions').update(row).eq('id', editing as number)
    setBusy(false)

    if (error) return void toast.error(error.message)
    toast.success(editing === 'new' ? 'Deal created.' : 'Deal updated.')
    setEditing(null)
    setForm(BLANK)
    router.refresh()
  }

  async function togglePause(p: Promotion) {
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase
      .from('promotions')
      .update({ is_active: !p.is_active })
      .eq('id', p.id)
    setBusy(false)
    if (error) return void toast.error(error.message)
    toast.success(p.is_active ? 'Deal paused.' : 'Deal running again.')
    router.refresh()
  }

  async function remove(p: Promotion) {
    if (!window.confirm(`Delete “${p.name}”? Its history keeps the name and stays on client profiles.`))
      return
    setBusy(true)
    const supabase = createClient()
    const { error } = await supabase.from('promotions').delete().eq('id', p.id)
    setBusy(false)
    if (error) return void toast.error(error.message)
    toast.success('Deal deleted. Its redemption history remains.')
    router.refresh()
  }

  const referralEarned = referrals.filter((r) => r.status === 'earned').length
  const referralApplied = referrals.filter((r) => r.status === 'applied').length

  const asRule = (p: Promotion): PromotionRule => p

  return (
    <div className="space-y-8">
      {/* ── The board ──────────────────────────────────────── */}
      <Panel className="p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <h2 className="display text-xl">The deals</h2>
          {editing === null && (
            <Button
              size="sm"
              onClick={() => {
                setForm(BLANK)
                setEditing('new')
              }}
            >
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              New deal
            </Button>
          )}
        </div>

        {promotions.length === 0 && editing === null && (
          <p className="mt-4 text-sm text-[var(--color-muted)]">
            Nothing on the board yet. A deal applies itself everywhere the moment it is
            live — booking, the desk, and the till.
          </p>
        )}

        {promotions.length > 0 && (
          <ul className="mt-5 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {promotions.map((p) => {
              const live = promotionIsLive(asRule(p), nowMs)
              const ended = p.ends_at !== null && new Date(p.ends_at).getTime() < nowMs
              const u = usage[p.id]
              return (
                <li key={p.id} className="py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        {p.name}
                        <Badge tone={live ? 'success' : 'neutral'} size="sm">
                          {live ? 'Live' : ended ? 'Ended' : p.is_active ? 'Scheduled' : 'Paused'}
                        </Badge>
                      </p>
                      <p className="mt-1 text-xs text-[var(--color-muted)]">
                        {PROMOTION_KIND_LABELS[p.kind]} · {valueSummary(p)} · {windowLabel(p)}
                      </p>
                      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                        {u
                          ? `Used ${u.uses} time${u.uses === 1 ? '' : 's'} · ${formatMoney(u.cents)} given away`
                          : 'Not used yet'}
                      </p>
                    </div>
                    <div className="flex items-center gap-1">
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => togglePause(p)}>
                        {p.is_active ? (
                          <Pause className="h-4 w-4" strokeWidth={1.75} />
                        ) : (
                          <Play className="h-4 w-4" strokeWidth={1.75} />
                        )}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => startEdit(p)}>
                        <Pencil className="h-4 w-4" strokeWidth={1.75} />
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => remove(p)}>
                        <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                      </Button>
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {/* ── The form ─────────────────────────────────────── */}
        {editing !== null && (
          <form
            onSubmit={save}
            className="mt-6 space-y-4 border border-[var(--color-border)] bg-[var(--color-linen)] p-5 dark:bg-[var(--color-background)]"
          >
            <div className="flex items-baseline justify-between gap-4">
              <p className="label-caps text-[var(--color-accent)]">
                {editing === 'new' ? 'New deal' : 'Edit deal'}
              </p>
              <button
                type="button"
                onClick={() => {
                  setEditing(null)
                  setForm(BLANK)
                }}
                className="label-caps text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              >
                <X className="h-4 w-4" strokeWidth={1.75} />
              </button>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div>
                <Label htmlFor="promo-name">Name — shows on receipts and the booking page</Label>
                <Input
                  id="promo-name"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="August BOGO"
                />
              </div>
              <div>
                <Label htmlFor="promo-kind">Deal type</Label>
                <Select
                  id="promo-kind"
                  value={form.kind}
                  disabled={editing !== 'new'}
                  onChange={(e) => setForm({ ...form, kind: e.target.value as PromotionKind })}
                >
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {PROMOTION_KIND_LABELS[k]}
                    </option>
                  ))}
                </Select>
              </div>
            </div>

            {/* Only the fields this kind reads. */}
            <div className="grid gap-4 sm:grid-cols-3">
              {form.kind === 'service_sale' && (
                <div>
                  <Label htmlFor="promo-sale">Sale price ($)</Label>
                  <Input
                    id="promo-sale"
                    inputMode="decimal"
                    value={form.salePrice}
                    onChange={(e) => setForm({ ...form, salePrice: e.target.value })}
                    placeholder="175"
                  />
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    Or leave blank and use a percent instead.
                  </p>
                </div>
              )}

              {form.kind !== 'referral' || form.amount === '' ? (
                <div>
                  <Label htmlFor="promo-percent">Percent off</Label>
                  <Input
                    id="promo-percent"
                    inputMode="numeric"
                    value={form.percent}
                    onChange={(e) => setForm({ ...form, percent: e.target.value })}
                    placeholder="50"
                  />
                </div>
              ) : null}

              {form.kind === 'product_multibuy' && (
                <div>
                  <Label htmlFor="promo-min">Group size</Label>
                  <Input
                    id="promo-min"
                    inputMode="numeric"
                    value={form.minItems}
                    onChange={(e) => setForm({ ...form, minItems: e.target.value })}
                  />
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    3 means “buy 2, get the 3rd”. Applies to every retail product.
                  </p>
                </div>
              )}

              {form.kind === 'referral' && (
                <div>
                  <Label htmlFor="promo-amount">Reward ($ off a visit)</Label>
                  <Input
                    id="promo-amount"
                    inputMode="decimal"
                    value={form.amount}
                    onChange={(e) => setForm({ ...form, amount: e.target.value })}
                    placeholder="20"
                  />
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    Or leave blank and use a percent instead.
                  </p>
                </div>
              )}
            </div>

            {form.kind === 'service_sale' && (
              <fieldset>
                <legend className="label-caps mb-2 text-[var(--color-muted)]">
                  Services on sale
                </legend>
                <div className="grid gap-1 sm:grid-cols-2">
                  {services
                    .filter((s) => s.is_active)
                    .map((s) => {
                      const on = form.serviceIds.includes(s.id)
                      return (
                        <label key={s.id} className="flex cursor-pointer items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() =>
                              setForm({
                                ...form,
                                serviceIds: on
                                  ? form.serviceIds.filter((x) => x !== s.id)
                                  : [...form.serviceIds, s.id],
                              })
                            }
                            className="h-4 w-4 accent-[var(--color-accent)]"
                          />
                          <span className="min-w-0">
                            {catName.get(s.category_id) ?? 'Other'} — {s.name}{' '}
                            <span className="tabular-nums text-[var(--color-muted)]">
                              {formatMoney(s.price_cents)}
                            </span>
                          </span>
                        </label>
                      )
                    })}
                </div>
              </fieldset>
            )}

            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <Label htmlFor="promo-starts">Starts</Label>
                <Input
                  id="promo-starts"
                  type="date"
                  value={form.startsAt}
                  onChange={(e) => setForm({ ...form, startsAt: e.target.value })}
                />
              </div>
              <div>
                <Label htmlFor="promo-ends">Ends (inclusive)</Label>
                <Input
                  id="promo-ends"
                  type="date"
                  value={form.endsAt}
                  onChange={(e) => setForm({ ...form, endsAt: e.target.value })}
                />
              </div>
              <label className="flex items-center gap-2 self-end pb-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={form.isActive}
                  onChange={(e) => setForm({ ...form, isActive: e.target.checked })}
                  className="h-4 w-4 accent-[var(--color-accent)]"
                />
                Running
              </label>
            </div>

            <div className="flex gap-2 border-t border-[var(--color-border)] pt-4">
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? 'Saving…' : editing === 'new' ? 'Create deal' : 'Save changes'}
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setEditing(null)
                  setForm(BLANK)
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        )}
      </Panel>

      {/* ── Referrals ──────────────────────────────────────── */}
      <Panel className="p-6">
        <h2 className="display flex items-center gap-2 text-xl">
          <Users className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={1.75} />
          Referrals
        </h2>
        <p className="mt-1 max-w-prose text-sm text-[var(--color-muted)]">
          Every client has a code on their Rewards page. A new client types it into their
          first booking; each code counts each person once, and the reward above (the
          “Referral reward” deal) is what the referrer earns — the front desk takes it
          off their next visit from the appointment screen.
        </p>

        <div className="mt-5 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
          <StatTile label="People referred" value={referrals.length} />
          <StatTile label="Rewards waiting" value={referralEarned} />
          <StatTile label="Rewards used" value={referralApplied} />
        </div>

        {referrals.length > 0 && (
          <ul className="mt-5 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {referrals.slice(0, 12).map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <span>
                  {r.referrer}
                  <span className="ml-2 text-xs text-[var(--color-muted)]">
                    brought someone in · {new Date(r.createdAt).toLocaleDateString()}
                  </span>
                </span>
                <Badge
                  tone={r.status === 'applied' ? 'neutral' : r.status === 'earned' ? 'success' : 'danger'}
                  size="sm"
                >
                  {r.status === 'earned'
                    ? `reward waiting${r.rewardCents ? ` · ${formatMoney(r.rewardCents)}` : r.rewardPercent ? ` · ${r.rewardPercent}%` : ''}`
                    : r.status === 'applied'
                      ? 'reward used'
                      : 'void'}
                </Badge>
              </li>
            ))}
          </ul>
        )}
      </Panel>
    </div>
  )
}
