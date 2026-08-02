import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { loadAvailability } from '@/lib/booking'
import { generateSlots } from '@/lib/availability'
import { syncAppointmentToCalendar } from '@/lib/calendar-push'
import { dateKeyInTimeZone, MINUTE_MS } from '@/lib/time'
import { isFrontDesk, isStaff } from '@/types/database'

export const dynamic = 'force-dynamic'

const MAX_BODY_BYTES = 4_096

const MoveSchema = z.object({
  /** Absolute instant. The wall clock it came from is the browser's problem. */
  startsAt: z.string().min(1).max(40),
  /** Reassigning to another provider. Omit to keep the current one. */
  providerId: z.string().uuid().nullish(),
  /**
   * Drop it outside published hours. Squeezing someone in is a normal thing for
   * a studio to do, and this never bypasses the overlap check — the exclusion
   * constraint is not something the request body can reach.
   */
  overrideAvailability: z.boolean().default(false),
})

type MoveError =
  | 'invalid_request'
  | 'unknown_appointment'
  | 'not_movable'
  | 'unknown_provider'
  | 'provider_not_bookable'
  | 'service_not_offered_by_provider'
  | 'slot_unavailable'
  | 'slot_taken'
  | 'room_taken'
  | 'move_failed'

/** What staff should read when a move is refused. */
const MOVE_ERROR_MESSAGES: Record<MoveError, string> = {
  invalid_request: 'That move did not look right. Please try again.',
  unknown_appointment: 'That appointment no longer exists.',
  not_movable: 'A cancelled or finished appointment cannot be moved.',
  unknown_provider: 'That provider is not available.',
  provider_not_bookable: 'That provider does not have hours set up. Drop it with override to book it anyway.',
  service_not_offered_by_provider: 'That provider does not offer what this appointment is booked for.',
  slot_unavailable: 'Nothing is open there — outside hours, on a block, or too close to another booking.',
  slot_taken: 'That slot just went. Someone else took it while you were dragging.',
  room_taken: 'The room is already in use then.',
  move_failed: 'The move did not go through. The appointment has not been changed.',
}

const fail = (error: MoveError, status: number) =>
  NextResponse.json({ error, message: MOVE_ERROR_MESSAGES[error] }, { status })

