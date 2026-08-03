import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getStripe, stripeConfigured, siteUrl } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { isStaff } from '@/types/database'

export const dynamic = 'force-dynamic'

const Body = z.object({ appointment_id: z.string().uuid() })

/**
 * Stripe Checkout session for an appointment deposit.
 *
 * The amount comes from the appointment row, never the request. The caller
 * only names which appointment; a tampered body cannot change what is charged.
 *
 * This handler reaches for createAdminClient(), which is past RLS, so it has to
 * do the authorisation the database is not being asked to do — AGENTS.md rule 4.
 * It did not, and an appointment id was the whole of the credential: anyone who
 * had one could mint a Checkout session against somebody else's booking, which
 * confirms the booking exists, discloses its deposit, and opens a payment intent
 * on it. Nobody could steal money that way — they would be paying — but "the
 * attack is only useful for giving us money" is not an authorisation model.
 *
 * It is your own appointment, or you are staff. Guests are unaffected: booking
 * redirects to /login before the flow starts, so every caller has a session.
 */
export async function POST(request: NextRequest) {
  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'stripe_not_configured' }, { status: 503 })
  }

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }

  const {
    data: { user },
  } = await (await createClient()).auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  const supabase = createAdminClient()

  const { data: appointment } = await supabase
    .from('appointments')
    .select('id, deposit_cents, deposit_status, status, starts_at, guest_email, client_id')
    .eq('id', parsed.data.appointment_id)
    .maybeSingle()

  if (!appointment) {
    return NextResponse.json({ error: 'unknown_appointment' }, { status: 404 })
  }

  // Deliberately 404, not 403: a distinct "forbidden" would confirm that an
  // appointment with that id exists, which is the disclosure being closed.
  if (appointment.client_id !== user.id) {
    const { data: me } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', user.id)
      .maybeSingle()

    if (!isStaff(me?.role)) {
      return NextResponse.json({ error: 'unknown_appointment' }, { status: 404 })
    }
  }
  if (appointment.status === 'cancelled') {
    return NextResponse.json({ error: 'appointment_cancelled' }, { status: 409 })
  }
  if (appointment.deposit_cents <= 0 || appointment.deposit_status === 'paid') {
    return NextResponse.json({ error: 'no_deposit_due' }, { status: 409 })
  }

  const { data: lines } = await supabase
    .from('appointment_services')
    .select('name_snapshot')
    .eq('appointment_id', appointment.id)
    .order('sort_order')

  const description = (lines ?? []).map((l) => l.name_snapshot).join(' + ') || 'Appointment'

  /*
    Stripe's own hosted checkout page and the receipt it emails are the only
    message about this booking that leaves the app — there is no mail sender in
    this codebase — so this line item is read by a client who may not have an
    appointment yet. "Applied to your service total at your appointment" reads
    as a receipt for a confirmed booking, which is the same claim BookingFlow
    and /account/appointments were corrected to stop making.

    /api/stripe/deposit accepts a pending appointment on purpose (a held slot is
    exactly what a deposit is for); it just must not describe one as settled.
  */
  const awaitingApproval = appointment.status === 'pending'
  const lineDescription = awaitingApproval
    ? 'Your time is held while the studio confirms this booking. Applied to your service total on the day.'
    : 'Applied to your service total at your appointment.'

  const stripe = getStripe()
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    customer_email: appointment.guest_email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: appointment.deposit_cents,
          product_data: {
            name: `Deposit — ${description}`,
            description: lineDescription,
          },
        },
      },
    ],
    // The webhook is what marks the deposit paid; these URLs are only where the
    // browser lands.
    success_url: `${siteUrl()}/account/appointments/${appointment.id}?deposit=paid`,
    cancel_url: `${siteUrl()}/account/appointments/${appointment.id}?deposit=cancelled`,
    metadata: {
      kind: 'appointment_deposit',
      appointment_id: appointment.id,
    },
  })

  await supabase
    .from('appointments')
    .update({ stripe_session_id: session.id })
    .eq('id', appointment.id)

  return NextResponse.json({ url: session.url })
}
