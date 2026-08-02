/**
 * Slot generation — the single source of truth for "is this time bookable".
 *
 * Mirrored into supabase/functions/_shared/availability.ts, which the
 * booking-create function uses to RE-DERIVE the requested slot server-side.
 * The browser's chosen time is only ever *matched* against this output, never
 * believed. Keep the two files in step.
 */

import {
  addDaysToDateKey,
  dayOfWeekForDateKey,
  minutesToTime,
  timeToMinutes,
  zonedTimeToUtc,
  MINUTE_MS,
} from './time'

export interface Interval {
  start: number
  end: number
}

/** The one overlap test in the system. Half-open: touching is not overlapping. */
export function overlaps(a: Interval, b: Interval): boolean {
  return a.start < b.end && a.end > b.start
}

export interface ScheduleRow {
  day_of_week: number
  start_time: string
  end_time: string
  slot_interval_minutes: number
}

export interface BlockRow {
  block_date: string
  start_time: string | null
  end_time: string | null
}

export interface BusyRow {
  starts_at: string
  ends_at: string
  /**
   * A stretch in the middle of someone else's appointment where the PROVIDER
   * is free and the ROOM is not — hair colour developing, a peel sitting.
   * Emitted by the `provider_busy_segments` RPC (migration 036).
   *
   * Ignored unless `allowProcessingOverlap` is on, so a busy list that never
   * sets it behaves exactly as it always has.
   */
  is_processing?: boolean | null
}

export interface AvailabilityInput {
  /** Provider's IANA zone. All wall-clock rows below are read in this zone. */
  timeZone: string
  schedules: ScheduleRow[]
  blocks: BlockRow[]
  /** 'YYYY-MM-DD' studio closure dates. */
  closures: string[]
  /** Existing appointments and cached external calendar busy time. */
  busy: BusyRow[]
  /** Total minutes the slot must occupy, service duration + buffer. */
  durationMinutes: number
  bufferMinutes: number
  /** Earliest bookable instant, from booking_settings.min_lead_minutes. */
  minLeadMinutes: number
  maxAdvanceDays: number
  /** Injected so callers control "now" and tests stay deterministic. */
  now: Date

  /**
   * ── Scheduling mechanics (migration 036) ───────────────────
   *
   * Every field below is optional and every default is a no-op. A caller that
   * sets none of them gets the slot list this module produced before they
   * existed — that is the contract, and there is a test for it.
   *
   * Read from `provider_scheduling_config(provider, location)`.
   */

  /**
   * Idle the studio wants either side of a booking, in minutes.
   * Measured against other appointments only, never against the open or close
   * of the working window: a 9am booking on a 9am open is not a gap violation.
   */
  minGapMinutes?: number
  /**
   * The other direction — keep the day compact. On a day that already has
   * something in it, an offered slot has to sit within this many minutes of the
   * nearest booking. Null or undefined = no ceiling. An empty day is unaffected;
   * the rule is about not scattering, and there is nothing yet to scatter from.
   */
  maxGapMinutes?: number | null
  /**
   * Don't leave a fifteen-minute orphan. A slot that would strand a free
   * stretch shorter than this — against a neighbouring appointment OR against
   * the edge of the working window — is not offered. 0 = off.
   */
  minFragmentMinutes?: number
  /**
   * Offer the processing gap inside someone else's appointment. Off by
   * default and deliberately so: freeing the provider only helps if there is
   * somewhere else for the second client to sit.
   */
  allowProcessingOverlap?: boolean
}

export interface DaySlots {
  dateKey: string
  slots: Date[]
}

/**
 * The occupied intervals immediately either side of a candidate, or null where
 * there is nothing on that side. Null means "the working window", not "zero" —
 * the two rules that care about the difference need to tell them apart.
 */
function neighbours(
  candidate: Interval,
  occupied: Interval[]
): { prevEnd: number | null; nextStart: number | null } {
  let prevEnd: number | null = null
  let nextStart: number | null = null

  for (const o of occupied) {
    if (o.end <= candidate.start && (prevEnd === null || o.end > prevEnd)) prevEnd = o.end
    if (o.start >= candidate.end && (nextStart === null || o.start < nextStart)) {
      nextStart = o.start
    }
  }

  return { prevEnd, nextStart }
}

/**
 * Every open start time in [fromDateKey, fromDateKey + days), as absolute
 * instants. A slot is open when the provider works then, the whole
 * service + buffer fits inside that working window, and nothing already
 * occupies any part of it.
 */
