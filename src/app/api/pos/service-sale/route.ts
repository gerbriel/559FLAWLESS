import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { logError } from '@/lib/log-error'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { priceService } from '@/lib/booking'
import { queueNotificationEmails } from '@/lib/notification-email'
import { isFrontDesk, isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

const SaleSchema = z
  .object({
    clientId: z.string().uuid().nullish(),
    guestName: z.string().trim().max(120).nullish(),
    serviceIds: z.array(z.number().int().positive()).min(1).max(6),
    paymentMethod: z.enum(['cash', 'card', 'apple_pay', 'zelle', 'paypal', 'venmo', 'cashapp', 'other']),
    notes: z.string().trim().max(500).nullish(),
    /** Manager-only, verified server-side. Integer cents off the visit. */
    discountCents: z.number().int().min(0).max(1_000_000).default(0),
  })
  .refine((v) => v.clientId || v.guestName, {
    message: 'Name the customer, even if only as a walk-in.',
  })

/**
 * Ring up a SERVICE at the till.
 *
 * A service sold at the counter is not an order — it is a visit that just
 * happened. So this writes what the rest of the system already understands:
 * a completed appointment, timed now, with the service lines priced by the
 * same priceService() every booking uses (per-provider overrides, pair deals
 * and sales included). Completing it draws down back-bar stock; the payment
 * lands in the ledger; loyalty, referral settlement, commissions and every
 * report follow with no special cases.
 *
 * The appointment takes the overlap escape hatch (036): the client is
 * standing at the counter, so whatever the calendar says about this exact
 * minute is already settled in the room. Staff-authorised, reasoned, and
 * impossible for the public path by table CHECK.
 *
 * The manual discount is manager-only, verified here — a request from anyone
 * else simply loses the field. It lands in `promo_discount_cents`, the same
 * column every visit-level deal uses, so the total derivation needs nothing.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: staff } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()
  if (!staff || staff.suspended_at || !isFrontDesk(staff.role as UserRole)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsed = SaleSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'Check the sale.' },
      { status: 400 }
    )
  }
  const { clientId, guestName, serviceIds, paymentMethod, notes } = parsed.data
  const discount = isManager(staff.role as UserRole) ? parsed.data.discountCents : 0

  const admin = createAdminClient()

  // Whose book this lands in. The bookable provider — for this studio, the
  // owner in the room.
  const { data: providers } = await admin
    .from('profiles')
    .select('id')
    .neq('role', 'client')
    .is('suspended_at', null)
    .eq('accepts_online_booking', true)
    .limit(1)
  const providerId = providers?.[0]?.id
  if (!providerId) {
    return NextResponse.json(
      { error: 'no_provider', message: 'No bookable provider is configured.' },
      { status: 409 }
    )
  }

  // The same pricing every booking gets — overrides, pair deals, live sales.
  const outcome = await priceService(providerId, serviceIds, [])
  if (!outcome.ok) {
    return NextResponse.json(
      {
        error: outcome.error,
        message:
          outcome.error === 'service_not_offered_by_provider'
            ? 'The provider does not offer one of those services.'
            : 'One of those services is not sellable right now.',
      },
      { status: 409 }
    )
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
      created_by: user.id,
      // The counter outranks the calendar for this minute — see the header.
      allows_overlap: true,
      overlap_reason: 'Rung up at the till',
      overlap_authorized_by: user.id,
      checked_in_at: now.toISOString(),
    })
    .select('id')
    .single()

  if (insertError || !appointment) {
    void logError('pos/service-sale', insertError?.message ?? 'insert failed', {})
    return NextResponse.json(
      { error: 'sale_failed', message: 'Could not start that sale.' },
      { status: 500 }
    )
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
      added_by: user.id,
      sort_order: i,
    }))
  )
  if (lineError) {
    await admin.from('appointments').delete().eq('id', appointment.id)
    void logError('pos/service-sale', lineError.message, { step: 'lines' })
    return NextResponse.json(
      { error: 'sale_failed', message: 'Could not add those services.' },
      { status: 500 }
    )
  }

  // checked_in -> completed is the transition the back-bar stock trigger
  // watches (007) — inserting as completed outright would skip the draw-down.
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
    return NextResponse.json(
      { error: 'sale_failed', message: 'The sale was not completed. Nothing was charged.' },
      { status: 500 }
    )
  }

  // The money, in the same ledger every balance reads.
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
    void logError('pos/service-sale', paymentError.message, { step: 'record_payment', appointment_id: done.id })
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

  queueNotificationEmails()

  return NextResponse.json(
    {
      ok: true,
      appointment_id: done.id,
      subtotal_cents: done.subtotal_cents,
      discount_cents: done.promo_discount_cents,
      total_cents: done.total_cents,
    },
    { status: 201 }
  )
}
