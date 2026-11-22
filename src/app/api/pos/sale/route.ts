import { NextResponse, type NextRequest } from 'next/server'
import { logError } from '@/lib/log-error'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { multibuyDiscountCents, multibuyPromo, type PromotionRule } from '@/lib/promotions'
import { isFrontDesk, isManager, type UserRole } from '@/types/database'
import { currentMembershipPerks } from '@/lib/memberships'
import { bestProductPerk, type PerkUnit } from '@/lib/member-product-perks'
import { pricePosServices, recordPosVisit, type PosPaymentMethod, type PosVisit } from '@/lib/pos-visit'
import type Stripe from 'stripe'
import { queueNotificationEmails } from '@/lib/notification-email'
import { getStripe, siteUrl, stripeConfigured } from '@/lib/stripe'
import { addMinutes } from '@/lib/time'

export const dynamic = 'force-dynamic'

const SaleSchema = z
  .object({
    clientId: z.string().uuid().nullish(),
    guestName: z.string().trim().max(120).nullish(),
    items: z
      .array(
        z.object({
          productId: z.number().int().positive(),
          qty: z.number().int().positive().max(999),
        })
      )
      .max(50)
      .default([]),
    /**
     * Treatments rung up in the same sale. They become a completed visit
     * (src/lib/pos-visit.ts), priced server-side like every booking; the one
     * payment settles that visit first and the rest lands on the order.
     */
    serviceIds: z.array(z.number().int().positive()).max(6).default([]),
    /**
     * An amount typed in at the till — an add-on, a touch-up, a debt from
     * before the app, or the whole sale before anyone has listed what it was
     * for. Products and services can be put against it later from Orders.
     *
     * With `applyToAppointments`, the amount pays off what those visits still
     * owe first, and only what is left over becomes the custom line.
     *
     * The one place a price comes from the browser, on purpose: it is the
     * desk's own figure, it is front desk and up only (checked below), and the
     * order records who rang it up.
     */
    custom: z
      .object({
        description: z.string().trim().min(1).max(120),
        amountCents: z.number().int().min(1).max(1_000_000),
        taxable: z.boolean().default(false),
      })
      .nullish(),
    /**
     * How the money is taken. The first eight are taken at the counter and
     * recorded now. `phone_link` (the client pays a Stripe Checkout link on
     * their own phone) and `stripe_app` (staff charge it with Tap to Pay in
     * the Stripe app) are taken through Stripe: the sale is written, the
     * money is NOT recorded, and a till ticket waits for the webhook (090).
     */
    paymentMethod: z.enum([
      'cash',
      'card',
      'apple_pay',
      'zelle',
      'paypal',
      'venmo',
      'cashapp',
      'other',
      'phone_link',
      'stripe_app',
    ]),
    appointmentId: z.string().uuid().nullish(),
    /** The client's own visits whose balance the custom amount settles first. */
    applyToAppointments: z.array(z.string().uuid()).max(10).default([]),
    notes: z.string().trim().max(500).nullish(),
    /** Manager-only, verified below. Integer cents off before tax. */
    discountCents: z.number().int().min(0).max(1_000_000).default(0),
  })
  .refine((v) => v.clientId || v.guestName, {
    message: 'Name the customer, even if only as a walk-in.',
  })
  .refine((v) => v.items.length > 0 || v.custom || v.serviceIds.length > 0, {
    message: 'Add something to the sale first.',
  })
  .refine((v) => v.applyToAppointments.length === 0 || (v.custom && v.clientId), {
    message: 'Only a custom amount for a named client can go against their balance.',
  })
  // A ticket settles one visit and one order. Old balances riding on a sale
  // that may never be paid would have to be unwound on expiry, so they are
  // taken on their own (or on the visit) instead.
  .refine(
    (v) =>
      v.applyToAppointments.length === 0 ||
      (v.paymentMethod !== 'phone_link' && v.paymentMethod !== 'stripe_app'),
    {
      message:
        'An old balance cannot ride on a card payment through Stripe. Untick it under Pay off first, or take it on its own.',
    }
  )

/** Minutes a till ticket waits before it lapses (090). */
const TICKET_MINUTES = 30
/** Stripe will not charge a card less than this, in cents. */
const STRIPE_MINIMUM_CENTS = 50

/** Fresno County's combined rate, unless the studio has set its own. */
const DEFAULT_TAX_RATE = 0.0835

