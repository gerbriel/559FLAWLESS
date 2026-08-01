'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { X, Trash2, Plus } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'

export interface EditableService {
  id: number
  category_id: number
  name: string
  slug: string
  description: string | null
  details: string | null
  aftercare: string | null
  price_cents: number
  price_is_starting: boolean
  duration_minutes: number
  buffer_minutes: number
  is_active: boolean
  is_featured: boolean
  sort_order: number
  // Gates — admin-only, enforced by a trigger as well as hidden here.
  is_intimate: boolean
  requires_age_verification: boolean
  min_age: number
  requires_consultation: boolean
  patch_test_hours: number
  deposit_cents: number
  cancellation_window_hours: number
}

export interface ServiceCategoryOption {
  id: number
  name: string
}

/** "$85.00" → 8500. Returns null if it isn't a number. */
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

const BLANK: Omit<EditableService, 'id'> = {
  category_id: 0,
  name: '',
  slug: '',
  description: null,
  details: null,
  aftercare: null,
  price_cents: 0,
  price_is_starting: false,
  duration_minutes: 60,
  buffer_minutes: 10,
  is_active: true,
  is_featured: false,
  sort_order: 0,
  is_intimate: false,
  requires_age_verification: false,
  min_age: 18,
  requires_consultation: false,
  patch_test_hours: 0,
  deposit_cents: 0,
  cancellation_window_hours: 24,
}

/**
 * Create or edit one service.
 *
 * Managers get the menu: name, copy, price, duration, whether it is listed.
 * The booking gates — age verification, patch tests, deposits — are admin-only
 * and simply absent for everyone else. A database trigger enforces the same
 * line, so hiding them here is convenience rather than the actual guard.
 */
