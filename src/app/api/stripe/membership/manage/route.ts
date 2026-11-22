import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getStripe, stripeConfigured, siteUrl } from '@/lib/stripe'
import { logError } from '@/lib/log-error'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'
import { isManager } from '@/types/database'

export const dynamic = 'force-dynamic'

const Body = z.object({
  action: z.enum(['stop_renewing', 'resume_renewing', 'billing_portal', 'end_now']),
  client_membership_id: z.number().int().positive().optional(),
})

/**
 * Managing a renewing membership (083): stop it renewing, start it again, end
 * it today, or hand the member to Stripe's billing portal to change their card.
 *
 * Stripe is the record of the subscription, so every change is made THERE
 * first and mirrored locally second. The local write is not the authority: the
 * customer.subscription.updated webhook writes the same three columns through
 * sync_membership_subscription(), and both writes are idempotent, so whichever
 * lands second changes nothing. The local write exists so the page the member
 * returns to already says the right thing.
 *
 * Who may act on which membership:
 *   - With no client_membership_id, the caller's own live membership (active or
 *     past_due, newest).
 *   - With one, the caller's own row, or anybody's if the caller is a manager
 *     or admin. The role is read from profiles on the server, never from the
 *     request. Writes then go through the admin client, because 050 gives
 *     clients no UPDATE on client_memberships at all, and that is right: what a
 *     member may change is exactly these actions, checked here, not a column.
 *
 * Responses: { ok: true, auto_renew } for the two toggles and end_now, { url }
 * for the portal, { error: '<snake_case>' } otherwise.
 */
