import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getStripe, stripeConfigured, siteUrl } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { isStaff } from '@/types/database'

export const dynamic = 'force-dynamic'

const Body = z.object({ appointment_id: z.string().uuid() })

/**
 * Stripe Checkout for what an appointment still owes.
 *
 * The amount is the balance the database derives — total minus every
 * succeeded payment — never the request's. Same authorisation model as the
 * deposit route it mirrors: your own appointment or you are staff, and an
 * outsider's guess gets a plain 404 rather than a confirmation the booking
 * exists.
 *
 * The webhook is what records the money (kind 'service'); these URLs are only
 * where the browser lands. Recording through `payments` means loyalty points,
 * referral settlement, and the balance math all follow with no extra wiring.
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
    .select('id, total_cents, status, guest_email, client_id')
    .eq('id', parsed.data.appointment_id)
    .maybeSingle()

  if (!appointment) {
    return NextResponse.json({ error: 'unknown_appointment' }, { status: 404 })
  }

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

  // A visit that did not happen is not billed (025's reading).
  if (['cancelled', 'no_show'].includes(appointment.status)) {
    return NextResponse.json({ error: 'not_billed' }, { status: 409 })
  }

  const { data: payments } = await supabase
    .from('payments')
    .select('amount_cents')
    .eq('appointment_id', appointment.id)
    .eq('status', 'succeeded')

  const taken = (payments ?? []).reduce((n, p) => n + p.amount_cents, 0)
  const balance = Math.max(appointment.total_cents - taken, 0)

  if (balance <= 0) {
    return NextResponse.json({ error: 'nothing_owed' }, { status: 409 })
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
          unit_amount: balance,
          product_data: {
            name: `Balance — ${description}`,
            description: 'The remaining amount on your appointment.',
          },
        },
      },
    ],
    success_url: `${siteUrl()}/account/appointments/${appointment.id}?balance=paid`,
    cancel_url: `${siteUrl()}/account/appointments/${appointment.id}?balance=cancelled`,
    metadata: {
      kind: 'appointment_balance',
      appointment_id: appointment.id,
    },
  })

  return NextResponse.json({ url: session.url })
}
