'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Select } from '@/components/ui/field'
import {
  describeOffset,
  formatLocalSendTime,
  type NotificationAnchor,
  type NotificationKind,
  type NotificationSchedule,
} from '@/types/notifications'

export interface ScopeOption {
  id: number
  name: string
}

const UNITS: { value: string; label: string; minutes: number }[] = [
  { value: 'minutes', label: 'minutes', minutes: 1 },
  { value: 'hours', label: 'hours', minutes: 60 },
  { value: 'days', label: 'days', minutes: 1440 },
  { value: 'weeks', label: 'weeks', minutes: 10080 },
]

/** 1440 → { amount: 1, unit: 'days' }. Picks the largest unit that divides cleanly. */
function splitMinutes(minutes: number): { amount: number; unit: string } {
  const magnitude = Math.abs(minutes)
  for (const u of [...UNITS].reverse()) {
    if (magnitude % u.minutes === 0 && magnitude >= u.minutes) {
      return { amount: magnitude / u.minutes, unit: u.value }
    }
  }
  return { amount: magnitude, unit: 'minutes' }
}

/**
 * The lines that decide when one kind of message goes out.
 *
 * An offset is a signed number of minutes from an anchor, and the anchor is
 * modelled rather than assumed: "24 hours before the appointment starts" and
 * "six weeks after their last visit" are the same arithmetic against different
 * clocks, and the studio genuinely wants both.
 *
 * `send_at_local` is the difference between a countdown and a habit. Leave it
 * empty and the offset stays an exact duration, so a 24-hour reminder for the
 * Sunday after the clocks change lands an hour off the wall clock — correct for
 * a countdown. Set it and the message moves to that hour in the studio's own
 * timezone, which is what you want for anything a person reads over coffee.
 */
