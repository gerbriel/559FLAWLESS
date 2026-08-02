'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input } from '@/components/ui/field'
import { describeProcessing, processingWindowError } from '@/types/scheduling'

export interface SchedulableService {
  id: number
  name: string
  duration_minutes: number
  processing_start_minutes: number
  processing_minutes: number
  requires_booking_approval: boolean
}

/**
 * Processing time and review policy for one service.
 *
 * Deliberately not on the service editor: this is scheduling mechanics, and the
 * service editor is about what the treatment is and what it costs. A studio
 * setting up processing time is thinking about their day, not their menu.
 *
 * The two numbers are validated here for a readable message and again by a
 * CHECK constraint in migration 036 for the truth of it. The rule is the same
 * in both places: the window has to leave at least five minutes of real work on
 * either side, because a "gap" that starts at minute zero is not a gap.
 */
export function SchedulingServiceRules({ service }: { service: SchedulableService }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [start, setStart] = useState(String(service.processing_start_minutes))
  const [minutes, setMinutes] = useState(String(service.processing_minutes))
  const [review, setReview] = useState(service.requires_booking_approval)

  const startNum = Number(start) || 0
  const minutesNum = Number(minutes) || 0
  const problem = processingWindowError(startNum, minutesNum, service.duration_minutes)

  async function save() {
    if (problem) {
      toast.error(problem)
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('services')
      .update({
        processing_start_minutes: minutesNum === 0 ? 0 : startNum,
        processing_minutes: minutesNum,
        requires_booking_approval: review,
      })
      .eq('id', service.id)
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not save that.')
      return
    }

    toast.success('Saved.')
    setOpen(false)
    router.refresh()
  }

  return (
    <li className="py-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-sm">{service.name}</p>
          <p className="mt-1 text-xs text-[var(--color-muted)]">
            {service.duration_minutes} min ·{' '}
            {service.processing_minutes > 0
              ? `${service.processing_minutes} min free from minute ${service.processing_start_minutes}`
              : 'hands on throughout'}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {service.requires_booking_approval && <Badge tone="warning">Always reviewed</Badge>}
          {service.processing_minutes > 0 && <Badge tone="info">Processing</Badge>}
          <Button variant="subtle" size="sm" onClick={() => setOpen(!open)}>
            {open ? 'Close' : 'Edit'}
          </Button>
        </div>
      </div>

      {open && (
        <div className="mt-5 space-y-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <div>
            <p className="label-caps text-[var(--color-muted)]">Processing time</p>
            <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
              The stretch in the middle where the client is developing and you are not
              doing anything. Leave it at zero unless there genuinely is one.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <Field
              label="Free from minute"
              htmlFor={`ps_${service.id}`}
              hint="Counted from the start of this service."
            >
              <Input
                id={`ps_${service.id}`}
                type="number"
                min={0}
                max={service.duration_minutes}
                value={start}
                onChange={(e) => setStart(e.target.value)}
                disabled={minutesNum === 0}
              />
            </Field>

            <Field
              label="For how long"
              htmlFor={`pm_${service.id}`}
              hint="0 turns processing time off."
            >
              <Input
                id={`pm_${service.id}`}
                type="number"
                min={0}
                max={service.duration_minutes}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
              />
            </Field>
          </div>

          {problem ? (
            <p className="border-l-2 border-red-600 pl-3 text-sm text-red-700 dark:text-red-400">
              {problem}
            </p>
          ) : (
            <p className="border-l-2 border-[var(--color-accent)] pl-3 text-sm text-[var(--color-muted)]">
              {describeProcessing(startNum, minutesNum, service.duration_minutes)}
              {minutesNum > 0 && (
                <span className="mt-1 block">
                  The room stays booked the whole time either way. Whether the website may
                  offer that window to someone else is the studio-wide switch above.
                </span>
              )}
            </p>
          )}

          <label className="flex cursor-pointer items-start gap-3 border-t border-[var(--color-border)] pt-5 text-sm">
            <input
              type="checkbox"
              checked={review}
              onChange={(e) => setReview(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Always hold a booking for this service
              <span className="block text-[var(--color-muted)]">
                Whoever books it online, and however many times they have been here.
                Booking it for someone yourself is unaffected.
              </span>
            </span>
          </label>

          <Button size="sm" onClick={save} disabled={busy || !!problem}>
            {busy ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}
    </li>
  )
}
