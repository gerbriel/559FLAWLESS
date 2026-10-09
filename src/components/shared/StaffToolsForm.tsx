'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

type Flag = 'time_clock_enabled' | 'my_hours_enabled'

/**
 * The two staff tools a small studio may not want in front of it (077).
 *
 * Each switch saves on its own, straight to `booking_settings` — managers and
 * up may write that row (029), which is the gate; this form being drawn only
 * for managers is the courtesy.
 */
export function StaffToolsForm({
  timeClock,
  myHours,
}: {
  timeClock: boolean
  myHours: boolean
}) {
  const router = useRouter()
  const [values, setValues] = useState({ time_clock_enabled: timeClock, my_hours_enabled: myHours })
  const [busy, setBusy] = useState<Flag | null>(null)

  async function toggle(flag: Flag, next: boolean) {
    setValues((v) => ({ ...v, [flag]: next }))
    setBusy(flag)
    const { error } = await createClient()
      .from('booking_settings')
      .update(flag === 'time_clock_enabled' ? { time_clock_enabled: next } : { my_hours_enabled: next })
      .eq('id', 1)
    setBusy(null)

    if (error) {
      setValues((v) => ({ ...v, [flag]: !next }))
      toast.error(error.message || 'Could not save that.')
      return
    }

    toast.success(
      flag === 'time_clock_enabled'
        ? next
          ? 'Time clock switched on.'
          : 'Time clock switched off. Hours already recorded are kept.'
        : next
          ? 'My hours is back in the menu.'
          : 'My hours is hidden from the menu.'
    )
    router.refresh()
  }

  return (
    <div className="max-w-xl space-y-5">
      <Switch
        id="tool_time_clock"
        label="Time clock & Timesheets"
        hint="Clock in and out, timesheets, and the reminders when someone forgets. Off hides all of it and stops the reminders; hours already recorded are kept."
        checked={values.time_clock_enabled}
        disabled={busy === 'time_clock_enabled'}
        onChange={(v) => toggle('time_clock_enabled', v)}
      />
      <Switch
        id="tool_my_hours"
        label="My hours"
        hint="Each provider's working week and their Google Calendar connection. Off hides it from the menu and the Calendar tabs; the hours still decide what clients can book, and the page stays reachable from here."
        checked={values.my_hours_enabled}
        disabled={busy === 'my_hours_enabled'}
        onChange={(v) => toggle('my_hours_enabled', v)}
      />
    </div>
  )
}

function Switch({
  id,
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-6">
      <label htmlFor={id} className="min-w-0">
        <span className="block text-sm">{label}</span>
        <span className="mt-1 block text-xs leading-relaxed text-[var(--color-muted)]">{hint}</span>
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
          checked ? 'bg-[var(--color-accent)]' : 'bg-[var(--color-border)]'
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-[var(--color-background)] shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </div>
  )
}
