import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { addMinutes } from '@/lib/time'
import { CARD_MATCH_WINDOW_MINUTES, STRIPE_APP_GRACE_MINUTES, frontDeskOnly, ticketIdFrom } from '@/lib/till-ticket'

export const dynamic = 'force-dynamic'

/**
 * Where a till sale taken through Stripe stands (090). The till polls this
 * every few seconds while it waits.
 *
 * Its status comes from the database, which only the webhook moves to
 * `paid`; nothing the client's browser does reaches it. A Stripe app ticket
 * five minutes past its time is let go here, because no Stripe event will
 * ever close it (the grace is for a tap whose webhook is still on its way).
 * A phone link ticket is not: its session's expired event closes it, and
 * closing it early could cancel a sale whose payment is still on its way.
 *
 * While a Stripe app ticket waits, the card payments of the same amount that
 * the webhook could not match (from the last two hours) come back with it,
 * for the desk to pick with one tap.
 */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await frontDeskOnly()
  if (!gate.ok) return gate.response

  const id = ticketIdFrom((await params).id)
  if (!id) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const admin = createAdminClient()
  const read = () =>
    admin
      .from('till_tickets')
      .select('id, method, status, amount_cents, expires_at, paid_at, stripe_checkout_url, order_id, appointment_id')
      .eq('id', id)
      .maybeSingle()

  let { data: ticket } = await read()
  if (!ticket) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const now = new Date()
  if (
    ticket.status === 'awaiting' &&
    ticket.method === 'stripe_app' &&
    addMinutes(new Date(ticket.expires_at), STRIPE_APP_GRACE_MINUTES) <= now
  ) {
    await admin.rpc('expire_till_ticket', { p_ticket: id })
    ;({ data: ticket } = await read())
    if (!ticket) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  let candidates: { id: number; payment_intent_id: string; amount_cents: number; description: string | null; paid_at: string }[] = []
  if (ticket.status === 'awaiting' && ticket.method === 'stripe_app') {
    const { data } = await admin
      .from('stripe_unmatched_payments')
      .select('id, stripe_payment_intent_id, amount_cents, description, paid_at')
      .eq('amount_cents', ticket.amount_cents)
      .eq('kind', 'payment')
      .is('matched_ticket_id', null)
      .is('dismissed_at', null)
      .gte('paid_at', addMinutes(now, -CARD_MATCH_WINDOW_MINUTES).toISOString())
      .order('paid_at', { ascending: false })
      .limit(10)
    candidates = (data ?? []).map((u) => ({
      id: u.id,
      payment_intent_id: u.stripe_payment_intent_id,
      amount_cents: u.amount_cents,
      description: u.description,
      paid_at: u.paid_at,
    }))
  }

  return NextResponse.json({
    ticket: {
      id: ticket.id,
      method: ticket.method,
      status: ticket.status,
      amount_cents: ticket.amount_cents,
      expires_at: ticket.expires_at,
      paid_at: ticket.paid_at,
      checkout_url: ticket.stripe_checkout_url,
    },
    candidates,
  })
}
