import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getStripe, stripeConfigured, siteUrl } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

const Body = z.object({ appointment_id: z.string().uuid() })

/**
 * Stripe Checkout session for an appointment deposit.
 *
 * The amount comes from the appointment row, never the request. The caller
 * only names which appointment; a tampered body cannot change what is charged.
 */
export async function POST(request: NextRequest) {
  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'stripe_not_configured' }, { status: 503 })
  }

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
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
            description: 'Applied to your service total at your appointment.',
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
