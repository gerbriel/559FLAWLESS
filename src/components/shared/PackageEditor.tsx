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

export interface EditablePackage {
  id: number
  name: string
  slug: string
  description: string | null
  /** Null is an open package — it pays for whichever service is on the visit. */
  service_id: number | null
  session_count: number
  price_cents: number
  valid_days: number
  is_active: boolean
  sort_order: number
}

export interface PackageServiceOption {
  id: number
  name: string
  price_cents: number
}

/** "$450.00" → 45000. Null if it isn't a number. */
function toCents(dollars: string): number | null {
  const n = Number(dollars.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

const money = (cents: number) => (cents / 100).toFixed(2)

/** A slug the URL can carry: lowercase, hyphens, nothing else. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

const BLANK: Omit<EditablePackage, 'id'> = {
  name: '',
  slug: '',
  description: null,
  service_id: null,
  session_count: 6,
  price_cents: 0,
  valid_days: 365,
  is_active: true,
  sort_order: 0,
}

/**
 * Create or edit one prepaid package.
 *
 * `service_packages` is `is_admin()` for writes in 008 — a manager can price a
 * service but not a course of them — so this is only ever rendered for an
 * admin. RLS refuses anyone else regardless, which is what actually holds; the
 * page hiding the button is a courtesy.
 *
 * Two figures are shown rather than asked for. The per-session price is the
 * package divided by the sessions in it, and the saving is that against the
 * service's own price — both display only, both derived from integer cents,
 * and neither ever stored. What the client is charged is `price_cents`, once.
 */
export function PackageEditor({
  pkg,
  services,
  trigger = 'button',
}: {
  pkg?: EditablePackage
  services: PackageServiceOption[]
  /** `link` renders a quiet inline "Edit" for a table row. */
  trigger?: 'button' | 'link'
}) {
  const router = useRouter()
  const isNew = !pkg
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [form, setForm] = useState<Omit<EditablePackage, 'id'>>(pkg ?? BLANK)
  const [price, setPrice] = useState(money(pkg?.price_cents ?? 0))

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  const priceCents = toCents(price) ?? 0
  const sessions = Math.max(form.session_count, 1)
  // Integer cents in, integer cents out. Rounding here can be a cent off across
  // the whole course, which is exactly why it is never what gets charged.
  const perSessionCents = Math.round(priceCents / sessions)
  const service = services.find((s) => s.id === form.service_id)
  const listCents = service ? service.price_cents * sessions : 0
  const savingCents = listCents > 0 ? listCents - priceCents : 0

  async function save(e: React.FormEvent) {
    e.preventDefault()

    const cents = toCents(price)
    if (cents === null) {
      toast.error('That price is not a number.')
      return
    }
    if (!form.name.trim()) {
      toast.error('Give the package a name.')
      return
    }
    if (!Number.isInteger(form.session_count) || form.session_count < 1) {
      toast.error('A package has to be at least one session.')
      return
    }
    if (form.session_count > 100) {
      toast.error('A hundred sessions is more course than anyone books. Check that number.')
      return
    }
    if (!Number.isInteger(form.valid_days) || form.valid_days < 0) {
      toast.error('Expiry is a whole number of days. Use 0 for a package that never expires.')
      return
    }

    const payload = {
      name: form.name.trim(),
      slug: form.slug.trim() || slugify(form.name),
      description: form.description?.trim() || null,
      service_id: form.service_id,
      session_count: form.session_count,
      price_cents: cents,
      valid_days: form.valid_days,
      is_active: form.is_active,
      sort_order: form.sort_order,
    }

    setBusy(true)
    const supabase = createClient()
    const { error } = isNew
      ? await supabase.from('service_packages').insert(payload)
      : await supabase.from('service_packages').update(payload).eq('id', pkg.id)
    setBusy(false)

    if (error) {
      toast.error(
        error.code === '23505'
          ? 'Another package already uses that name. Try a slightly different one.'
          : error.message || 'Could not save that package.'
      )
      return
    }

    toast.success(isNew ? `${payload.name} added.` : 'Saved.')
    setOpen(false)
    if (isNew) {
      setForm(BLANK)
      setPrice('0.00')
    }
    router.refresh()
  }

  async function remove() {
    if (!pkg) return
    if (
      !confirm(
        `Delete "${pkg.name}"? Anyone who has already bought it keeps their sessions — but if it has ever sold, switching it off is the honest move.`
      )
    ) {
      return
    }

    setBusy(true)
    const { error } = await createClient().from('service_packages').delete().eq('id', pkg.id)
    setBusy(false)

    if (error) {
      toast.error(
        // client_packages.package_id is ON DELETE RESTRICT, so a package
        // somebody holds cannot be deleted at all. Say that rather than
        // repeating Postgres at them.
        error.code === '23503'
          ? 'Clients still hold this package, so it cannot be deleted. Switch it off instead.'
          : error.message || 'Could not delete that package.'
      )
      return
    }
    toast.success(`${pkg.name} deleted.`)
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
        New package
      </Button>
    )
  }

  return (
    <Modal
      label={isNew ? 'Add a package' : `Edit ${pkg.name}`}
      title={isNew ? 'New package' : pkg.name}
      onClose={() => setOpen(false)}
      busy={busy}
      onSubmit={save}
      footer={
        <div className="flex w-full flex-wrap items-center justify-between gap-3">
          <div className="flex gap-2.5">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Saving…' : isNew ? 'Add package' : 'Save'}
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
          A course bought up front and drawn down a session at a time. The client pays
          once, here; every visit it covers is then settled against this balance.
        </p>

        <div className="mt-7 grid gap-5 sm:grid-cols-2">
          <Field label="Name" htmlFor="pkg_name" className="sm:col-span-2">
            <Input
              id="pkg_name"
              required
              maxLength={120}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
              placeholder="Six-session brightening course"
            />
          </Field>

          <Field
            label="Description"
            htmlFor="pkg_description"
            hint="What the course is for. Shown on the public gift cards & packages page."
            className="sm:col-span-2"
          >
            <Textarea
              id="pkg_description"
              maxLength={600}
              value={form.description ?? ''}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>

          <Field
            label="Service"
            htmlFor="pkg_service"
            hint="What a session buys. Leave open and it pays for whichever service is on the visit."
            className="sm:col-span-2"
          >
            <Select
              id="pkg_service"
              value={form.service_id === null ? '' : String(form.service_id)}
              onChange={(e) => set('service_id', e.target.value ? Number(e.target.value) : null)}
            >
              <option value="">Any service</option>
              {services.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} — {formatMoney(s.price_cents)}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Sessions" htmlFor="pkg_sessions">
            <Input
              id="pkg_sessions"
              type="number"
              min={1}
              max={100}
              step={1}
              required
              value={form.session_count}
              onChange={(e) => set('session_count', Number(e.target.value))}
            />
          </Field>

          <Field label="Price" htmlFor="pkg_price" hint="In dollars, for the whole course.">
            <Input
              id="pkg_price"
              inputMode="decimal"
              required
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>

          <Field
            label="Expires after"
            htmlFor="pkg_valid_days"
            hint="Days from purchase. 0 never expires."
          >
            <Input
              id="pkg_valid_days"
              type="number"
              min={0}
              max={3650}
              step={1}
              required
              value={form.valid_days}
              onChange={(e) => set('valid_days', Number(e.target.value))}
            />
          </Field>

          <Field label="Sort order" htmlFor="pkg_sort" hint="Lower shows first.">
            <Input
              id="pkg_sort"
              type="number"
              step={1}
              value={form.sort_order}
              onChange={(e) => set('sort_order', Number(e.target.value))}
            />
          </Field>

          <label className="flex items-center gap-3 text-sm sm:col-span-2">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => set('is_active', e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            Listed and sellable
          </label>
        </div>

        <dl
          data-ui="tile"
          className="mt-7 flex flex-wrap gap-x-10 gap-y-3 bg-[var(--color-linen)] p-5 text-sm dark:bg-[var(--color-background)]"
        >
          <div>
            <dt className="label-caps text-[var(--color-muted)]">Per session</dt>
            <dd className="mt-1 tabular-nums">
              {priceCents > 0 ? formatMoney(perSessionCents) : '—'}
            </dd>
          </div>
          <div>
            <dt className="label-caps text-[var(--color-muted)]">Bought singly</dt>
            <dd className="mt-1 tabular-nums">
              {listCents > 0 ? formatMoney(listCents) : '—'}
            </dd>
          </div>
          <div>
            <dt className="label-caps text-[var(--color-muted)]">Client saves</dt>
            <dd className="mt-1 tabular-nums">
              {listCents > 0 ? (
                savingCents > 0 ? (
                  formatMoney(savingCents)
                ) : (
                  <span className="text-amber-700 dark:text-amber-400">
                    Nothing — priced at or above the singles
                  </span>
                )
              ) : (
                '—'
              )}
            </dd>
          </div>
        </dl>

    </Modal>
  )
}
