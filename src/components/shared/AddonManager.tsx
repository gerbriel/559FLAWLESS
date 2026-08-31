'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input, Select, Textarea, Label } from '@/components/ui/field'
import { Panel } from '@/components/ui/dashboard'
import { formatMoney, formatDuration } from '@/lib/utils'
import { pairDiscountCents } from '@/lib/pair-discounts'

/**
 * "Add to this service", editable — the section clients see on a service page
 * and inside the booking flow, managed per service.
 *
 * Pick a service, then two lists:
 *   1. Add-ons — every add-on in the catalogue, ticked where this service
 *      offers it. Create, edit and retire add-ons here too; deleting one keeps
 *      history intact because appointment lines freeze a name snapshot (004).
 *   2. Pair deals — other SERVICES discounted when booked alongside this one
 *      (067). These are not add-ons: the paired service keeps its own gates
 *      (18+, consent, deposit), which is the whole reason it is a service.
 *
 * Direct browser writes, RLS enforced: `service_addons`, `service_addon_links`
 * and `service_pair_discounts` are all admin-write (002, 067), so this
 * component renders only for an admin — the policy is what actually refuses
 * anyone else.
 */

export interface ManagedAddon {
  id: number
  name: string
  description: string | null
  price_cents: number
  duration_minutes: number
  is_active: boolean
}

export interface ManagedPairDeal {
  id: number
  trigger_service_id: number
  discounted_service_id: number
  percent_off: number
  label: string
  is_active: boolean
}

export interface ManagedService {
  id: number
  name: string
  price_cents: number
  category_id: number
  is_active: boolean
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Dollars in, integer cents out — refuses anything that does not read as money. */
function parseMoney(value: string): number | null {
  const cleaned = value.replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) return null
  const [whole, frac = ''] = cleaned.split('.')
  return Number(whole) * 100 + Number(frac.padEnd(2, '0') || 0)
}

const BLANK = { name: '', price: '', minutes: '0', description: '' }

