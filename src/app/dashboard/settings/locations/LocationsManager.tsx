'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import {
  formatLocationAddress,
  isKnownTimeZone,
  isValidLocationSlug,
  slugifyLocationName,
  type Location,
} from '@/types/locations'

/** How many rows point at a location, so "delete" can be honest about itself. */
export interface LocationUsage {
  appointments: number
  orders: number
  staff: number
}

/** The zones a Californian studio is realistically opening in. Not a limit. */
const COMMON_ZONES = [
  'America/Los_Angeles',
  'America/Phoenix',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
]

type Draft = {
  name: string
  slug: string
  address_line1: string
  city: string
  state: string
  postal: string
  timezone: string
  phone: string
  email: string
  sort_order: string
  is_active: boolean
}

function draftFrom(location: Location): Draft {
  return {
    name: location.name,
    slug: location.slug,
    address_line1: location.address_line1 ?? '',
    city: location.city ?? '',
    state: location.state ?? '',
    postal: location.postal ?? '',
    timezone: location.timezone,
    phone: location.phone ?? '',
    email: location.email ?? '',
    sort_order: String(location.sort_order),
    is_active: location.is_active,
  }
}

const BLANK: Draft = {
  name: '',
  slug: '',
  address_line1: '',
  city: '',
  state: '',
  postal: '',
  timezone: 'America/Los_Angeles',
  phone: '',
  email: '',
  sort_order: '',
  is_active: true,
}

/** Everything that must be true before a row is worth sending. */
function validate(draft: Draft): string | null {
  if (!draft.name.trim()) return 'Give it a name — that is what everyone will call it.'
  if (!isValidLocationSlug(draft.slug))
    return 'The web address can only use lowercase letters, numbers and hyphens.'
  if (!isKnownTimeZone(draft.timezone))
    return `"${draft.timezone}" is not a timezone this browser recognises.`
  if (draft.sort_order.trim() && !Number.isInteger(Number(draft.sort_order)))
    return 'Order has to be a whole number.'
  return null
}

/** The columns as the database wants them: blanks become null, not ''. */
function toRow(draft: Draft) {
  const blankToNull = (v: string) => (v.trim() ? v.trim() : null)
  return {
    name: draft.name.trim(),
    slug: draft.slug.trim(),
    address_line1: blankToNull(draft.address_line1),
    city: blankToNull(draft.city),
    state: blankToNull(draft.state),
    postal: blankToNull(draft.postal),
    timezone: draft.timezone.trim(),
    phone: blankToNull(draft.phone),
    email: blankToNull(draft.email),
    sort_order: draft.sort_order.trim() ? Number(draft.sort_order) : 0,
    is_active: draft.is_active,
  }
}

/**
 * Add, edit, reorder and retire the studio's locations.
 *
 * The one below is the studio that already exists — the address came from the
 * contact details rather than being typed in again, so editing it here and
 * editing the footer are the same fact in two places until someone reconciles
 * them. Renaming it is safe; it is a label, not a key.
 */
