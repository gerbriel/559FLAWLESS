import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createStaffBooking, BOOKING_ERROR_MESSAGES, MAX_ADDONS } from '@/lib/booking'
import { isFrontDesk } from '@/types/database'

export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 16_384

const StaffBookingSchema = z.object({
  clientId: z.string().uuid(),
  providerId: z.string().uuid(),
  serviceId: z.number().int().positive(),
  addonIds: z.array(z.number().int().positive()).max(MAX_ADDONS).default([]),
  startsAt: z.string().min(1).max(40),
  notes: z.string().trim().max(2000).nullish(),
  /** Squeeze someone in outside published hours. Never bypasses overlap. */
  overrideAvailability: z.boolean().default(false),
})

/**
 * Book on behalf of a client.
 *
 * Everything past authorisation is delegated to `createStaffBooking`, which
 * shares its pricing and insert path with the public booking engine.
 *
 * The previous version of this route reimplemented all of it and got two things
 * wrong: it wrote the `slot` column by hand — a tstzrange owned by a trigger, so
 * every insert died with `22P02 malformed range literal` — and its conflict
 * check used OR where overlap needs AND, so it reported "slot taken" for almost
 * any request that did reach the insert. It also declared `addonIds` and then
 * ignored them, so add-ons were silently dropped and never charged.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || profile.suspended_at || !isFrontDesk(profile.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

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
      { error: 'invalid_request', message: BOOKING_ERROR_MESSAGES.invalid_request },
      { status: 400 }
    )
  }

  const body = result.data
  const outcome = await createStaffBooking({
    clientId: body.clientId,
    providerId: body.providerId,
    serviceId: body.serviceId,
    addonIds: body.addonIds,
    startsAt: body.startsAt,
    notes: body.notes ?? null,
    createdBy: user.id,
    overrideAvailability: body.overrideAvailability,
  })

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.error, message: BOOKING_ERROR_MESSAGES[outcome.error] },
      { status: outcome.status }
    )
  }

  return NextResponse.json({ ok: true, booking: outcome.booking }, { status: 201 })
}
