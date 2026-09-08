'use client'

import * as React from 'react'
import { CalendarClock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Select } from '@/components/ui/field'
import {
  dateKeyInTimeZone,
  dayLabelForDateKey,
  formatTimeInTimeZone,
  zonedParts,
} from '@/lib/time'
import { isAwaitingApproval, PENDING_TITLE } from './CalendarView'
import {
  appointmentMinutes,
  DROP_STEP_MINUTES,
  type MovableAppointment,
} from './DragScheduleProvider'
import type { AppointmentStatus } from '@/types/database'

/**
 * Move an appointment, change its length, or both — as a form.
 *
 * Extracted from the drag board so the surfaces without a drag have the same
 * powers: the touch calendar (where dragging fights the scroll it shares a
 * gesture with) and the appointment page (where `?action=reschedule` used to
 * arrive and find nothing). One dialog, one /move route, one set of rules.
 *
 * Length lives here rather than on a resize handle because no surface draws a
 * card to its duration — there is no bottom edge that MEANS the end time, so
 * dragging one would be pantomime.
 */

export interface MoveDialogProvider {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
}

export interface MoveDialogAppointment extends MovableAppointment {
  status: AppointmentStatus
}

export function moveProviderName(p: MoveDialogProvider): string {
  return (
    p.display_name ?? (`${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() || 'Provider')
  )
}

/** Quarter-hour lengths up to the 8-hour bound the services table enforces. */
const DURATION_CHOICES = Array.from({ length: 32 }, (_, i) => (i + 1) * 15)

function durationLabel(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} min`
  if (m === 0) return `${h} hr`
  return `${h} hr ${m} min`
}

/**
 * Minutes past midnight, as the studio's clock reads it. Through `zonedParts`
 * rather than getHours(): the viewer's machine may well be somewhere else.
 */
function wallMinutes(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone)
  return p.hour * 60 + p.minute
}

export function MoveAppointmentDialog({
  appointment,
  clientLabel,
  serviceLabel,
  providers,
  timezone,
  busy,
  onClose,
  onSubmit,
}: {
  appointment: MoveDialogAppointment
  /** Who and what, already worded by the caller — this dialog only repeats it. */
  clientLabel: string
  serviceLabel: string
  providers: MoveDialogProvider[]
  timezone: string
  busy: boolean
  onClose: () => void
  onSubmit: (
    dateKey: string,
    time: string,
    providerId: string,
    durationMinutes: number,
    override: boolean
  ) => Promise<boolean>
}) {
  const start = new Date(appointment.starts_at)
  const [dateKey, setDateKey] = React.useState(dateKeyInTimeZone(start, timezone))
  const [time, setTime] = React.useState(() => {
    const minutes = wallMinutes(start, timezone)
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  })
  const [providerId, setProviderId] = React.useState(appointment.provider_id)
  const [duration, setDuration] = React.useState(() => appointmentMinutes(appointment))
  const [override, setOverride] = React.useState(false)
  const firstField = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    firstField.current?.focus()
  }, [])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move_dialog_title"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
      >
        <h2 id="move_dialog_title" className="display flex items-center gap-2 text-2xl">
          <CalendarClock className="h-5 w-5 text-[var(--color-muted)]" strokeWidth={1.5} aria-hidden />
          Move appointment
        </h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {clientLabel} — {serviceLabel || 'appointment'}, currently{' '}
          {formatTimeInTimeZone(start, timezone)} on{' '}
          {dayLabelForDateKey(dateKeyInTimeZone(start, timezone))}. The client is notified
          of any change, in their account and by email.
        </p>

        <form
          className="mt-6 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault()
            await onSubmit(dateKey, time, providerId, duration, override)
          }}
        >
          <Field label="Date" htmlFor="move_date">
            <Input
              ref={firstField}
              id="move_date"
              type="date"
              required
              value={dateKey}
              onChange={(e) => setDateKey(e.target.value)}
            />
          </Field>

          <Field label="Start time" htmlFor="move_time" hint="In the studio's clock.">
            <Input
              id="move_time"
              type="time"
              step={DROP_STEP_MINUTES * 60}
              required
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </Field>

          <Field
            label="Length"
            htmlFor="move_length"
            hint="Extending blocks more of the calendar; the price stays what was booked."
          >
            <Select
              id="move_length"
              value={String(duration)}
              onChange={(e) => setDuration(Number(e.target.value))}
            >
              {DURATION_CHOICES.includes(duration) ? null : (
                <option value={duration}>{durationLabel(duration)} (current)</option>
              )}
              {DURATION_CHOICES.map((m) => (
                <option key={m} value={m}>
                  {durationLabel(m)}
                </option>
              ))}
            </Select>
          </Field>

          {providers.length > 1 && (
            <Field label="Provider" htmlFor="move_provider">
              <Select
                id="move_provider"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {moveProviderName(p)}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Outside published hours
              <span className="block text-xs text-[var(--color-muted)]">
                Squeezing someone in. It still cannot land on top of another booking.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Saving…' : 'Confirm change'}
            </Button>
            <Button type="button" size="sm" variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            {/* Named, not spelled out of the enum: "pending" in a neutral chip
                reads like a payment state, and the one thing whoever is moving
                this needs to know is that the client has not been told they
                have this booking at all. */}
            {isAwaitingApproval(appointment) ? (
              <Badge tone="warning" title={PENDING_TITLE}>
                Awaiting approval
              </Badge>
            ) : (
              <Badge tone="neutral">{appointment.status.replace('_', ' ')}</Badge>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
