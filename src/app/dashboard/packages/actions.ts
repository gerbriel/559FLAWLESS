'use server'

/**
 * Selling and spending prepaid service packages.
 *
 * Everything here runs as the signed-in staff member, not as the service role.
 * `client_packages` and `package_redemptions` are both `is_front_desk()` for
 * ALL (008), and `record_payment` (025) is SECURITY DEFINER but refuses a
 * client, so RLS is doing the actual work — the role check at the top of each
 * action exists to give a sentence back instead of an empty result set.
 *
 * Two things are read from the database rather than trusted from the browser,
 * for the same reason `priceService()` does it on the booking side: the price
 * of a package, and the price of the service a session is being spent on. The
 * caller names WHICH package and WHICH appointment, and nothing else.
 *
 * The one thing this cannot be is a single transaction. 008 ships no function
 * for redeeming, so a redemption is three statements — the row, the decrement,
 * the ledger entry — and each failure undoes the ones before it. See
 * `redeemSession` for the ordering and why it is that way round.
 */

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { DAY_MS, requestNow } from '@/lib/time'
import { isFrontDesk, type UserRole } from '@/types/database'
import type {
  PackageError,
  PackageOutcome,
  PackageSaleResult,
  RedemptionResult,
} from './errors'

const fail = (error: PackageError): { ok: false; error: PackageError } => ({ ok: false, error })

/** The signed-in staff member, or a refusal. */
async function requireFrontDesk() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return { supabase, user: null, error: 'unauthorized' as const }

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'client') as UserRole
  const allowed = !profile?.suspended_at && isFrontDesk(role)

  return { supabase, user, error: allowed ? null : ('forbidden' as const) }
}

interface CoveredLine {
  serviceId: number | null
  name: string
  priceCents: number
}

/**
 * What a package would pay for on this visit.
 *
 * A package names one service, so the covered amount is that line's frozen
 * price — the snapshot on `appointment_services`, not today's menu price. A
 * package with no service (`service_id` is nullable in 008) is an open one and
 * covers the dearest SERVICE on the visit, which is the reading that cannot
 * leave a client worse off for having booked two things at once.
 *
 * Add-on lines are excluded from that. `appointment_services` holds both — an
 * add-on row carries `addon_id` and a null `service_id` — and a session buys a
 * treatment, not the numbing gel that went with it.
 */
function coveredLine(packageServiceId: number | null, lines: CoveredLine[]): CoveredLine | null {
  if (packageServiceId === null) {
    return lines
      .filter((l) => l.serviceId !== null)
      .reduce<CoveredLine | null>(
        (best, l) => (best === null || l.priceCents > best.priceCents ? l : best),
        null
      )
  }
  const matches = lines.filter((l) => l.serviceId === packageServiceId)
  if (matches.length === 0) return null
  // Two of the same service on one visit is one session against the dearer.
  return matches.reduce((best, l) => (l.priceCents > best.priceCents ? l : best))
}

/**
 * What a package credit is called on the ledger.
 *
 * `payments` has no column pointing at the redemption that produced it, so the
 * note is the only handle. Two packages spent on one visit produce two credits
 * that are otherwise identical in method, kind and appointment — undoing one of
 * them has to be able to say which. One builder, used on the way in and on the
 * way back out.
 */
function creditNote(packageName: string, lineName: string): string {
  return `${packageName} — ${lineName}`
}

// ── Selling ─────────────────────────────────────────────────

/**
 * Sell one package at the counter.
 *
 * The money and the balance are written as one sale, so the client's timeline,
 * the ledger and the sessions they now hold all point at the same order:
 *
 *   1. an order, as a `cart`
 *   2. its single line — the package, at the price the database holds
 *   3. the `client_packages` row that is the actual thing bought
 *   4. the order moved to `completed`, which is what assigns its number
 *   5. the `payments` row, kind `package`
 *
 * `cart` first and `completed` afterwards for the same reason the retail till
 * does it: the status-change trigger is what finishes an order off. Steps 1–3
 * are all reversible, so a failure in any of them removes the shell and the
 * customer is told nothing was charged — which is true, because step 5 has not
 * run.
 *
 * No sales tax. A package is prepaid service time, and services are not
 * taxable in California; writing 8.35% of it into `tax_cents` would be
 * inventing a liability the client will never be asked for.
 */
