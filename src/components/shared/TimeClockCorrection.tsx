'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { timeclockDb, type TimesheetEntry } from '@/types/timetracking'

/**
 * `2026-07-09T16:30:00-07:00` -> `2026-07-09T16:30`, in the studio's zone.
 *
 * `datetime-local` has no zone, so the string handed to it must already be
 * wall-clock where the shift happened — otherwise a manager in one timezone
 * edits a shift that reads differently to the person who worked it. Built from
 * Intl parts rather than slicing an ISO string, per the rule in src/lib/time.ts.
 */
function toLocalInputValue(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(iso))

  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00'
  const hour = get('hour') === '24' ? '00' : get('hour')
  return `${get('year')}-${get('month')}-${get('day')}T${hour}:${get('minute')}`
}

/**
 * The reverse: wall clock in `timeZone` -> an absolute instant.
 *
 * Same two-step resolve as `zonedTimeToUtc` in src/lib/time.ts — guess with the
 * offset at the naive instant, then re-resolve with the offset actually in
 * force there. Kept local because that helper takes a date key and a time
 * string and this has a single `datetime-local` value; the arithmetic is
 * identical and deliberately so.
 */
function fromLocalInputValue(value: string, timeZone: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!m) return null
  const [, y, mo, d, h, mi] = m
  const naive = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi))

  const offsetAt = (instant: number) => {
    const p = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    }).formatToParts(new Date(instant))
    const g = (t: string) => Number(p.find((x) => x.type === t)?.value ?? '0')
    return (
      Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second')) -
      Math.floor(instant / 1000) * 1000
    )
  }

  const o1 = offsetAt(naive)
  const o2 = offsetAt(naive - o1)
  if (o1 === o2) return new Date(naive - o1).toISOString()
  const o3 = offsetAt(naive - o2)
  if (o2 === o3) return new Date(naive - o2).toISOString()
  return new Date(naive - Math.min(o2, o3)).toISOString()
}

/**
 * A manager fixes a shift. People forget to clock out, and the alternative to
 * fixing it is a fourteen-hour phantom shift on somebody's pay.
 *
 * The reason is required by the database, not just by this form — every
 * correction lands in `time_entry_edits` with its author, its before, its
 * after, and its reason. That is what makes this safe to offer at all.
 */
export function TimeClockCorrection({
  entry,
  timeZone,
  locations,
}: {
  entry: TimesheetEntry
  timeZone: string
  locations: { id: number; name: string }[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [clockedIn, setClockedIn] = useState(() => toLocalInputValue(entry.clocked_in_at, timeZone))
  const [clockedOut, setClockedOut] = useState(() =>
    entry.clocked_out_at ? toLocalInputValue(entry.clocked_out_at, timeZone) : ''
  )
  const [locationId, setLocationId] = useState(entry.location_id)
  const [reason, setReason] = useState('')

  async function save() {
    const inIso = fromLocalInputValue(clockedIn, timeZone)
    if (!inIso) {
      toast.error('That start time is not a time.')
      return
    }

    const outIso = clockedOut ? fromLocalInputValue(clockedOut, timeZone) : null
    if (clockedOut && !outIso) {
      toast.error('That end time is not a time.')
      return
    }
    if (outIso && new Date(outIso) <= new Date(inIso)) {
      toast.error('A shift cannot end before it started.')
      return
    }
    if (reason.trim().length < 3) {
      toast.error('Say why you are changing it — it goes on the record with your name.')
      return
    }

    setBusy(true)
    const { error } = await timeclockDb(createClient()).rpc('correct_time_entry', {
      p_entry_id: entry.entry_id,
      p_clocked_in: inIso,
      p_clocked_out: outIso,
      p_reason: reason.trim(),
      p_location_id: locationId,
    })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not save that correction.')
      return
    }

    toast.success('Corrected. The change is on the record.')
    setOpen(false)
    setReason('')
    router.refresh()
  }

  if (!open) {
    return (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        Correct
      </Button>
    )
  }

  return (
    <div className="relative space-y-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left">
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
        aria-label="Close"
      >
        <X className="h-4 w-4" strokeWidth={1.5} />
      </button>

      <p className="label-caps text-[var(--color-muted)]">
        Correct {entry.staff_name ?? 'this shift'}
      </p>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Clocked in" htmlFor={`in_${entry.entry_id}`}>
          <Input
            id={`in_${entry.entry_id}`}
            type="datetime-local"
            value={clockedIn}
            onChange={(e) => setClockedIn(e.target.value)}
          />
        </Field>

        <Field
          label="Clocked out"
          htmlFor={`out_${entry.entry_id}`}
          hint={entry.is_open ? 'Still open. Set this to close it.' : undefined}
        >
          <Input
            id={`out_${entry.entry_id}`}
            type="datetime-local"
            value={clockedOut}
            onChange={(e) => setClockedOut(e.target.value)}
          />
        </Field>
      </div>

      {locations.length > 1 && (
        <Field
          label="Location"
          htmlFor={`loc_${entry.entry_id}`}
          hint="Where the shift is counted. Where they clocked out is recorded separately."
        >
          <Select
            id={`loc_${entry.entry_id}`}
            value={locationId}
            onChange={(e) => setLocationId(Number(e.target.value))}
          >
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </Select>
        </Field>
      )}

      <Field
        label="Why"
        htmlFor={`why_${entry.entry_id}`}
        hint="Recorded with your name and the time. Required."
      >
        <Textarea
          id={`why_${entry.entry_id}`}
          rows={2}
          maxLength={400}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Forgot to clock out; confirmed she left at 4:30."
        />
      </Field>

      <Button size="sm" onClick={save} disabled={busy}>
        {busy ? 'Saving…' : 'Save correction'}
      </Button>
    </div>
  )
}
