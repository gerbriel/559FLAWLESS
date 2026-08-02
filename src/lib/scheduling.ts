/**
 * Server-side bridge between the scheduling configuration in the database
 * (migration 036) and the pure slot generator in `src/lib/availability.ts`.
 *
 * It lives here rather than in availability.ts on purpose: that module is
 * dependency-free and mirrored into a Deno runtime, and giving it a Supabase
 * import would end that. Everything here reads; nothing here decides.
 *
 * The two functions below are the whole surface `src/lib/booking.ts` needs:
 *
 *   const config = await loadSchedulingConfig(providerId)
 *   const busy   = await loadBusySegments(providerId, from, to)
 *
 * both of which degrade to the pre-036 behaviour if the migration has not been
 * applied — the config falls back to every rule off, and the segments fall back
 * to the plain appointment windows. That is not defensive padding: ten agents
 * are shipping migrations into this database at once and a booking page that
 * 500s because one of them has not landed yet is a worse failure than a booking
 * page that is slightly less clever for an hour.
 */

import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import type { AvailabilityInput, BusyRow } from '@/lib/availability'
import { MINUTE_MS } from '@/lib/time'
import type { SchedulingConfig } from '@/types/scheduling'

/** Every rule off — what an untouched studio gets, and the fallback. */
export const NO_SCHEDULING_RULES: Omit<SchedulingConfig, 'location_id'> = {
  min_gap_minutes: 0,
  max_gap_minutes: null,
  min_fragment_minutes: 0,
  allow_processing_overlap: false,
}

/**
 * The gap rules in force for a provider: their own row where they have set one,
 * the site policy underneath, off underneath that. Resolved by the database so
 * the settings page and the booking page can never disagree about the answer.
 */
export async function loadSchedulingConfig(
  providerId: string,
  locationId?: number | null
): Promise<Omit<SchedulingConfig, 'location_id'>> {
  const supabase = createAdminClient()

  const { data, error } = await supabase.rpc('provider_scheduling_config', {
    p_provider: providerId,
    p_location: locationId ?? null,
  })

  if (error || !data) return NO_SCHEDULING_RULES

  const row = Array.isArray(data) ? data[0] : data
  if (!row) return NO_SCHEDULING_RULES

  return {
    min_gap_minutes: row.min_gap_minutes ?? 0,
    max_gap_minutes: row.max_gap_minutes ?? null,
    min_fragment_minutes: row.min_fragment_minutes ?? 0,
    allow_processing_overlap: row.allow_processing_overlap ?? false,
  }
}

/**
 * Everything occupying a provider between two instants, one row per segment.
 *
 * A processing gap comes back as its own row flagged `is_processing`, because
 * it blocks the room even where it does not block the provider. Slot generation
 * only drops those rows when the studio has switched processing overlap on.
 *
 * Replaces the two hand-rolled queries in `loadAvailability` — appointments
 * plus their buffer, and cached calendar busy time. The RPC covers both, and
 * covers the buffer correctly, because it reads the same `slot` column the
 * exclusion constraint reads rather than re-deriving it in TypeScript.
 */
export async function loadBusySegments(
  providerId: string,
  fromIso: string,
  toIso: string
): Promise<BusyRow[] | null> {
  const supabase = createAdminClient()

  const { data, error } = await supabase.rpc('provider_busy_segments', {
    p_provider: providerId,
    p_from: fromIso,
    p_to: toIso,
  })

  if (error || !data) return null

  return data.map((s) => ({
    starts_at: s.starts_at,
    ends_at: s.ends_at,
    is_processing: s.is_processing,
  }))
}

/** The pre-036 shape of a busy row: window plus its own turnover buffer. */
export function busyFromAppointments(
  rows: { starts_at: string; ends_at: string; buffer_minutes: number | null }[]
): BusyRow[] {
  return rows.map((a) => ({
    starts_at: a.starts_at,
    ends_at: new Date(
      new Date(a.ends_at).getTime() + (a.buffer_minutes ?? 0) * MINUTE_MS
    ).toISOString(),
  }))
}

/**
 * Fold a resolved config into an availability input.
 *
 * One line at the end of `loadAvailability`, so there is one place where the
 * database's answer becomes the slot generator's question.
 */
export function withSchedulingConfig(
  input: AvailabilityInput,
  config: Omit<SchedulingConfig, 'location_id'>
): AvailabilityInput {
  return {
    ...input,
    minGapMinutes: config.min_gap_minutes,
    maxGapMinutes: config.max_gap_minutes,
    minFragmentMinutes: config.min_fragment_minutes,
    allowProcessingOverlap: config.allow_processing_overlap,
  }
}

/**
 * Does this booking need a person to look at it before it is confirmed?
 *
 * `src/lib/booking.ts` should call this before it inserts, so the status it
 * hands the browser is the status the booking will actually have. The triggers
 * in 036 enforce the same rules whatever path the row comes in by — this is
 * about telling the client the truth the first time, not about enforcement.
 */
export async function bookingReviewReason(opts: {
  clientId: string | null
  email: string | null
  phone: string | null
  serviceIds: number[]
  locationId?: number | null
}): Promise<string | null> {
  const supabase = createAdminClient()

  const { data, error } = await supabase.rpc('booking_review_reason', {
    p_client_id: opts.clientId,
    p_guest_email: opts.email,
    p_guest_phone: opts.phone,
    p_service_ids: opts.serviceIds,
    p_location_id: opts.locationId ?? null,
  })

  // A failure here must not block a booking. The triggers still hold it if it
  // needs holding; the client just sees "confirmed" a moment before the queue
  // corrects it, which is the same thing that happens without this call at all.
  if (error) return null
  return (data as string | null) ?? null
}