export async function sellPackage(input: {
  packageId: number
  clientId: string
  paymentMethod: 'cash' | 'card' | 'other'
  note?: string | null
}): Promise<PackageOutcome<PackageSaleResult>> {
  const { supabase, user, error: authError } = await requireFrontDesk()
  if (authError) return fail(authError)
  if (!user) return fail('unauthorized')

  if (!input.clientId) return fail('client_required')

  // WHICH package, never what it costs. Same rule as the booking engine.
  const { data: pkg } = await supabase
    .from('service_packages')
    .select('id, name, session_count, price_cents, valid_days, is_active')
    .eq('id', input.packageId)
    .maybeSingle()

  if (!pkg) return fail('unknown_package')
  if (!pkg.is_active) return fail('package_inactive')

  const note = input.note?.trim() || null
  const now = requestNow()
  // Instant arithmetic on an instant — `valid_days` is a duration, not a wall
  // clock, so this needs no zone. 0 or less means it never expires.
  const expiresAt =
    pkg.valid_days > 0 ? new Date(now + pkg.valid_days * DAY_MS).toISOString() : null

  const { data: order, error: orderError } = await supabase
    .from('orders')
    .insert({
      client_id: input.clientId,
      status: 'cart',
      channel: 'in_store',
      fulfillment: 'pickup',
      payment_method: input.paymentMethod,
      sold_by: user.id,
      staff_notes: note,
      tax_cents: 0,
    })
    .select('id')
    .single()

  if (orderError || !order) {
    console.error('package order insert failed', orderError)
    return fail('sale_failed')
  }

  // product_id null: nothing comes off a shelf, so `order_decrement_stock`
  // skips the line. The line-total trigger and the order rollup treat it like
  // any other, which is the point of putting it here at all.
  const { error: itemError } = await supabase.from('order_items').insert({
    order_id: order.id,
    product_id: null,
    name_snapshot: `${pkg.name} — ${pkg.session_count} sessions`,
    sku_snapshot: null,
    unit_price_cents: pkg.price_cents,
    qty: 1,
  })

  if (itemError) {
    await supabase.from('orders').delete().eq('id', order.id)
    console.error('package order item insert failed', itemError)
    return fail('sale_failed')
  }

  const { data: balance, error: balanceError } = await supabase
    .from('client_packages')
    .insert({
      client_id: input.clientId,
      package_id: pkg.id,
      sessions_total: pkg.session_count,
      sessions_remaining: pkg.session_count,
      expires_at: expiresAt,
      order_id: order.id,
    })
    .select('id')
    .single()

  if (balanceError || !balance) {
    // Nothing has been paid and no order number has been assigned, so the
    // shell goes cleanly. Items cascade with it.
    await supabase.from('orders').delete().eq('id', order.id)
    console.error('client package insert failed', balanceError)
    return fail('sale_failed')
  }

  const { data: completed, error: completeError } = await supabase
    .from('orders')
    .update({ status: 'completed', paid_at: new Date(now).toISOString() })
    .eq('id', order.id)
    .select('id, order_number, total_cents')
    .single()

  if (completeError || !completed) {
    // client_packages.order_id is ON DELETE SET NULL, so the balance would
    // outlive an order that never happened. Remove it first, by hand.
    await supabase.from('client_packages').delete().eq('id', balance.id)
    await supabase.from('orders').delete().eq('id', order.id)
    console.error('package order completion failed', completeError)
    return fail('sale_failed')
  }

  // Kind `package`, method however they actually paid. `package` as a METHOD
  // means a session was spent, not that one was bought — see redeemSession.
  const { error: paymentError } = await supabase.rpc('record_payment', {
    p_amount_cents: completed.total_cents,
    p_kind: 'package',
    p_method: input.paymentMethod,
    p_order: completed.id,
    p_note: note,
  })

  if (paymentError) {
    // The customer has paid and holds the sessions. A missing ledger row is a
    // reconciliation problem, not a reason to unwind a completed sale in front
    // of them — the retail till takes the same view.
    console.error('package payment record failed', paymentError, { orderId: completed.id })
  }

  revalidatePath('/dashboard/packages')
  revalidatePath('/dashboard/packages/balances')
  revalidatePath(`/dashboard/clients/${input.clientId}`)

  return {
    ok: true,
    data: {
      orderId: completed.id,
      orderNumber: completed.order_number,
      clientPackageId: balance.id,
      totalCents: completed.total_cents,
      sessions: pkg.session_count,
      expiresAt,
      name: pkg.name,
    },
  }
}

