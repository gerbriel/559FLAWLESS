import { NextResponse, type NextRequest } from 'next/server'
import { logError } from '@/lib/log-error'
import type Stripe from 'stripe'
import { getStripe, stripeConfigured } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'

export const dynamic = 'force-dynamic'

/**
 * Stripe webhook — the authoritative record that money moved.
 *
 * The browser landing on a success_url proves nothing; only a signature-verified
 * event does. Deposits are marked paid here, retail orders flip to `paid` here
 * (which is what triggers the stock decrement), and both write a `payments` row.
 *
 * Handlers are idempotent: Stripe retries, and a retry must not double-decrement
 * stock or write a second payment row.
 */
export async function POST(request: NextRequest) {
  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'stripe_not_configured' }, { status: 503 })
  }

  const secret = process.env.STRIPE_WEBHOOK_SECRET
  if (!secret) {
    console.error('STRIPE_WEBHOOK_SECRET is not set — refusing to trust the payload')
    return NextResponse.json({ error: 'webhook_not_configured' }, { status: 503 })
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 400 })
  }

  // Signature verification needs the exact bytes Stripe sent, so read the raw
  // body — never request.json().
  const raw = await request.text()

  let event: Stripe.Event
  try {
    event = getStripe().webhooks.constructEvent(raw, signature, secret)
  } catch (err) {
    console.error('stripe signature verification failed', err)
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 })
  }

  const admin = createAdminClient()

  /**
   * supabase-js does not throw — it resolves with { error } — so without this
   * the try/catch below could never fire for a failed write, the handler
   * returned 200 anyway, and Stripe stopped retrying an event whose money was
   * recorded nowhere. Throwing turns a failed write back into the 500 the
   * catch already promises, and the idempotency checks above each write are
   * what make the retry safe.
   */
  const must = <T extends { error: { message: string } | null }>(res: T, what: string): T => {
    if (res.error) {
      throw new Error(`${what}: ${res.error.message}`)
    }
    return res
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object
        const kind = session.metadata?.kind

        if (kind === 'appointment_deposit') {
          const appointmentId = session.metadata?.appointment_id
          if (!appointmentId) break

          const { data: appointment } = await admin
            .from('appointments')
            .select('id, client_id, deposit_status, deposit_cents')
            .eq('id', appointmentId)
            .maybeSingle()

          // Idempotency: a retry finds it already paid and stops here.
          if (!appointment || appointment.deposit_status === 'paid') break

          must(
            await admin
              .from('appointments')
              .update({
                deposit_status: 'paid',
                stripe_payment_intent_id: paymentIntentId(session),
              })
              .eq('id', appointmentId),
            `mark deposit paid for ${appointmentId}`
          )

          must(
            await admin.from('payments').insert({
              amount_cents: session.amount_total ?? appointment.deposit_cents,
              method: 'card',
              kind: 'deposit',
              appointment_id: appointmentId,
              client_id: appointment.client_id,
              stripe_payment_intent_id: paymentIntentId(session),
              status: 'succeeded',
            }),
            `record deposit payment for ${appointmentId}`
          )
        }

        if (kind === 'appointment_balance') {
          const appointmentId = session.metadata?.appointment_id
          if (!appointmentId) break

          // Idempotency: this session's payment intent is the key. A retry
          // finds the row it already wrote and stops here.
          const intent = paymentIntentId(session)
          if (intent) {
            const { data: existing } = await admin
              .from('payments')
              .select('id')
              .eq('stripe_payment_intent_id', intent)
              .eq('kind', 'service')
              .limit(1)
            if (existing && existing.length > 0) break
          }

          const { data: appointment } = await admin
            .from('appointments')
            .select('id, client_id')
            .eq('id', appointmentId)
            .maybeSingle()
          if (!appointment) break

          must(
            await admin.from('payments').insert({
              amount_cents: session.amount_total ?? 0,
              method: 'card',
              kind: 'service',
              appointment_id: appointmentId,
              client_id: appointment.client_id,
              stripe_payment_intent_id: intent,
              status: 'succeeded',
              note: 'Balance paid online',
            }),
            `record balance payment for ${appointmentId}`
          )
        }

        if (kind === 'product_order') {
          const orderId = Number(session.metadata?.order_id)
          if (!Number.isInteger(orderId)) break

          const { data: order } = await admin
            .from('orders')
            .select('id, status, client_id, total_cents')
            .eq('id', orderId)
            .maybeSingle()

          // Idempotency: only the cart -> paid transition decrements stock, and
          // an already-paid order is left alone.
          if (!order || order.status === 'paid' || order.status === 'completed') break

          must(
            await admin
              .from('orders')
              .update({
                status: 'paid',
                paid_at: new Date().toISOString(),
                stripe_payment_intent_id: paymentIntentId(session),
              })
              .eq('id', orderId),
            `mark order ${orderId} paid`
          )

          must(
            await admin.from('payments').insert({
              amount_cents: session.amount_total ?? order.total_cents,
              method: 'card',
              kind: 'product',
              order_id: orderId,
              client_id: order.client_id,
              stripe_payment_intent_id: paymentIntentId(session),
              status: 'succeeded',
            }),
            `record order payment for ${orderId}`
          )
        }
        break
      }

      case 'checkout.session.expired': {
        const session = event.data.object
        if (session.metadata?.kind === 'product_order') {
          const orderId = Number(session.metadata?.order_id)
          if (Number.isInteger(orderId)) {
            must(
              await admin
                .from('orders')
                .update({ status: 'cancelled' })
                .eq('id', orderId)
                .eq('status', 'pending_payment'),
              `cancel expired order ${orderId}`
            )
          }
        }
        break
      }

      case 'charge.refunded': {
        const charge = event.data.object
        const intentId =
          typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id

        if (intentId) {
          // Idempotency: this was the one handler with none, so a retried
          // event inserted the negative row twice and the refund ledger
          // doubled. The charge id is the natural key.
          const { data: already } = must(
            await admin
              .from('payments')
              .select('id')
              .eq('kind', 'refund')
              .eq('stripe_charge_id', charge.id)
              .limit(1),
            `check refund idempotency for ${charge.id}`
          )
          if (already && already.length > 0) break

          must(
            await admin
              .from('appointments')
              .update({ deposit_status: 'refunded' })
              .eq('stripe_payment_intent_id', intentId),
            `mark deposit refunded for ${intentId}`
          )

          must(
            await admin.from('payments').insert({
              amount_cents: -(charge.amount_refunded ?? 0),
              method: 'card',
              kind: 'refund',
              stripe_payment_intent_id: intentId,
              stripe_charge_id: charge.id,
              status: 'refunded',
            }),
            `record refund for ${charge.id}`
          )
        }
        break
      }

      default:
        // Unhandled event types are acknowledged so Stripe stops retrying.
        break
    }
  } catch (err) {
    // A 500 makes Stripe retry, which is what we want for a transient failure.
    void logError('stripe/webhook', err, { event_type: event.type, event_id: event.id })
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 })
  }

  return NextResponse.json({ received: true })
}

function paymentIntentId(session: Stripe.Checkout.Session): string | null {
  if (!session.payment_intent) return null
  return typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent.id
}
