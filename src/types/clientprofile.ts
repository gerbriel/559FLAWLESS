/**
 * Row shapes for migration 039 — client bans, photo documentation, and the
 * unified client timeline.
 *
 * These live here rather than in `src/types/database.ts` only because that file
 * is being edited concurrently. They are `type` aliases, never `interface`:
 * an interface has no implicit index signature and so fails supabase-js's
 * `Record<string, unknown>` constraint, which silently collapses every query
 * result to `never`. Fold them into database.ts when it is next regenerated —
 * the exact `Tables` / `Views` entries are listed at the bottom of 039.
 */

// ── Banning ───────────────────────────────────────────────────

export type ClientBan = {
  id: number
  client_id: string
  /** Where the decision was made. Always a real site — scope is the next field. */
  location_id: number
  /** True = every site. False = only `location_id`. */
  applies_studio_wide: boolean
  /** Staff-facing only. Never rendered on a client-facing surface. */
  reason: string
  banned_by: string | null
  banned_at: string
  /** Null = until somebody lifts it. */
  expires_at: string | null
  lifted_at: string | null
  lifted_by: string | null
  lift_reason: string | null
  created_at: string
  updated_at: string
}

/** A ban row with the two profiles the panel shows names for. */
export type ClientBanWithActors = ClientBan & {
  banned_by_profile: { first_name: string | null; last_name: string | null } | null
  lifted_by_profile: { first_name: string | null; last_name: string | null } | null
  locations: { name: string } | null
}

/**
 * Is this ban stopping a booking right now?
 *
 * The same three clauses as `public.client_is_banned` in 039. The SQL copy is
 * what actually refuses the insert; this one exists to render a badge.
 */
export function banIsLive(ban: Pick<ClientBan, 'lifted_at' | 'expires_at'>, now: number): boolean {
  if (ban.lifted_at) return false
  if (ban.expires_at && new Date(ban.expires_at).getTime() <= now) return false
  return true
}

/**
 * What a declined client is told.
 *
 * Not "you are banned", and not the reason somebody wrote about them — that is
 * a staff note. A decline plus a phone number leaves room for the conversation
 * that might actually resolve it, and does not hand a stranger a transcript of
 * what the studio thinks of them.
 *
 * `src/lib/booking.ts` owns BOOKING_ERROR_MESSAGES; this is the copy to add
 * there under the `client_banned` key.
 */
export const BANNED_BOOKING_MESSAGE =
  'We are not able to book this one online. Please call the studio and we will take it from there.'

// ── Photo documentation ───────────────────────────────────────

export type PhotoPhase = 'before' | 'after' | 'progress'

/** One row of `public.appointment_photo_prompts`. */
export type AppointmentPhotoPrompt = {
  appointment_id: string
  client_id: string
  provider_id: string
  location_id: number
  starts_at: string
  status: string
  photo_documented: boolean
  /** Any service on the visit is intimate, by the service flag or its category. */
  intimate: boolean
  documented_services: string | null
  followup_days: number
  before_count: number
  after_count: number
  progress_count: number
  /** Blanket release, plus the separate intimate consent where §6 requires it. */
  consent_ok: boolean
  /** Null unless a photograph is due AND consent permits it. */
  photo_due: PhotoPhase | null
}

/** One row of `public.client_photo_status`. */
export type ClientPhotoStatus = {
  client_id: string
  photo_release_at: string | null
  photo_release_revoked_at: string | null
  photo_release_ok: boolean
  intimate_consent_ok: boolean
  documented_visits: number
  visits_with_photos: number
  photo_count: number
  before_count: number
  after_count: number
  progress_count: number
  last_photo_at: string | null
  followup_service: string | null
  followup_visit_at: string | null
  /** Null when consent does not permit a photograph — the gate is in SQL. */
  followup_due_at: string | null
  followup_overdue: boolean
}

export type TreatmentPhotoRow = {
  id: number
  appointment_id: string | null
  storage_path: string
  phase: PhotoPhase
  body_area: string | null
  taken_at: string
  notes: string | null
  deletion_requested_at: string | null
}

/** A photo row paired with the short-lived signed URL minted for it server-side. */
export type SignedTreatmentPhoto = TreatmentPhotoRow & { signedUrl: string | null }

// ── Timeline ──────────────────────────────────────────────────

export type TimelineKind =
  | 'appointment'
  | 'purchase'
  | 'payment'
  | 'note'
  | 'consent'
  | 'intake'
  | 'photo'
  | 'patch_test'
  | 'ban'
  | 'ban_lifted'

/**
 * One row of `public.client_timeline`.
 *
 * `ref` is text because the ids being unioned are not one type — an appointment
 * is a uuid, an order is a bigint. Pair it with `kind` to build a link.
 */
export type ClientTimelineEntry = {
  client_id: string
  occurred_at: string
  kind: TimelineKind
  ref: string
  title: string
  detail: string | null
  amount_cents: number | null
  status: string | null
  /** Null on rows that belong to the business rather than to a building. */
  location_id: number | null
}

// ── Derived profile numbers ───────────────────────────────────
//
// All of these read `client_records`, whose counters `client_record_sync_stats`
// (005) already maintains from `appointments`. Nothing here re-aggregates the
// appointment table — that would be a second copy of the same sum, free to
// drift.

export type ClientRecordStats = {
  visit_count: number
  no_show_count: number
  cancel_count: number
  lifetime_value_cents: number
  first_visit_at: string | null
  last_visit_at: string | null
}

/** Average days between completed visits. Null until there are two of them. */
export function visitCadenceDays(r: ClientRecordStats): number | null {
  if (r.visit_count < 2 || !r.first_visit_at || !r.last_visit_at) return null
  const span = new Date(r.last_visit_at).getTime() - new Date(r.first_visit_at).getTime()
  if (span <= 0) return null
  return Math.round(span / 86_400_000 / (r.visit_count - 1))
}

/**
 * Share of kept-or-missed bookings the client did not turn up to.
 *
 * Cancellations are excluded from the denominator on purpose: cancelling is the
 * behaviour the studio wants, and counting it against someone would make the
 * considerate client and the one who simply vanished look alike.
 */
export function noShowRatePct(r: ClientRecordStats): number | null {
  const attended = r.visit_count + r.no_show_count
  if (attended === 0) return null
  return Math.round((100 * r.no_show_count) / attended)
}

/** Integer cents throughout — no float ever touches a price. */
export function averageTicketCents(r: ClientRecordStats): number | null {
  if (r.visit_count === 0) return null
  return Math.round(r.lifetime_value_cents / r.visit_count)
}
