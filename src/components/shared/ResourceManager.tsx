'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, Plus, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { cn } from '@/lib/utils'
import {
  RESOURCE_KIND_LABELS,
  describeCapacity,
  type ResourceKind,
} from '@/types/resources'

export interface ManagedResource {
  id: number
  location_id: number
  room_id: number | null
  name: string
  kind: ResourceKind
  quantity: number
  is_active: boolean
  sort_order: number
  notes: string | null
}

export interface ResourceServiceOption {
  id: number
  name: string
}

export interface ResourceLocationOption {
  id: number
  name: string
}

export interface ResourceLink {
  service_id: number
  resource_id: number
  quantity: number
}

type Draft = {
  name: string
  kind: ResourceKind
  quantity: string
  notes: string
  location_id: string
  is_active: boolean
}

const BLANK: Draft = {
  name: '',
  kind: 'equipment',
  quantity: '1',
  notes: '',
  location_id: '',
  is_active: true,
}

/**
 * Rooms, beds, warmers, masks — and which treatments need them.
 *
 * The number that matters on this screen is `quantity`. It is capacity, not a
 * label: with two warmers the studio can run two waxes at once, and the booking
 * page will offer that second slot the moment the second warmer is entered here.
 * Lowering it below what is already booked is refused by the database, and the
 * message it sends back says which bookings are in the way.
 */
