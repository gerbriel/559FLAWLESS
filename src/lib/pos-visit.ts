/**
 * A visit rung up at the till.
 *
 * A service sold at the counter is not an order: it is a visit that just
 * happened. So this writes what the rest of the system already understands:
 * a completed appointment, timed now, with the service lines priced by the
 * same priceService() every booking uses (per-provider overrides, pair deals
 * and sales included). Completing it draws down back-bar stock; loyalty,
 * referral settlement, commissions and every report follow with no special
 * cases.
 *
 * The appointment takes the overlap escape hatch (036): the client is
 * standing at the counter, so whatever the calendar says about this exact
 * minute is already settled in the room. Staff-authorised, reasoned, and
 * impossible for the public path by table CHECK.
 *
 * Two callers. /api/pos/service-sale rings up services alone and lets this
 * write the payment row too. /api/pos/sale rings up services with products in
 * one payment, so it asks for the visit unpaid and records the money itself,
 * once it knows the products went through as well.
 *
 * The caller has already authenticated and authorised the staff member and
 * hands in its own service-role client; this module never makes one.
 */

import 'server-only'
import type { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log-error'
import { priceService } from '@/lib/booking'
import { applyMembershipBenefit } from '@/lib/memberships'

type Admin = ReturnType<typeof createAdminClient>

export type PosPaymentMethod =
  | 'cash'
  | 'card'
  | 'apple_pay'
  | 'zelle'
  | 'paypal'
  | 'venmo'
  | 'cashapp'
  | 'other'

export interface PosVisit {
  appointmentId: string
  /** The priced lines, in the order they were rung up. */
  lines: { serviceId: number; name: string; priceCents: number }[]
  subtotalCents: number
  /** The manual discount this visit actually took, integer cents. Never more than it owed. */
  discountCents: number
  /** Included sessions plus member prices and percentage, integer cents. */
  membershipCents: number
  membershipName: string | null
  /** What the visit owes after membership and discount. */
  totalCents: number
}

export type PosVisitOutcome =
  | { ok: true; visit: PosVisit }
  | { ok: false; status: number; error: string; message: string }

/** Whose book a till visit lands in: the bookable provider, the owner in the room. */
async function tillProviderId(admin: Admin): Promise<string | null> {
  const { data: providers } = await admin
    .from('profiles')
    .select('id')
    .neq('role', 'client')
    .is('suspended_at', null)
    .eq('accepts_online_booking', true)
    .limit(1)
  return providers?.[0]?.id ?? null
}

/**
 * What these services cost before any membership, read-only: the same
 * priceService() the visit is written with, and nothing is written. Null when
 * they cannot be priced (recordPosVisit then refuses with its own message).
 * For a check that must run before anything exists, such as the card minimum
 * of a sale taken through Stripe.
 */
export async function pricePosServices(admin: Admin, serviceIds: number[]): Promise<number | null> {
  const providerId = await tillProviderId(admin)
  if (!providerId) return null
  const outcome = await priceService(providerId, serviceIds, [])
  if (!outcome.ok) return null
  return outcome.priced.services.reduce((sum, svc) => sum + svc.price_cents, 0)
}

/**
 * Write a completed visit for these services, now.
 *
 * `discountCents` must already be verified as the manager's (the callers
 * check the role). It is capped here at what the visit owes after the
 * membership, so `discountCents` in the result is what was really used and a
 * caller can carry the rest over to the products.
 *
 * With `recordPayment: false` no ledger row is written: the visit is left
 * with its whole total owing, for the caller to settle.
 */
export async function recordPosVisit(
  admin: Admin,
  opts: {
    staffId: string
    clientId: string | null
    guestName: string | null
    serviceIds: number[]
    paymentMethod: PosPaymentMethod
    notes: string | null
    discountCents: number
    recordPayment: boolean
  }
): Promise<PosVisitOutcome> {
  const { staffId, clientId, guestName, serviceIds, paymentMethod, notes } = opts

  // Whose book this lands in. The bookable provider: for this studio, the
  // owner in the room.
  const providerId = await tillProviderId(admin)
  if (!providerId) {
    return { ok: false, status: 409, error: 'no_provider', message: 'No bookable provider is configured.' }
  }

  // The same pricing every booking gets: overrides, pair deals, live sales.
  const outcome = await priceService(providerId, serviceIds, [])
  if (!outcome.ok) {
    return {
      ok: false,
      status: 409,
      error: outcome.error,
      message:
        outcome.error === 'service_not_offered_by_provider'
          ? 'The provider does not offer one of those services.'
          : 'One of those services is not sellable right now.',
    }
  }
  const { services, durationMinutes } = outcome.priced

  const now = new Date()
  const endsAt = new Date(now.getTime() + Math.max(durationMinutes, 5) * 60_000)

  const { data: appointment, error: insertError } = await admin
    .from('appointments')
    .insert({
      provider_id: providerId,
      client_id: clientId ?? null,
      guest_first_name: clientId ? null : (guestName ?? 'Walk-in'),
      starts_at: now.toISOString(),
      ends_at: endsAt.toISOString(),
      buffer_minutes: 0,
      status: 'checked_in',
      source: 'walk_in',
      deposit_cents: 0,
      deposit_status: 'none',
      staff_notes: notes ?? null,
      created_by: staffId,
      // The counter outranks the calendar for this minute; see the header.
      allows_overlap: true,
      overlap_reason: 'Rung up at the till',
      overlap_authorized_by: staffId,
      checked_in_at: now.toISOString(),
    })
    .select('id')
    .single()

  if (insertError || !appointment) {
    void logError('pos/service-sale', insertError?.message ?? 'insert failed', {})
    return { ok: false, status: 500, error: 'sale_failed', message: 'Could not start that sale.' }
  }

  const { error: lineError } = await admin.from('appointment_services').insert(
    services.map((svc, i) => ({
      appointment_id: appointment.id,
      service_id: svc.id,
      name_snapshot: svc.name,
      price_cents: svc.price_cents,
      duration_minutes: svc.duration_minutes,
      full_price_cents: svc.full_price_cents ?? null,
      pair_discount_id: svc.pair_discount_id ?? null,
      promotion_id: svc.promotion_id ?? null,
      added_by: staffId,
      sort_order: i,
    }))
  )
  if (lineError) {
    await admin.from('appointments').delete().eq('id', appointment.id)
    void logError('pos/service-sale', lineError.message, { step: 'lines' })
    return { ok: false, status: 500, error: 'sale_failed', message: 'Could not add those services.' }
  }

  const subtotal = services.reduce((sum, svc) => sum + svc.price_cents, 0)

  // A member's included facial and member prices, exactly as a booking gets
  // them. The same function, so the counter and the calendar cannot disagree.
  const membership = clientId
    ? await applyMembershipBenefit({
        appointmentId: appointment.id,
        clientId,
        lines: services.map((svc) => ({ serviceId: svc.id, priceCents: svc.price_cents })),
        subtotalCents: subtotal,
      })
    : null
  const membershipCents = membership ? membership.coveredCents + membership.discountCents : 0

  // The manual discount never takes the visit below zero; what it could not
  // use here is the caller's to carry over to the products.
  const discount = Math.min(Math.max(opts.discountCents, 0), Math.max(subtotal - membershipCents, 0))

  // checked_in -> completed is the transition the back-bar stock trigger
  // watches (007); inserting as completed outright would skip the draw-down.
  // The manual discount rides the same update; the derive trigger floors at 0.
  const { data: done, error: completeError } = await admin
    .from('appointments')
    .update({
      status: 'completed',
      completed_at: now.toISOString(),
      ...(discount > 0 ? { promo_discount_cents: discount } : {}),
    })
    .eq('id', appointment.id)
    .select('id, subtotal_cents, total_cents, promo_discount_cents')
    .single()

  if (completeError || !done) {
    void logError('pos/service-sale', completeError?.message ?? 'complete failed', {
      appointment_id: appointment.id,
    })
    // Nothing half-written stands: the visit never completed, so no back-bar
    // stock was drawn and no payment exists. Deleting it cascades to its lines
    // and any membership session applyMembershipBenefit spent (050's FK); the
    // 078 release trigger watches a status change to cancelled, not a delete,
    // so the session is removed once, by the cascade.
    const { error: cleanupError } = await admin.from('appointments').delete().eq('id', appointment.id)
    if (cleanupError) {
      void logError('pos/service-sale', cleanupError.message, {
        step: 'cleanup_uncompleted_visit',
        appointment_id: appointment.id,
      })
    }
    return {
      ok: false,
      status: 500,
      error: 'sale_failed',
      message: 'The sale was not completed. Nothing was charged.',
    }
  }

  // The money, in the same ledger every balance reads. A visit the membership
  // covered entirely takes nothing, and record_payment refuses a zero.
  if (opts.recordPayment && done.total_cents > 0) {
    const { error: paymentError } = await admin.rpc('record_payment', {
      p_amount_cents: done.total_cents,
      p_kind: 'service',
      p_method: paymentMethod,
      p_appointment: done.id,
      p_note: notes ?? null,
    })
    if (paymentError) {
      // The visit stands; a missing ledger row is reconciliation, not a reason
      // to fail in front of the client.
      void logError('pos/service-sale', paymentError.message, {
        step: 'record_payment',
        appointment_id: done.id,
      })
    }
  }

  // The deals' paper trail, like the booking engine writes.
  const redemptions = services
    .filter((s) => s.promotion_id && s.full_price_cents !== undefined)
    .map((s) => ({
      promotion_id: s.promotion_id!,
      promotion_name: s.promotion_name ?? 'Promotion',
      client_id: clientId ?? null,
      appointment_id: done.id,
      discount_cents: (s.full_price_cents ?? s.price_cents) - s.price_cents,
    }))
  if (redemptions.length > 0) {
    await admin.from('promotion_redemptions').insert(redemptions)
  }

  return {
    ok: true,
    visit: {
      appointmentId: done.id,
      lines: services.map((svc) => ({ serviceId: svc.id, name: svc.name, priceCents: svc.price_cents })),
      subtotalCents: done.subtotal_cents,
      discountCents: discount,
      membershipCents,
      membershipName: membership?.planName ?? null,
      totalCents: done.total_cents,
    },
  }
}