export async function POST(request: NextRequest) {
  if (!stripeConfigured()) {
    return NextResponse.json({ error: 'stripe_not_configured' }, { status: 503 })
  }

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_request' }, { status: 400 })
  }
  const { action, client_membership_id } = parsed.data

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 })
  }

  // Role and suspension, both from profiles on the server. A suspended
  // account changes nothing here, its own membership included.
  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()
  if (profile?.suspended_at) {
    return NextResponse.json({ error: 'suspended' }, { status: 403 })
  }

  const admin = createAdminClient()

  const lookup = admin
    .from('client_memberships')
    .select(
      'id, client_id, status, current_period_end, cancel_at_period_end, cancelled_at, auto_renew, stripe_subscription_id, stripe_customer_id'
    )

  const { data: target } =
    client_membership_id === undefined
      ? await lookup
          .eq('client_id', user.id)
          .in('status', ['active', 'past_due'])
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      : await lookup.eq('id', client_membership_id).maybeSingle()

  if (!target) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  if (target.client_id !== user.id) {
    if (!profile || !isManager(profile.role)) {
      // The same answer as a row that does not exist: whether somebody else
      // holds membership N is not this caller's business.
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
  }

  const stripe = getStripe()

  if (action === 'billing_portal') {
    if (!target.stripe_customer_id) {
      return NextResponse.json({ error: 'not_a_subscription' }, { status: 409 })
    }
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer: target.stripe_customer_id,
        return_url: `${siteUrl()}/memberships`,
      })
      return NextResponse.json({ url: portal.url })
    } catch (err) {
      void logError('stripe/membership/manage', err, {
        step: 'billing_portal',
        client_membership_id: target.id,
      })
      return NextResponse.json({ error: 'stripe_failed' }, { status: 502 })
    }
  }

  const subscriptionId = target.stripe_subscription_id
  if (!subscriptionId) {
    return NextResponse.json({ error: 'not_a_subscription' }, { status: 409 })
  }

  if (action === 'end_now') {
    // Cancel in Stripe first, or it keeps billing whatever the row says. A
    // subscription that is already over (an earlier end_now, the portal, a
    // webhook that beat us here) is the outcome asked for, not a failure.
    try {
      await stripe.subscriptions.cancel(subscriptionId)
    } catch (err) {
      let alreadyOver = false
      try {
        const existing = await stripe.subscriptions.retrieve(subscriptionId)
        alreadyOver =
          existing.status === 'canceled' || existing.status === 'incomplete_expired'
      } catch {
        // Fall through to the failure below.
      }
      if (!alreadyOver) {
        void logError('stripe/membership/manage', err, {
          step: 'end_now',
          client_membership_id: target.id,
        })
        return NextResponse.json({ error: 'stripe_failed' }, { status: 502 })
      }
    }

    // Idempotent: a row that has already ended keeps the dates it ended with.
    if (target.status !== 'cancelled' && target.status !== 'expired') {
      const stamp = new Date().toISOString()
      const { error } = await admin
        .from('client_memberships')
        .update({
          status: 'cancelled',
          cancelled_at: target.cancelled_at ?? stamp,
          ended_at: stamp,
          auto_renew: false,
          cancel_at_period_end: false,
        })
        .eq('id', target.id)
        .in('status', ['active', 'past_due'])
      if (error) {
        // Stripe has cancelled it; customer.subscription.deleted will mirror it.
        void logError('stripe/membership/manage', error.message, {
          step: 'end_now_local',
          client_membership_id: target.id,
        })
      }
    }
    return NextResponse.json({ ok: true, auto_renew: false })
  }

  if (target.status === 'cancelled' || target.status === 'expired') {
    return NextResponse.json({ error: 'membership_ended' }, { status: 409 })
  }

  if (action === 'stop_renewing') {
    try {
      await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true })
    } catch (err) {
      void logError('stripe/membership/manage', err, {
        step: 'stop_renewing',
        client_membership_id: target.id,
      })
      return NextResponse.json({ error: 'stripe_failed' }, { status: 502 })
    }

    const { error } = await admin
      .from('client_memberships')
      .update({
        cancel_at_period_end: true,
        auto_renew: false,
        cancelled_at: target.cancelled_at ?? new Date().toISOString(),
      })
      .eq('id', target.id)
    if (error) {
      // Stripe has it; the webhook will mirror it. Say so in the log, not as a
      // failure to the member, whose request did take effect.
      void logError('stripe/membership/manage', error.message, {
        step: 'stop_renewing_local',
        client_membership_id: target.id,
      })
    }
    return NextResponse.json({ ok: true, auto_renew: false })
  }

  // resume_renewing. Only while the subscription is still alive in Stripe and
  // the period it would renew from has not already run out: a subscription
  // that has ended is a new sign-up, not a resumption.
  let subscription
  try {
    subscription = await stripe.subscriptions.retrieve(subscriptionId)
  } catch (err) {
    void logError('stripe/membership/manage', err, {
      step: 'resume_retrieve',
      client_membership_id: target.id,
    })
    return NextResponse.json({ error: 'stripe_failed' }, { status: 502 })
  }

  const periodEnd = subscription.items.data[0]?.current_period_end
  const periodOver =
    new Date(target.current_period_end).getTime() <= Date.now() ||
    (periodEnd !== undefined && periodEnd * 1000 <= Date.now())
  if (
    subscription.status === 'canceled' ||
    subscription.status === 'incomplete_expired' ||
    subscription.ended_at !== null ||
    periodOver
  ) {
    return NextResponse.json({ error: 'subscription_ended' }, { status: 409 })
  }

  try {
    // The billing portal (and newer API versions) can schedule the end with
    // `cancel_at` instead of `cancel_at_period_end`. Clear whichever is set;
    // Stripe refuses both in one request.
    await stripe.subscriptions.update(
      subscriptionId,
      subscription.cancel_at_period_end || subscription.cancel_at === null
        ? { cancel_at_period_end: false }
        : { cancel_at: '' }
    )
  } catch (err) {
    void logError('stripe/membership/manage', err, {
      step: 'resume_renewing',
      client_membership_id: target.id,
    })
    return NextResponse.json({ error: 'stripe_failed' }, { status: 502 })
  }

  const { error } = await admin
    .from('client_memberships')
    .update({ cancel_at_period_end: false, auto_renew: true, cancelled_at: null })
    .eq('id', target.id)
  if (error) {
    void logError('stripe/membership/manage', error.message, {
      step: 'resume_renewing_local',
      client_membership_id: target.id,
    })
  }
  return NextResponse.json({ ok: true, auto_renew: true })
}
