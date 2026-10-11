import { NextResponse, type NextRequest } from 'next/server'
import { z } from 'zod'
import { getStripe, stripeConfigured, siteUrl } from '@/lib/stripe'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

const Body = z.object({ membership_id: z.number().int().positive() })

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

  const [{ data: plan }, { data: live }] = await Promise.all([
    admin
      .from('memberships')
      .select('id, name, description, price_cents, period_months, is_active, sell_online')
      .eq('id', parsed.data.membership_id)
      .maybeSingle(),
    // One live membership per person (050's partial unique index). Refused here
    // so nobody pays for a second one the webhook could not enrol.
    admin
      .from('client_memberships')
      .select('id')
      .eq('client_id', user.id)
      .eq('status', 'active')
      .gt('current_period_end', new Date().toISOString())
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

  const session = await getStripe().checkout.sessions.create({
    mode: 'payment',
    customer_email: user.email ?? undefined,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: 'usd',
          unit_amount: plan.price_cents,
          product_data: {
            name: `${plan.name} — ${months}`,
            description:
              'Paid up front. Each visit is booked separately and confirmed by the studio.',
          },
        },
      },
    ],
    // The webhook is what enrols; these are only where the browser lands.
    success_url: `${siteUrl()}/memberships?joined=1`,
    cancel_url: `${siteUrl()}/memberships`,
    metadata: {
      kind: 'membership',
      membership_id: String(plan.id),
      client_id: user.id,
    },
  })

  return NextResponse.json({ url: session.url })
}