/**
 * Ring up an in-person sale.
 *
 * Prices and stock are read from the database here rather than trusted from the
 * browser — the till is a staff tool, but "staff" includes whoever is standing
 * at an unlocked iPad, and a mispriced receipt is a real loss.
 *
 * The order is written as a cart and then moved to `paid`, because the
 * status-change trigger is what decrements stock. Writing it as paid outright
 * would sell the product without ever taking it off the shelf.
 *
 * Services and products in one sale, one payment. Everything about the
 * products is checked first (stock, price, sold to clients), then the visit is
 * written unpaid, then the order. The money is recorded last: the visit's
 * total on the visit, any old balances the custom amount settles, and the rest
 * on the order. With services and nothing else, no order is written and the
 * payment goes on the visit, as service-sale does.
 *
 * The manager's discount comes off the services first and whatever is left of
 * it off the products. A custom amount is never discounted.
 *
 * If the order fails once the visit exists, the visit is NOT removed:
 * completing it drew down back-bar stock, spent any included session and
 * settled loyalty. The response is 409 `visit_recorded_unpaid` so the desk
 * knows the visit is on the record owing and the products were not sold.
 *
 * Taken through Stripe (`phone_link`, `stripe_app`; 090): everything above is
 * written the same, except no payments row and the order stops at
 * `pending_payment`, so no stock moves yet. A till ticket for the whole
 * amount waits 30 minutes, and for `phone_link` a Checkout Session is made
 * for it. The response adds `awaiting: true` and
 * `ticket: { id, method, amount_cents, expires_at, checkout_url? }`; the
 * webhook settles the ticket when Stripe says the money moved. A failure
 * opening the ticket or the session cancels the pending order and answers
 * like an order failure (409 `visit_recorded_unpaid` when a visit stands).
 * Old balances (`applyToAppointments`) are refused with these two methods.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const { data: staff } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!staff || staff.suspended_at || !isFrontDesk(staff.role)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsed = SaleSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'invalid_request',
        message: parsed.error.issues[0]?.message ?? 'Check the sale and try again.',
      },
      { status: 400 }
    )
  }

  const {
    clientId,
    guestName,
    items,
    serviceIds,
    custom,
    paymentMethod,
    appointmentId,
    applyToAppointments,
    notes,
  } = parsed.data
  const admin = createAdminClient()

  // Taken through Stripe (090): the sale is written exactly as below, but the
  // money is not recorded and the order waits at pending_payment. What the
  // ledger will say when it lands is 'card'.
  const throughStripe = paymentMethod === 'phone_link' || paymentMethod === 'stripe_app'
  const ledgerMethod: PosPaymentMethod = throughStripe ? 'card' : paymentMethod
  if (paymentMethod === 'phone_link' && !stripeConfigured()) {
    return NextResponse.json(
      { error: 'stripe_not_configured', message: 'Stripe is not set up, so there is no payment link to show.' },
      { status: 503 }
    )
  }

  // ── What the typed amount settles first ──────────────────────
  // Balances are re-derived here from `payments`, the same arithmetic as the
  // Orders page: the browser says WHICH visits, never how much they owe.
  const applied: { appointmentId: string; cents: number; kind: 'deposit' | 'service' }[] = []
  if (custom && clientId && applyToAppointments.length > 0) {
    const [{ data: visits, error: visitError }, { data: paidRows, error: paidError }] = await Promise.all([
      admin
        .from('appointments')
        .select('id, starts_at, status, total_cents')
        .in('id', applyToAppointments)
        .eq('client_id', clientId)
        .not('status', 'in', '(cancelled,no_show)')
        .order('starts_at', { ascending: true }),
      admin
        .from('payments')
        .select('appointment_id, amount_cents')
        .in('appointment_id', applyToAppointments)
        .eq('status', 'succeeded'),
    ])

    if (visitError || paidError || !visits) {
      return NextResponse.json(
        { error: 'lookup_failed', message: 'Could not read what that client owes.' },
        { status: 500 }
      )
    }

    // A visit a till sale is waiting on a card payment for (090) is not paid
    // off here as well: the card would land on a visit already settled.
    const { data: waiting } = await admin
      .from('till_tickets')
      .select('appointment_id')
      .in('appointment_id', applyToAppointments)
      .eq('status', 'awaiting')
    const awaitingCard = new Set((waiting ?? []).map((t) => t.appointment_id))

    let left = custom.amountCents
    for (const v of visits) {
      if (left <= 0) break
      if (awaitingCard.has(v.id)) continue
      const taken = (paidRows ?? [])
        .filter((p) => p.appointment_id === v.id)
        .reduce((sum, p) => sum + p.amount_cents, 0)
      const owed = Math.max(v.total_cents - taken, 0)
      const cents = Math.min(owed, left)
      if (cents <= 0) continue
      // Same rule as TakePayment: a first, partial payment is the deposit.
      applied.push({
        appointmentId: v.id,
        cents,
        kind: taken === 0 && cents < v.total_cents ? 'deposit' : 'service',
      })
      left -= cents
    }
  }
  const appliedCents = applied.reduce((sum, a) => sum + a.cents, 0)
  // What is left of the typed amount after the balances — the custom line.
  const extraCents = (custom?.amountCents ?? 0) - appliedCents

  /**
   * Record the balance payments. Run as the signed-in staff member, not the
   * service role, so `processed_by` says who took the money.
   *
   * The visit this request wrote goes first, ahead of the old balances. It is
   * not run through the client check above: the server created it a moment
   * ago, and that check exists to stop a caller naming someone else's visit.
   */
  async function settleBalances(): Promise<string | null> {
    const due = [
      ...(visit && visit.totalCents > 0
        ? [{ appointmentId: visit.appointmentId, cents: visit.totalCents, kind: 'service' as const }]
        : []),
      ...applied,
    ]
    for (const a of due) {
      const { error } = await supabase.rpc('record_payment', {
        p_amount_cents: a.cents,
        p_kind: a.kind,
        p_method: ledgerMethod,
        p_appointment: a.appointmentId,
        p_note: notes ?? null,
      })
      if (error) {
        void logError('pos/sale', error.message, { step: 'settle_balance', appointment_id: a.appointmentId })
        return a.appointmentId
      }
    }
    return null
  }

  // Written below, once the products have been checked.
  let visit: PosVisit | null = null

  // The whole amount went on balances: nothing left to sell, so no order.
  if (custom && extraCents <= 0 && items.length === 0 && serviceIds.length === 0) {
    const failed = await settleBalances()
    if (failed && failed === applied[0]?.appointmentId) {
      return NextResponse.json(
        { error: 'sale_failed', message: 'Could not record that payment. Nothing was taken.' },
        { status: 500 }
      )
    }
    return NextResponse.json(
      {
        ok: true,
        order: null,
        applied,
        applied_cents: appliedCents,
        total_cents: appliedCents,
        ...(failed ? { warning: 'Part of that payment did not record. Check the visit under Orders.' } : {}),
      },
      { status: 201 }
    )
  }

  // Merge duplicate lines so two scans of the same product are one line of two,
  // and so the stock check below sees the true quantity.
  const wanted = new Map<number, number>()
  for (const it of items) {
    wanted.set(it.productId, (wanted.get(it.productId) ?? 0) + it.qty)
  }

  const { data: products, error: productError } =
    wanted.size === 0
      ? { data: [], error: null }
      : await admin
          .from('products')
          .select('id, name, sku, price_cents, category_id, stock_qty, is_active, is_retail, external_url')
          .in('id', [...wanted.keys()])

  if (productError || !products) {
    return NextResponse.json(
      { error: 'lookup_failed', message: 'Could not read the products.' },
      { status: 500 }
    )
  }

  const lines: {
    product_id: number
    category_id: number | null
    name_snapshot: string
    sku_snapshot: string | null
    unit_price_cents: number
    qty: number
  }[] = []

  for (const [productId, qty] of wanted) {
    const p = products.find((row) => row.id === productId)
    if (!p) {
      return NextResponse.json(
        { error: 'unknown_product', message: 'One of those products no longer exists.' },
        { status: 400 }
      )
    }
    if (!p.is_active || !p.is_retail) {
      return NextResponse.json(
        { error: 'not_for_sale', message: `${p.name} is not sold to clients.` },
        { status: 400 }
      )
    }
    // The Rhonda Allison catalogue was seeded without prices — the marketplace
    // owned them. Selling at the counter needs the studio's own figure, and
    // ringing up $0 is worse than refusing.
    if (p.price_cents <= 0) {
      return NextResponse.json(
        {
          error: 'no_price',
          message: `${p.name} has no price yet. Set one under Inventory before selling it.`,
          productId,
        },
        { status: 409 }
      )
    }
    if (Number(p.stock_qty) < qty) {
      return NextResponse.json(
        {
          error: 'out_of_stock',
          message: `Only ${Number(p.stock_qty)} of ${p.name} on the shelf.`,
          productId,
          available: Number(p.stock_qty),
          // The studio's Rhonda Allison storefront can ship it instead.
          externalUrl: p.external_url,
        },
        { status: 409 }
      )
    }

    lines.push({
      product_id: p.id,
      category_id: p.category_id,
      name_snapshot: p.name,
      sku_snapshot: p.sku,
      unit_price_cents: p.price_cents,
      qty,
    })
  }

  const productSubtotal = lines.reduce((sum, l) => sum + l.unit_price_cents * l.qty, 0)
  const customCents = custom ? extraCents : 0

  // The multibuy deal (068): "buy 2 get the 3rd half off". Computed from the
  // whole basket, cheapest units first, before the order exists — the items
  // trigger reads discount_cents off the order when it rolls up the total.
  const { data: promoRows } = await admin
    .from('promotions')
    .select(
      'id, name, kind, percent_off, amount_cents, sale_price_cents, min_items, service_ids, starts_at, ends_at, is_active'
    )
    .eq('is_active', true)
    .eq('kind', 'product_multibuy')
  const multibuy = multibuyPromo((promoRows ?? []) as PromotionRule[], Date.now())
  const multibuyCents = multibuy
    ? multibuyDiscountCents(
        multibuy,
        lines.flatMap((l) => Array<number>(l.qty).fill(l.unit_price_cents))
      )
    : 0

  // A named client's membership perks (086), each priced over the whole
  // basket, the single best one kept. It competes with the multibuy deal and
  // the better single cut wins (no stacking). A tie goes to the membership:
  // it is the client's own entitlement, and the receipt should say so.
  const memberPerks = clientId && lines.length > 0 ? await currentMembershipPerks(clientId) : null
  const units: PerkUnit[] = lines.flatMap((l) =>
    Array.from({ length: l.qty }, () => ({
      productId: l.product_id,
      categoryId: l.category_id,
      priceCents: l.unit_price_cents,
    }))
  )
  // A limited perk (087) whose uses are spent sits out; the next best competes.
  let memberBest = memberPerks
    ? bestProductPerk(memberPerks.perks, units, memberPerks.availability)
    : null

  const { data: rateSetting } = await admin
    .from('site_settings')
    .select('text_value')
    .eq('key', 'sales_tax_rate')
    .eq('is_active', true)
    .maybeSingle()

  const parsedRate = Number(rateSetting?.text_value)
  const taxRate =
    Number.isFinite(parsedRate) && parsedRate >= 0 && parsedRate < 1 ? parsedRate : DEFAULT_TAX_RATE

  const staffRole = staff.role as UserRole
  const staffId = user.id
  // The manager's typed discount, verified here: anyone else loses the field.
  let typedDiscount = isManager(staffRole) ? parsed.data.discountCents : 0

  // ── A card minimum, checked before anything is written ───────
  // Stripe will not charge under 50 cents. The services are priced read-only
  // here (the visit is not written yet), and the figure is an upper bound: a
  // membership can only take more off. Under the floor and above zero is
  // refused now; a sale a membership brings under it after the visit exists
  // gets the same code in its 409 (see openTicket).
  if (throughStripe) {
    const servicesCents = serviceIds.length > 0 ? await pricePosServices(admin, serviceIds) : 0
    if (servicesCents !== null) {
      const productDeal = Math.max(multibuyCents, memberBest?.off ?? 0)
      const productsAfterDeal = Math.max(productSubtotal - productDeal, 0)
      const leftoverDiscount = Math.max(typedDiscount - servicesCents, 0)
      const productsDue = Math.max(productsAfterDeal - leftoverDiscount, 0)
      const taxEstimate = Math.round((productsDue + (custom?.taxable ? customCents : 0)) * taxRate)
      const estimate =
        Math.max(servicesCents - typedDiscount, 0) + productsDue + customCents + taxEstimate
      if (estimate > 0 && estimate < STRIPE_MINIMUM_CENTS) {
        return NextResponse.json(
          {
            error: 'below_card_minimum',
            message: 'Stripe cannot charge a card under $0.50. Take this one as cash.',
          },
          { status: 409 }
        )
      }
    }
  }

  // ── The visit, when services are in the sale ─────────────────
  // Written unpaid: the money is recorded once, below, after the products
  // are certain. The discount comes off the services first; what the visit
  // could not use carries over to the products.
  if (serviceIds.length > 0) {
    const outcome = await recordPosVisit(admin, {
      staffId: user.id,
      clientId: clientId ?? null,
      guestName: guestName ?? null,
      serviceIds,
      paymentMethod: ledgerMethod,
      notes: notes ?? null,
      discountCents: typedDiscount,
      recordPayment: false,
    })
    if (!outcome.ok) {
      // Nothing was written that stands, so nothing was sold.
      return NextResponse.json({ error: outcome.error, message: outcome.message }, { status: outcome.status })
    }
    visit = outcome.visit
    typedDiscount = Math.max(typedDiscount - visit.discountCents, 0)
    queueNotificationEmails()
  }

  /** What the receipt shows of the visit. */
  const visitPart = visit
    ? {
        appointment_id: visit.appointmentId,
        lines: visit.lines.map((l) => ({ name: l.name, price_cents: l.priceCents })),
        subtotal_cents: visit.subtotalCents,
        discount_cents: visit.discountCents,
        membership_cents: visit.membershipCents,
        membership_name: visit.membershipName,
        total_cents: visit.totalCents,
      }
    : null
  const visitCents = visit?.totalCents ?? 0

  /**
   * A failure on the order side. Before a visit exists it is the plain error;
   * after, the visit stands (completing it had side effects) and the desk is
   * told it is on the record owing while the products were not sold.
   */
  function orderFailed(status: number, body: { error: string; message: string }) {
    if (!visit) return NextResponse.json(body, { status })
    // Too little for a card once the membership came off: say exactly that.
    if (body.error === 'below_card_minimum') {
      return NextResponse.json(
        {
          error: 'below_card_minimum',
          message: `${body.message} The visit is on the client's record with that balance owing.`,
          visit: visitPart,
        },
        { status: 409 }
      )
    }
    return NextResponse.json(
      {
        error: 'visit_recorded_unpaid',
        message:
          'The visit is on the client\'s record with a balance owing, but the products were not sold and nothing was charged. Take payment on the visit, then ring up the products again.',
        visit: visitPart,
      },
      { status: 409 }
    )
  }

  /**
   * Open a till ticket for a sale taken through Stripe (090), and for
   * phone_link the Checkout Session behind its QR code. Everything the sale
   * wrote stands. On a failure here the pending order is cancelled (nothing
   * was sold, stock was never taken, its perk claim stops counting) and the
   * visit, when there is one, stays on the record owing, the same 409 the
   * order failure gives.
   */
  async function openTicket(
    orderId: number | null,
    cents: number,
    deal: { promotionId: number; name: string; cents: number } | null = null
  ): Promise<
    | { ok: true; ticket: { id: number; method: string; amount_cents: number; expires_at: string; checkout_url?: string } }
    | { ok: false; response: NextResponse }
  > {
    async function undo(status: number, body: { error: string; message: string }) {
      if (orderId) {
        await admin.from('orders').update({ status: 'cancelled' }).eq('id', orderId).eq('status', 'pending_payment')
      }
      return { ok: false as const, response: orderFailed(status, body) }
    }

    if (cents < STRIPE_MINIMUM_CENTS) {
      return undo(409, {
        error: 'below_card_minimum',
        message: 'Stripe cannot charge a card under $0.50. Take this one as cash.',
      })
    }

    const now = new Date()
    const expiresAt = addMinutes(now, TICKET_MINUTES)
    const { data: ticket, error: ticketError } = await admin
      .from('till_tickets')
      .insert({
        order_id: orderId,
        appointment_id: visit?.appointmentId ?? null,
        client_id: clientId ?? null,
        guest_name: clientId ? null : (guestName ?? 'Walk-in'),
        amount_cents: cents,
        method: paymentMethod as 'phone_link' | 'stripe_app',
        created_by: staffId,
        expires_at: expiresAt.toISOString(),
        note: notes ?? null,
        // Written to promotion_redemptions by settle_till_ticket, once paid.
        multibuy_promotion_id: deal?.promotionId ?? null,
        multibuy_promotion_name: deal?.name ?? null,
        multibuy_discount_cents: deal?.cents ?? 0,
      })
      .select('id, method, amount_cents, expires_at')
      .single()
    if (ticketError || !ticket) {
      void logError('pos/sale', ticketError?.message ?? 'ticket insert failed', { step: 'ticket_insert', order_id: orderId })
      return undo(500, { error: 'sale_failed', message: 'Could not start the card payment. Nothing was charged.' })
    }

    if (paymentMethod !== 'phone_link') return { ok: true, ticket }

    let email: string | null = null
    if (clientId) {
      const { data: who } = await admin.from('profiles').select('email').eq('id', clientId).maybeSingle()
      email = who?.email?.trim() || null
    }

    let session: Stripe.Checkout.Session | null = null
    try {
      const metadata = { kind: 'till_ticket', ticket_id: String(ticket.id) }
      session = await getStripe().checkout.sessions.create({
        mode: 'payment',
        // Stripe wants a session to live at least 30 minutes, measured from
        // its own clock; a minute past the ticket keeps the request above
        // that floor. The webhook's session.expired is what closes the ticket.
        expires_at: Math.floor(addMinutes(expiresAt, 1).getTime() / 1000),
        customer_email: email ?? undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'usd',
              unit_amount: cents,
              product_data: { name: `559 Flawless, sale #${ticket.id}` },
            },
          },
        ],
        metadata,
        payment_intent_data: { metadata },
        success_url: `${siteUrl()}/pay/done`,
        cancel_url: `${siteUrl()}/pay/cancelled`,
      })
      const { error: linkError } = await admin
        .from('till_tickets')
        .update({ stripe_session_id: session.id, stripe_checkout_url: session.url })
        .eq('id', ticket.id)
      if (linkError) throw new Error(linkError.message)
      return { ok: true, ticket: { ...ticket, checkout_url: session.url ?? undefined } }
    } catch (err) {
      void logError('pos/sale', err, { step: 'checkout_session', ticket_id: ticket.id })
      // A session made but not saved would be a live link nobody can see:
      // close it at Stripe so it can never be paid.
      if (session) {
        try {
          await getStripe().checkout.sessions.expire(session.id)
        } catch (expireErr) {
          void logError('pos/sale', expireErr, { step: 'checkout_session_expire', ticket_id: ticket.id })
        }
      }
      const failure = {
        error: 'stripe_failed',
        message: 'Stripe did not make a payment link. Nothing was charged. Try again or take it another way.',
      }
      // The ticket goes with the order.
      const { error: expireError } = await admin.rpc('expire_till_ticket', { p_ticket: ticket.id })
      if (expireError) {
        void logError('pos/sale', expireError.message, { step: 'ticket_expire', ticket_id: ticket.id })
        await admin.from('till_tickets').update({ status: 'expired' }).eq('id', ticket.id).eq('status', 'awaiting')
        return undo(502, failure)
      }
      return { ok: false, response: orderFailed(502, failure) }
    }
  }

  // ── Services and nothing else: no order, the payment goes on the visit ──
  if (visit && lines.length === 0 && customCents <= 0 && throughStripe && visitCents > 0) {
    const opened = await openTicket(null, visitCents)
    if (!opened.ok) return opened.response
    return NextResponse.json(
      {
        ok: true,
        awaiting: true,
        order: null,
        order_lines: [],
        visit: visitPart,
        visit_cents: visitCents,
        discount_cents: 0,
        membership_cents: 0,
        membership_name: null,
        applied: [],
        applied_cents: 0,
        total_cents: visitCents,
        ticket: opened.ticket,
      },
      { status: 201 }
    )
  }
  if (visit && lines.length === 0 && customCents <= 0) {
    const failed = await settleBalances()
    return NextResponse.json(
      {
        ok: true,
        order: null,
        order_lines: [],
        visit: visitPart,
        visit_cents: visitCents,
        discount_cents: 0,
        membership_cents: 0,
        membership_name: null,
        applied,
        applied_cents: appliedCents,
        total_cents: visitCents + appliedCents,
        ...(failed
          ? {
              warning:
                failed === visit.appointmentId
                  ? 'The visit is recorded but its payment did not save. Take payment on the visit under Orders.'
                  : 'The balance payment did not record. Take it on the visit instead.',
            }
          : {}),
      },
      { status: 201 }
    )
  }

  /**
   * The whole price of the sale for a given member perk cut. A function,
   * because a perk that loses its claim below (no use left) is priced out and
   * the sale is priced again without it.
   */
  function priceSale(memberCents: number) {
    const source: 'membership' | 'multibuy' | null =
      memberCents > 0 && memberCents >= multibuyCents
        ? 'membership'
        : multibuy && multibuyCents > 0
          ? 'multibuy'
          : null
    const promoDiscount =
      source === 'membership' ? memberCents : source === 'multibuy' ? multibuyCents : 0

    // The manager's hand-typed discount rides on top of the winning deal but
    // is verified above: a front-desk request has already lost the field, and
    // the sum can never exceed the products being sold. What is left here is
    // what the services did not use. A custom amount is already the desk's
    // own figure; discounting it as well would be the same thing twice.
    const manual = Math.min(typedDiscount, Math.max(productSubtotal - promoDiscount, 0))
    const discount = promoDiscount + manual

    // Tax follows what the customer actually pays, not the pre-deal figure. A
    // custom amount is taxed only when the desk says it is goods; an add-on
    // treatment or an old balance is not.
    const taxableCents =
      Math.max(productSubtotal - discount, 0) + (custom?.taxable ? customCents : 0)
    const tax = Math.round(taxableCents * taxRate)
    return { source, promoDiscount, discount, tax }
  }
  let { source, promoDiscount, discount, tax } = priceSale(memberBest?.off ?? 0)

  const { data: order, error: orderError } = await admin
    .from('orders')
    .insert({
      client_id: clientId ?? null,
      guest_name: clientId ? null : (guestName ?? 'Walk-in'),
      status: 'cart',
      channel: 'in_store',
      fulfillment: 'pickup',
      payment_method: ledgerMethod,
      sold_by: user.id,
      // A custom amount that settled a visit's balance belongs to that visit,
      // which is also what the attach-rate figure reads.
      appointment_id: appointmentId ?? visit?.appointmentId ?? applied[0]?.appointmentId ?? null,
      staff_notes: notes ?? null,
      tax_cents: tax,
      discount_cents: discount,
      // Which deal supplied the deal part of discount_cents. The manual
      // discount is not a source; it rides on top.
      discount_source: source,
      client_membership_id: source === 'membership' ? memberPerks!.clientMembershipId : null,
      // The deal's own cut, kept apart from the manual amount on top.
      deal_discount_cents: promoDiscount,
    })
    .select('id')
    .single()

  if (orderError || !order) {
    void logError('pos/sale', orderError?.message ?? 'order insert failed', { step: 'order_insert' })
    return orderFailed(500, { error: 'sale_failed', message: 'Could not start that sale.' })
  }

  // A membership perk that won is claimed now, before the lines go in (the
  // items trigger rolls the total up from discount_cents and tax_cents, so
  // they must be final first). claim_perk_use (087) takes a lock, counts the
  // uses and writes the redemption row only if one is left. A perk refused
  // there, or one whose claim errors, sits out and the sale is priced again
  // without it: the desk never hands over a discount that was not counted,
  // and the receipt staff see comes from this response, so it shows what was
  // actually charged.
  if (source === 'membership' && memberPerks && memberBest) {
    const pricedSource = source
    const pricedDiscount = discount
    const refused = new Set<number>()
    while (source === 'membership' && memberBest) {
      const { data: claimed, error: claimError } = await admin.rpc('claim_perk_use', {
        p_perk: memberBest.perk.id,
        p_client_membership: memberPerks.clientMembershipId,
        p_client: clientId ?? null,
        p_order: order.id,
        p_discount_cents: promoDiscount,
        p_units: memberBest.units,
      })
      if (claimError || typeof claimed !== 'boolean') {
        void logError('pos/sale', claimError?.message ?? 'claim_perk_use returned no answer', {
          step: 'perk_claim',
          order_id: order.id,
          perk_id: memberBest.perk.id,
        })
      } else if (claimed) {
        break
      }
      refused.add(memberBest.perk.id)
      memberBest = bestProductPerk(
        memberPerks.perks.filter((p) => !refused.has(p.id)),
        units,
        memberPerks.availability
      )
      ;({ source, promoDiscount, discount, tax } = priceSale(memberBest?.off ?? 0))
    }

    if (source !== pricedSource || discount !== pricedDiscount) {
      const { error: repriceError } = await admin
        .from('orders')
        .update({
          tax_cents: tax,
          discount_cents: discount,
          discount_source: source,
          client_membership_id: source === 'membership' ? memberPerks.clientMembershipId : null,
          deal_discount_cents: promoDiscount,
        })
        .eq('id', order.id)
      if (repriceError) {
        // Still a cart: nothing paid, nothing off the shelf, so removing it is clean.
        await admin.from('orders').delete().eq('id', order.id)
        void logError('pos/sale', repriceError.message, { step: 'perk_reprice', order_id: order.id })
        return orderFailed(500, { error: 'sale_failed', message: 'Could not price that sale.' })
      }
    }
  }

  const { error: itemsError } = await admin.from('order_items').insert([
    // category_id rode along only for the perk arithmetic; order_items has none.
    ...lines.map((l) => ({
      order_id: order.id,
      product_id: l.product_id,
      name_snapshot: l.name_snapshot,
      sku_snapshot: l.sku_snapshot,
      unit_price_cents: l.unit_price_cents,
      qty: l.qty,
    })),
    ...(custom && customCents > 0
      ? [
          {
            order_id: order.id,
            kind: 'custom' as const,
            product_id: null,
            name_snapshot: custom.description,
            sku_snapshot: null,
            // What is left after the balances: the balances are paid on
            // their visits, not again on this order.
            unit_price_cents: customCents,
            qty: 1,
          },
        ]
      : []),
  ])

  if (itemsError) {
    // Nothing has been paid or decremented yet, so removing the shell is clean.
    await admin.from('orders').delete().eq('id', order.id)
    void logError('pos/sale', itemsError.message, { step: 'items_insert' })
    return orderFailed(500, { error: 'sale_failed', message: 'Could not add those items.' })
  }

  // The item trigger has recomputed subtotal and total from the lines; it reads
  // tax_cents off the order, which was set at insert. Moving out of `cart`
  // assigns the order number and decrements stock.
  //
  // `completed`, not `paid`: the customer is holding the bottle. `paid` is what
  // the Orders page treats as "still to fulfil", which is right for an online
  // order waiting to be packed and wrong for a sale handed over at the counter.
  //
  // Taken through Stripe, it moves to `pending_payment` instead: numbered,
  // nothing off the shelf (only paid and completed take stock, 021), and
  // settle_till_ticket() completes it when the money lands (090).
  const { data: paid, error: payError } = await admin
    .from('orders')
    .update(
      throughStripe
        ? { status: 'pending_payment' }
        : { status: 'completed', paid_at: new Date().toISOString() }
    )
    .eq('id', order.id)
    .select('id, order_number, subtotal_cents, tax_cents, total_cents')
    .single()

  if (payError || !paid) {
    void logError('pos/sale', payError?.message ?? 'mark paid failed', { step: 'mark_paid' })
    // Nothing was sold, so a perk use claimed for it goes back now rather
    // than waiting out claim_perk_use's in-flight window on a dead cart.
    await admin.from('membership_perk_redemptions').delete().eq('order_id', order.id)
    return orderFailed(500, {
      error: 'sale_failed',
      message: 'The sale was not completed. Nothing was charged.',
    })
  }

  // Record the money as well as the sale. Without this the order shows as
  // fully outstanding on the ledger, because `payments` is what a balance is
  // computed from — the Stripe webhook writes one for every online order and
  // the counter has to do the same.
  // Through Stripe, the webhook writes it instead (settle_till_ticket).
  const { error: paymentError } = throughStripe
    ? { error: null }
    : await admin.rpc('record_payment', {
        p_amount_cents: paid.total_cents,
        p_kind: 'product',
        p_method: ledgerMethod,
        p_order: paid.id,
        p_note: notes ?? null,
      })

  if (paymentError) {
    // The sale itself stands — the customer has paid and has the product. A
    // missing ledger row is a reconciliation problem, not a reason to fail the
    // transaction in front of them.
    void logError('pos/sale', paymentError.message, { step: 'record_payment', order_id: paid.id })
  }

  // The deal's paper trail: who it was and how much came off. A membership
  // perk win was written by claim_perk_use above, before the sale went
  // through; a multibuy win lands in promotion_redemptions. Best effort: the
  // sale stands either way.
  // Through Stripe the deal is not used until the sale is paid: the ticket
  // carries it and settle_till_ticket writes the row (090).
  if (!throughStripe && multibuy && source === 'multibuy' && promoDiscount > 0) {
    const { error: redemptionError } = await admin.from('promotion_redemptions').insert({
      promotion_id: multibuy.id,
      promotion_name: multibuy.name,
      client_id: clientId ?? null,
      order_id: paid.id,
      discount_cents: promoDiscount,
    })
    if (redemptionError) {
      void logError('pos/sale', redemptionError.message, { step: 'promo_redemption', order_id: paid.id })
    }
  }

  // The balances last, once the sale is certain: a failed order must not
  // leave money recorded against a visit for a sale that never happened.
  // The visit this request wrote is among them, first.
  // Through Stripe nothing is recorded yet: the ticket waits for the webhook
  // with the whole of it (no old balances ride on such a sale, see above).
  let ticket: Extract<Awaited<ReturnType<typeof openTicket>>, { ok: true }>['ticket'] | null = null
  if (throughStripe) {
    const cents = paid.total_cents + visitCents
    if (cents > 0) {
      const opened = await openTicket(
        paid.id,
        cents,
        multibuy && source === 'multibuy' && promoDiscount > 0
          ? { promotionId: multibuy.id, name: multibuy.name, cents: promoDiscount }
          : null
      )
      if (!opened.ok) return opened.response
      ticket = opened.ticket
    } else {
      // Nothing to charge (a deal took it all): handed over now, like cash.
      await admin
        .from('orders')
        .update({ status: 'completed', paid_at: new Date().toISOString() })
        .eq('id', paid.id)
        .eq('status', 'pending_payment')
    }
  }

  const failed =
    !throughStripe && (applied.length > 0 || visitCents > 0) ? await settleBalances() : null

  return NextResponse.json(
    {
      ok: true,
      ...(ticket ? { awaiting: true, ticket } : {}),
      order: paid,
      // What was sold on the order, for the receipt.
      order_lines: [
        ...lines.map((l) => ({
          name: l.name_snapshot,
          qty: l.qty,
          line_cents: l.unit_price_cents * l.qty,
        })),
        ...(custom && customCents > 0
          ? [{ name: custom.description, qty: 1, line_cents: customCents }]
          : []),
      ],
      visit: visitPart,
      visit_cents: visitCents,
      discount_cents: discount,
      // What a membership perk took off, the way service-sale reports it.
      membership_cents: source === 'membership' ? promoDiscount : 0,
      membership_name: source === 'membership' ? memberPerks!.planName : null,
      applied,
      applied_cents: appliedCents,
      total_cents: paid.total_cents + appliedCents + visitCents,
      ...(failed
        ? {
            warning:
              visit && failed === visit.appointmentId
                ? 'The visit is recorded but its payment did not save. Take payment on the visit under Orders.'
                : 'The balance payment did not record. Take it on the visit instead.',
          }
        : {}),
    },
    { status: 201 }
  )
}