// ── Spending ────────────────────────────────────────────────

/**
 * Spend one session against one appointment.
 *
 * The guard is `unique (appointment_id, client_package_id)` in 008 and nothing
 * else. This does not look first and then insert — two people checking a
 * client out on two iPads both pass that check and both write. It inserts, and
 * reads SQLSTATE 23505 back as `already_redeemed`, exactly the way
 * `src/lib/booking.ts` reads 23P01 back as `slot_taken`.
 *
 * Then two statements the constraint cannot cover:
 *
 *   • the decrement, written as a compare-and-set against the value just read,
 *     so a redemption on a DIFFERENT appointment landing in between loses
 *     rather than silently overwriting. `sessions_remaining >= 0` is a CHECK,
 *     so it can never go under either way.
 *   • the ledger row: kind `package`, method `package`, for the price of the
 *     covered service. This is what makes the client not pay again — there is
 *     no discount field to reach for, and inventing one would put a second
 *     answer beside `appointment_balance_cents()`, which is the sum of
 *     payments and nothing else.
 *
 * Order matters. The redemption goes first because it is the only step with a
 * real uniqueness guarantee; if either of the others fails, the ones before it
 * are undone and the caller is told nothing has changed. A stray credit with
 * no session behind it is far worse than a retry.
 */