export function NotificationScheduleList({
  kind,
  anchorMode,
  schedules,
  services,
  categories,
}: {
  kind: NotificationKind
  /** 'appointment' offsets run backwards from a visit; 'last_visit' runs forwards. */
  anchorMode: 'appointment' | 'last_visit'
  schedules: NotificationSchedule[]
  services: ScopeOption[]
  categories: ScopeOption[]
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [adding, setAdding] = useState(false)

  const [label, setLabel] = useState('')
  const [amount, setAmount] = useState('1')
  const [unit, setUnit] = useState(anchorMode === 'last_visit' ? 'weeks' : 'days')
  const [anchor, setAnchor] = useState<NotificationAnchor>(
    anchorMode === 'last_visit' ? 'last_visit' : 'appointment_start'
  )
  const [sendAt, setSendAt] = useState(anchorMode === 'last_visit' ? '10:00' : '')
  const [scope, setScope] = useState('')

  async function toggle(schedule: NotificationSchedule, next: boolean) {
    setBusy(true)
    const { error } = await createClient()
      .from('notification_schedules')
      .update({ is_active: next })
      .eq('id', schedule.id)
    setBusy(false)

    if (error) {
      toast.error('Could not change that.')
      return
    }
    toast.success(next ? 'Switched on.' : 'Switched off.')
    router.refresh()
  }

  async function remove(schedule: NotificationSchedule) {
    setBusy(true)
    const { error } = await createClient()
      .from('notification_schedules')
      .delete()
      .eq('id', schedule.id)
    setBusy(false)

    if (error) {
      toast.error('Could not remove that.')
      return
    }
    toast.success('Removed.')
    router.refresh()
  }

  async function add() {
    const n = Number(amount)
    if (!Number.isFinite(n) || n <= 0) {
      toast.error('How far from the visit? Enter a number above zero.')
      return
    }
    if (!label.trim()) {
      toast.error('Give the line a name so you can tell them apart later.')
      return
    }

    const perUnit = UNITS.find((u) => u.value === unit)?.minutes ?? 1
    const magnitude = Math.round(n * perUnit)
    // Before the visit for anything anchored on an appointment; after it for a
    // rebooking nudge. The database enforces the same rule.
    const offsetMinutes = anchorMode === 'last_visit' ? magnitude : -magnitude

    const [scopeKind, scopeId] = scope ? scope.split(':') : []

    setBusy(true)
    const { error } = await createClient()
      .from('notification_schedules')
      .insert({
        kind,
        label: label.trim(),
        anchor,
        offset_minutes: offsetMinutes,
        send_at_local: sendAt || null,
        service_id: scopeKind === 'service' ? Number(scopeId) : null,
        category_id: scopeKind === 'category' ? Number(scopeId) : null,
      })
    setBusy(false)

    if (error) {
      toast.error(
        error.code === '23505'
          ? 'You already have a line at exactly that timing.'
          : error.message || 'Could not add that.'
      )
      return
    }

    toast.success('Added.')
    setLabel('')
    setAmount('1')
    setScope('')
    setAdding(false)
    router.refresh()
  }

  function scopeLabel(s: NotificationSchedule): string | null {
    if (s.service_id) return services.find((x) => x.id === s.service_id)?.name ?? 'One service'
    if (s.category_id)
      return categories.find((x) => x.id === s.category_id)?.name ?? 'One category'
    return null
  }

  return (
    <div>
      {schedules.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">
          Nothing scheduled, so nothing is sent.
        </p>
      ) : (
        <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {schedules.map((s) => {
            const split = splitMinutes(s.offset_minutes)
            const at = formatLocalSendTime(s.send_at_local)
            const where = scopeLabel(s)

            return (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
                <div>
                  <p className="flex flex-wrap items-center gap-2 text-sm">
                    {s.label}
                    {!s.is_active && (
                      <Badge tone="neutral" size="sm">
                        Off
                      </Badge>
                    )}
                    {where && (
                      <Badge tone="accent" size="sm">
                        {where}
                      </Badge>
                    )}
                  </p>
                  <p className="mt-1 text-xs text-[var(--color-muted)]">
                    {describeOffset(s.offset_minutes, s.anchor)}
                    {at
                      ? `, sent at ${at} studio time`
                      : `, to the minute (${split.amount} ${split.unit} exactly)`}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="subtle"
                    size="sm"
                    disabled={busy}
                    onClick={() => toggle(s, !s.is_active)}
                  >
                    {s.is_active ? 'Switch off' : 'Switch on'}
                  </Button>
                  <button
                    type="button"
                    aria-label={`Remove ${s.label}`}
                    disabled={busy}
                    onClick={() => remove(s)}
                    className="flex h-9 w-9 items-center justify-center text-[var(--color-muted)] transition-colors hover:text-red-700 disabled:opacity-45"
                  >
                    <Trash2 className="h-4 w-4" strokeWidth={1.5} />
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      )}

      {!adding ? (
        <Button variant="ghost" size="sm" className="mt-3 px-0" onClick={() => setAdding(true)}>
          Add another
        </Button>
      ) : (
        <div className="mt-4 space-y-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <Field
            label="Call it"
            htmlFor={`label_${kind}`}
            hint="How it reads in this list, e.g. “The day before”."
          >
            <Input
              id={`label_${kind}`}
              value={label}
              maxLength={60}
              onChange={(e) => setLabel(e.target.value)}
            />
          </Field>

          <div className="grid gap-3 sm:grid-cols-[1fr_1.2fr]">
            <Field label="How long" htmlFor={`amount_${kind}`}>
              <Input
                id={`amount_${kind}`}
                type="number"
                min={1}
                step="any"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>
            <Field label="Units" htmlFor={`unit_${kind}`}>
              <Select id={`unit_${kind}`} value={unit} onChange={(e) => setUnit(e.target.value)}>
                {UNITS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {anchorMode === 'appointment' ? (
            <Field label="Before what" htmlFor={`anchor_${kind}`}>
              <Select
                id={`anchor_${kind}`}
                value={anchor}
                onChange={(e) => setAnchor(e.target.value as NotificationAnchor)}
              >
                <option value="appointment_start">the appointment starts</option>
                <option value="appointment_end">the appointment ends</option>
              </Select>
            </Field>
          ) : (
            <p className="text-xs text-[var(--color-muted)]">
              Counted from the end of their last visit. A client with anything already
              booked is never nudged.
            </p>
          )}

          <Field
            label="Send it at"
            htmlFor={`sendat_${kind}`}
            hint="Optional, studio time. Leave empty and it goes exactly that far from the visit, whatever hour that lands on."
          >
            <Input
              id={`sendat_${kind}`}
              type="time"
              value={sendAt}
              onChange={(e) => setSendAt(e.target.value)}
            />
          </Field>

          <Field
            label="Only for"
            htmlFor={`scope_${kind}`}
            hint="Leave as Everything unless this timing is specific to one treatment."
          >
            <Select id={`scope_${kind}`} value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">Everything</option>
              <optgroup label="Category">
                {categories.map((c) => (
                  <option key={`c${c.id}`} value={`category:${c.id}`}>
                    {c.name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Service">
                {services.map((s) => (
                  <option key={`s${s.id}`} value={`service:${s.id}`}>
                    {s.name}
                  </option>
                ))}
              </optgroup>
            </Select>
          </Field>

          <div className="flex gap-3">
            <Button size="sm" onClick={add} disabled={busy}>
              {busy ? 'Adding…' : 'Add'}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setAdding(false)} disabled={busy}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
