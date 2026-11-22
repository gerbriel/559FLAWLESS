import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { formatMoney } from '@/lib/utils'
import { frontDeskOnly, ticketIdFrom } from '@/lib/till-ticket'

export const dynamic = 'force-dynamic'

const Body = z.object({ payment_intent_id: z.string().trim().min(3).max(255) })

/**
 * Tie a card payment the webhook parked to this till sale (090).
 *
 * The payment is evidence Stripe already sent: it is only in
 * stripe_unmatched_payments because a signed payment_intent.succeeded put it
 * there. The amount must be the ticket's to the cent; anything else is
 * refused, because a near miss is a different sale. Stripe app sales only:
 * a phone link sale is paid through its own Checkout session. match_unmatched_payment
 * settles the ticket and marks the row matched in one transaction.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await frontDeskOnly()
  if (!gate.ok) return gate.response

  const id = ticketIdFrom((await params).id)
  if (!id) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request', message: 'Pick a payment to match.' }, { status: 400 })
  }

  const admin = createAdminClient()
  const [{ data: ticket }, { data: payment }] = await Promise.all([
    admin.from('till_tickets').select('id, method, status, amount_cents').eq('id', id).maybeSingle(),
    admin
      .from('stripe_unmatched_payments')
      .select('id, amount_cents, matched_ticket_id, dismissed_at')
      .eq('stripe_payment_intent_id', parsed.data.payment_intent_id)
      .eq('kind', 'payment')
      .maybeSingle(),
  ])

  if (!ticket) return NextResponse.json({ error: 'not_found', message: 'That sale is not on file.' }, { status: 404 })
  if (!payment) {
    return NextResponse.json(
      { error: 'unknown_payment', message: 'That card payment is not waiting to be matched.' },
      { status: 404 }
    )
  }
  if (payment.matched_ticket_id !== null || payment.dismissed_at !== null) {
    return NextResponse.json(
      { error: 'already_handled', message: 'That card payment has already been matched or dismissed.' },
      { status: 409 }
    )
  }
  // A phone link sale is paid through its own Checkout session, which may
  // still be open on the client's phone; matching a Tap to Pay payment to it
  // could take the money twice. Only Stripe app sales are matched by hand.
  if (ticket.method !== 'stripe_app') {
    return NextResponse.json(
      {
        error: 'not_stripe_app',
        message: 'Only a sale rung up as Card via Stripe app can be matched to a card payment.',
      },
      { status: 409 }
    )
  }
  if (ticket.status !== 'awaiting' && ticket.status !== 'expired') {
    return NextResponse.json(
      { error: 'not_awaiting', message: `That sale is ${ticket.status}, so it cannot take a payment.` },
      { status: 409 }
    )
  }
  if (payment.amount_cents !== ticket.amount_cents) {
    return NextResponse.json(
      {
        error: 'amount_mismatch',
        message: `That card payment is ${formatMoney(payment.amount_cents)} and this sale is ${formatMoney(ticket.amount_cents)}. Only a payment for the same amount can be matched.`,
      },
      { status: 409 }
    )
  }

  const { data: matched, error } = await admin.rpc('match_unmatched_payment', { p_id: payment.id, p_ticket: ticket.id })
  if (error) {
    return NextResponse.json({ error: 'match_failed', message: 'Could not match that payment.' }, { status: 500 })
  }
  if (!matched) {
    return NextResponse.json(
      { error: 'match_refused', message: 'That payment or sale changed a moment ago. Refresh and try again.' },
      { status: 409 }
    )
  }
  return NextResponse.json({ ok: true })
}