export async function redeemSession(input: {
  clientPackageId: number
  appointmentId: string
}): Promise<PackageOutcome<RedemptionResult>> {
  const { supabase, error: authError } = await requireFrontDesk()
  if (authError) return fail(authError)

  const [{ data: balance }, { data: appointment }] = await Promise.all([
    supabase
      .from('client_packages')
      .select(
        'id, client_id, package_id, sessions_total, sessions_remaining, expires_at, service_packages(id, name, service_id)'
      )
      .eq('id', input.clientPackageId)
      .maybeSingle(),
    supabase
      .from('appointments')
      .select(
        'id, client_id, status, total_cents, appointment_services(service_id, name_snapshot, price_cents)'
      )
      .eq('id', input.appointmentId)
      .maybeSingle(),
  ])

  if (!balance) return fail('unknown_balance')
  if (!appointment) return fail('unknown_appointment')
  if (balance.client_id !== appointment.client_id) return fail('wrong_client')
  if (balance.sessions_remaining <= 0) return fail('no_sessions_left')
  if (balance.expires_at && new Date(balance.expires_at).getTime() <= requestNow()) {
    return fail('balance_expired')
  }
  if (appointment.status === 'cancelled' || appointment.status === 'no_show') {
    return fail('appointment_not_billable')
  }

  const definition = balance.service_packages as unknown as {
    id: number
    name: string
    service_id: number | null
  } | null

  const lines = (
    (appointment.appointment_services ?? []) as {
      service_id: number | null
      name_snapshot: string
      price_cents: number
    }[]
  ).map((l) => ({
    serviceId: l.service_id,
    name: l.name_snapshot,
    priceCents: l.price_cents,
  }))

  const covered = coveredLine(definition?.service_id ?? null, lines)
  if (!covered) return fail('service_not_covered')

  // What is still owed, from the ledger — never a stored flag. Redeeming
  // against a visit that is already settled would spend a session for nothing.
  const { data: taken } = await supabase
    .from('payments')
    .select('amount_cents')
    .eq('appointment_id', appointment.id)
    .eq('status', 'succeeded')

  const paidCents = (taken ?? []).reduce((sum, p) => sum + p.amount_cents, 0)
  const outstandingCents = Math.max(appointment.total_cents - paidCents, 0)
  // Integer cents throughout. A session pays off what is left of the line it
  // covers, and not a cent more.
  const coveredCents = Math.min(covered.priceCents, outstandingCents)
  if (coveredCents <= 0) return fail('nothing_to_cover')

  // ── 1. The row the constraint governs ─────────────────────
  const { data: redemption, error: redeemError } = await supabase
    .from('package_redemptions')
    .insert({
      client_package_id: balance.id,
      appointment_id: appointment.id,
    })
    .select('id')
    .single()

  if (redeemError || !redemption) {
    // 23505 = unique_violation: this visit has already spent a session of this
    // package — here, or on somebody else's screen a moment ago.
    if (redeemError?.code === '23505') return fail('already_redeemed')
    console.error('package redemption insert failed', redeemError)
    return fail('redeem_failed')
  }

  // ── 2. The decrement, as a compare-and-set ────────────────
  const { data: decremented } = await supabase
    .from('client_packages')
    .update({ sessions_remaining: balance.sessions_remaining - 1 })
    .eq('id', balance.id)
    .eq('sessions_remaining', balance.sessions_remaining)
    .select('sessions_remaining')
    .maybeSingle()

  let remaining = decremented?.sessions_remaining ?? null

  if (remaining === null) {
    // Somebody moved the balance between the read and the write. Re-read, and
    // try once more against the value that is actually there.
    const { data: fresh } = await supabase
      .from('client_packages')
      .select('sessions_remaining')
      .eq('id', balance.id)
      .maybeSingle()

    if (fresh && fresh.sessions_remaining > 0) {
      const { data: retried } = await supabase
        .from('client_packages')
        .update({ sessions_remaining: fresh.sessions_remaining - 1 })
        .eq('id', balance.id)
        .eq('sessions_remaining', fresh.sessions_remaining)
        .select('sessions_remaining')
        .maybeSingle()
      remaining = retried?.sessions_remaining ?? null
    }
  }

  if (remaining === null) {
    await supabase.from('package_redemptions').delete().eq('id', redemption.id)
    return fail('balance_moved')
  }

  // ── 3. The money ──────────────────────────────────────────
  // The note is how `undoRedemption` finds this exact row again when two
  // different packages have both been spent on the same visit. Keep the two
  // in step — `creditNote` builds it in one place for both.
  const { error: paymentError } = await supabase.rpc('record_payment', {
    p_amount_cents: coveredCents,
    p_kind: 'package',
    p_method: 'package',
    p_appointment: appointment.id,
    p_note: creditNote(definition?.name ?? 'Package', covered.name),
  })

  if (paymentError) {
    // Put the session back and drop the redemption. A spent session with no
    // matching credit on the visit is a client paying twice.
    await supabase
      .from('client_packages')
      .update({ sessions_remaining: remaining + 1 })
      .eq('id', balance.id)
      .eq('sessions_remaining', remaining)
    await supabase.from('package_redemptions').delete().eq('id', redemption.id)
    console.error('package payment record failed', paymentError)
    return fail('redeem_failed')
  }

  revalidatePath('/dashboard/packages/balances')
  revalidatePath(`/dashboard/appointments/${appointment.id}`)
  if (balance.client_id) revalidatePath(`/dashboard/clients/${balance.client_id}`)

  return {
    ok: true,
    data: {
      redemptionId: redemption.id,
      clientPackageId: balance.id,
      appointmentId: appointment.id,
      sessionsRemaining: remaining,
      coveredCents,
    },
  }
}

/**
 * Put a session back.
 *
 * The counter gets this wrong — the wrong client is checked out, or the visit
 * is cancelled after the session was already spent — and with no way back the
 * client is simply short a treatment they paid for.
 *
 * The credit is reversed rather than deleted. `payments` is evidence, and a
 * refund row of the same size is how every other reversal in this schema is
 * recorded; `record_payment` refuses a negative amount under any kind but
 * `refund`, which is the rule saying so.
 *
 * The money moves FIRST, and the session only goes back if it moved. The other
 * order gives a client both their session and a free treatment, and only one of
 * those two mistakes is recoverable by looking at the ledger afterwards.
 */
