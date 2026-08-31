'use server'

/**
 * The in-chair upsell (067): the client came in for a facial, the provider
 * talked them into the paired Brazilian, and it goes onto TODAY's appointment
 * at the pair price — no new booking, no retyping, no hand-applied discount.
 *
 * Everything here runs as the signed-in staff member, not the service role.
 * RLS is doing the actual work: a provider can insert lines only on their own
 * appointment (067), front desk and up on any (004), and the appointment
 * update that stretches `ends_at` rides the same policies. The role check at
 * the top exists to give a sentence back instead of an empty result set.
 *
 * The price is read from the database and cut by the same `pairDiscountCents`
 * the booking engine uses — the caller names WHICH appointment and WHICH
 * service, and nothing else. Same reasoning as `priceService()`.
 *
 * The window is the day of the visit, deliberately. This is "while they are in
 * the chair", not a voucher — a client who leaves and comes back next week
 * books the service at its ordinary price, or pairs it with their next facial.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { bestPairDiscount, pairDiscountCents, type PairDiscountRule } from '@/lib/pair-discounts'
import { dateKeyInTimeZone, requestNow } from '@/lib/time'
import { isFrontDesk, isStaff, type UserRole } from '@/types/database'

const STUDIO_TZ = 'America/Los_Angeles'

export type PairUpsellError =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'not_today'
  | 'not_open'
  | 'already_on_visit'
  | 'no_pair'
  | 'not_offered'
  | 'age_confirmation_required'
  | 'no_room'
  | 'failed'

export type PairUpsellOutcome =
  | { ok: true; name: string; priceCents: number; fullPriceCents: number }
  | { ok: false; error: PairUpsellError }

const fail = (error: PairUpsellError): { ok: false; error: PairUpsellError } => ({
  ok: false,
  error,
})

/** Staff-facing copy for each refusal. */
export const PAIR_UPSELL_ERROR_MESSAGES: Record<PairUpsellError, string> = {
  unauthorized: 'You are signed out. Sign in and try again.',
  forbidden: 'Only staff can add a service to an appointment.',
  not_found: 'That appointment could not be loaded.',
  not_today: 'The pair deal is added on the day of the visit. For another day, book it.',
  not_open: 'This appointment is not in a state a service can be added to.',
  already_on_visit: 'That service is already on this visit.',
  no_pair: 'Nothing on this visit pairs with that service.',
  not_offered: 'This provider does not offer that service.',
  age_confirmation_required: 'Confirm the client is of age before adding this service.',
  no_room: 'The calendar has no room to extend this appointment. Adjust the schedule first.',
  failed: 'The service could not be added. Please try again.',
}

/**
 * Add a pair-deal service to an existing appointment at its discounted price.
 *
 * `ageConfirmed` is the staff member attesting they verified the client's age
 * in person — required when the service demands it and the visit has no
 * attestation yet, exactly parallel to the checkbox a client ticks online.
 */
export async function addPairedService(
  appointmentId: string,
  serviceId: number,
  ageConfirmed: boolean
): Promise<PairUpsellOutcome> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return fail('unauthorized')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'client') as UserRole
  if (profile?.suspended_at || !isStaff(role)) return fail('forbidden')

  // RLS narrows this: a provider only ever gets their own appointment back, so
  // "not yours" and "does not exist" are the same honest answer.
  const { data: appointment } = await supabase
    .from('appointments')
    .select(
      'id, provider_id, status, starts_at, ends_at, age_attested_at, appointment_services(id, service_id, sort_order)'
    )
    .eq('id', appointmentId)
    .maybeSingle()

  if (!appointment) return fail('not_found')
  if (!isFrontDesk(role) && appointment.provider_id !== user.id) return fail('forbidden')

  if (!['confirmed', 'checked_in', 'completed'].includes(appointment.status)) {
    return fail('not_open')
  }

  const now = requestNow()
  if (
    dateKeyInTimeZone(new Date(appointment.starts_at), STUDIO_TZ) !==
    dateKeyInTimeZone(new Date(now), STUDIO_TZ)
  ) {
    return fail('not_today')
  }

  const lines = (appointment.appointment_services ?? []) as {
    id: number
    service_id: number | null
    sort_order: number
  }[]
  if (lines.some((l) => l.service_id === serviceId)) return fail('already_on_visit')

  const visitServiceIds = lines
    .map((l) => l.service_id)
    .filter((id): id is number => id !== null)

  const [{ data: rules }, { data: service }, { data: link }] = await Promise.all([
    supabase
      .from('service_pair_discounts')
      .select('id, trigger_service_id, discounted_service_id, percent_off, label')
      .eq('is_active', true)
      .eq('discounted_service_id', serviceId),
    supabase
      .from('services')
      .select('id, name, price_cents, duration_minutes, is_active, requires_age_verification')
      .eq('id', serviceId)
      .maybeSingle(),
    supabase
      .from('provider_services')
      .select('price_cents, duration_minutes, is_active')
      .eq('provider_id', appointment.provider_id)
      .eq('service_id', serviceId)
      .maybeSingle(),
  ])

  const rule = bestPairDiscount((rules ?? []) as PairDiscountRule[], visitServiceIds, serviceId)
  if (!rule) return fail('no_pair')
  if (!service?.is_active) return fail('not_found')
  if (!link?.is_active) return fail('not_offered')

  // Per-provider override wins, then the deal comes off — half off means half
  // of what this provider actually charges. Same order as priceService().
  const fullPriceCents = link.price_cents ?? service.price_cents
  const durationMinutes = link.duration_minutes ?? service.duration_minutes
  const off = pairDiscountCents(fullPriceCents, rule.percent_off)
  const priceCents = fullPriceCents - off

  const needsAge = service.requires_age_verification && !appointment.age_attested_at
  if (needsAge && !ageConfirmed) return fail('age_confirmation_required')

  // A visit still under way gets longer; a completed one is history and its
  // window stays put — the wax happened inside whatever time it happened in.
  const extend = appointment.status !== 'completed'
  const newEndsAt = new Date(
    new Date(appointment.ends_at).getTime() + durationMinutes * 60_000
  ).toISOString()

  if (extend || needsAge) {
    const { error: updateError } = await supabase
      .from('appointments')
      .update({
        ...(extend ? { ends_at: newEndsAt } : {}),
        ...(needsAge ? { age_attested_at: new Date(now).toISOString() } : {}),
      })
      .eq('id', appointmentId)

    if (updateError) {
      // 23P01: the exclusion constraint — the next slot is taken.
      return fail(updateError.code === '23P01' ? 'no_room' : 'failed')
    }
  }

  const { error: lineError } = await supabase.from('appointment_services').insert({
    appointment_id: appointmentId,
    service_id: serviceId,
    name_snapshot: service.name,
    price_cents: priceCents,
    duration_minutes: durationMinutes,
    full_price_cents: fullPriceCents,
    pair_discount_id: rule.id,
    added_by: user.id,
    added_at: new Date(now).toISOString(),
    sort_order: Math.max(-1, ...lines.map((l) => l.sort_order)) + 1,
  })

  if (lineError) {
    // Put the window back rather than leave a stretched appointment with no
    // line to show for it. Best effort — the failure the client sees is real
    // either way.
    if (extend) {
      await supabase
        .from('appointments')
        .update({ ends_at: appointment.ends_at })
        .eq('id', appointmentId)
    }
    return fail('failed')
  }

  revalidatePath(`/dashboard/appointments/${appointmentId}`)
  return { ok: true, name: service.name, priceCents, fullPriceCents }
}
