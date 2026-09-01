'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea, Select } from '@/components/ui/field'
import type { BookingSettings } from '@/types/database'

/**
 * The notice periods a studio actually chooses between.
 *
 * 24 hours is the default: enough to plan the day, not so much that a Friday
 * cancellation cannot be refilled.
 */
const LEAD_PRESETS = [
  { minutes: 0, label: 'None — same-day booking is fine' },
  { minutes: 60, label: '1 hour' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
  { minutes: 720, label: '12 hours' },
  { minutes: 1440, label: '24 hours' },
  { minutes: 2880, label: '2 days' },
  { minutes: 4320, label: '3 days' },
  { minutes: 10080, label: '1 week' },
]

export function BookingSettingsForm({ settings }: { settings: BookingSettings }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    min_lead_minutes: String(settings.min_lead_minutes),
    max_advance_days: String(settings.max_advance_days),
    timezone: settings.timezone,
    auto_confirm: settings.auto_confirm,
    // Shown in DOLLARS, like the service editor's deposit field — the two
    // used to disagree (this one took cents), which is a 100x mistake waiting.
    default_deposit_dollars:
      settings.default_deposit_cents % 100 === 0
        ? String(settings.default_deposit_cents / 100)
        : (settings.default_deposit_cents / 100).toFixed(2),
    cancellation_policy: settings.cancellation_policy ?? '',
    late_policy: settings.late_policy ?? '',
  })

  async function save(e: React.FormEvent) {
    e.preventDefault()

    const depositCents = Math.round(Number(form.default_deposit_dollars) * 100)
    if (!Number.isFinite(depositCents) || depositCents < 0) {
      toast.error('That default deposit is not a number.')
      return
    }

    setBusy(true)

    const { error } = await createClient()
      .from('booking_settings')
      .update({
        min_lead_minutes: Number(form.min_lead_minutes),
        max_advance_days: Number(form.max_advance_days),
        timezone: form.timezone.trim(),
        auto_confirm: form.auto_confirm,
        default_deposit_cents: depositCents,
        cancellation_policy: form.cancellation_policy.trim() || null,
        late_policy: form.late_policy.trim() || null,
      })
      .eq('id', 1)

    setBusy(false)

    if (error) {
      toast.error('Could not save.')
      return
    }

    toast.success('Saved.')
    router.refresh()
  }

  return (
    <form
      onSubmit={save}
      className="space-y-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        {/* Offered in the units people actually think in. "1440 minutes" is
            technically the same as "a day" and nobody reads it that way. */}
        <Field
          label="Notice required"
          htmlFor="min_lead"
          hint="How far ahead a client has to book. You can still fit someone in yourself — this only limits online booking."
        >
          <Select
            id="min_lead"
            value={
              LEAD_PRESETS.some((o) => String(o.minutes) === form.min_lead_minutes)
                ? form.min_lead_minutes
                : 'custom'
            }
            onChange={(e) => {
              if (e.target.value === 'custom') return
              setForm({ ...form, min_lead_minutes: e.target.value })
            }}
          >
            {LEAD_PRESETS.map((o) => (
              <option key={o.minutes} value={String(o.minutes)}>
                {o.label}
              </option>
            ))}
            {!LEAD_PRESETS.some((o) => String(o.minutes) === form.min_lead_minutes) && (
              <option value="custom">
                Custom — {form.min_lead_minutes} minutes
              </option>
            )}
          </Select>
        </Field>

        <Field
          label="Book ahead (days)"
          htmlFor="max_advance"
          hint="How far out the calendar opens."
        >
          <Input
            id="max_advance"
            type="number"
            min={1}
            max={365}
            value={form.max_advance_days}
            onChange={(e) => setForm({ ...form, max_advance_days: e.target.value })}
          />
        </Field>

        <Field label="Studio timezone" htmlFor="tz" hint="IANA name, e.g. America/Los_Angeles.">
          <Input
            id="tz"
            value={form.timezone}
            onChange={(e) => setForm({ ...form, timezone: e.target.value })}
          />
        </Field>

        <Field
          label="Default deposit ($)"
          htmlFor="deposit"
          hint="In dollars, like the service editor. Used when a service sets no deposit of its own."
        >
          <Input
            id="deposit"
            type="number"
            min={0}
            step="0.01"
            value={form.default_deposit_dollars}
            onChange={(e) => setForm({ ...form, default_deposit_dollars: e.target.value })}
          />
        </Field>
      </div>

      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input
          type="checkbox"
          checked={form.auto_confirm}
          onChange={(e) => setForm({ ...form, auto_confirm: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>
          Confirm online bookings automatically.
          <span className="block text-[var(--color-muted)]">
            Turn this off to hold every booking for staff review first.
          </span>
        </span>
      </label>

      <Field label="Cancellation policy" htmlFor="cancel_policy">
        <Textarea
          id="cancel_policy"
          rows={2}
          maxLength={1000}
          value={form.cancellation_policy}
          onChange={(e) => setForm({ ...form, cancellation_policy: e.target.value })}
        />
      </Field>

      <Field label="Late policy" htmlFor="late_policy">
        <Textarea
          id="late_policy"
          rows={2}
          maxLength={1000}
          value={form.late_policy}
          onChange={(e) => setForm({ ...form, late_policy: e.target.value })}
        />
      </Field>

      <Button type="submit" disabled={busy}>
        {busy ? 'Saving…' : 'Save settings'}
      </Button>
    </form>
  )
}
