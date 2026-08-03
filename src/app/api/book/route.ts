import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createBooking, BOOKING_ERROR_MESSAGES, MAX_ADDONS } from '@/lib/booking'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 16_384

const BookingSchema = z.object({
  provider_id: z.string().uuid(),
  // A list, so a client can book several services as one appointment. A bare
  // number is still accepted so an older client build keeps working.
  service_ids: z
    .union([
      z.number().int().positive().transform((n) => [n]),
      z.array(z.number().int().positive()).min(1).max(6),
    ]),
  addon_ids: z.array(z.number().int().positive()).max(MAX_ADDONS).default([]),
  starts_at: z.string().min(1).max(40),
  first_name: z.string().trim().min(1).max(80),
  last_name: z.string().trim().min(1).max(80),
  email: z.string().trim().email().max(254),
  phone: z.string().trim().max(40).nullish(),
  notes: z.string().trim().max(2000).nullish(),
  age_attested: z.boolean().default(false),
})

export async function POST(request: NextRequest) {
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

  const result = BookingSchema.safeParse(parsed)
  if (!result.success) {
    return NextResponse.json(
      { error: 'invalid_request', message: BOOKING_ERROR_MESSAGES.invalid_request },
      { status: 400 }
    )
  }

  // If the visitor happens to be signed in, attach the booking to their
  // account. This is read from the session cookie, never from the body — a
  // caller must not be able to book on someone else's behalf.
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const body = result.data
  const outcome = await createBooking({
    providerId: body.provider_id,
    serviceIds: body.service_ids,
    addonIds: body.addon_ids,
    startsAt: body.starts_at,
    firstName: body.first_name,
    lastName: body.last_name,
    email: body.email.toLowerCase(),
    phone: body.phone ?? null,
    notes: body.notes ?? null,
    ageAttested: body.age_attested,
    clientId: user?.id ?? null,
  })

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error, message: BOOKING_ERROR_MESSAGES[outcome.error] },
      { status: outcome.status }
    )
  }

  // `booking.status` rides along and is load-bearing: with approval routing on,
  // the database may have held this for review, and the confirmation screen has
  // to say so rather than claiming a confirmation that has not happened.
  return NextResponse.json({ ok: true, booking: outcome.booking }, { status: 201 })
}