export function LocationsManager({
  locations,
  usage,
}: {
  locations: Location[]
  usage: Record<number, LocationUsage>
}) {
  const router = useRouter()
  const [editing, setEditing] = useState<number | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)

  // The primary is the first ACTIVE row in sort order — the same rule
  // public.default_location_id() applies, so this badge cannot lie.
  const primaryId = locations.find((l) => l.is_active)?.id ?? null

  async function save(draft: Draft, id: number | null) {
    const problem = validate(draft)
    if (problem) {
      toast.error(problem)
      return
    }

    setBusy(true)
    const supabase = createClient()
    const row = toRow(draft)

    const { error } = id
      ? await supabase.from('locations').update(row).eq('id', id)
      : await supabase.from('locations').insert(row)
    setBusy(false)

    if (error) {
      toast.error(
        error.code === '23505'
          ? `Another location already uses "${row.slug}".`
          : error.message || 'Could not save that location.'
      )
      return
    }

    toast.success(id ? 'Saved.' : `${row.name} added.`)
    setEditing(null)
    setCreating(false)
    router.refresh()
  }

  async function remove(location: Location) {
    setBusy(true)
    const { error } = await createClient().from('locations').delete().eq('id', location.id)
    setBusy(false)

    if (error) {
      // 23503: something still points at it. Every location_id is ON DELETE
      // RESTRICT precisely so an appointment can never lose the record of where
      // it happened — so the answer is to close the location, not erase it.
      toast.error(
        error.code === '23503'
          ? `${location.name} has appointments, sales or staff on file. Turn it off instead — the history stays.`
          : error.message || 'Could not remove that location.'
      )
      return
    }

    toast.success(`${location.name} removed.`)
    router.refresh()
  }

  return (
    <div>
      <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
        {locations.map((location) => {
          const address = formatLocationAddress(location)
          const counts = usage[location.id] ?? { appointments: 0, orders: 0, staff: 0 }
          const isPrimary = location.id === primaryId

          return (
            <li key={location.id} className="py-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2.5">
                    <span className="text-base">{location.name}</span>
                    {isPrimary && <Badge tone="accent">Primary</Badge>}
                    {!location.is_active && <Badge tone="neutral">Closed</Badge>}
                  </p>
                  {address && (
                    <p className="mt-1 text-xs text-[var(--color-muted)]">{address}</p>
                  )}
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    /{location.slug} &middot; {location.timezone}
                    {location.phone ? ` · ${location.phone}` : ''}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {counts.staff} on staff &middot; {counts.appointments} appointments
                    &middot; {counts.orders} sales
                  </p>
                </div>

                <div className="flex shrink-0 gap-2">
                  <Button
                    variant="subtle"
                    size="sm"
                    onClick={() => setEditing(editing === location.id ? null : location.id)}
                  >
                    {editing === location.id ? 'Close' : 'Edit'}
                  </Button>
                </div>
              </div>

              {editing === location.id && (
                <LocationForm
                  initial={draftFrom(location)}
                  busy={busy}
                  isPrimary={isPrimary}
                  onCancel={() => setEditing(null)}
                  onSave={(draft) => save(draft, location.id)}
                  onDelete={
                    counts.appointments + counts.orders + counts.staff === 0
                      ? () => remove(location)
                      : undefined
                  }
                />
              )}
            </li>
          )
        })}
      </ul>

      <div className="mt-8">
        {creating ? (
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
            <div className="flex items-center justify-between">
              <p className="label-caps text-[var(--color-muted)]">New location</p>
              <button
                type="button"
                onClick={() => setCreating(false)}
                className="flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                aria-label="Close"
              >
                <X className="h-4 w-4" strokeWidth={1.5} />
              </button>
            </div>
            <p className="mt-2 max-w-prose text-xs text-[var(--color-muted)]">
              A new location opens with the full service menu and a blank week of
              opening hours. Nothing can be booked there until someone is assigned to
              it and has hours, so it is safe to set up in advance.
            </p>
            <LocationForm
              initial={BLANK}
              busy={busy}
              isPrimary={false}
              autoSlug
              onCancel={() => setCreating(false)}
              onSave={(draft) => save(draft, null)}
            />
          </div>
        ) : (
          <Button variant="outline" size="sm" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" strokeWidth={2} />
            Add a location
          </Button>
        )}
      </div>
    </div>
  )
}

