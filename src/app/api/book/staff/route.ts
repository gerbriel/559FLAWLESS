import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { isFrontDesk } from '@/types/database'
import { generateSlots, type AvailabilityInput } from '@/lib/availability'
import { dateKeyInTimeZone, zonedTimeToUtc, isValidTimeZone } from '@/lib/time'

export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 16_384

const StaffBookingSchema = z.object({
  clientId: z.string().uuid(),
  serviceId: z.number().int().positive(),
  providerId: z.string().uuid(),
  startsAt: z.string().min(1).max(40),
  addonIds: z.array(z.number().int().positive()).max(6).default([]),
  notes: z.string().trim().max(2000).nullish(),
  source: z.literal('staff'),
})

export async function POST(request: NextRequest) {
  // Check authentication
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // Check authorization - must be front desk or higher
  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || !isFrontDesk(profile.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Parse request body
  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 })
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 })
  }

  const result = StaffBookingSchema.safeParse(parsed)
  if (!result.success) {
    return NextResponse.json(
      { error: 'invalid_request', details: result.error.issues },
      { status: 400 }
    )
  }

  const body = result.data
  const admin = createAdminClient()

  try {
    // Fetch client info
    const { data: client } = await admin
      .from('profiles')
      .select('id, first_name, last_name, email, phone')
      .eq('id', body.clientId)
      .eq('role', 'client')
      .maybeSingle()

    if (!client) {
      return NextResponse.json({ error: 'client_not_found' }, { status: 404 })
    }

    // Fetch service details
    const { data: service } = await admin
      .from('services')
      .select('id, name, price_cents, duration_minutes, buffer_minutes, deposit_cents')
      .eq('id', body.serviceId)
      .eq('is_active', true)
      .maybeSingle()

    if (!service) {
      return NextResponse.json({ error: 'service_not_found' }, { status: 404 })
    }

    // Fetch provider details
    const { data: provider } = await admin
      .from('profiles')
      .select('id, timezone')
      .eq('id', body.providerId)
      .eq('role', 'provider')
      .maybeSingle()

    if (!provider || !isValidTimeZone(provider.timezone)) {
      return NextResponse.json({ error: 'provider_not_found' }, { status: 404 })
    }

    // Parse and validate the requested slot
    const requestedAt = new Date(body.startsAt)
    if (isNaN(requestedAt.getTime())) {
      return NextResponse.json({ error: 'invalid_datetime' }, { status: 400 })
    }

    const endsAt = new Date(requestedAt.getTime() + service.duration_minutes * 60_000)
    const bufferEndsAt = new Date(endsAt.getTime() + service.buffer_minutes * 60_000)

    // Check for conflicts
    const { data: conflicts } = await admin
      .from('appointments')
      .select('id')
      .eq('provider_id', body.providerId)
      .neq('status', 'cancelled')
      .or(`starts_at.lt.${bufferEndsAt.toISOString()},ends_at.gt.${requestedAt.toISOString()}`)
      .limit(1)

    if (conflicts && conflicts.length > 0) {
      return NextResponse.json({ error: 'slot_taken' }, { status: 409 })
    }

    // Create appointment
    const { data: appointment, error: appointmentError } = await admin
      .from('appointments')
      .insert({
        provider_id: body.providerId,
        client_id: body.clientId,
        starts_at: requestedAt.toISOString(),
        ends_at: endsAt.toISOString(),
        buffer_minutes: service.buffer_minutes,
        slot: dateKeyInTimeZone(requestedAt, provider.timezone) + 'T' + 
              requestedAt.toISOString().split('T')[1].slice(0, 8),
        status: 'confirmed',
        source: 'staff',
        subtotal_cents: service.price_cents,
        total_cents: service.price_cents,
        deposit_cents: service.deposit_cents,
        deposit_status: service.deposit_cents > 0 ? 'none' : 'none',
        client_notes: body.notes ?? null,
        created_by: user.id,
      })
      .select('id')
      .single()

    if (appointmentError) {
      console.error('Appointment creation error:', appointmentError)
      return NextResponse.json({ error: 'booking_failed' }, { status: 500 })
    }

    // Add service to appointment
    await admin
      .from('appointment_services')
      .insert({
        appointment_id: appointment.id,
        service_id: body.serviceId,
        name_snapshot: service.name,
        price_cents: service.price_cents,
        duration_minutes: service.duration_minutes,
        sort_order: 0,
      })

    // Create notification for client
    await admin
      .from('notifications')
      .insert({
        user_id: body.clientId,
        type: 'appointment_booked',
        title: 'Appointment Booked',
        body: `Your ${service.name} appointment has been scheduled.`,
        link: `/account/appointments/${appointment.id}`,
        appointment_id: appointment.id,
      })

    return NextResponse.json({ 
      ok: true, 
      id: appointment.id,
      startsAt: requestedAt.toISOString(),
      endsAt: endsAt.toISOString(),
    }, { status: 201 })

  } catch (error) {
    console.error('Staff booking error:', error)
    return NextResponse.json({ error: 'internal_error' }, { status: 500 })
  }
}
