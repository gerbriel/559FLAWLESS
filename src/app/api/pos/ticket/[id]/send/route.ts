import { NextResponse, type NextRequest } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { emailConfigured, queueNotificationEmails } from '@/lib/notification-email'
import { formatMoney } from '@/lib/utils'
import { addMinutes } from '@/lib/time'
import { frontDeskOnly, ticketIdFrom } from '@/lib/till-ticket'

export const dynamic = 'force-dynamic'

/**
 * Email a till sale's phone link to the client (090).
 *
 * It goes the way every other message to a client goes: a notification row
 * (the bell in their account) mirrored to email by queueNotificationEmails.
 * Only for a named client with an address on file; a walk-in scans the QR
 * code. There is no SMS sender in this codebase, so there is no text option.
 */
export async function POST(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const gate = await frontDeskOnly()
  if (!gate.ok) return gate.response

  const id = ticketIdFrom((await params).id)
  if (!id) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const admin = createAdminClient()
  const { data: ticket } = await admin
    .from('till_tickets')
    .select('id, method, status, amount_cents, client_id, stripe_checkout_url')
    .eq('id', id)
    .maybeSingle()
  if (!ticket) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (ticket.status !== 'awaiting' || ticket.method !== 'phone_link' || !ticket.stripe_checkout_url) {
    return NextResponse.json(
      { error: 'not_awaiting', message: 'That sale has no open payment link to send.' },
      { status: 409 }
    )
  }
  if (!ticket.client_id) {
    return NextResponse.json(
      { error: 'no_client', message: 'A walk-in has no email on file. Show them the code instead.' },
      { status: 409 }
    )
  }

  const { data: client } = await admin
    .from('profiles')
    .select('email, suspended_at')
    .eq('id', ticket.client_id)
    .maybeSingle()
  if (!client?.email?.trim() || client.suspended_at) {
    return NextResponse.json(
      { error: 'no_email', message: 'That client has no email on file. Show them the code instead.' },
      { status: 409 }
    )
  }
  if (!emailConfigured()) {
    return NextResponse.json(
      { error: 'email_not_configured', message: 'Email is not set up yet. Show them the code instead.' },
      { status: 503 }
    )
  }

  // One email a minute per sale: a second tap while the first is in flight
  // should not fill the client's inbox.
  const { data: recent } = await admin
    .from('notifications')
    .select('id')
    .eq('user_id', ticket.client_id)
    .eq('link', ticket.stripe_checkout_url)
    .gte('created_at', addMinutes(new Date(), -1).toISOString())
    .limit(1)
  if (recent && recent.length > 0) {
    return NextResponse.json(
      { error: 'sent_recently', message: 'The link was emailed less than a minute ago. Give it a moment.' },
      { status: 429 }
    )
  }

  const { error } = await admin.from('notifications').insert({
    user_id: ticket.client_id,
    type: 'system',
    title: 'Your payment link from 559 Flawless',
    body: `Pay ${formatMoney(ticket.amount_cents)} for today at the studio. The link works for 30 minutes from when the sale was rung up.`,
    link: ticket.stripe_checkout_url,
  })
  if (error) {
    return NextResponse.json({ error: 'send_failed', message: 'Could not send the link.' }, { status: 500 })
  }
  queueNotificationEmails()
  return NextResponse.json({ ok: true, to: client.email })
}
