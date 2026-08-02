/**
 * Row shapes and copy for the scheduling mechanics added in migration 036.
 *
 * These live here rather than in `src/types/database.ts` only because that file
 * is regenerated wholesale; the entries it needs are listed at the bottom of
 * this file so the next `supabase gen types` run has something to check against.
 *
 * Row shapes are `type` aliases, never `interface`. An interface has no implicit
 * index signature, which fails supabase-js's `Record<string, unknown>`
 * constraint and silently collapses every query result to `never`.
 */

/** Why a booking is sitting in the approval queue. */
export type BookingReviewReason =
  | 'studio_policy'
  | 'service_policy'
  | 'first_visit'
  | 'no_show_history'

/**
 * Plain-language copy for the queue. The database has its own copy of this in
 * `booking_review_label()` for the notification body — the two say the same
 * thing because a staff member reading the bell and the same staff member
 * reading the queue should not have to work out that they match.
 */
export const REVIEW_REASON_LABELS: Record<BookingReviewReason, string> = {
  studio_policy: 'Every online booking is held for review',
  service_policy: 'This service is always reviewed',
  first_visit: 'First visit',
  no_show_history: 'Missed appointments on record',
}

export function reviewReasonLabel(reason: string | null): string {
  if (reason && reason in REVIEW_REASON_LABELS) {
    return REVIEW_REASON_LABELS[reason as BookingReviewReason]
  }
  return 'Held for review'
}

/** Per-site booking mechanics. One row per location. */
export type SchedulingPolicy = {
  location_id: number
  require_approval_new_client: boolean
  /** N or more no-shows on record sends the next booking to review. 0 = never. */
  no_show_threshold: number
  default_min_gap_minutes: number
  default_max_gap_minutes: number | null
  default_min_fragment_minutes: number
  allow_processing_overlap: boolean
  updated_at: string
}

/**
 * One provider's gap rules at one site. Every field falls back to the site
 * policy when null, and the site policy falls back to off — so an absent row
 * means "whatever the studio said", not "no rules".
 */
export type ProviderSchedulingSettings = {
  provider_id: string
  location_id: number
  min_gap_minutes: number
  max_gap_minutes: number | null
  min_fragment_minutes: number
  allow_processing_overlap: boolean | null
  updated_at: string
}

/** The resolved answer: what `provider_scheduling_config()` returns. */
export type SchedulingConfig = {
  location_id: number
  min_gap_minutes: number
  max_gap_minutes: number | null
  min_fragment_minutes: number
  allow_processing_overlap: boolean
}

/** One segment of a provider's day, from `provider_busy_segments()`. */
export type BusySegment = {
  starts_at: string
  ends_at: string
  /** True where the provider is free but the room is not. */
  is_processing: boolean
}

/** The 036 columns on `services`. */
export type ServiceSchedulingFields = {
  processing_start_minutes: number
  processing_minutes: number
  requires_booking_approval: boolean
}

/** The 036 columns on `appointments`. */
export type AppointmentSchedulingFields = {
  /** Minute offsets from starts_at where the provider is free. */
  processing_windows: string
  /** Provider active time. Written by a trigger; never by the application. */
  provider_slot: string
  allows_overlap: boolean
  overlap_reason: string | null
  overlap_authorized_by: string | null
  approval_reason: string | null
}

/**
 * The gap presets a studio actually chooses between. Offered as a list for the
 * same reason the notice period is: "45" is a number, "three quarters of an
 * hour" is a decision.
 */
export const GAP_PRESETS: { minutes: number; label: string }[] = [
  { minutes: 0, label: 'None — back to back is fine' },
  { minutes: 5, label: '5 minutes' },
  { minutes: 10, label: '10 minutes' },
  { minutes: 15, label: '15 minutes' },
  { minutes: 20, label: '20 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 45, label: '45 minutes' },
  { minutes: 60, label: '1 hour' },
]

export const MAX_GAP_PRESETS: { minutes: number | null; label: string }[] = [
  { minutes: null, label: 'No limit — spread the day out' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 60, label: '1 hour' },
  { minutes: 90, label: '1 hour 30' },
  { minutes: 120, label: '2 hours' },
  { minutes: 240, label: '4 hours' },
]

export const FRAGMENT_PRESETS: { minutes: number; label: string }[] = [
  { minutes: 0, label: 'Off — leave any gap' },
  { minutes: 15, label: '15 minutes' },
  { minutes: 20, label: '20 minutes' },
  { minutes: 30, label: '30 minutes' },
  { minutes: 45, label: '45 minutes' },
  { minutes: 60, label: '1 hour' },
]

/** '1 hour 30' rather than '90 minutes', for anything over an hour. */
export function formatMinutes(minutes: number): string {
  if (minutes === 0) return 'none'
  if (minutes < 60) return `${minutes} min`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  const hours = `${h} hour${h === 1 ? '' : 's'}`
  return m === 0 ? hours : `${hours} ${m}`
}

/**
 * What a service's processing window means in words, for the settings page.
 * Mirrors the CHECK in migration 036: the window has to leave at least five
 * minutes of real work on either side of it.
 */
export function describeProcessing(
  startMinutes: number,
  minutes: number,
  durationMinutes: number
): string {
  if (minutes <= 0) return 'The provider is with the client throughout.'
  return (
    `Hands on for the first ${startMinutes} min, free from ${startMinutes} to ` +
    `${startMinutes + minutes} min, then back for the last ` +
    `${durationMinutes - startMinutes - minutes} min.`
  )
}

export function processingWindowError(
  startMinutes: number,
  minutes: number,
  durationMinutes: number
): string | null {
  if (minutes === 0) return null
  if (startMinutes < 5) return 'Processing has to start at least 5 minutes in.'
  if (startMinutes + minutes > durationMinutes - 5) {
    return `It has to finish at least 5 minutes before the end of a ${durationMinutes}-minute service.`
  }
  return null
}

/* ────────────────────────────────────────────────────────────
 * FOR src/types/database.ts — the entries migration 036 adds.
 * Reproduced here as a checklist; see the agent report for the
 * literal Tables/Functions blocks to paste in.
 *
 *   Tables:    scheduling_policies, provider_scheduling_settings
 *   Columns:   services.processing_start_minutes,
 *              services.processing_minutes,
 *              services.requires_booking_approval,
 *              appointments.processing_windows,
 *              appointments.provider_slot,
 *              appointments.allows_overlap,
 *              appointments.overlap_reason,
 *              appointments.overlap_authorized_by,
 *              appointments.approval_reason
 *   Functions: provider_scheduling_config, provider_busy_segments,
 *              provider_home_location_id, booking_review_reason,
 *              booking_review_label
 * ──────────────────────────────────────────────────────────── */
