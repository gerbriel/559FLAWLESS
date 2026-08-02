'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Select } from '@/components/ui/field'
import {
  FRAGMENT_PRESETS,
  GAP_PRESETS,
  MAX_GAP_PRESETS,
  type SchedulingPolicy,
} from '@/types/scheduling'

const NO_SHOW_PRESETS = [
  { value: 0, label: 'Never — a missed appointment changes nothing' },
  { value: 1, label: 'After one missed appointment' },
  { value: 2, label: 'After two' },
  { value: 3, label: 'After three' },
]

/**
 * The studio's booking mechanics for one site.
 *
 * Two halves that read as one page but are not the same kind of decision.
 * The approval rules decide who gets to book without being asked about; the
 * gap defaults decide how the day is shaped. Both start off, and off means
 * exactly what the booking page did before any of this existed.
 */
export function SchedulingPolicyForm({
  policy,
  locationName,
}: {
  policy: SchedulingPolicy
  locationName: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    require_approval_new_client: policy.require_approval_new_client,
    no_show_threshold: String(policy.no_show_threshold),
    default_min_gap_minutes: String(policy.default_min_gap_minutes),
    default_max_gap_minutes:
      policy.default_max_gap_minutes === null ? '' : String(policy.default_max_gap_minutes),
    default_min_fragment_minutes: String(policy.default_min_fragment_minutes),
    allow_processing_overlap: policy.allow_processing_overlap,
  })

  async function save(e: React.FormEvent) {
    e.preventDefault()

    const minGap = Number(form.default_min_gap_minutes)
    const maxGap = form.default_max_gap_minutes === '' ? null : Number(form.default_max_gap_minutes)
    if (maxGap !== null && maxGap < minGap) {
      toast.error('The most idle time cannot be less than the least.')
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('scheduling_policies')
      .update({
        require_approval_new_client: form.require_approval_new_client,
        no_show_threshold: Number(form.no_show_threshold),
        default_min_gap_minutes: minGap,
        default_max_gap_minutes: maxGap,
        default_min_fragment_minutes: Number(form.default_min_fragment_minutes),
        allow_processing_overlap: form.allow_processing_overlap,
      })
      .eq('location_id', policy.location_id)
    setBusy(false)

    if (error) {
      toast.error('Could not save those rules.')
      return
    }

    toast.success('Saved.')
    router.refresh()
  }

  return (
    <form
      onSubmit={save}
      className="space-y-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <p className="label-caps text-[var(--color-muted)]">{locationName}</p>

      <section className="space-y-5">
        <div>
          <h3 className="display text-xl">Who gets looked at first</h3>
          <p className="mt-1.5 max-w-prose text-sm text-[var(--color-muted)]">
            A booking that matches any of these lands in{' '}
            <span className="text-[var(--color-foreground)]">Waiting on you</span> instead of
            confirming itself. It still holds its time on the calendar while it waits, so
            nobody can take the slot out from under it.
          </p>
        </div>

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={form.require_approval_new_client}
            onChange={(e) =>
              setForm({ ...form, require_approval_new_client: e.target.checked })
            }
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Someone booking for the first time
            <span className="block text-[var(--color-muted)]">
              Matched the same way the CRM matches a guest booking: their account, then
              their email, then their phone number.
            </span>
          </span>
        </label>

        <Field
          label="Someone who has not turned up"
          htmlFor="no_show_threshold"
          hint="Counts every appointment marked no-show on their record, however long ago."
        >
          <Select
            id="no_show_threshold"
            value={form.no_show_threshold}
            onChange={(e) => setForm({ ...form, no_show_threshold: e.target.value })}
          >
            {NO_SHOW_PRESETS.map((o) => (
              <option key={o.value} value={String(o.value)}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>

        <p className="border-l-2 border-[var(--color-border)] pl-3 text-xs text-[var(--color-muted)]">
          Individual services can also be set to always need review — that is further down
          this page. Holding <em>every</em> online booking is the switch under Booking
          policy in Settings, and it overrides all of this.
        </p>
      </section>

      <section className="space-y-5 border-t border-[var(--color-border)] pt-8">
        <div>
          <h3 className="display text-xl">How the day is shaped</h3>
          <p className="mt-1.5 max-w-prose text-sm text-[var(--color-muted)]">
            Defaults for everyone. A provider who wants something different sets it on
            their own row below.
          </p>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="Least idle time between clients"
            htmlFor="min_gap"
            hint="On top of the turnover buffer a service already carries. Measured against other appointments, not the start of the day."
          >
            <Select
              id="min_gap"
              value={form.default_min_gap_minutes}
              onChange={(e) => setForm({ ...form, default_min_gap_minutes: e.target.value })}
            >
              {GAP_PRESETS.map((o) => (
                <option key={o.minutes} value={String(o.minutes)}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Most idle time between clients"
            htmlFor="max_gap"
            hint="Keeps the day packed. Only applies once something is booked — the first appointment of the day can go anywhere."
          >
            <Select
              id="max_gap"
              value={form.default_max_gap_minutes}
              onChange={(e) => setForm({ ...form, default_max_gap_minutes: e.target.value })}
            >
              {MAX_GAP_PRESETS.map((o) => (
                <option key={String(o.minutes)} value={o.minutes === null ? '' : String(o.minutes)}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>

          <Field
            label="Don't leave me a gap shorter than"
            htmlFor="min_fragment"
            hint="A time that would strand a shorter stretch than this — against the next booking or against opening and closing — is not offered at all."
            className="sm:col-span-2"
          >
            <Select
              id="min_fragment"
              value={form.default_min_fragment_minutes}
              onChange={(e) =>
                setForm({ ...form, default_min_fragment_minutes: e.target.value })
              }
            >
              {FRAGMENT_PRESETS.map((o) => (
                <option key={o.minutes} value={String(o.minutes)}>
                  {o.label}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={form.allow_processing_overlap}
            onChange={(e) => setForm({ ...form, allow_processing_overlap: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Let the website book into a service&rsquo;s processing time
            <span className="block text-[var(--color-muted)]">
              While a peel is developing you are free, but the client is still in the room.
              Only switch this on if there is somewhere else for the second person to be —
              the nail desk, the second chair. With one room, leave it off: you can still
              double up yourself from the calendar, deliberately, with a note.
            </span>
          </span>
        </label>
      </section>

      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save rules'}
      </Button>
    </form>
  )
}