export function ServiceEditor({
  service,
  categories,
  isAdmin,
}: {
  service?: EditableService
  categories: ServiceCategoryOption[]
  isAdmin: boolean
}) {
  const router = useRouter()
  const isNew = !service
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [form, setForm] = useState<Omit<EditableService, 'id'>>(
    service ?? { ...BLANK, category_id: categories[0]?.id ?? 0 }
  )
  const [price, setPrice] = useState(money(service?.price_cents ?? 0))
  const [deposit, setDeposit] = useState(money(service?.deposit_cents ?? 0))

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }))
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()

    const priceCents = toCents(price)
    const depositCents = toCents(deposit)
    if (priceCents === null) {
      toast.error('That price is not a number.')
      return
    }
    if (depositCents === null) {
      toast.error('That deposit is not a number.')
      return
    }
    if (depositCents > priceCents) {
      toast.error('The deposit cannot be more than the price.')
      return
    }
    if (form.duration_minutes < 5 || form.duration_minutes > 480) {
      toast.error('Duration must be between 5 and 480 minutes.')
      return
    }
    if (!form.category_id) {
      toast.error('Pick a category.')
      return
    }

    const slug = form.slug.trim() || slugify(form.name)
    const payload = {
      category_id: form.category_id,
      name: form.name.trim(),
      slug,
      description: form.description?.trim() || null,
      details: form.details?.trim() || null,
      aftercare: form.aftercare?.trim() || null,
      price_cents: priceCents,
      price_is_starting: form.price_is_starting,
      duration_minutes: form.duration_minutes,
      buffer_minutes: form.buffer_minutes,
      is_active: form.is_active,
      is_featured: form.is_featured,
      sort_order: form.sort_order,
      // Only sent by an admin. Managers never touch these keys, so an
      // unchanged value can't trip the trigger.
      ...(isAdmin
        ? {
            is_intimate: form.is_intimate,
            requires_age_verification: form.requires_age_verification,
            min_age: form.min_age,
            requires_consultation: form.requires_consultation,
            patch_test_hours: form.patch_test_hours,
            deposit_cents: depositCents,
            cancellation_window_hours: form.cancellation_window_hours,
          }
        : {}),
    }

    setBusy(true)
    const supabase = createClient()
    const { error } = isNew
      ? await supabase.from('services').insert(payload)
      : await supabase.from('services').update(payload).eq('id', service.id)
    setBusy(false)

    if (error) {
      toast.error(
        error.code === '23505'
          ? 'Another service already uses that name. Try a slightly different one.'
          : error.message || 'Could not save that service.'
      )
      return
    }

    toast.success(isNew ? `${payload.name} added.` : 'Saved.')
    setOpen(false)
    if (isNew) setForm({ ...BLANK, category_id: categories[0]?.id ?? 0 })
    router.refresh()
  }

  async function remove() {
    if (!service) return
    if (!confirm(`Delete "${service.name}"? If it has ever been booked, switch it off instead.`)) {
      return
    }

    setBusy(true)
    const { error } = await createClient().from('services').delete().eq('id', service.id)
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not delete that service.')
      return
    }
    toast.success(`${service.name} deleted.`)
    setOpen(false)
    router.refresh()
  }

  if (!open) {
    return (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        {isNew ? (
          <>
            <Plus className="h-4 w-4" strokeWidth={1.75} />
            New service
          </>
        ) : (
          'Edit'
        )}
      </Button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={isNew ? 'Add a service' : `Edit ${service.name}`}
      onClick={() => !busy && setOpen(false)}
    >
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        className="relative my-8 w-full max-w-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-2xl sm:my-0 sm:p-8"
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          aria-label="Close"
        >
          <X className="h-5 w-5" strokeWidth={1.5} />
        </button>

        <h2 className="display pr-10 text-2xl">{isNew ? 'Add a service' : service.name}</h2>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="sv_name" className="sm:col-span-2">
            <Input
              id="sv_name"
              required
              maxLength={120}
              value={form.name}
              onChange={(e) => set('name', e.target.value)}
            />
          </Field>

          <Field label="Category" htmlFor="sv_cat">
            <Select
              id="sv_cat"
              value={form.category_id}
              onChange={(e) => set('category_id', Number(e.target.value))}
            >
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Price" htmlFor="sv_price" hint="In dollars, e.g. 85 or 85.00">
            <Input
              id="sv_price"
              required
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>

          <Field
            label="Duration"
            htmlFor="sv_dur"
            hint="Minutes the client is in the room. 5–480."
          >
            <Input
              id="sv_dur"
              type="number"
              min={5}
              max={480}
              required
              value={form.duration_minutes}
              onChange={(e) => set('duration_minutes', Number(e.target.value))}
            />
          </Field>

          <Field
            label="Turnaround"
            htmlFor="sv_buf"
            hint="Minutes to reset the room afterwards. Blocks the calendar; not charged."
          >
            <Input
              id="sv_buf"
              type="number"
              min={0}
              max={120}
              value={form.buffer_minutes}
              onChange={(e) => set('buffer_minutes', Number(e.target.value))}
            />
          </Field>

          <Field
            label="Short description"
            htmlFor="sv_desc"
            className="sm:col-span-2"
            hint="One or two lines. This is what shows on the menu."
          >
            <Textarea
              id="sv_desc"
              rows={2}
              maxLength={400}
              value={form.description ?? ''}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>

          <Field
            label="Full details"
            htmlFor="sv_details"
            className="sm:col-span-2"
            hint="What it treats, how it feels, what it is not. Shown on the service's own page."
          >
            <Textarea
              id="sv_details"
              rows={4}
              maxLength={4000}
              value={form.details ?? ''}
              onChange={(e) => set('details', e.target.value)}
            />
          </Field>

          <Field
            label="Aftercare"
            htmlFor="sv_after"
            className="sm:col-span-2"
            hint="Sent to the client after their appointment."
          >
            <Textarea
              id="sv_after"
              rows={3}
              maxLength={4000}
              value={form.aftercare ?? ''}
              onChange={(e) => set('aftercare', e.target.value)}
            />
          </Field>

          <Field label="Order on the menu" htmlFor="sv_sort" hint="Lower shows first.">
            <Input
              id="sv_sort"
              type="number"
              value={form.sort_order}
              onChange={(e) => set('sort_order', Number(e.target.value))}
            />
          </Field>
        </div>

        <div className="mt-5 space-y-3">
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) => set('is_active', e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Listed
              <span className="block text-xs text-[var(--color-muted)]">
                Unticking hides it from the menu and from booking. Past appointments keep it.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={form.is_featured}
              onChange={(e) => set('is_featured', e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>Featured on the home page</span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={form.price_is_starting}
              onChange={(e) => set('price_is_starting', e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Price varies
              <span className="block text-xs text-[var(--color-muted)]">
                Shows as &ldquo;from ${price}&rdquo;.
              </span>
            </span>
          </label>
        </div>

        {isAdmin && (
          <fieldset className="mt-7 border-t border-[var(--color-border)] pt-6">
            <legend className="label-caps text-[var(--color-muted)]">
              Booking rules — admin only
            </legend>

            <div className="mt-4 space-y-3">
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={form.is_intimate}
                  onChange={(e) => set('is_intimate', e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>
                  Intimate service
                  <span className="block text-xs text-[var(--color-muted)]">
                    Described in plain clinical language and handled discreetly.
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={form.requires_age_verification}
                  onChange={(e) => set('requires_age_verification', e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>
                  Age must be confirmed before booking
                  <span className="block text-xs text-[var(--color-muted)]">
                    Required for every intimate service.
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={form.requires_consultation}
                  onChange={(e) => set('requires_consultation', e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>Consultation first — cannot be booked directly online</span>
              </label>
            </div>

            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Minimum age" htmlFor="sv_age">
                <Input
                  id="sv_age"
                  type="number"
                  min={0}
                  max={99}
                  value={form.min_age}
                  onChange={(e) => set('min_age', Number(e.target.value))}
                />
              </Field>

              <Field
                label="Patch test"
                htmlFor="sv_patch"
                hint="Hours beforehand. 0 for none."
              >
                <Input
                  id="sv_patch"
                  type="number"
                  min={0}
                  value={form.patch_test_hours}
                  onChange={(e) => set('patch_test_hours', Number(e.target.value))}
                />
              </Field>

              <Field label="Deposit" htmlFor="sv_dep" hint="In dollars. 0 for none.">
                <Input
                  id="sv_dep"
                  inputMode="decimal"
                  value={deposit}
                  onChange={(e) => setDeposit(e.target.value)}
                />
              </Field>

              <Field
                label="Cancellation window"
                htmlFor="sv_cancel"
                hint="Hours before the appointment. Cancelling later forfeits the deposit."
              >
                <Input
                  id="sv_cancel"
                  type="number"
                  min={0}
                  value={form.cancellation_window_hours}
                  onChange={(e) => set('cancellation_window_hours', Number(e.target.value))}
                />
              </Field>
            </div>
          </fieldset>
        )}

        <div className="mt-7 flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? 'Saving…' : isNew ? 'Add service' : 'Save'}
          </Button>
          <Button type="button" variant="subtle" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
          {!isNew && isAdmin && (
            <button
              type="button"
              onClick={remove}
              disabled={busy}
              className="ml-auto flex items-center gap-1.5 text-sm text-red-700 hover:underline dark:text-red-400"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              Delete
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
