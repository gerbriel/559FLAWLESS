'use client'

import { useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { cn } from '@/lib/utils'
import { addDaysToDateKey, dateKeyInTimeZone } from '@/lib/time'
import { DAY_INITIALS, DAY_NAMES } from '@/types/resources'

export interface WaitlistServiceOption {
  id: number
  name: string
}

export interface WaitlistProviderOption {
  id: string
  display_name: string
}

/**
 * "Take my name" — for the moment the calendar has nothing to offer.
 *
 * Deliberately standalone rather than a step inside the booking flow. Someone
 * reaching this has already been told no; the last thing they need is a fifth
 * step and a progress rail. It opens closed, asks for the least it can, and
 * writes through `join_waitlist`, which is the only path that can guarantee an
 * entry arrives with its services attached.
 *
 * What is NOT asked for: a time. They are here because the times did not work.
 * A day range and a rough part of the day is the honest shape of "let me know",
 * and it is exactly what the matcher compares a freed slot against.
 */
export function WaitlistJoin({
  services,
  providers = [],
  selectedServiceIds = [],
  preferredProviderId = null,
  timeZone,
  fromDateKey,
  locationId = null,
  className,
}: {
  /** Everything bookable, so they can widen beyond what they were looking at. */
  services: WaitlistServiceOption[]
  providers?: WaitlistProviderOption[]
  /** What they had chosen when the calendar came back empty. */
  selectedServiceIds?: number[]
  preferredProviderId?: string | null
  /** The location's zone — used only to work out what "today" is. */
  timeZone: string
  /** 'YYYY-MM-DD' of the week they were looking at, if there was one. */
  fromDateKey?: string
  locationId?: number | null
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [joined, setJoined] = useState(false)

  // Initialisers, not an effect: this is the starting state, not a reaction to
  // something changing.
  const [chosen, setChosen] = useState<number[]>(() =>
    selectedServiceIds.length > 0 ? selectedServiceIds : []
  )
  const [providerId, setProviderId] = useState<string>(preferredProviderId ?? '')
  const [earliest, setEarliest] = useState(
    () => fromDateKey ?? dateKeyInTimeZone(new Date(), timeZone)
  )
  const [latest, setLatest] = useState(() =>
    addDaysToDateKey(fromDateKey ?? dateKeyInTimeZone(new Date(), timeZone), 28)
  )
  const [days, setDays] = useState<number[]>([])
  const [earliestTime, setEarliestTime] = useState('')
  const [latestTime, setLatestTime] = useState('')
  const [note, setNote] = useState('')

  const today = dateKeyInTimeZone(new Date(), timeZone)

  function toggleService(id: number) {
    setChosen((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id]))
  }

  function toggleDay(day: number) {
    setDays((cur) => (cur.includes(day) ? cur.filter((d) => d !== day) : [...cur, day]))
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (chosen.length === 0) {
      setError('Choose at least one service so we know what to watch for.')
      return
    }
    if (latest < earliest) {
      setError('The last date needs to be on or after the first.')
      return
    }
    if (earliestTime && latestTime && latestTime <= earliestTime) {
      setError('The end of your time window needs to be after the start.')
      return
    }

    setBusy(true)
    const { error: rpcError } = await createClient().rpc('join_waitlist', {
      p_service_ids: chosen,
      p_earliest_date: earliest,
      p_latest_date: latest,
      p_provider_id: providerId || null,
      p_days_of_week: days,
      p_earliest_time: earliestTime || null,
      p_latest_time: latestTime || null,
      p_note: note.trim() || null,
      p_location_id: locationId,
    })
    setBusy(false)

    if (rpcError) {
      // join_waitlist raises with a sentence meant for the person reading it.
      setError(rpcError.message || 'We could not add you to the list. Please try again.')
      return
    }

    setJoined(true)
  }

  if (joined) {
    return (
      <div
        className={cn(
          'border border-[var(--color-border)] bg-[var(--color-surface)] p-8',
          className
        )}
      >
        <div className="flex items-start gap-4">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--color-accent)]">
            <Check className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.5} />
          </span>
          <div>
            <p className="display text-2xl">You&rsquo;re on the list.</p>
            <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
              If something opens up that fits, we will message you here and hold it
              while you decide. Longest wait goes first, so you keep your place —
              there is nothing to refresh and nobody to beat.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (!open) {
    return (
      <div
        className={cn(
          'border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-6 dark:bg-[var(--color-surface)]',
          className
        )}
      >
        <p className="label-caps mb-3 text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]">
          Nothing open?
        </p>
        <p className="mb-5 text-sm leading-relaxed text-[var(--color-muted)]">
          Cancellations happen most weeks. Tell us roughly when you would come in and
          we will message you the moment something frees up — first asked, first
          offered.
        </p>
        <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
          Join the waitlist
        </Button>
      </div>
    )
  }

  return (
    <form
      onSubmit={submit}
      className={cn(
        'border border-[var(--color-border)] bg-[var(--color-surface)] p-6 sm:p-8',
        className
      )}
    >
      <p className="label-caps mb-2 text-[var(--color-accent)]">Waitlist</p>
      <h3 className="display text-2xl">Tell us when you could come in.</h3>
      <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
        The wider you can be, the sooner something will fit. Nothing here books you
        in — we will message you first.
      </p>

      <div className="mt-8 space-y-7">
        <div>
          <p className="label-caps mb-3 text-[var(--color-muted)]">
            What are you waiting for?
          </p>
          <div className="grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2">
            {services.map((s) => {
              const on = chosen.includes(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggleService(s.id)}
                  className={cn(
                    'flex items-center gap-2.5 p-4 text-left text-sm transition-colors',
                    on
                      ? 'bg-[var(--color-clay-soft)] dark:bg-[var(--color-background)]'
                      : 'bg-[var(--color-surface)] hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)]'
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      'flex h-4 w-4 shrink-0 items-center justify-center border',
                      on
                        ? 'border-[var(--color-accent)] bg-[var(--color-accent)]'
                        : 'border-[var(--color-border)]'
                    )}
                  >
                    {on && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
                  </span>
                  {s.name}
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field label="From" htmlFor="wl_from">
            <Input
              id="wl_from"
              type="date"
              required
              min={today}
              value={earliest}
              onChange={(e) => setEarliest(e.target.value)}
            />
          </Field>
          <Field label="Until" htmlFor="wl_to" hint="We will keep watching until then.">
            <Input
              id="wl_to"
              type="date"
              required
              min={earliest}
              value={latest}
              onChange={(e) => setLatest(e.target.value)}
            />
          </Field>
        </div>

        <div>
          <p className="label-caps mb-1 text-[var(--color-muted)]">Which days suit?</p>
          <p className="mb-3 text-xs text-[var(--color-muted)]">
            Leave them all off if any day works.
          </p>
          <div className="flex flex-wrap gap-px border border-[var(--color-border)] bg-[var(--color-border)]">
            {DAY_INITIALS.map((initial, day) => {
              const on = days.includes(day)
              return (
                <button
                  key={day}
                  type="button"
                  aria-pressed={on}
                  aria-label={DAY_NAMES[day]}
                  onClick={() => toggleDay(day)}
                  className={cn(
                    'h-11 flex-1 min-w-11 text-sm transition-colors',
                    on
                      ? 'bg-[var(--color-accent)] text-white'
                      : 'bg-[var(--color-surface)] hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)]'
                  )}
                >
                  {initial}
                </button>
              )
            })}
          </div>
        </div>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field
            label="No earlier than"
            htmlFor="wl_time_from"
            hint="Optional. Leave blank for any time."
          >
            <Input
              id="wl_time_from"
              type="time"
              value={earliestTime}
              onChange={(e) => setEarliestTime(e.target.value)}
            />
          </Field>
          <Field label="No later than" htmlFor="wl_time_to" hint="Optional.">
            <Input
              id="wl_time_to"
              type="time"
              value={latestTime}
              onChange={(e) => setLatestTime(e.target.value)}
            />
          </Field>
        </div>

        {providers.length > 1 && (
          <Field
            label="Anyone in particular?"
            htmlFor="wl_provider"
            hint="Naming someone means you will only hear about their openings."
          >
            <Select
              id="wl_provider"
              value={providerId}
              onChange={(e) => setProviderId(e.target.value)}
            >
              <option value="">Whoever is free</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.display_name}
                </option>
              ))}
            </Select>
          </Field>
        )}

        <Field
          label="Anything else?"
          htmlFor="wl_note"
          hint="Short notice is fine, weekends only, that sort of thing."
        >
          <Textarea
            id="wl_note"
            maxLength={500}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
      </div>

      {error && (
        <p className="mt-6 border border-red-600/40 bg-red-50 p-4 text-sm text-red-800 dark:bg-transparent dark:text-red-400">
          {error}
        </p>
      )}

      <div className="mt-8 flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={busy}>
          {busy ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" strokeWidth={2} />
              Adding you…
            </>
          ) : (
            'Add me to the list'
          )}
        </Button>
        <Button type="button" variant="ghost" className="px-0" onClick={() => setOpen(false)}>
          Never mind
        </Button>
      </div>
    </form>
  )
}
