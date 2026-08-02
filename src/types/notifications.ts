/**
 * Client notification types — migration 038.
 *
 * Row shapes are `type` aliases, never `interface`: an interface has no
 * implicit index signature, so it fails supabase-js's `Record<string, unknown>`
 * constraint and every query using it silently collapses to `never`.
 *
 * These mirror what must be added to `src/types/database.ts` under
 * `Tables` and `Functions`. Until that merge lands, import the row shapes from
 * here.
 */

export type NotificationKind =
  | 'booking_confirmation'
  | 'appointment_reminder'
  | 'appointment_changed'
  | 'appointment_cancelled'
  | 'waitlist_opening'
  | 'rebooking_nudge'
  | 'intake_outstanding'
  | 'patch_test_due'

export type NotificationChannel = 'in_app' | 'email' | 'sms'
export type NotificationCategory = 'transactional' | 'marketing'
export type NotificationAnchor = 'appointment_start' | 'appointment_end' | 'last_visit'
export type NotificationSubject = 'appointment' | 'client' | 'waitlist_entry'
export type NotificationQueueStatus = 'pending' | 'sent' | 'skipped' | 'failed'

export type NotificationTemplate = {
  id: number
  location_id: number
  kind: NotificationKind
  channel: NotificationChannel
  title_template: string
  body_template: string
  link_template: string | null
  opens_thread: boolean
  is_active: boolean
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type NotificationSchedule = {
  id: number
  location_id: number
  kind: NotificationKind
  label: string
  anchor: NotificationAnchor
  /** Signed minutes from the anchor. Negative is before, positive is after. */
  offset_minutes: number
  /** 'HH:MM:SS' wall clock in the location's zone, or null to keep it an exact offset. */
  send_at_local: string | null
  service_id: number | null
  category_id: number | null
  is_active: boolean
  created_at: string
  updated_at: string
}

export type NotificationQueueItem = {
  id: number
  location_id: number
  schedule_id: number | null
  template_id: number | null
  kind: NotificationKind
  category: NotificationCategory
  channel: NotificationChannel
  recipient_id: string
  subject_type: NotificationSubject
  subject_id: string
  appointment_id: string | null
  scheduled_for: string
  title: string
  body: string | null
  link: string | null
  status: NotificationQueueStatus
  attempts: number
  sent_at: string | null
  notification_id: number | null
  thread_id: string | null
  skipped_reason: string | null
  last_error: string | null
  created_at: string
}

/** What `dispatch_notifications()` reports back. */
export type DispatchSummary = {
  materialised: number
  sent: number
  skipped: number
  failed: number
  /** Queued for a channel this deployment has no sender for yet. */
  awaiting_sender: number
}

// ── Presentation ──────────────────────────────────────────────

export const NOTIFICATION_KINDS: NotificationKind[] = [
  'booking_confirmation',
  'appointment_reminder',
  'appointment_changed',
  'appointment_cancelled',
  'waitlist_opening',
  'rebooking_nudge',
  'intake_outstanding',
  'patch_test_due',
]

export const KIND_LABELS: Record<NotificationKind, string> = {
  booking_confirmation: 'Booking confirmation',
  appointment_reminder: 'Appointment reminder',
  appointment_changed: 'Appointment rescheduled',
  appointment_cancelled: 'Appointment cancelled',
  waitlist_opening: 'Waitlist opening',
  rebooking_nudge: 'Rebooking nudge',
  intake_outstanding: 'Forms outstanding',
  patch_test_due: 'Patch test needed',
}

export const KIND_DESCRIPTIONS: Record<NotificationKind, string> = {
  booking_confirmation: 'Sent the moment a booking is made, once the services are on it.',
  appointment_reminder: 'Sent ahead of the visit, on the schedule you set below.',
  appointment_changed: 'Sent when an appointment moves to a different time.',
  appointment_cancelled: 'Sent when the studio cancels. A client cancelling their own is not told twice.',
  waitlist_opening: 'Sent when a slot someone was waiting for comes free.',
  rebooking_nudge: 'Sent to a client who has not been back and has nothing booked.',
  intake_outstanding: 'Sent when forms are still outstanding before a visit.',
  patch_test_due: 'Sent when a booked treatment needs a patch test first.',
}

/**
 * Which side of consent law each kind sits on. Mirrors
 * `public.notification_kind_category()` — the database is authoritative and
 * forces this onto every queue row; this copy only decides what the UI says.
 */
export const KIND_CATEGORY: Record<NotificationKind, NotificationCategory> = {
  booking_confirmation: 'transactional',
  appointment_reminder: 'transactional',
  appointment_changed: 'transactional',
  appointment_cancelled: 'transactional',
  waitlist_opening: 'transactional',
  rebooking_nudge: 'marketing',
  intake_outstanding: 'transactional',
  patch_test_due: 'transactional',
}

/** Which kinds are driven by a schedule rather than by an event. */
export const SCHEDULED_KINDS: NotificationKind[] = [
  'appointment_reminder',
  'intake_outstanding',
  'patch_test_due',
  'rebooking_nudge',
]

export const ANCHOR_LABELS: Record<NotificationAnchor, string> = {
  appointment_start: 'the appointment starts',
  appointment_end: 'the appointment ends',
  last_visit: 'their last visit ended',
}

/**
 * The exact placeholder set. Documented on
 * `public.render_notification_template()`; anything not on this list is left in
 * the message verbatim rather than blanked or rejected.
 */
export const PLACEHOLDERS: { token: string; describes: string }[] = [
  { token: 'client_first_name', describes: 'First name, or “there” if we only have a guest booking' },
  { token: 'client_last_name', describes: 'Surname' },
  { token: 'client_name', describes: 'Both names' },
  { token: 'service', describes: 'What they are booked for' },
  { token: 'provider', describes: 'Who is treating them' },
  { token: 'when', describes: 'Date and time, e.g. “Monday, March 9 at 9:00 AM”' },
  { token: 'date', describes: 'Date only' },
  { token: 'time', describes: 'Time only' },
  { token: 'last_visit', describes: 'The visit being followed up' },
  { token: 'location', describes: 'Studio name' },
  { token: 'location_address', describes: 'Street, city, state' },
  { token: 'location_phone', describes: 'The number to call' },
  { token: 'cancellation_reason', describes: 'What was given, if anything' },
  { token: 'appointment_link', describes: 'Their own page for that appointment' },
]

/**
 * "1 day and 2 hours before the appointment starts" from a signed minute
 * offset. Written out rather than shown as a number because -60480 is not a
 * quantity anyone reads correctly.
 */
export function describeOffset(minutes: number, anchor: NotificationAnchor): string {
  const magnitude = Math.abs(minutes)
  const direction = minutes < 0 ? 'before' : 'after'

  const weeks = Math.floor(magnitude / 10080)
  const days = Math.floor((magnitude % 10080) / 1440)
  const hours = Math.floor((magnitude % 1440) / 60)
  const mins = magnitude % 60

  const parts: string[] = []
  if (weeks) parts.push(`${weeks} week${weeks === 1 ? '' : 's'}`)
  if (days) parts.push(`${days} day${days === 1 ? '' : 's'}`)
  if (hours) parts.push(`${hours} hour${hours === 1 ? '' : 's'}`)
  if (mins) parts.push(`${mins} minute${mins === 1 ? '' : 's'}`)
  if (parts.length === 0) parts.push('0 minutes')

  return `${parts.join(' ')} ${direction} ${ANCHOR_LABELS[anchor]}`
}

/** 'HH:MM:SS' (or 'HH:MM') from Postgres → '10:00 AM'. */
export function formatLocalSendTime(time: string | null): string | null {
  if (!time) return null
  const [h, m] = time.split(':').map(Number)
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null
  const suffix = h < 12 ? 'AM' : 'PM'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return `${hour12}:${String(m).padStart(2, '0')} ${suffix}`
}
