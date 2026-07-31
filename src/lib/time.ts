// 559 Flawless — DST-safe IANA timezone helpers.
//
// Dependency-free. Imported by the Next app AND mirrored byte-for-byte into
// supabase/functions/_shared/tz.ts, which Deno loads. If you change one, change
// the other — the booking function re-derives slots with this exact math and a
// drift between the two reintroduces the double-booking class of bug.
//
// Contract: provider_schedules.start_time, availability_blocks.start_time, and
// availability_blocks.block_date are WALL-CLOCK in the provider's IANA zone.
// Everything stored, compared, or sent to Google is an absolute instant.
// No setHours, no setDate, no toISOString().split('T')[0] anywhere.

export const MINUTE_MS = 60_000
export const DAY_MS = 86_400_000

/**
 * The clock, read once through a named door.
 *
 * Server Components legitimately need "now" (today's book, whether a signature
 * has expired), but a bare `Date.now()` in a component body is an impure call
 * during render — React's compiler lint flags it, and rightly so for anything
 * that might re-run. Routing every read through here keeps the impurity in one
 * place, makes every time-dependent page greppable, and gives tests a single
 * seam to stub.
 */
export function requestNow(): number {
  return Date.now()
}

const partsCache = new Map<string, Intl.DateTimeFormat>()

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
    partsCache.set(timeZone, f)
  }
  return f
}

export interface ZonedParts {
  year: number
  month: number // 1-12
  day: number // 1-31
  hour: number // 0-23
  minute: number
  second: number
}

/** Wall-clock fields of an instant, as observed in `timeZone`. */
export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatter(timeZone).formatToParts(instant)
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? '0')
  // en-US hour12:false renders midnight as '24' in some ICU versions
  const hour = get('hour') % 24
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  }
}

/** Offset of `timeZone` from UTC at `instant`, in ms (east of UTC is positive). */
export function timeZoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone)
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

/** 'YYYY-MM-DD' for an instant in `timeZone`. Replaces toISOString().split('T')[0]. */
export function dateKeyInTimeZone(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone)
  return `${pad(p.year, 4)}-${pad(p.month, 2)}-${pad(p.day, 2)}`
}

/** 0 = Sunday … 6 = Saturday, as observed in `timeZone`. */
export function dayOfWeekInTimeZone(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone)
  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay()
}

/**
 * Wall clock in `timeZone` -> absolute instant. DST-safe, zero dependencies.
 *
 * `dateKey` is 'YYYY-MM-DD'; `time` is 'HH:MM' or 'HH:MM:SS' (Postgres TIME).
 *
 * Guess with the offset at the naive instant, then re-resolve with the offset
 * actually in force at the guessed instant. On a DST boundary the two disagree:
 *   • spring-forward gap (the wall time never happens) -> resolves FORWARD;
 *   • fall-back overlap (it happens twice) -> resolves to the FIRST occurrence.
 */
export function zonedTimeToUtc(dateKey: string, time: string, timeZone: string): Date {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const [h, mi, s] = timeToParts(time)
  const naive = Date.UTC(y, mo - 1, d, h, mi, s)

  const o1 = timeZoneOffsetMs(new Date(naive), timeZone)
  const o2 = timeZoneOffsetMs(new Date(naive - o1), timeZone)
  if (o1 === o2) return new Date(naive - o1)

  const o3 = timeZoneOffsetMs(new Date(naive - o2), timeZone)
  if (o2 === o3) return new Date(naive - o2)

  return new Date(naive - Math.min(o2, o3))
}

/** Minutes since midnight for a Postgres TIME string. */
export function timeToMinutes(time: string): number {
  const [h, mi] = timeToParts(time)
  return h * 60 + mi
}

/** Minutes since midnight -> 'HH:MM' wall clock. */
export function minutesToTime(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440
  return `${pad(Math.floor(m / 60), 2)}:${pad(m % 60, 2)}`
}

/** Calendar-day arithmetic on the date key itself — never on an instant. */
export function addDaysToDateKey(dateKey: string, days: number): string {
  const [y, mo, d] = dateKey.split('-').map(Number)
  const t = new Date(Date.UTC(y, mo - 1, d) + days * DAY_MS)
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1, 2)}-${pad(t.getUTCDate(), 2)}`
}

/** 0 = Sunday … 6 = Saturday for a date key (already wall-clock, no zone needed). */
export function dayOfWeekForDateKey(dateKey: string): number {
  const [y, mo, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay()
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * MINUTE_MS)
}

/** e.g. '9:00 AM' — rendered in the studio's zone, not the viewer's. */
export function formatTimeInTimeZone(instant: Date, timeZone: string): string {
  return instant.toLocaleTimeString('en-US', {
    timeZone,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

/** e.g. 'Monday, March 10' — rendered in the studio's zone. */
export function formatDateInTimeZone(instant: Date, timeZone: string): string {
  return instant.toLocaleDateString('en-US', {
    timeZone,
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
}

/** e.g. 'Mon, Mar 10 · 9:00 AM' */
export function formatDateTimeInTimeZone(instant: Date, timeZone: string): string {
  const d = instant.toLocaleDateString('en-US', {
    timeZone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  })
  return `${d} · ${formatTimeInTimeZone(instant, timeZone)}`
}

/** Short zone label for UI, e.g. 'PDT'. */
export function timeZoneAbbreviation(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(instant)
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? timeZone
}

/** Human month label for a date key, e.g. 'March 2026'. */
export function monthLabelForDateKey(dateKey: string): string {
  const [y, mo] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'long',
    year: 'numeric',
  })
}

function timeToParts(time: string): [number, number, number] {
  const [h, mi, s] = time.split(':')
  return [Number(h) || 0, Number(mi) || 0, Number(s) || 0]
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0')
}
