import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log-error'
import { getStripe, stripeConfigured } from '@/lib/stripe'
import { frontDeskOnly, ticketIdFrom } from '@/lib/till-ticket'

export const dynamic = 'force-dynamic'

/**
 * Call off a till sale that is waiting for a card payment (090).
 *
 * cancel_till_ticket() runs as the signed-in staff member and checks the role
 * itself. Its pending order is cancelled (stock was never taken); the visit,
 * when there is one, stays completed with its balance owing, so the till
 * offers it under "Pay off first".
 *
 * A phone link is closed at Stripe FIRST, so the client cannot pay a sale
 * that no longer exists. If Stripe says the session is already paid the
 * cancel is refused (the webhook is about to settle it), and if Stripe cannot
 * be reached it is refused too, rather than leave a live link behind.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await frontDeskOnly()
  if (!gate.ok) return gate.response

  const id = ticketIdFrom((await params).id)
  if (!id) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const admin = createAdminClient()
  const { data: ticket } = await admin
    .from('till_tickets')
    .select('id, method, status, stripe_session_id')
    .eq('id', id)
    .maybeSingle()
  if (!ticket) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (ticket.status !== 'awaiting') {
    return NextResponse.json(
      { error: 'not_awaiting', message: `That sale is already ${ticket.status}.`, status: ticket.status },
      { status: 409 }
    )
  }

  if (ticket.method === 'phone_link' && ticket.stripe_session_id) {
    if (!stripeConfigured()) {
      return NextResponse.json(
        { error: 'stripe_not_configured', message: 'Stripe is not set up, so the link cannot be closed.' },
        { status: 503 }
      )
    }
    const stripe = getStripe()
    try {
      const session = await stripe.checkout.sessions.retrieve(ticket.stripe_session_id)
      if (session.status === 'complete') {
        return NextResponse.json(
          { error: 'already_paid', message: 'It was just paid on the phone. The sale will show as paid in a moment.' },
          { status: 409 }
        )
      }
      if (session.status === 'open') await stripe.checkout.sessions.expire(ticket.stripe_session_id)
    } catch (err) {
      void logError('pos/ticket/cancel', err, { ticket_id: id })
      return NextResponse.json(
        { error: 'stripe_failed', message: 'Could not close the payment link at Stripe. Try again in a moment.' },
        { status: 502 }
      )
    }
  }

  const { data: cancelled, error } = await gate.supabase.rpc('cancel_till_ticket', { p_ticket: id })
  if (error) {
    return NextResponse.json({ error: 'cancel_failed', message: 'Could not cancel that sale.' }, { status: 500 })
  }
  if (!cancelled) {
    return NextResponse.json(
      { error: 'not_awaiting', message: 'That sale changed a moment ago. It may have just been paid.' },
      { status: 409 }
    )
  }
  return NextResponse.json({ ok: true })
}