function LocationForm({
  initial,
  busy,
  isPrimary,
  autoSlug = false,
  onSave,
  onCancel,
  onDelete,
}: {
  initial: Draft
  busy: boolean
  isPrimary: boolean
  /** New rows derive the web address from the name until it is typed in. */
  autoSlug?: boolean
  onSave: (draft: Draft) => void
  onCancel: () => void
  onDelete?: () => void
}) {
  const [draft, setDraft] = useState<Draft>(initial)
  const [slugTouched, setSlugTouched] = useState(!autoSlug)

  const set = (patch: Partial<Draft>) => setDraft((d) => ({ ...d, ...patch }))

  return (
    <form
      className="mt-5 space-y-5 border-t border-[var(--color-border)] pt-5"
      onSubmit={(e) => {
        e.preventDefault()
        onSave(draft)
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name" htmlFor="loc-name" hint="What staff and clients call it.">
          <Input
            id="loc-name"
            required
            maxLength={80}
            value={draft.name}
            onChange={(e) =>
              set({
                name: e.target.value,
                ...(slugTouched ? {} : { slug: slugifyLocationName(e.target.value) }),
              })
            }
          />
        </Field>

        <Field
          label="Web address"
          htmlFor="loc-slug"
          hint="Appears in the booking link: /book?location=…"
        >
          <Input
            id="loc-slug"
            required
            maxLength={60}
            value={draft.slug}
            onChange={(e) => {
              setSlugTouched(true)
              set({ slug: e.target.value.toLowerCase() })
            }}
          />
        </Field>

        <Field label="Street" htmlFor="loc-street" className="sm:col-span-2">
          <Input
            id="loc-street"
            maxLength={120}
            value={draft.address_line1}
            onChange={(e) => set({ address_line1: e.target.value })}
          />
        </Field>

        <Field label="City" htmlFor="loc-city">
          <Input
            id="loc-city"
            maxLength={80}
            value={draft.city}
            onChange={(e) => set({ city: e.target.value })}
          />
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="State" htmlFor="loc-state">
            <Input
              id="loc-state"
              maxLength={2}
              value={draft.state}
              onChange={(e) => set({ state: e.target.value.toUpperCase() })}
            />
          </Field>
          <Field label="ZIP" htmlFor="loc-postal">
            <Input
              id="loc-postal"
              maxLength={10}
              value={draft.postal}
              onChange={(e) => set({ postal: e.target.value })}
            />
          </Field>
        </div>

        <Field
          label="Timezone"
          htmlFor="loc-tz"
          hint="Every opening time at this location is read in this zone."
        >
          <Input
            id="loc-tz"
            required
            list="loc-tz-options"
            maxLength={64}
            value={draft.timezone}
            onChange={(e) => set({ timezone: e.target.value })}
          />
          <datalist id="loc-tz-options">
            {COMMON_ZONES.map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </Field>

        <Field
          label="Order"
          htmlFor="loc-order"
          hint="Lowest first. The first open location is the primary one."
        >
          <Input
            id="loc-order"
            inputMode="numeric"
            maxLength={4}
            value={draft.sort_order}
            onChange={(e) => set({ sort_order: e.target.value })}
          />
        </Field>

        <Field label="Phone" htmlFor="loc-phone">
          <Input
            id="loc-phone"
            type="tel"
            maxLength={40}
            value={draft.phone}
            onChange={(e) => set({ phone: e.target.value })}
          />
        </Field>

        <Field label="Email" htmlFor="loc-email">
          <Input
            id="loc-email"
            type="email"
            maxLength={254}
            value={draft.email}
            onChange={(e) => set({ email: e.target.value })}
          />
        </Field>
      </div>

      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={draft.is_active}
          onChange={(e) => set({ is_active: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          Open
          <span className="block text-xs text-[var(--color-muted)]">
            {isPrimary
              ? 'Closing the primary location hands that role to the next one in order. Its history is kept either way.'
              : 'A closed location disappears from the booking site and the switcher. Nothing that happened there is lost.'}
          </span>
        </span>
      </label>

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        {onDelete && (
          <Button
            type="button"
            variant="danger"
            size="sm"
            className="ml-auto"
            disabled={busy}
            onClick={onDelete}
          >
            Remove
          </Button>
        )}
      </div>
    </form>
  )
}
