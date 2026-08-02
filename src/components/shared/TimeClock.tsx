'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Coffee, LogIn, LogOut, Square } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/field'
import { requestNow } from '@/lib/time'
import {
  timeclockDb,
  formatMinutes,
  elapsedMinutesSince,
  type BreakType,
  type TimeClockState,
} from '@/types/timetracking'

export type TimeClockLocation = {
  id: number
  name: string
}

/**
 * Clock in, take a break, clock out. One tap for the common case.
 *
 * Every button is an RPC, not a table write: `clock_in` and `clock_out` are
 * SECURITY DEFINER and stamp `now()` themselves. That is the point — RLS grants
 * direct writes on `time_entries` to managers only, so there is no path here
 * that lets someone set their own start time to three hours ago.
 *
 * The elapsed counter is presentational. It ticks off the browser clock and is
 * never what gets recorded; the shift's real length is the difference between
 * two server-stamped instants, computed in the database.
 */
export function TimeClock({
  initial,
  breakTypes,
  locations,
  compact = false,
}: {
  initial: TimeClockState
  breakTypes: BreakType[]
  locations: TimeClockLocation[]
  /** Chrome-sized: one line, no location picker unless it is needed. */
  compact?: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [, startTransition] = useTransition()

  const [locationId, setLocationId] = useState<number>(
    initial.entry?.location_id ?? locations[0]?.id ?? 0
  )
  const [breakTypeId, setBreakTypeId] = useState<number>(breakTypes[0]?.id ?? 0)

  // Ticks the elapsed counter. requestNow() rather than a bare Date.now() even
  // here — the lazy initialiser runs during render, which is exactly the read
  // the named seam exists for (see AGENTS.md on the clock).
  const [now, setNow] = useState(() => requestNow())
  useEffect(() => {
    const t = setInterval(() => setNow(requestNow()), 30_000)
    return () => clearInterval(t)
  }, [])

  const entry = initial.entry
  const openBreak = initial.openBreak
  const onTheClock = entry !== null

  async function call(fn: string, args: Record<string, unknown>, success: string) {
    setBusy(true)
    const { error } = await timeclockDb(createClient()).rpc(fn, args)
    setBusy(false)

    if (error) {
      // The database's messages are already written for the person reading
      // them ("You are already clocked in", "End the Lunch break first"), so
      // pass them through rather than inventing a worse one.
      toast.error(error.message || 'That did not go through.')
      // Whatever we believed about their state was wrong; re-read it.
      startTransition(() => router.refresh())
      return
    }

    toast.success(success)
    startTransition(() => router.refresh())
  }

  const elapsed = entry ? elapsedMinutesSince(entry.clocked_in_at, now) : 0
  const breakElapsed = openBreak ? elapsedMinutesSince(openBreak.started_at, now) : 0
  const multiSite = locations.length > 1
  const currentLocation = locations.find((l) => l.id === entry?.location_id)

  return (
    <div
      className={
        compact
          ? 'flex flex-wrap items-center gap-3'
          : 'border border-[var(--color-border)] bg-[var(--color-surface)] p-6'
      }
    >
      {!compact && (
        <p className="label-caps mb-4 text-[var(--color-muted)]">Time clock</p>
      )}

      <div className={compact ? 'flex flex-wrap items-center gap-3' : 'space-y-5'}>
        {/* ── Status ── */}
        <div className={compact ? 'flex items-baseline gap-2' : ''}>
          {onTheClock ? (
            <>
              <span className="flex items-center gap-2 text-sm">
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 bg-[var(--color-accent)]"
                />
                {openBreak ? (
                  <span>
                    On a {openBreak.name_snapshot.toLowerCase()} break —{' '}
                    <span className="tabular-nums">{formatMinutes(breakElapsed)}</span>
                    {!openBreak.is_paid_snapshot && (
                      <span className="text-[var(--color-muted)]"> (unpaid)</span>
                    )}
                  </span>
                ) : (
                  <span>
                    On the clock — <span className="tabular-nums">{formatMinutes(elapsed)}</span>
                    {multiSite && currentLocation && (
                      <span className="text-[var(--color-muted)]"> at {currentLocation.name}</span>
                    )}
                  </span>
                )}
              </span>
            </>
          ) : (
            <span className="text-sm text-[var(--color-muted)]">Not clocked in.</span>
          )}
        </div>

        {/* ── Actions ── */}
        <div className="flex flex-wrap items-center gap-2">
          {!onTheClock && (
            <>
              {multiSite && (
                <Select
                  aria-label="Location"
                  className="h-11 w-auto sm:h-9"
                  value={locationId}
                  onChange={(e) => setLocationId(Number(e.target.value))}
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </Select>
              )}
              <Button
                size="sm"
                disabled={busy}
                onClick={() =>
                  call('clock_in', { p_location_id: locationId || null }, 'Clocked in.')
                }
              >
                <LogIn className="h-3.5 w-3.5" strokeWidth={2} />
                Clock in
              </Button>
            </>
          )}

          {onTheClock && openBreak && (
            // The primary action while a break is running. The database refuses
            // a clock-out with an open break rather than inventing an end for
            // it, so this is the way out.
            <Button size="sm" disabled={busy} onClick={() => call('end_break', {}, 'Break ended.')}>
              <Square className="h-3.5 w-3.5" strokeWidth={2} />
              End break
            </Button>
          )}

          {onTheClock && !openBreak && (
            <>
              {breakTypes.length > 0 && (
                <>
                  <Select
                    aria-label="Break"
                    className="h-11 w-auto sm:h-9"
                    value={breakTypeId}
                    onChange={(e) => setBreakTypeId(Number(e.target.value))}
                  >
                    {breakTypes.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                        {b.default_minutes ? ` · ${b.default_minutes} min` : ''}
                        {b.is_paid ? ' · paid' : ' · unpaid'}
                      </option>
                    ))}
                  </Select>
                  <Button
                    size="sm"
                    variant="subtle"
                    disabled={busy || !breakTypeId}
                    onClick={() =>
                      call('start_break', { p_break_type_id: breakTypeId }, 'Break started.')
                    }
                  >
                    <Coffee className="h-3.5 w-3.5" strokeWidth={2} />
                    Break
                  </Button>
                </>
              )}

              {multiSite && (
                <Select
                  aria-label="Clocking out at"
                  className="h-11 w-auto sm:h-9"
                  value={locationId}
                  onChange={(e) => setLocationId(Number(e.target.value))}
                >
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.id === entry?.location_id ? l.name : `Leaving from ${l.name}`}
                    </option>
                  ))}
                </Select>
              )}

              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() =>
                  call(
                    'clock_out',
                    { p_location_id: multiSite ? locationId || null : null },
                    'Clocked out.'
                  )
                }
              >
                <LogOut className="h-3.5 w-3.5" strokeWidth={2} />
                Clock out
              </Button>
            </>
          )}
        </div>

        {!compact && !onTheClock && breakTypes.length > 0 && (
          <p className="text-xs text-[var(--color-muted)]">
            {breakTypes
              .filter((b) => !b.is_paid)
              .map((b) => b.name)
              .join(' and ') || 'Unpaid breaks'}{' '}
            come off your hours. Paid breaks do not.
          </p>
        )}
      </div>
    </div>
  )
}
