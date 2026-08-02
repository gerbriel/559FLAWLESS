/**
 * Row shapes for the resource and waitlist tables added in migration 037.
 *
 * These live here rather than in `database.ts` only because that file is being
 * regenerated; the entries belong there and this file should fold into it. Same
 * rule applies as everywhere else: `type` aliases, never `interface` — an
 * interface has no implicit index signature and so fails supabase-js's
 * `Record<string, unknown>` constraint, which silently collapses every query
 * result to `never`.
 */

// ── Resources ─────────────────────────────────────────────────

export type ResourceKind = 'room' | 'equipment'

/**
 * Anything a booking consumes besides the provider.
 *
 * `quantity` is capacity, not a flag. Two identical wax warmers run two waxes at
 * once; one runs one. That number is the reason the database needs a counting
 * check alongside the exclusion constraint — see 037.
 */
export type Resource = {
  id: number
  location_id: number
  /** The `rooms` row from 002 this stands for, if it stands for one. */
  room_id: number | null
  name: string
  kind: ResourceKind
  quantity: number
  is_active: boolean
  sort_order: number
  notes: string | null
  created_at: string
  updated_at: string
}

/** What a service consumes, and how many of it. */
export type ServiceResource = {
  service_id: number
  resource_id: number
  quantity: number
}

/**
 * A hold on a resource for the length of an appointment.
 *
 * Written only by `sync_appointment_resources`; there is no insert policy. The
 * three denormalised columns are what the guards test, because an exclusion
 * constraint is an index over one table and cannot join out to find them.
 */
export type AppointmentResource = {
  id: number
  appointment_id: string
  resource_id: number
  quantity: number
  /** `[starts_at, ends_at + buffer)` as a Postgres tstzrange literal. */
  slot: string
  is_held: boolean
  is_exclusive: boolean
  created_at: string
}

/** One row of `resource_conflicts()` — a resource standing in the way. */
export type ResourceConflict = {
  resource_id: number
  resource_name: string
  kind: ResourceKind
  capacity: number
  required: number
  peak_in_use: number
}

/** One row of `resource_busy_intervals()`, shaped like `AvailabilityInput.busy`. */
export type ResourceBusyInterval = {
  starts_at: string
  ends_at: string
}

export const RESOURCE_KIND_LABELS: Record<ResourceKind, string> = {
  room: 'Room',
  equipment: 'Equipment',
}

/**
 * How a capacity reads in a sentence.
 *
 * 0 is not "none of it exists" — it is the honest state for a steamer that is in
 * for repair, and it correctly makes every service needing it unbookable.
 */
export function describeCapacity(quantity: number): string {
  if (quantity === 0) return 'Out of service'
  if (quantity === 1) return 'One at a time'
  return `${quantity} at a time`
}

// ── Waitlist ──────────────────────────────────────────────────

export type WaitlistStatus =
  | 'waiting'
  | 'notified'
  | 'converted'
  | 'expired'
  | 'cancelled'

/**
 * Someone who wanted a time that was not free.
 *
 * Dates and times are WALL-CLOCK in the location's zone, the same rule
 * `provider_schedules.start_time` follows. "Saturday mornings" is something a
 * person means locally; it is not an instant, and it is never stored as one.
 */
export type WaitlistEntry = {
  id: string
  location_id: number
  client_id: string
  preferred_provider_id: string | null
  /** 'YYYY-MM-DD', local to the location. */
  earliest_date: string
  latest_date: string
  /** 0 = Sunday, matching `provider_schedules.day_of_week`. Empty = any day. */
  days_of_week: number[]
  /** 'HH:MM:SS', local to the location. Null = any time. */
  earliest_time: string | null
  latest_time: string | null
  note: string | null
  status: WaitlistStatus
  created_at: string
  notified_at: string | null
  /** Until this instant, nobody else is told about the slot they were offered. */
  claim_expires_at: string | null
  offers_sent: number
  last_offer_appointment_id: string | null
  expires_at: string | null
  converted_appointment_id: string | null
  updated_at: string
}

export type WaitlistServiceLink = {
  entry_id: string
  service_id: number
}

/** The single-row policy table behind the fairness rule. */
export type WaitlistSettings = {
  id: number
  auto_notify: boolean
  /** 1 is strict first-come, first-served. */
  batch_size: number
  claim_window_minutes: number
  /** Inside this many hours of the slot, everyone matching is told at once. */
  urgent_within_hours: number
  max_offers_per_entry: number
  default_expiry_days: number
  urgent_max_recipients: number
  updated_at: string
}

/** One row of `waitlist_matches()`. */
export type WaitlistMatch = {
  entry_id: string
  client_id: string
  client_name: string | null
  waiting_since: string
  status: WaitlistStatus
  offers_sent: number
}

export const WAITLIST_STATUS_LABELS: Record<WaitlistStatus, string> = {
  waiting: 'Waiting',
  notified: 'Offered',
  converted: 'Booked',
  expired: 'Expired',
  cancelled: 'Withdrawn',
}

export const WAITLIST_STATUS_TONES: Record<
  WaitlistStatus,
  'neutral' | 'accent' | 'success' | 'warning' | 'info'
> = {
  waiting: 'neutral',
  notified: 'accent',
  converted: 'success',
  expired: 'warning',
  cancelled: 'neutral',
}

/** 0 = Sunday, so the array index is the stored value. */
export const DAY_NAMES = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const

export const DAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const

/** "Saturdays and Sundays", or null when they will take any day. */
export function describeDays(days: number[]): string | null {
  if (days.length === 0 || days.length === 7) return null
  const names = [...days].sort((a, b) => a - b).map((d) => `${DAY_NAMES[d]}s`)
  if (names.length === 1) return names[0]
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** '14:30:00' → '2:30 PM'. Wall-clock in, wall-clock out — no zone involved. */
export function formatWallTime(time: string | null): string | null {
  if (!time) return null
  const [h, m] = time.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  const suffix = h < 12 ? 'AM' : 'PM'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`
}

/** "9:00 AM – 12:00 PM", "From 2:00 PM", "Until 11:00 AM", or null for any time. */
export function describeTimeWindow(
  earliest: string | null,
  latest: string | null
): string | null {
  const from = formatWallTime(earliest)
  const to = formatWallTime(latest)
  if (from && to) return `${from} – ${to}`
  if (from) return `From ${from}`
  if (to) return `Until ${to}`
  return null
}

/**
 * "Sep 1", or "Sep 1 – Sep 30".
 *
 * Built from the key's own parts and rendered in UTC, the same way
 * `dayLabelForDateKey` does it: a date key is already a calendar day, and
 * reinterpreting it through a timezone is how you end up showing the day before.
 */
export function formatDateKeyShort(dateKey: string): string {
  const [y, mo, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
  })
}

export function describeDateRange(earliest: string, latest: string): string {
  const from = formatDateKeyShort(earliest)
  return earliest === latest ? from : `${from} – ${formatDateKeyShort(latest)}`
}

/**
 * Minutes left on a claim, or null when there is no live claim.
 *
 * Takes `now` rather than reading the clock, so a Server Component can pass
 * `requestNow()` through and a Client Component can pass its own tick.
 */
export function claimMinutesLeft(
  claimExpiresAt: string | null,
  now: number
): number | null {
  if (!claimExpiresAt) return null
  const left = Math.round((new Date(claimExpiresAt).getTime() - now) / 60_000)
  return left > 0 ? left : null
}
