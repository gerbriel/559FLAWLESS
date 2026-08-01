import {
  dayOfWeekForDateKey,
  timeToMinutes,
  dateKeyInTimeZone,
  zonedTimeToUtc,
} from '@/lib/time'

/**
 * Turning "why can't anyone book this?" into something you can look at.
 *
 * The availability engine already knows all of this — it just subtracts it and
 * shows what is left. For staff the subtraction itself is the useful part: an
 * empty Tuesday afternoon could be a closure, a dentist appointment, or hours
 * that were never set, and those need different reactions.
 */

export interface ProviderSchedule {
  provider_id: string
  day_of_week: number
  start_time: string
  end_time: string
  is_active: boolean
}

export interface AvailabilityBlockRow {
  id: number
  provider_id: string
  block_date: string
  start_time: string | null
  end_time: string | null
  reason: string | null
}

export interface CalendarBusyRow {
  id: number
  provider_id: string
  starts_at: string
  ends_at: string
  summary: string | null
}

export interface ClosureRow {
  closure_date: string
  reason: string
}

export type BlockKind = 'closed' | 'off_hours' | 'blocked' | 'external'

export interface BlockedSpan {
  kind: BlockKind
  /** Minutes from midnight, in the studio's zone. */
  startMinutes: number
  endMinutes: number
  label: string
}

export const BLOCK_LABELS: Record<BlockKind, string> = {
  closed: 'Studio closed',
  off_hours: 'Outside working hours',
  blocked: 'Time off',
  external: 'Busy in your calendar',
}

/** Tailwind classes per kind. Off-hours is the quietest — it is the default state. */
export const BLOCK_STYLES: Record<BlockKind, string> = {
  closed: 'bg-red-500/10 border-red-500/30',
  off_hours: 'bg-[var(--color-border)]/40 border-transparent',
  blocked: 'bg-amber-500/15 border-amber-500/35',
  external: 'bg-[var(--color-accent)]/12 border-[var(--color-accent)]/30',
}

const DAY_START = 0
const DAY_END = 24 * 60

/**
 * Every reason a given day is unavailable, as spans of minutes past midnight.
 *
 * `providerId` narrows to one person's calendar. With none given — the "all
 * providers" view — only studio-wide closures are returned, because an hour
 * one esthetician has off is not an hour the studio is shut.
 */
export function blockedSpansForDay(
  dateKey: string,
  timezone: string,
  opts: {
    providerId?: string | null
    schedules: ProviderSchedule[]
    blocks: AvailabilityBlockRow[]
    busy: CalendarBusyRow[]
    closures: ClosureRow[]
  }
): BlockedSpan[] {
  const spans: BlockedSpan[] = []

  // A studio closure covers the whole day and makes everything else moot.
  const closure = opts.closures.find((c) => c.closure_date === dateKey)
  if (closure) {
    return [
      {
        kind: 'closed',
        startMinutes: DAY_START,
        endMinutes: DAY_END,
        label: closure.reason || BLOCK_LABELS.closed,
      },
    ]
  }

  if (!opts.providerId) return spans

  // ── Outside working hours ──
  // The gaps around this provider's shifts for this weekday. No shift at all
  // means the whole day is off — which is the answer to "why is Sunday empty".
  const dow = dayOfWeekForDateKey(dateKey)
  const shifts = opts.schedules
    .filter((s) => s.provider_id === opts.providerId && s.day_of_week === dow && s.is_active)
    .map((s) => ({ start: timeToMinutes(s.start_time), end: timeToMinutes(s.end_time) }))
    .sort((a, b) => a.start - b.start)

  if (shifts.length === 0) {
    spans.push({
      kind: 'off_hours',
      startMinutes: DAY_START,
      endMinutes: DAY_END,
      label: 'Not working this day',
    })
  } else {
    let cursor = DAY_START
    for (const shift of shifts) {
      if (shift.start > cursor) {
        spans.push({
          kind: 'off_hours',
          startMinutes: cursor,
          endMinutes: shift.start,
          label: BLOCK_LABELS.off_hours,
        })
      }
      cursor = Math.max(cursor, shift.end)
    }
    if (cursor < DAY_END) {
      spans.push({
        kind: 'off_hours',
        startMinutes: cursor,
        endMinutes: DAY_END,
        label: BLOCK_LABELS.off_hours,
      })
    }
  }

  // ── Time off entered in the app ──
  for (const b of opts.blocks) {
    if (b.provider_id !== opts.providerId || b.block_date !== dateKey) continue
    spans.push({
      kind: 'blocked',
      // Null start/end means the whole day.
      startMinutes: b.start_time ? timeToMinutes(b.start_time) : DAY_START,
      endMinutes: b.end_time ? timeToMinutes(b.end_time) : DAY_END,
      label: b.reason || BLOCK_LABELS.blocked,
    })
  }

  // ── Busy time pulled from Google ──
  for (const e of opts.busy) {
    if (e.provider_id !== opts.providerId) continue

    // These are absolute instants, so they are clipped to the studio's day
    // rather than assumed to sit inside it — an overnight event should shade
    // the morning of the following day, not wrap around to negative minutes.
    const start = new Date(e.starts_at)
    const end = new Date(e.ends_at)
    const startsToday = dateKeyInTimeZone(start, timezone) === dateKey
    const endsToday = dateKeyInTimeZone(end, timezone) === dateKey
    // Midnight-to-midnight for this calendar day, resolved through the same
    // DST-aware helper the booking engine uses. A multi-day event covers today
    // without starting or ending on it.
    const from = zonedTimeToUtc(dateKey, '00:00', timezone)
    const to = new Date(from.getTime() + 86_400_000)
    const spansToday = start < to && end > from
    if (!spansToday) continue

    spans.push({
      kind: 'external',
      startMinutes: startsToday ? minutesIntoDay(start, timezone) : DAY_START,
      endMinutes: endsToday ? minutesIntoDay(end, timezone) : DAY_END,
      label: e.summary || BLOCK_LABELS.external,
    })
  }

  return spans.filter((s) => s.endMinutes > s.startMinutes)
}

/** Minutes past midnight for an instant, read in the studio's zone. */
function minutesIntoDay(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant)
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0)
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
  // Intl renders midnight as 24 in some locales' hourCycle.
  return (h % 24) * 60 + m
}

/** Does an hour-long row overlap any blocked span? Used to shade the day grid. */
export function spansOverlappingHour(spans: BlockedSpan[], hour: number): BlockedSpan[] {
  const from = hour * 60
  const to = from + 60
  return spans.filter((s) => s.startMinutes < to && s.endMinutes > from)
}

/** "9:00 AM – 11:30 AM" for a span, for the tooltip and the summary line. */
export function formatSpan(span: BlockedSpan): string {
  if (span.startMinutes === DAY_START && span.endMinutes === DAY_END) return 'All day'
  return `${formatMinutes(span.startMinutes)} – ${formatMinutes(span.endMinutes)}`
}

function formatMinutes(total: number): string {
  const h24 = Math.floor(total / 60)
  const m = total % 60
  const suffix = h24 >= 12 ? 'PM' : 'AM'
  const h = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h}:${String(m).padStart(2, '0')} ${suffix}`
}
