import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getStripe, stripeConfigured, siteUrl } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkoutCustomer } from '@/lib/stripe-customer'
import { createClient } from '@/lib/supabase/server'
import { membershipPeriodLabel } from '@/types/memberships'

export const dynamic = 'force-dynamic'

const Body = z.object({
  membership_id: z.number().int().positive(),
  auto_renew: z.boolean().optional().default(false),
})

/**
 * Stripe bills a month interval at most twelve times over. A plan with a
 * longer period than that (050 allows up to 24 months) cannot be a
 * subscription and is sold pay-once instead.
 */
const STRIPE_MAX_MONTHS = 12

/**
 * Stripe Checkout for joining a membership online (078).
 *
 * The caller names WHICH plan; the amount is the plan's own price, read here
 * (rule 2). Nothing is enrolled by this route — the webhook does that when
 * Stripe says the money moved, and the enrol trigger snapshots the price again
 * from the plan, so a tampered session could not buy a cheaper membership even
 * if one could be minted.
 *
 * Signed-in only: a membership belongs to an account, because its sessions are
 * spent from that account's bookings.
 *
 * Two modes (083). Pay-once is the 078 path: one payment for one period, and
 * the studio records later periods by hand. Renewing (`auto_renew: true`, and
 * only when the plan has `auto_renew_offered`) opens Checkout in subscription
 * mode, so Stripe holds the card and charges it every period; the webhook
 * enrols on checkout.session.completed and settles each invoice after that.
 * Asking to renew on a plan that does not offer it falls back to pay-once
 * rather than failing: the member still gets what the page sold them.
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

  const admin = createAdminClient()

  // A suspended account buys nothing. Read with the role, from profiles on
  // the server, never from the request.
  const { data: profile } = await admin
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()
  if (profile?.suspended_at) {
    return NextResponse.json({ error: 'suspended' }, { status: 403 })
  }

  const [{ data: plan }, { data: live }] = await Promise.all([
    admin
      .from('memberships')
      .select('id, name, description, price_cents, period_months, is_active, sell_online, auto_renew_offered')
      .eq('id', parsed.data.membership_id)
      .maybeSingle(),
    // One live membership per person (050's partial unique index). Refused here
    // so nobody pays for a second one the webhook could not enrol. Same
    // predicate as the index, and no date filter: an active row past its end
    // date, or a past_due one, still blocks the insert.
    admin
      .from('client_memberships')
      .select('id')
      .eq('client_id', user.id)
      .in('status', ['active', 'past_due'])
      .limit(1),
  ])

  if (!plan || !plan.is_active || !plan.sell_online || plan.price_cents <= 0) {
    return NextResponse.json({ error: 'not_for_sale' }, { status: 404 })
  }
  if ((live ?? []).length > 0) {
    return NextResponse.json(
      { error: 'already_member', message: 'You already have a membership running.' },
      { status: 409 }
    )
  }

  const months = plan.period_months === 1 ? '1 month' : `${plan.period_months} months`
  const renewing =
    parsed.data.auto_renew &&
    plan.auto_renew_offered &&
    plan.period_months <= STRIPE_MAX_MONTHS

  const metadata = {
    kind: 'membership',
    membership_id: String(plan.id),
    client_id: user.id,
  }
  // The client's one Stripe customer (091), so a second plan, a deposit and
  // a bag all land on the same person at Stripe (050 gap 1). The membership
  // row still gets its own copy from the webhook, as before.
  const stripe = getStripe()
  const payer = (
    await checkoutCustomer(admin, stripe, { userId: user.id, email: user.email }, renewing ? 'subscription' : 'payment')
  ).params
  // The webhook is what enrols; these are only where the browser lands.
  const success_url = `${siteUrl()}/memberships/welcome?joined=1`
  const cancel_url = `${siteUrl()}/memberships`

  const session = renewing
    ? await stripe.checkout.sessions.create({
        mode: 'subscription',
        ...payer,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: plan.price_cents,
              recurring: { interval: 'month', interval_count: plan.period_months },
              product_data: {
                name: plan.name,
                description: `Renews every ${membershipPeriodLabel(plan.period_months)} until you stop it. Each visit is booked separately and confirmed by the studio.`,
              },
            },
          },
        ],
        // On the subscription too, so every invoice and subscription event can
        // be recognised as a membership without a lookup.
        subscription_data: { metadata },
        success_url,
        cancel_url,
        metadata: { ...metadata, auto_renew: '1' },
      })
    : await stripe.checkout.sessions.create({
        mode: 'payment',
        ...payer,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: plan.price_cents,
              product_data: {
                name: `${plan.name}, ${months}`,
                description:
                  'Paid up front. Each visit is booked separately and confirmed by the studio.',
              },
            },
          },
        ],
        success_url,
        cancel_url,
        metadata,
      })

  return NextResponse.json({ url: session.url })
}
