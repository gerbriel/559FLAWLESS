'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import { ROLE_LABELS, type UserRole } from '@/types/database'
import { formatDateKey, formatRate } from '@/types/staff'

export type AssignableStaff = {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
  role: UserRole
}

export type AssignablePlan = {
  id: number
  name: string
  service_rate_bp: number
  retail_rate_bp: number
  is_active: boolean
}

export type AssignableLocation = { id: number; name: string }

export type AssignmentRow = {
  id: number
  profile_id: string
  plan_id: number
  location_id: number
  effective_from: string
  effective_to: string | null
  note: string | null
}

function staffName(s: AssignableStaff): string {
  const name = s.display_name?.trim() || `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim()
  return name || 'Unnamed'
}

/**
 * Who is on which rate card, at which site, and since when.
 *
 * The dates are the whole point. A report for March reads the row that covered
 * March, so ending an assignment is how a rate changes — not editing the card,
 * which the database refuses once it has been in force. Two cards covering one
 * day for one person at one site is refused by an exclusion constraint, the
 * same way two bookings cannot share a slot.
 */
export function CommissionAssignments({
  staff,
  plans,
  locations,
  assignments,
  today,
}: {
  staff: AssignableStaff[]
  plans: AssignablePlan[]
  locations: AssignableLocation[]
  assignments: AssignmentRow[]
  /** 'YYYY-MM-DD' in the location's zone, read on the server. */
  today: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [open, setOpen] = useState(false)

  const [profileId, setProfileId] = useState(staff[0]?.id ?? '')
  const [planId, setPlanId] = useState(String(plans[0]?.id ?? ''))
  const [locationId, setLocationId] = useState(String(locations[0]?.id ?? ''))
  const [from, setFrom] = useState(today)
  const [until, setUntil] = useState('')
  const [note, setNote] = useState('')

  const planName = (id: number) => plans.find((p) => p.id === id)?.name ?? `Card ${id}`
  const locationName = (id: number) =>
    locations.find((l) => l.id === id)?.name ?? `Site ${id}`

  async function assign() {
    if (!profileId || !planId || !locationId || !from) {
      toast.error('Pick a person, a card, a site, and a start date.')
      return
    }
    if (until && until < from) {
      toast.error('The end date cannot be before the start date.')
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('staff_commission_plans')
      .insert({
        profile_id: profileId,
        plan_id: Number(planId),
        location_id: Number(locationId),
        effective_from: from,
        effective_to: until || null,
        note: note.trim() || null,
      })
    setBusy(false)

    if (error) {
      toast.error(
        error.message.includes('no_overlap')
          ? 'They are already on a card covering those dates at that site. End that one first.'
          : error.message || 'Could not assign that card.'
      )
      return
    }

    toast.success('Assigned.')
    setOpen(false)
    setNote('')
    setUntil('')
    router.refresh()
  }

  async function end(row: AssignmentRow) {
    if (row.effective_to && row.effective_to < today) {
      toast.error('That one has already ended.')
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('staff_commission_plans')
      .update({ effective_to: today })
      .eq('id', row.id)
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not end that assignment.')
      return
    }

    toast.success('Ended today. Anything after this earns nothing until a new card starts.')
    router.refresh()
  }

  const byPerson = staff
    .map((s) => ({
      person: s,
      rows: assignments
        .filter((a) => a.profile_id === s.id)
        .sort((a, b) => b.effective_from.localeCompare(a.effective_from)),
    }))
    .filter((g) => g.rows.length > 0 || staff.length <= 12)

  return (
    <div>
      {plans.length === 0 ? (
        <p className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          Make a rate card first — there is nothing to put anyone on.
        </p>
      ) : !open ? (
        <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
          Assign a card
        </Button>
      ) : (
        <div className="space-y-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Who" htmlFor="assign_person">
              <Select
                id="assign_person"
                value={profileId}
                onChange={(e) => setProfileId(e.target.value)}
              >
                {staff.map((s) => (
                  <option key={s.id} value={s.id}>
                    {staffName(s)} — {ROLE_LABELS[s.role]}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Card" htmlFor="assign_plan">
              <Select id="assign_plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatRate(p.service_rate_bp)} services,{' '}
                    {formatRate(p.retail_rate_bp)} retail
                  </option>
                ))}
              </Select>
            </Field>

            <Field
              label="Site"
              htmlFor="assign_location"
              hint="Rates can differ by site; each one is its own assignment."
            >
              <Select
                id="assign_location"
                value={locationId}
                onChange={(e) => setLocationId(e.target.value)}
              >
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Note" htmlFor="assign_note" hint="Optional.">
              <Input
                id="assign_note"
                maxLength={200}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>

            <Field
              label="From"
              htmlFor="assign_from"
              hint="Work on or after this date pays at this card's rates."
            >
              <Input
                id="assign_from"
                type="date"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </Field>

            <Field label="Until" htmlFor="assign_until" hint="Leave empty for open-ended.">
              <Input
                id="assign_until"
                type="date"
                value={until}
                onChange={(e) => setUntil(e.target.value)}
              />
            </Field>
          </div>

          <div className="flex flex-wrap gap-3">
            <Button size="sm" onClick={assign} disabled={busy}>
              {busy ? 'Saving…' : 'Assign'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="mt-10 space-y-10">
        {byPerson.map(({ person, rows }) => (
          <div key={person.id}>
            <div className="flex flex-wrap items-baseline gap-3">
              <h3 className="display text-xl">{staffName(person)}</h3>
              <span className="label-caps text-[var(--color-muted)]">
                {ROLE_LABELS[person.role]}
              </span>
            </div>

            {rows.length === 0 ? (
              <p className="mt-3 text-sm text-[var(--color-muted)]">
                No card. Nothing they do earns commission until there is one.
              </p>
            ) : (
              <ul className="mt-4 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                {rows.map((r) => {
                  const current =
                    r.effective_from <= today && (r.effective_to === null || r.effective_to >= today)

                  return (
                    <li
                      key={r.id}
                      className="flex flex-wrap items-center justify-between gap-4 py-4"
                    >
                      <div>
                        <p className="text-sm">
                          {planName(r.plan_id)}
                          <span className="text-[var(--color-muted)]">
                            {' '}
                            · {locationName(r.location_id)}
                          </span>
                        </p>
                        <p className="text-xs tabular-nums text-[var(--color-muted)]">
                          {formatDateKey(r.effective_from)} —{' '}
                          {r.effective_to ? formatDateKey(r.effective_to) : 'ongoing'}
                          {r.note ? ` · ${r.note}` : ''}
                        </p>
                      </div>

                      <div className="flex flex-wrap items-center gap-3">
                        {current ? (
                          <Badge tone="success">In force</Badge>
                        ) : r.effective_from > today ? (
                          <Badge tone="info">Starts later</Badge>
                        ) : (
                          <Badge tone="neutral">Ended</Badge>
                        )}
                        {(current || r.effective_from > today) && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => end(r)}
                            disabled={busy}
                          >
                            End today
                          </Button>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
