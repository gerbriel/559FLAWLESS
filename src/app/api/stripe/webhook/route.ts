import { NextResponse, after, type NextRequest } from 'next/server'
import { syncAppointmentToCalendar } from '@/lib/calendar-push'
import { logError } from '@/lib/log-error'
import type Stripe from 'stripe'
import { getStripe, stripeConfigured } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import { queueNotificationEmails } from '@/lib/notification-email'

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
      case 'checkout.session.expired': {
        const session = event.data.object
        const kind = session.metadata?.kind

        // A retail bag nobody paid for. This used to live in a second
        // `case` for the same event further down, which a switch never
        // reaches, so expired orders sat at pending_payment forever.
        if (kind === 'product_order') {
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
          break
        }

        if (kind !== 'appointment_deposit') break
        const appointmentId = session.metadata?.appointment_id
        if (!appointmentId) break

        // A hold nobody paid for, released the moment Stripe gives up on the
        // session (080). The function refuses anything requested or paid, so
        // a retry — or a client who paid through a second session — is safe.
        must(
          await admin.rpc('release_unpaid_hold', { p_appointment: appointmentId }),
          `release unpaid hold ${appointmentId}`
        )
        break
      }

      case 'checkout.session.completed': {
        const session = event.data.object
        const kind = session.metadata?.kind

        if (kind === 'membership' && session.mode === 'subscription') {
          // Joining online with renewal (083). Stripe owns the card and the
          // billing period from here; see migration 083's header.
          const membershipId = Number(session.metadata?.membership_id)
          const clientId = session.metadata?.client_id
          const subscriptionId = stripeId(session.subscription)
          const customerId = stripeId(session.customer)
          if (!membershipId || !clientId || !subscriptionId) break

          // Idempotency: a retried checkout event finds the membership this
          // subscription already enrolled. It still falls through to the
          // settle below, which is itself idempotent, so a retry that follows
          // a half-finished first attempt completes it.
          const { data: linked } = must(
            await admin
              .from('client_memberships')
              .select('id')
              .eq('stripe_subscription_id', subscriptionId)
              .maybeSingle(),
            `look up membership for ${subscriptionId}`
          )

          if (!linked) {
            // The ids go on in the same insert as the enrolment, not after it,
            // so there is no moment at which an invoice event could find a
            // membership that exists but cannot be matched to its subscription.
            // The enrol trigger (050) still sets the price snapshot and period,
            // and raises the first period's `due` charge; the settle below
            // re-anchors that period to Stripe's and marks it paid.
            const inserted = await admin
              .from('client_memberships')
              .insert({
                client_id: clientId,
                membership_id: membershipId,
                status: 'active',
                note: 'Joined online, renews automatically',
                stripe_subscription_id: subscriptionId,
                stripe_customer_id: customerId,
                auto_renew: true,
              })
              .select('id')
              .single()

            if (inserted.error) {
              // A concurrent delivery of this same event won the insert.
              const { data: raced } = await admin
                .from('client_memberships')
                .select('id')
                .eq('stripe_subscription_id', subscriptionId)
                .maybeSingle()
              if (!raced) {
                // 23505 here is the one-live-membership index: they already
                // hold one. Stripe is now billing a subscription nobody
                // enrolled, so it is cancelled and its first charge refunded
                // (see refundUnenrolledMembership), and the log says so.
                void logError('stripe/webhook', inserted.error.message, {
                  step: 'membership_subscription_enrol',
                  client_id: clientId,
                  membership_id: membershipId,
                  subscription: subscriptionId,
                  amount_cents: session.amount_total,
                })
                if (inserted.error.code === '23505') {
                  await refundUnenrolledMembership(session)
                  break
                }
                throw new Error(`enrol membership for ${clientId}: ${inserted.error.message}`)
              }
            }
          }

          // Settle the first invoice here rather than waiting for invoice.paid,
          // which usually arrived BEFORE this event and found no membership to
          // settle. Also mirror the subscription's state, for the same reason:
          // customer.subscription.updated may already have come and gone.
          const subscription = await getStripe().subscriptions.retrieve(subscriptionId, {
            expand: ['latest_invoice', 'latest_invoice.payments'],
          })
          const item = subscription.items.data[0]
          must(
            await admin.rpc('sync_membership_subscription', {
              p_subscription: subscriptionId,
              p_cancel_at_period_end: askedToStop(subscription),
              p_period_start: item ? isoFromSeconds(item.current_period_start) : null,
              p_period_end: item ? isoFromSeconds(item.current_period_end) : null,
              p_status: subscription.status,
            }),
            `sync subscription ${subscriptionId}`
          )

          const invoice =
            subscription.latest_invoice && typeof subscription.latest_invoice !== 'string'
              ? subscription.latest_invoice
              : null
          const period = invoice ? invoicePeriod(invoice) : null
          if (invoice && invoice.status === 'paid' && period) {
            must(
              await admin.rpc('settle_membership_invoice', {
                p_subscription: subscriptionId,
                p_invoice: invoice.id,
                p_period_start: period.start,
                p_period_end: period.end,
                p_amount_cents: invoice.amount_paid,
                p_payment_intent: invoicePaymentIntent(invoice),
              }),
              `settle first invoice ${invoice.id}`
            )
          }
          break
        }

        if (kind === 'membership') {
          // Joining online (078). Enrol, then mark the first period paid.
          const membershipId = Number(session.metadata?.membership_id)
          const clientId = session.metadata?.client_id
          const intent = paymentIntentId(session)
          if (!membershipId || !clientId) break

          // Idempotency: this payment intent already settled a period.
          if (intent) {
            const { data: settled } = await admin
              .from('membership_charges')
              .select('id')
              .eq('stripe_payment_intent_id', intent)
              .limit(1)
            if (settled && settled.length > 0) break
          }

          // The enrol trigger (050) sets the price snapshot and the period end
          // from the plan, and writes the first period's charge as `due`.
          const inserted = await admin
            .from('client_memberships')
            .insert({
              client_id: clientId,
              membership_id: membershipId,
              status: 'active',
              note: 'Joined online',
            })
            .select('id, current_period_start')
            .single()
          let enrolled = inserted.data
          const enrolError = inserted.error

          // A retry of this same event can land after the enrolment but before
          // the charge was marked: the membership exists and its first period
          // is still `due`. Finish that one rather than stopping short.
          if (enrolError?.code === '23505') {
            const { data: pending } = await admin
              .from('client_memberships')
              .select('id, current_period_start, membership_charges(status)')
              .eq('client_id', clientId)
              .eq('membership_id', membershipId)
              .eq('note', 'Joined online')
              .order('created_at', { ascending: false })
              .limit(1)
              .maybeSingle()
            const charges = (pending?.membership_charges ?? []) as { status: string }[]
            if (pending && charges.some((c) => c.status === 'due')) enrolled = pending
          }

          if (!enrolled) {
            // 23505: they already hold a live membership (one per person). The
            // money has moved for nothing, so it goes straight back (see
            // refundUnenrolledMembership). A retry would only fail again.
            void logError('stripe/webhook', enrolError?.message ?? 'membership enrol failed', {
              step: 'membership_enrol',
              client_id: clientId,
              membership_id: membershipId,
              payment_intent: intent,
              amount_cents: session.amount_total,
            })
            if (enrolError?.code === '23505') {
              await refundUnenrolledMembership(session)
              break
            }
            throw new Error(`enrol membership for ${clientId}: ${enrolError?.message}`)
          }

          must(
            await admin
              .from('membership_charges')
              .update({
                status: 'paid',
                method: 'stripe',
                paid_at: new Date().toISOString(),
                amount_cents: session.amount_total ?? undefined,
                stripe_payment_intent_id: intent,
                note: 'Paid online at sign-up',
              })
              .eq('client_membership_id', enrolled.id)
              .eq('period_start', enrolled.current_period_start),
            `mark membership ${enrolled.id} paid`
          )
        }

        if (kind === 'appointment_deposit') {
          const appointmentId = session.metadata?.appointment_id
          if (!appointmentId) break

          const { data: appointment } = await admin
            .from('appointments')
            .select('id, client_id, deposit_status, deposit_cents, requested_at')
            .eq('id', appointmentId)
            .maybeSingle()

          if (!appointment) {
            // Money arrived for a hold that is gone — released as unpaid before
            // this event got here. Loud, because somebody has to refund it.
            void logError('stripe/webhook', 'deposit paid for an appointment that no longer exists', {
              appointment_id: appointmentId,
              payment_intent: paymentIntentId(session),
              amount_cents: session.amount_total,
              customer_email: session.customer_details?.email ?? null,
            })
            break
          }
          // Idempotency: a retry finds it already paid and stops here.
          if (appointment.deposit_status === 'paid') break

          const becameRequest = appointment.requested_at === null
          must(
            await admin
              .from('appointments')
              .update({
                deposit_status: 'paid',
                stripe_payment_intent_id: paymentIntentId(session),
                // The deposit is the ticket in (080): paying it is what makes
                // this a request. Same statement as the payment, so a retry
                // can never leave one without the other.
                requested_at: appointment.requested_at ?? new Date().toISOString(),
              })
              .eq('id', appointmentId),
            `mark deposit paid for ${appointmentId}`
          )

          // Now that it is a request, it belongs on the provider's Google
          // Calendar — booking.ts deliberately did not push the unpaid hold.
          if (becameRequest) after(() => syncAppointmentToCalendar(appointmentId))

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

      // ── Renewing memberships (083) ──────────────────────────
      // Every handler below ignores anything that is not a membership
      // subscription, and every database call is idempotent: Stripe retries,
      // and sends these in no promised order.
      case 'invoice.paid':
      case 'invoice.payment_succeeded': {
        // Stripe sends both for one invoice; the second finds it settled.
        const invoice = event.data.object
        const subscriptionId = await membershipSubscriptionOf(invoice)
        const period = invoicePeriod(invoice)
        if (!subscriptionId || !period) break

        const { data: chargeId } = must(
          await admin.rpc('settle_membership_invoice', {
            p_subscription: subscriptionId,
            p_invoice: invoice.id,
            p_period_start: period.start,
            p_period_end: period.end,
            p_amount_cents: invoice.amount_paid,
            p_payment_intent: invoicePaymentIntent(invoice),
          }),
          `settle invoice ${invoice.id}`
        )
        if (chargeId === null) {
          // The usual order for a first invoice: it beat the checkout event
          // that enrols the member. Not an error and not retried; the checkout
          // handler retrieves the subscription and settles this invoice.
          console.info('[stripe/webhook] invoice paid before enrolment', {
            invoice: invoice.id,
            subscription: subscriptionId,
          })
        }
        break
      }

      case 'invoice.payment_failed': {
        const invoice = event.data.object
        const subscriptionId = await membershipSubscriptionOf(invoice)
        if (!subscriptionId) break
        const period = invoicePeriod(invoice)

        must(
          await admin.rpc('fail_membership_invoice', {
            p_subscription: subscriptionId,
            p_invoice: invoice.id,
            p_period_start: period?.start ?? null,
            p_period_end: period?.end ?? null,
            p_amount_cents: invoice.amount_due,
          }),
          `fail invoice ${invoice.id}`
        )
        break
      }

      case 'customer.subscription.updated': {
        const subscription = event.data.object
        if (subscription.metadata?.kind !== 'membership') break
        // In this API version the period lives on the subscription ITEM, not
        // the subscription. A membership subscription has exactly one item.
        const item = subscription.items.data[0]

        must(
          await admin.rpc('sync_membership_subscription', {
            p_subscription: subscription.id,
            p_cancel_at_period_end: askedToStop(subscription),
            p_period_start: item ? isoFromSeconds(item.current_period_start) : null,
            p_period_end: item ? isoFromSeconds(item.current_period_end) : null,
            p_status: subscription.status,
          }),
          `sync subscription ${subscription.id}`
        )
        break
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object
        if (subscription.metadata?.kind !== 'membership') break

        must(
          await admin.rpc('end_membership_subscription', {
            p_subscription: subscription.id,
            p_ended_at: isoFromSeconds(subscription.ended_at ?? event.created),
          }),
          `end subscription ${subscription.id}`
        )
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

          // A membership period paid by this intent (078 pay-once, or a
          // renewing invoice since 083) is marked refunded too. The membership
          // itself is left as it is: whether a refund also ends it is a
          // person's decision, not the webhook's. Setting a status twice is
          // harmless, so this needs no idempotency check of its own.
          must(
            await admin
              .from('membership_charges')
              .update({ status: 'refunded' })
              .eq('stripe_payment_intent_id', intentId),
            `mark membership charge refunded for ${intentId}`
          )

          // Who it goes back to. Without this the refund row carried neither
          // a client nor an appointment, so it could never come off anybody's
          // total — and since 081 that total is what the counter calls
          // lifetime value. Read from the appointment the intent paid for;
          // a refund against a retail order has no appointment and keeps the
          // nulls, which is honest rather than guessed.
          const { data: refunded } = await admin
            .from('appointments')
            .select('id, client_id')
            .eq('stripe_payment_intent_id', intentId)
            .maybeSingle()

          must(
            await admin.from('payments').insert({
              amount_cents: -(charge.amount_refunded ?? 0),
              method: 'card',
              kind: 'refund',
              appointment_id: refunded?.id ?? null,
              client_id: refunded?.client_id ?? null,
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

  // Payments ring bells through triggers (referral settled, and more to
  // come) — mirror them before acknowledging Stripe.
  queueNotificationEmails()

  return NextResponse.json({ received: true })
}

/**
 * Undo a membership checkout that could not be enrolled because the person
 * already holds a live one (050's one-live index). The membership route
 * refuses a second purchase up front, but two tabs can both pass that check,
 * and the loser has paid for a membership that does not exist. Leaving it for
 * a person to notice meant the money sat with the studio, and a subscription
 * kept charging every period, until somebody read the error log.
 *
 * Subscription mode: cancel the subscription so it never bills again, then
 * refund the payment intent behind its first invoice. Payment mode: refund the
 * session's payment intent. Refunds carry an idempotency key, so a retried
 * event does not refund twice. Any Stripe failure is logged, never thrown:
 * the event itself was handled, and a 500 would only repeat the same attempt.
 */
async function refundUnenrolledMembership(session: Stripe.Checkout.Session): Promise<void> {
  const stripe = getStripe()
  try {
    let intent: string | null = null
    if (session.mode === 'subscription') {
      const subscriptionId = stripeId(session.subscription)
      if (subscriptionId) {
        const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
          expand: ['latest_invoice', 'latest_invoice.payments'],
        })
        if (subscription.status !== 'canceled') {
          await stripe.subscriptions.cancel(subscriptionId)
        }
        const invoice =
          subscription.latest_invoice && typeof subscription.latest_invoice !== 'string'
            ? subscription.latest_invoice
            : null
        intent = invoice ? invoicePaymentIntent(invoice) : null
      }
    } else if (session.mode === 'payment') {
      intent = paymentIntentId(session)
    }

    if (intent) {
      await stripe.refunds.create(
        { payment_intent: intent },
        { idempotencyKey: `membership-unenrolled-${intent}` }
      )
    }
    void logError('stripe/webhook', 'membership not enrolled, refunded automatically', {
      step: 'membership_refund_unenrolled',
      session: session.id,
      mode: session.mode,
      payment_intent: intent,
      amount_cents: session.amount_total,
    })
  } catch (err) {
    void logError('stripe/webhook', err, {
      step: 'membership_refund_unenrolled',
      session: session.id,
      mode: session.mode,
      amount_cents: session.amount_total,
    })
  }
}

function paymentIntentId(session: Stripe.Checkout.Session): string | null {
  if (!session.payment_intent) return null
  return typeof session.payment_intent === 'string'
    ? session.payment_intent
    : session.payment_intent.id
}

function stripeId(ref: string | { id: string } | null | undefined): string | null {
  if (!ref) return null
  return typeof ref === 'string' ? ref : ref.id
}

function isoFromSeconds(seconds: number): string {
  return new Date(seconds * 1000).toISOString()
}

/**
 * Has the member (or the studio) asked this subscription to stop? Stripe has
 * two ways to say so: `cancel_at_period_end`, which the manage route sets, and
 * `cancel_at`, which the billing portal sets in newer API versions. Either one
 * means it will not renew, and that is all the database needs to know.
 */
function askedToStop(subscription: Stripe.Subscription): boolean {
  return subscription.cancel_at_period_end || subscription.cancel_at !== null
}

/**
 * The period an invoice bills for, from its first line. The invoice's own
 * period_start/period_end describe when items were gathered, not the service
 * period, which is a different (earlier) range on a renewal.
 */
function invoicePeriod(invoice: Stripe.Invoice): { start: string; end: string } | null {
  const line = invoice.lines?.data?.[0]
  if (!line?.period) return null
  return { start: isoFromSeconds(line.period.start), end: isoFromSeconds(line.period.end) }
}

/** The PaymentIntent that paid an invoice, when the payload carries it. */
function invoicePaymentIntent(invoice: Stripe.Invoice): string | null {
  const payment = invoice.payments?.data?.find((p) => p.payment.type === 'payment_intent')
  return stripeId(payment?.payment.payment_intent)
}

/**
 * The membership subscription an invoice belongs to, or null for anything
 * else (a one-off invoice, some future non-membership subscription). In this
 * API version the subscription lives at `invoice.parent.subscription_details`,
 * with a snapshot of its metadata. That snapshot is only populated for invoices
 * finalised after mid-2023 and is empty on a draft, so when it says nothing the
 * subscription itself is asked.
 */
async function membershipSubscriptionOf(invoice: Stripe.Invoice): Promise<string | null> {
  const details = invoice.parent?.subscription_details
  const subscriptionId = stripeId(details?.subscription)
  if (!subscriptionId) return null
  if (details?.metadata?.kind) {
    return details.metadata.kind === 'membership' ? subscriptionId : null
  }
  const subscription = await getStripe().subscriptions.retrieve(subscriptionId)
  return subscription.metadata?.kind === 'membership' ? subscriptionId : null
}