export function AddonManager({
  services,
  categories,
  addons,
  links,
  pairDeals,
}: {
  services: ManagedService[]
  categories: { id: number; name: string }[]
  addons: ManagedAddon[]
  links: { service_id: number; addon_id: number }[]
  pairDeals: ManagedPairDeal[]
}) {
  const router = useRouter()
  const [serviceId, setServiceId] = useState<number>(services[0]?.id ?? 0)
  const [busy, setBusy] = useState(false)

  // The add-on being edited inline, or 'new' for the create form.
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState(BLANK)

  // The pair-deal create form.
  const [pairOpen, setPairOpen] = useState(false)
  const [pairTarget, setPairTarget] = useState('')
  const [pairPercent, setPairPercent] = useState('50')

  const service = services.find((s) => s.id === serviceId) ?? null
  const catName = new Map(categories.map((c) => [c.id, c.name]))
  const linked = new Set(links.filter((l) => l.service_id === serviceId).map((l) => l.addon_id))
  const dealsHere = pairDeals.filter((d) => d.trigger_service_id === serviceId)
  const serviceName = new Map(services.map((s) => [s.id, s.name]))

  async function run(work: () => PromiseLike<{ error: { message: string } | null }>, done: string) {
    setBusy(true)
    const { error } = await work()
    setBusy(false)
    if (error) {
      toast.error(error.message)
      return false
    }
    toast.success(done)
    router.refresh()
    return true
  }

  function toggleLink(addonId: number, on: boolean) {
    const supabase = createClient()
    void run(
      () =>
        on
          ? supabase.from('service_addon_links').delete().match({ service_id: serviceId, addon_id: addonId })
          : supabase.from('service_addon_links').insert({ service_id: serviceId, addon_id: addonId }),
      on ? 'Taken off this service.' : 'Offered with this service.'
    )
  }

  async function saveAddon(e: React.FormEvent) {
    e.preventDefault()
    const priceCents = parseMoney(form.price)
    const minutes = Number(form.minutes)
    if (!form.name.trim()) return void toast.error('The add-on needs a name.')
    if (priceCents === null) return void toast.error('That price does not read as money.')
    if (!Number.isInteger(minutes) || minutes < 0) return void toast.error('Minutes must be a whole number.')

    const supabase = createClient()
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      price_cents: priceCents,
      duration_minutes: minutes,
    }

    if (editing === 'new') {
      setBusy(true)
      let { data: created, error } = await supabase
        .from('service_addons')
        .insert({ ...payload, slug: slugify(payload.name) })
        .select('id')
        .single()
      // A retired add-on may still hold the slug; a suffix beats a dead end.
      if (error?.code === '23505') {
        ;({ data: created, error } = await supabase
          .from('service_addons')
          .insert({ ...payload, slug: `${slugify(payload.name)}-${Math.floor(Math.random() * 1000)}` })
          .select('id')
          .single())
      }
      if (error || !created) {
        setBusy(false)
        return void toast.error(error?.message ?? 'Could not create the add-on.')
      }
      // New add-ons start on the service being edited — that is why the form
      // is here and not on a settings page.
      const { error: linkError } = await supabase
        .from('service_addon_links')
        .insert({ service_id: serviceId, addon_id: created.id })
      setBusy(false)
      if (linkError) toast.error(linkError.message)
      else toast.success('Add-on created and offered with this service.')
      setEditing(null)
      setForm(BLANK)
      router.refresh()
      return
    }

    const ok = await run(
      () => supabase.from('service_addons').update(payload).eq('id', editing as number),
      'Add-on updated.'
    )
    if (ok) {
      setEditing(null)
      setForm(BLANK)
    }
  }

  function deleteAddon(a: ManagedAddon) {
    if (!window.confirm(`Delete “${a.name}” everywhere? Past appointments keep their receipts.`)) return
    const supabase = createClient()
    void run(() => supabase.from('service_addons').delete().eq('id', a.id), 'Add-on deleted.')
  }

  async function addPair(e: React.FormEvent) {
    e.preventDefault()
    const target = Number(pairTarget)
    const percent = Number(pairPercent)
    if (!target) return void toast.error('Pick the service the deal discounts.')
    if (!Number.isInteger(percent) || percent < 1 || percent > 90) {
      return void toast.error('Percent off must be a whole number from 1 to 90.')
    }
    const label = `${percent === 50 ? 'Half off' : `${percent}% off`} when booked with ${service?.name ?? 'this service'}`
    const supabase = createClient()
    const ok = await run(
      () =>
        supabase.from('service_pair_discounts').insert({
          trigger_service_id: serviceId,
          discounted_service_id: target,
          percent_off: percent,
          label,
        }),
      'Pair deal added.'
    )
    if (ok) {
      setPairOpen(false)
      setPairTarget('')
      setPairPercent('50')
    }
  }

  function removePair(d: ManagedPairDeal) {
    const supabase = createClient()
    void run(
      () => supabase.from('service_pair_discounts').delete().eq('id', d.id),
      'Pair deal removed.'
    )
  }

  function togglePair(d: ManagedPairDeal) {
    const supabase = createClient()
    void run(
      () => supabase.from('service_pair_discounts').update({ is_active: !d.is_active }).eq('id', d.id),
      d.is_active ? 'Pair deal paused.' : 'Pair deal live again.'
    )
  }

  function startEdit(a: ManagedAddon) {
    setEditing(a.id)
    setForm({
      name: a.name,
      price: (a.price_cents / 100).toFixed(2),
      minutes: String(a.duration_minutes),
      description: a.description ?? '',
    })
  }

  const addonForm = (
    <form onSubmit={saveAddon} className="mt-3 grid gap-3 border border-[var(--color-border)] bg-[var(--color-linen)] p-4 dark:bg-[var(--color-background)] sm:grid-cols-2">
      <div>
        <Label htmlFor="addon-name">Name</Label>
        <Input id="addon-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label htmlFor="addon-price">Price ($)</Label>
          <Input id="addon-price" inputMode="decimal" value={form.price} onChange={(e) => setForm({ ...form, price: e.target.value })} />
        </div>
        <div>
          <Label htmlFor="addon-minutes">Minutes</Label>
          <Input id="addon-minutes" inputMode="numeric" value={form.minutes} onChange={(e) => setForm({ ...form, minutes: e.target.value })} />
        </div>
      </div>
      <div className="sm:col-span-2">
        <Label htmlFor="addon-desc">Description</Label>
        <Textarea id="addon-desc" rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
      </div>
      <div className="flex gap-2 sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy}>
          {editing === 'new' ? 'Create add-on' : 'Save changes'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => { setEditing(null); setForm(BLANK) }}>
          Cancel
        </Button>
      </div>
    </form>
  )

  if (!service) return null

  return (
    <Panel className="mt-12 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="display text-xl">Add to this service</h2>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            What the service page and the booking flow offer alongside a treatment.
          </p>
        </div>
        <div className="w-full sm:w-72">
          <Label htmlFor="addon-service">Editing</Label>
          <Select
            id="addon-service"
            value={String(serviceId)}
            onChange={(e) => {
              setServiceId(Number(e.target.value))
              setEditing(null)
              setPairOpen(false)
            }}
          >
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {catName.get(s.category_id) ?? 'Other'} — {s.name}
                {s.is_active ? '' : ' (hidden)'}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {/* ── Pair deals ─────────────────────────────────────── */}
      <div className="mt-8">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="label-caps text-[var(--color-accent)]">Pair deals</h3>
          {!pairOpen && (
            <Button variant="subtle" size="sm" onClick={() => setPairOpen(true)}>
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              Add a pair deal
            </Button>
          )}
        </div>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Another service, discounted when booked in the same visit as this one. It stays a
          real service — its own price crossed out, its 18+ and consent rules intact.
        </p>

        {dealsHere.length === 0 && !pairOpen && (
          <p className="mt-3 text-sm text-[var(--color-muted)]">None on this service.</p>
        )}

        {dealsHere.length > 0 && (
          <ul className="mt-3 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {dealsHere.map((d) => {
              const target = services.find((s) => s.id === d.discounted_service_id)
              const full = target?.price_cents ?? 0
              const cut = pairDiscountCents(full, d.percent_off)
              return (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                  <div className="min-w-0">
                    <p>
                      {serviceName.get(d.discounted_service_id) ?? 'Retired service'}
                      <span className="ml-2 label-caps text-[0.5625rem] text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]">
                        {d.percent_off}% off
                      </span>
                      {!d.is_active && (
                        <span className="ml-2 label-caps text-[0.5625rem] text-[var(--color-muted)]">paused</span>
                      )}
                    </p>
                    {target && (
                      <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                        <s>{formatMoney(full)}</s>{' '}
                        <span className="text-emerald-800 dark:text-emerald-400">
                          {formatMoney(full - cut)}
                        </span>{' '}
                        · shown as “{d.label}”
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => togglePair(d)}>
                      {d.is_active ? 'Pause' : 'Resume'}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => removePair(d)}>
                      <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}

        {pairOpen && (
          <form onSubmit={addPair} className="mt-3 flex flex-wrap items-end gap-3 border border-[var(--color-border)] bg-[var(--color-linen)] p-4 dark:bg-[var(--color-background)]">
            <div className="min-w-56 flex-1">
              <Label htmlFor="pair-target">Discounted service</Label>
              <Select id="pair-target" value={pairTarget} onChange={(e) => setPairTarget(e.target.value)}>
                <option value="">Choose…</option>
                {services
                  .filter((s) => s.id !== serviceId)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {catName.get(s.category_id) ?? 'Other'} — {s.name} · {formatMoney(s.price_cents)}
                    </option>
                  ))}
              </Select>
            </div>
            <div className="w-28">
              <Label htmlFor="pair-percent">% off</Label>
              <Input id="pair-percent" inputMode="numeric" value={pairPercent} onChange={(e) => setPairPercent(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                Add deal
              </Button>
              <Button type="button" variant="ghost" size="sm" onClick={() => setPairOpen(false)}>
                <X className="h-4 w-4" strokeWidth={1.75} />
              </Button>
            </div>
          </form>
        )}
      </div>

      {/* ── Add-ons ────────────────────────────────────────── */}
      <div className="mt-10">
        <div className="flex items-baseline justify-between gap-4">
          <h3 className="label-caps text-[var(--color-accent)]">Add-ons</h3>
          {editing === null && (
            <Button
              variant="subtle"
              size="sm"
              onClick={() => {
                setEditing('new')
                setForm(BLANK)
              }}
            >
              <Plus className="h-4 w-4" strokeWidth={1.75} />
              New add-on
            </Button>
          )}
        </div>
        <p className="mt-1 text-sm text-[var(--color-muted)]">
          Tick the ones offered with {service.name}. An add-on can be offered with any
          number of services.
        </p>

        {editing === 'new' && addonForm}

        <ul className="mt-3 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {addons.map((a) => {
            const on = linked.has(a.id)
            return (
              <li key={a.id} className="py-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <label className="flex min-w-0 cursor-pointer items-center gap-3">
                    <span
                      className={
                        'flex h-4 w-4 shrink-0 items-center justify-center border ' +
                        (on
                          ? 'border-[var(--color-accent)] bg-[var(--color-accent)]'
                          : 'border-[var(--color-border)]')
                      }
                    >
                      {on && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                    </span>
                    <input
                      type="checkbox"
                      className="sr-only"
                      checked={on}
                      disabled={busy}
                      onChange={() => toggleLink(a.id, on)}
                    />
                    <span className="min-w-0">
                      {a.name}
                      {!a.is_active && (
                        <span className="ml-2 label-caps text-[0.5625rem] text-[var(--color-muted)]">retired</span>
                      )}
                      <span className="ml-2 tabular-nums text-[var(--color-muted)]">
                        {formatMoney(a.price_cents)}
                        {a.duration_minutes > 0 && ` · ${formatDuration(a.duration_minutes)}`}
                      </span>
                    </span>
                  </label>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => startEdit(a)}>
                      <Pencil className="h-4 w-4" strokeWidth={1.75} />
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => deleteAddon(a)}>
                      <Trash2 className="h-4 w-4" strokeWidth={1.75} />
                    </Button>
                  </div>
                </div>
                {editing === a.id && addonForm}
              </li>
            )
          })}
          {addons.length === 0 && (
            <li className="py-3 text-sm text-[var(--color-muted)]">No add-ons in the catalogue yet.</li>
          )}
        </ul>
      </div>
    </Panel>
  )
}