export async function undoRedemption(input: {
  clientPackageId: number
  appointmentId: string
}): Promise<PackageOutcome<{ sessionsRemaining: number; reversedCents: number | null }>> {
  const { supabase, error: authError } = await requireFrontDesk()
  if (authError) return fail(authError)

  const { data: redemption } = await supabase
    .from('package_redemptions')
    .select('id, client_package_id, appointment_id')
    .eq('client_package_id', input.clientPackageId)
    .eq('appointment_id', input.appointmentId)
    .maybeSingle()

  if (!redemption) return fail('unknown_balance')

  const [{ data: balance }, { data: lines }, { data: credits }] = await Promise.all([
    supabase
      .from('client_packages')
      .select('id, client_id, sessions_total, sessions_remaining, service_packages(name, service_id)')
      .eq('id', redemption.client_package_id)
      .maybeSingle(),
    supabase
      .from('appointment_services')
      .select('service_id, name_snapshot, price_cents')
      .eq('appointment_id', redemption.appointment_id),
    supabase
      .from('payments')
      .select('id, amount_cents, note, created_at')
      .eq('appointment_id', redemption.appointment_id)
      .eq('method', 'package')
      .eq('kind', 'package')
      .eq('status', 'succeeded')
      .order('created_at', { ascending: false }),
  ])

  if (!balance) return fail('unknown_balance')

  const definition = balance.service_packages as unknown as {
    name: string
    service_id: number | null
  } | null

  // Rebuild the note this redemption wrote, and reverse THAT row. Two packages
  // spent on one visit leave two credits that are otherwise indistinguishable.
  const covered = coveredLine(
    definition?.service_id ?? null,
    (
      (lines ?? []) as { service_id: number | null; name_snapshot: string; price_cents: number }[]
    ).map((l) => ({
      serviceId: l.service_id,
      name: l.name_snapshot,
      priceCents: l.price_cents,
    }))
  )

  const wanted = covered ? creditNote(definition?.name ?? 'Package', covered.name) : null
  const rows = credits ?? []
  const credit =
    rows.find((c) => wanted !== null && c.note === wanted) ??
    // Nothing matched by name — safe only when there is exactly one candidate.
    (rows.length === 1 ? rows[0] : undefined)

  let reversedCents: number | null = null

  if (credit && credit.amount_cents > 0) {
    const { error: refundError } = await supabase.rpc('record_payment', {
      p_amount_cents: -credit.amount_cents,
      p_kind: 'refund',
      p_method: 'package',
      p_appointment: redemption.appointment_id,
      p_note: 'Package session returned',
    })
    if (refundError) {
      // Nothing has changed yet, which is exactly why this is first.
      console.error('package credit reversal failed', refundError)
      return fail('redeem_failed')
    }
    reversedCents = credit.amount_cents
  }

  const { error: deleteError } = await supabase
    .from('package_redemptions')
    .delete()
    .eq('id', redemption.id)

  if (deleteError) {
    // Put the credit back on so the visit is not left short-paid with the
    // session still marked spent.
    if (reversedCents !== null) {
      await supabase.rpc('record_payment', {
        p_amount_cents: reversedCents,
        p_kind: 'package',
        p_method: 'package',
        p_appointment: redemption.appointment_id,
        p_note: wanted ?? 'Package session',
      })
    }
    console.error('package redemption delete failed', deleteError)
    return fail('redeem_failed')
  }

  // Never above what was bought, however the two got out of step.
  const restored = Math.min(balance.sessions_remaining + 1, balance.sessions_total)
  await supabase
    .from('client_packages')
    .update({ sessions_remaining: restored })
    .eq('id', balance.id)
    .eq('sessions_remaining', balance.sessions_remaining)

  revalidatePath('/dashboard/packages/balances')
  revalidatePath(`/dashboard/appointments/${redemption.appointment_id}`)
  if (balance.client_id) revalidatePath(`/dashboard/clients/${balance.client_id}`)

  return { ok: true, data: { sessionsRemaining: restored, reversedCents } }
}
