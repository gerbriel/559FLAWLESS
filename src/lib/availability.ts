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
}

export interface DaySlots {
  dateKey: string
  slots: Date[]
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

  const closureSet = new Set(closures)

  // Pre-resolve occupied intervals once rather than per candidate slot.
  const occupied: Interval[] = busy.map((b) => ({
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

      // The last start that still lets the whole service finish before close.
      for (let m = openMin; m + totalMinutes <= closeMin; m += step) {
        const start = zonedTimeToUtc(dateKey, minutesToTime(m), timeZone)
        const startMs = start.getTime()
        const endMs = startMs + totalMinutes * MINUTE_MS

        if (startMs < earliest || startMs > latest) continue

        const candidate: Interval = { start: startMs, end: endMs }
        if (dayBlocks.some((b) => overlaps(candidate, b))) continue
        if (occupied.some((o) => overlaps(candidate, o))) continue

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
