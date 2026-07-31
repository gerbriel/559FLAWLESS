'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/field'
import type { BookingSettings } from '@/types/database'

export function BookingSettingsForm({ settings }: { settings: BookingSettings }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    min_lead_minutes: String(settings.min_lead_minutes),
    max_advance_days: String(settings.max_advance_days),
    timezone: settings.timezone,
    auto_confirm: settings.auto_confirm,
    default_deposit_cents: String(settings.default_deposit_cents),
    cancellation_policy: settings.cancellation_policy ?? '',
    late_policy: settings.late_policy ?? '',
  })

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)

    const { error } = await createClient()
      .from('booking_settings')
      .update({
        min_lead_minutes: Number(form.min_lead_minutes),
        max_advance_days: Number(form.max_advance_days),
        timezone: form.timezone.trim(),
        auto_confirm: form.auto_confirm,
        default_deposit_cents: Number(form.default_deposit_cents),
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
        <Field
          label="Minimum notice (minutes)"
          htmlFor="min_lead"
          hint="How soon before a slot someone can still book it."
        >
          <Input
            id="min_lead"
            type="number"
            min={0}
            max={10080}
            value={form.min_lead_minutes}
            onChange={(e) => setForm({ ...form, min_lead_minutes: e.target.value })}
          />
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
          label="Default deposit (cents)"
          htmlFor="deposit"
          hint="Used when a service sets no deposit of its own."
        >
          <Input
            id="deposit"
            type="number"
            min={0}
            value={form.default_deposit_cents}
            onChange={(e) => setForm({ ...form, default_deposit_cents: e.target.value })}
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