export function generateSlots(
  input: AvailabilityInput,
  fromDateKey: string,
  days: number
): DaySlots[] {
  const {
    timeZone,
    schedules,
    blocks,
    closures,
    busy,
    durationMinutes,
    bufferMinutes,
    minLeadMinutes,
    maxAdvanceDays,
    now,
  } = input

  const totalMinutes = durationMinutes + bufferMinutes
  const earliest = now.getTime() + minLeadMinutes * MINUTE_MS
  const latest = now.getTime() + maxAdvanceDays * 86_400_000

  const minGap = Math.max(0, input.minGapMinutes ?? 0)
  const maxGap = input.maxGapMinutes ?? null
  const minFragment = Math.max(0, input.minFragmentMinutes ?? 0)
  const allowProcessingOverlap = input.allowProcessingOverlap === true
  // One flag so the untouched-studio path stays the untouched-studio path:
  // no neighbour scan, no window-edge arithmetic, nothing.
  const gapRulesActive = minGap > 0 || maxGap !== null || minFragment > 0

  const closureSet = new Set(closures)

  // Pre-resolve occupied intervals once rather than per candidate slot.
  // A processing segment blocks the room, so it only comes out of the list when
  // the studio has said it has somewhere else to put the second client.
  const occupied: Interval[] = busy
    .filter((b) => !(allowProcessingOverlap && b.is_processing === true))
    .map((b) => ({
      start: new Date(b.starts_at).getTime(),
      end: new Date(b.ends_at).getTime(),
    }))

  const result: DaySlots[] = []

  for (let i = 0; i < days; i++) {
    const dateKey = addDaysToDateKey(fromDateKey, i)
    if (closureSet.has(dateKey)) {
      result.push({ dateKey, slots: [] })
      continue
    }

    const dow = dayOfWeekForDateKey(dateKey)
    const working = schedules.filter((s) => s.day_of_week === dow)
    if (working.length === 0) {
      result.push({ dateKey, slots: [] })
      continue
    }

    // Day-specific blocks, resolved to instants. A block with null times
    // covers the whole day.
    const dayBlocks: Interval[] = []
    let fullDayBlocked = false
    for (const b of blocks) {
      if (b.block_date !== dateKey) continue
      if (b.start_time == null || b.end_time == null) {
        fullDayBlocked = true
        break
      }
      dayBlocks.push({
        start: zonedTimeToUtc(dateKey, b.start_time, timeZone).getTime(),
        end: zonedTimeToUtc(dateKey, b.end_time, timeZone).getTime(),
      })
    }
    if (fullDayBlocked) {
      result.push({ dateKey, slots: [] })
      continue
    }

    const slots: Date[] = []

    for (const window of working) {
      const openMin = timeToMinutes(window.start_time)
      const closeMin = timeToMinutes(window.end_time)
      const step = Math.max(5, window.slot_interval_minutes)

      // The edges of this working window, as instants. Only the fragment rule
      // reads them, so they are only resolved when a rule is switched on.
      // A close of 24:00 is midnight on the NEXT day, not midnight on this one.
      const windowOpenMs = gapRulesActive
        ? zonedTimeToUtc(dateKey, minutesToTime(openMin), timeZone).getTime()
        : 0
      const windowCloseMs = gapRulesActive
        ? closeMin < 1440
          ? zonedTimeToUtc(dateKey, minutesToTime(closeMin), timeZone).getTime()
          : zonedTimeToUtc(
              addDaysToDateKey(dateKey, 1),
              minutesToTime(closeMin - 1440),
              timeZone
            ).getTime()
        : 0

      // The last start that still lets the whole service finish before close.
      for (let m = openMin; m + totalMinutes <= closeMin; m += step) {
        const start = zonedTimeToUtc(dateKey, minutesToTime(m), timeZone)
        const startMs = start.getTime()
        const endMs = startMs + totalMinutes * MINUTE_MS

        if (startMs < earliest || startMs > latest) continue

        const candidate: Interval = { start: startMs, end: endMs }
        if (dayBlocks.some((b) => overlaps(candidate, b))) continue
        if (occupied.some((o) => overlaps(candidate, o))) continue

        if (gapRulesActive) {
          const { prevEnd, nextStart } = neighbours(candidate, occupied)

          // Minimum gap: against real appointments only.
          if (minGap > 0) {
            if (prevEnd !== null && startMs - prevEnd < minGap * MINUTE_MS) continue
            if (nextStart !== null && nextStart - endMs < minGap * MINUTE_MS) continue
          }

          // No orphans: a free stretch is either nothing at all or big enough
          // to sell. Measured against the window edge too — the fifteen minutes
          // before opening is exactly the fragment nobody can book.
          if (minFragment > 0) {
            const before = startMs - (prevEnd ?? windowOpenMs)
            const after = (nextStart ?? windowCloseMs) - endMs
            if (before > 0 && before < minFragment * MINUTE_MS) continue
            if (after > 0 && after < minFragment * MINUTE_MS) continue
          }

          // Keep the day compact — but only once there is a day to keep
          // compact. With nothing booked yet, every time is as good as any.
          if (maxGap !== null && (prevEnd !== null || nextStart !== null)) {
            const before = prevEnd !== null ? startMs - prevEnd : Infinity
            const after = nextStart !== null ? nextStart - endMs : Infinity
            if (Math.min(before, after) > maxGap * MINUTE_MS) continue
          }
        }

        slots.push(start)
      }
    }

    // Overlapping schedule windows can emit the same start twice.
    const unique = Array.from(new Set(slots.map((s) => s.getTime())))
      .sort((a, b) => a - b)
      .map((t) => new Date(t))

    result.push({ dateKey, slots: unique })
  }

  return result
}

/**
 * Is `requested` one of the slots this provider is actually offering?
 * The booking function's authoritative check — an exact instant match against
 * regenerated availability, never a range test on client-supplied bounds.
 */
export function isSlotOffered(
  input: AvailabilityInput,
  requested: Date,
  dateKey: string
): boolean {
  const [day] = generateSlots(input, dateKey, 1)
  if (!day) return false
  return day.slots.some((s) => s.getTime() === requested.getTime())
}