export function ResourceManager({
  resources,
  services,
  links,
  locations,
  defaultLocationId,
}: {
  resources: ManagedResource[]
  services: ResourceServiceOption[]
  links: ResourceLink[]
  locations: ResourceLocationOption[]
  defaultLocationId: number
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const [draft, setDraft] = useState<Draft>(BLANK)

  const servicesFor = useMemo(() => {
    const map = new Map<number, number[]>()
    for (const link of links) {
      const list = map.get(link.resource_id) ?? []
      list.push(link.service_id)
      map.set(link.resource_id, list)
    }
    return map
  }, [links])

  const nameFor = useMemo(
    () => new Map(services.map((s) => [s.id, s.name])),
    [services]
  )
  const locationName = useMemo(
    () => new Map(locations.map((l) => [l.id, l.name])),
    [locations]
  )

  function startNew() {
    setDraft({ ...BLANK, location_id: String(defaultLocationId) })
    setEditing('new')
  }

  function startEdit(resource: ManagedResource) {
    setDraft({
      name: resource.name,
      kind: resource.kind,
      quantity: String(resource.quantity),
      notes: resource.notes ?? '',
      location_id: String(resource.location_id),
      is_active: resource.is_active,
    })
    setEditing(resource.id)
  }

  async function save() {
    const target = editing
    if (target === null) return

    const name = draft.name.trim()
    if (!name) {
      toast.error('Give it a name — "Room 2", "Wax warmer", "LED mask".')
      return
    }

    const quantity = Number(draft.quantity)
    if (!Number.isInteger(quantity) || quantity < 0) {
      toast.error('How many of it there are has to be a whole number, zero or more.')
      return
    }

    const row = {
      name,
      kind: draft.kind,
      quantity,
      notes: draft.notes.trim() || null,
      is_active: draft.is_active,
      location_id: Number(draft.location_id) || defaultLocationId,
    }

    setBusy(true)
    const supabase = createClient()
    const { error } =
      target === 'new'
        ? await supabase.from('resources').insert(row)
        : await supabase.from('resources').update(row).eq('id', target)
    setBusy(false)

    if (error) {
      // The capacity guard raises a sentence written for whoever is reading it.
      toast.error(error.message || 'Could not save that.')
      return
    }

    toast.success(target === 'new' ? `${name} added.` : 'Saved.')
    setEditing(null)
    router.refresh()
  }

  /** Attach or detach a service. One row per pairing; quantity is almost always 1. */
  async function toggleService(resourceId: number, serviceId: number, on: boolean) {
    setBusy(true)
    const supabase = createClient()
    const { error } = on
      ? await supabase
          .from('service_resources')
          .delete()
          .eq('resource_id', resourceId)
          .eq('service_id', serviceId)
      : await supabase
          .from('service_resources')
          .insert({ resource_id: resourceId, service_id: serviceId, quantity: 1 })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not change that.')
      return
    }
    router.refresh()
  }

  const editor = (
    <div className="space-y-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Name" htmlFor="res_name" className="sm:col-span-2">
          <Input
            id="res_name"
            maxLength={80}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            placeholder="Wax warmer"
          />
        </Field>

        <Field label="What is it" htmlFor="res_kind">
          <Select
            id="res_kind"
            value={draft.kind}
            onChange={(e) => setDraft({ ...draft, kind: e.target.value as ResourceKind })}
          >
            {(Object.keys(RESOURCE_KIND_LABELS) as ResourceKind[]).map((k) => (
              <option key={k} value={k}>
                {RESOURCE_KIND_LABELS[k]}
              </option>
            ))}
          </Select>
        </Field>

        <Field
          label="How many"
          htmlFor="res_qty"
          hint="Two warmers run two waxes at once. Zero means it is out of service."
        >
          <Input
            id="res_qty"
            type="number"
            min={0}
            step={1}
            value={draft.quantity}
            onChange={(e) => setDraft({ ...draft, quantity: e.target.value })}
          />
        </Field>

        {locations.length > 1 && (
          <Field label="Where it lives" htmlFor="res_loc">
            <Select
              id="res_loc"
              value={draft.location_id}
              onChange={(e) => setDraft({ ...draft, location_id: e.target.value })}
            >
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field label="Note" htmlFor="res_notes" className="sm:col-span-2">
          <Textarea
            id="res_notes"
            maxLength={300}
            value={draft.notes}
            onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
          />
        </Field>
      </div>

      <label className="flex cursor-pointer items-start gap-2.5 text-sm">
        <input
          type="checkbox"
          checked={draft.is_active}
          onChange={(e) => setDraft({ ...draft, is_active: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          In use
          <span className="block text-xs text-[var(--color-muted)]">
            Untick while it is in for repair. Anything that needs it stops being
            bookable, which is the honest answer.
          </span>
        </span>
      </label>

      <div className="flex items-center gap-3">
        <Button size="sm" disabled={busy} onClick={save}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
        <Button size="sm" variant="ghost" className="px-0" onClick={() => setEditing(null)}>
          Cancel
        </Button>
      </div>
    </div>
  )

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h2 className="label-caps text-[var(--color-accent)]">Rooms and equipment</h2>
        {editing !== 'new' && (
          <Button variant="subtle" size="sm" onClick={startNew}>
            <Plus className="h-3.5 w-3.5" strokeWidth={2} />
            Add one
          </Button>
        )}
      </div>

      {editing === 'new' && <div className="mt-5">{editor}</div>}

      {resources.length === 0 && editing !== 'new' ? (
        <p className="mt-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          Nothing here yet. Until something is listed, availability is decided by the
          provider&rsquo;s calendar alone — which is right for a studio where the only
          constraint is the person.
        </p>
      ) : (
        <ul className="mt-6 space-y-px border border-[var(--color-border)] bg-[var(--color-border)]">
          {resources.map((resource) => {
            const attached = servicesFor.get(resource.id) ?? []
            const isEditing = editing === resource.id

            return (
              <li key={resource.id} className="bg-[var(--color-surface)] p-5">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div>
                    <p className="flex flex-wrap items-center gap-2.5">
                      <span className={resource.is_active ? '' : 'line-through'}>
                        {resource.name}
                      </span>
                      <Badge tone={resource.kind === 'room' ? 'info' : 'neutral'}>
                        {RESOURCE_KIND_LABELS[resource.kind]}
                      </Badge>
                      {!resource.is_active && <Badge tone="warning">Out of service</Badge>}
                      {resource.room_id !== null && (
                        <Badge tone="neutral">From rooms</Badge>
                      )}
                    </p>
                    <p className="mt-1.5 text-xs text-[var(--color-muted)]">
                      {describeCapacity(resource.quantity)}
                      {locations.length > 1 &&
                        ` · ${locationName.get(resource.location_id) ?? 'Unassigned'}`}
                      {resource.notes ? ` · ${resource.notes}` : ''}
                    </p>
                  </div>

                  {!isEditing && (
                    <Button variant="subtle" size="sm" onClick={() => startEdit(resource)}>
                      Edit
                    </Button>
                  )}
                </div>

                {isEditing && (
                  <div className="relative mt-5">
                    <button
                      type="button"
                      onClick={() => setEditing(null)}
                      className="absolute right-2 top-2 z-10 flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                      aria-label="Close"
                    >
                      <X className="h-4 w-4" strokeWidth={1.5} />
                    </button>
                    {editor}
                  </div>
                )}

                <div className="mt-5 border-t border-[var(--color-border)] pt-4">
                  <p className="label-caps mb-3 text-[var(--color-muted)]">
                    Treatments that need it
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {services.map((service) => {
                      const on = attached.includes(service.id)
                      return (
                        <button
                          key={service.id}
                          type="button"
                          aria-pressed={on}
                          disabled={busy}
                          onClick={() => toggleService(resource.id, service.id, on)}
                          className={cn(
                            'flex items-center gap-1.5 border px-2.5 py-1.5 text-xs transition-colors disabled:opacity-50',
                            on
                              ? 'border-[var(--color-accent)] bg-[var(--color-clay-soft)] text-[var(--color-clay-deep)] dark:bg-transparent dark:text-[var(--color-accent)]'
                              : 'border-[var(--color-border)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'
                          )}
                        >
                          {on && <Check className="h-3 w-3" strokeWidth={2.5} />}
                          {service.name}
                        </button>
                      )
                    })}
                  </div>
                  {attached.length > 0 && (
                    <p className="mt-3 text-xs text-[var(--color-muted)]">
                      {attached.length === 1
                        ? `${nameFor.get(attached[0]) ?? 'One treatment'} cannot be booked without it.`
                        : `${attached.length} treatments cannot be booked without it.`}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