/**
 * Move one appointment to a new time, a new provider, or both.
 *
 * This exists because a drag on the calendar must not become an UPDATE from the
 * browser. Staff hold an authenticated session with an `update appointments`
 * policy, so a direct write would succeed — and would put a booking wherever it
 * was dropped, past closing time, on top of a block, in the middle of somebody
 * else's facial. The exclusion constraint would still stop a literal overlap,
 * but everything else that makes a time bookable would be gone.
 *
 * So a move is re-derived here exactly as a new booking is: duration and buffer
 * from the row (never the request), availability regenerated for the TARGET
 * provider, the requested instant matched against the slots that regeneration
 * actually produced, and the GiST constraint left to settle the race between
 * two people dragging into the same hour. 23P01 comes back as a 409 that says
 * so, not a 500.
 *
 * Not folded into src/lib/booking.ts on purpose: that module is the single
 * implementation of *creating* an appointment, and it is left alone. This
 * imports its availability loader rather than restating it, so the times a move
 * accepts and the times a booking accepts come from one place.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params

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

  if (!staff || staff.suspended_at || !isStaff(staff.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const raw = await request.text()
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: 'payload_too_large' }, { status: 413 })
  }

  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    return fail('invalid_request', 400)
  }

  const parsed = MoveSchema.safeParse(body)
  if (!parsed.success) return fail('invalid_request', 400)

  const requested = new Date(parsed.data.startsAt)
  if (Number.isNaN(requested.getTime())) return fail('invalid_request', 400)

  const admin = createAdminClient()
  const now = new Date()

  const { data: appointment } = await admin
    .from('appointments')
    .select('id, provider_id, starts_at, ends_at, buffer_minutes, status')
    .eq('id', id)
    .maybeSingle()

  if (!appointment) return fail('unknown_appointment', 404)

  // A front desk moves anyone's book; a provider moves their own and cannot
  // hand it to somebody else. Reassignment is a staffing decision.
  const desk = isFrontDesk(staff.role)
  if (!desk && appointment.provider_id !== user.id) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  if (
    appointment.status === 'cancelled' ||
    appointment.status === 'completed' ||
    appointment.status === 'no_show'
  ) {
    return fail('not_movable', 409)
  }

  const targetProvider = parsed.data.providerId ?? appointment.provider_id
  if (targetProvider !== appointment.provider_id && !desk) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  // Duration and buffer come off the row, never off the request — the same rule
  // that keeps a booking's price honest. A move changes when, not what.
  const durationMinutes = Math.round(
    (new Date(appointment.ends_at).getTime() - new Date(appointment.starts_at).getTime()) /
      MINUTE_MS
  )
  const bufferMinutes = appointment.buffer_minutes ?? 0
  const endsAt = new Date(requested.getTime() + durationMinutes * MINUTE_MS)

  if (
    targetProvider === appointment.provider_id &&
    requested.getTime() === new Date(appointment.starts_at).getTime()
  ) {
    // Dropped back where it started. Nothing to write, and nothing to explain.
    return NextResponse.json({
      ok: true,
      appointment: {
        id: appointment.id,
        providerId: appointment.provider_id,
        startsAt: appointment.starts_at,
        endsAt: appointment.ends_at,
      },
    })
  }

  const { data: provider } = await admin
    .from('profiles')
    .select('id, timezone, role, suspended_at')
    .eq('id', targetProvider)
    .maybeSingle()

  if (!provider || provider.role === 'client' || provider.suspended_at) {
    return fail('unknown_provider', 404)
  }

  // Handing an appointment to someone who does not perform it is a scheduling
  // mistake with a client sitting in the room at the other end of it.
  if (targetProvider !== appointment.provider_id) {
    const { data: lines } = await admin
      .from('appointment_services')
      .select('service_id')
      .eq('appointment_id', appointment.id)

    const serviceIds = (lines ?? [])
      .map((l) => l.service_id)
      .filter((s): s is number => s != null)

    if (serviceIds.length > 0) {
      const { data: offered } = await admin
        .from('provider_services')
        .select('service_id, is_active')
        .eq('provider_id', targetProvider)
        .in('service_id', serviceIds)

      const performs = new Set(
        (offered ?? []).filter((o) => o.is_active).map((o) => o.service_id)
      )
      if (serviceIds.some((s) => !performs.has(s))) {
        return fail('service_not_offered_by_provider', 409)
      }
    }
  }

  if (!parsed.data.overrideAvailability) {
    const dateKey = dateKeyInTimeZone(requested, provider.timezone)
    const availability = await loadAvailability({
      providerId: targetProvider,
      durationMinutes,
      bufferMinutes,
      fromDateKey: dateKey,
      days: 1,
      now,
    })

    if (!availability) return fail('provider_not_bookable', 409)

    // An appointment cannot be in its own way. Nudging 10:00 to 10:30 overlaps
    // where it currently sits, and without this every short move would be
    // refused by the booking it is itself made of.
    const ownStart = new Date(appointment.starts_at).getTime()
    const ownEnd = new Date(appointment.ends_at).getTime() + bufferMinutes * MINUTE_MS
    availability.busy = availability.busy.filter(
      (b) =>
        !(
          new Date(b.starts_at).getTime() === ownStart &&
          new Date(b.ends_at).getTime() === ownEnd
        )
    )

    // The notice period is a rule about how much warning a CLIENT must give
    // (migration 029 says as much). Staff moving this afternoon's two o'clock
    // to three is not a late booking, and holding them to it would make the
    // calendar unusable on the day it matters most.
    availability.minLeadMinutes = 0

    const [day] = generateSlots(availability, dateKey, 1)
    const offered = day?.slots.some((s) => s.getTime() === requested.getTime()) ?? false
    if (!offered) return fail('slot_unavailable', 409)
  }

  // `slot` is deliberately absent: the appointments_set_slot trigger owns it and
  // recomputes it from these three columns.
  const { data: moved, error: updateError } = await admin
    .from('appointments')
    .update({
      provider_id: targetProvider,
      starts_at: requested.toISOString(),
      ends_at: endsAt.toISOString(),
    })
    .eq('id', appointment.id)
    .select('id, provider_id, starts_at, ends_at, status')
    .single()

  if (updateError) {
    // 23P01 = exclusion_violation. Two people dragged into the same hour and
    // the database picked one; the other needs to be told which, not shown a
    // 500 and left wondering whether the move happened.
    if (updateError.code === '23P01') {
      const room = /room_no_overlap/.test(updateError.message ?? '')
      return fail(room ? 'room_taken' : 'slot_taken', 409)
    }
    console.error('appointment move failed', updateError, { appointmentId: appointment.id })
    return fail('move_failed', 500)
  }

  // The status trigger only records status changes, so a move would otherwise
  // leave no trace of who put the client at a different time.
  await admin.from('appointment_events').insert({
    appointment_id: appointment.id,
    event: 'moved',
    actor_id: user.id,
    detail:
      targetProvider === appointment.provider_id
        ? `Rescheduled from ${appointment.starts_at} to ${moved.starts_at}`
        : `Rescheduled from ${appointment.starts_at} to ${moved.starts_at} and reassigned`,
  })

  // Keep Google in step. Not awaited into the response: the move is committed
  // and the person who dragged it is watching a card that has already landed.
  void syncAppointmentToCalendar(appointment.id)

  return NextResponse.json({
    ok: true,
    appointment: {
      id: moved.id,
      providerId: moved.provider_id,
      startsAt: moved.starts_at,
      endsAt: moved.ends_at,
    },
  })
}
