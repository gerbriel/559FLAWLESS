/**
 * Applying a membership to a visit.
 *
 * This is the only place a membership turns into money. It runs AFTER the
 * appointment and its line items exist, and it deliberately runs after rather
 * than before, because the two benefits answer to different authorities:
 *
 *   • The percentage is arithmetic. This module owns it, in integer cents,
 *     through `membershipDiscountCents`.
 *   • An included session is a scarce thing, and scarce things are settled by
 *     the database. `membership_redemptions` carries a trigger that counts the
 *     period's spend under a row lock on the membership, so two bookings racing
 *     for the last included facial cannot both win. This module ASKS for the
 *     redemption and believes the answer — it never decides for itself that a
 *     session was available.
 *
 * Which is why the order is: book, write the lines, claim what the database
 * lets you claim, then price the remainder. A refused claim costs a discount
 * and never a slot: the appointment is already made, and the client simply pays
 * the ordinary price for that line.
 *
 * There is no parallel pricing path here. `appointments.subtotal_cents` is
 * still the sum of `appointment_services.price_cents`, exactly as it was; this
 * writes two integer-cent columns beside it and the database derives
 * `total_cents` from all three (see migration 050).
 */

import 'server-only'
import { createAdminClient } from '@/lib/supabase/admin'
import { membershipDiscountCents } from '@/types/memberships'

/** One priced service line on the visit, as `priceService()` produced it. */
export interface MembershipBenefitLine {
  serviceId: number
  priceCents: number
}

/** What was actually applied — never what was hoped for. */
export interface AppliedMembership {
  clientMembershipId: number
  planName: string
  /** List value of the lines an included session covered, integer cents. */
  coveredCents: number
  /** The member percentage off the rest of the visit, integer cents. */
  discountCents: number
  /** Included sessions consumed by this visit. */
  sessionsSpent: number
}

/** One literal. Concatenating widens the select to `string` and collapses the
 *  result type to SelectQueryError. */
const HELD_MEMBERSHIP_SELECT =
  'id, membership_id, status, current_period_start, current_period_end, memberships!client_memberships_membership_id_fkey(id, name, service_discount_pct, included_sessions_per_period)'

type HeldPlan = {
  id: number
  name: string
  service_discount_pct: number
  included_sessions_per_period: number
}

/**
 * Apply whatever membership the client holds to an appointment that already
 * exists, and return what was applied. `null` means nothing was: no membership,
 * none current, or a plan that granted nothing to this particular visit.
 *
 * Safe to call for a guest booking — pass the client id the appointment ended
 * up with (the `appointment_match_client` trigger may have supplied one the
 * request did not) and this returns null when there is none.
 *
 * Idempotent by construction: the appointment is only stamped while its
 * `client_membership_id` is still null, and the redemption rows carry a unique
 * key on (membership, appointment, service). A second call finds both closed
 * and changes nothing.
 */
export async function applyMembershipBenefit(opts: {
  appointmentId: string
  clientId: string | null
  /** Service lines only. Add-ons are discountable but never coverable. */
  lines: MembershipBenefitLine[]
  /** Everything on the visit, services and add-ons, integer cents. */
  subtotalCents: number
  now?: Date
}): Promise<AppliedMembership | null> {
  const { appointmentId, clientId, lines, subtotalCents } = opts
  if (!clientId || subtotalCents <= 0) return null

  const supabase = createAdminClient()
  const now = opts.now ?? new Date()

  // The benefit test, as a query: status is 'active' AND the period has not run
  // out. It is the same sentence as public.membership_is_current(), and the
  // database is the one that matters — a client_memberships row is unreadable
  // to its own holder for writing and there is at most one live row per person
  // (a partial unique index in 050 makes "which membership applies" a question
  // with one answer).
  const { data: held } = await supabase
    .from('client_memberships')
    .select(HELD_MEMBERSHIP_SELECT)
    .eq('client_id', clientId)
    .eq('status', 'active')
    .gt('current_period_end', now.toISOString())
    .maybeSingle()

  if (!held) return null

  const plan = held.memberships as unknown as HeldPlan | null
  if (!plan) return null

  let coveredCents = 0
  let sessionsSpent = 0
  const claimed: number[] = []

  if (plan.included_sessions_per_period > 0 && lines.length > 0) {
    // Which treatments a session may be spent on. NO ROWS MEANS ANY TREATMENT
    // — see the table comment in 050. An empty list is "not narrowed yet", not
    // "usable nowhere".
    const [{ data: scoped }, { data: spent }] = await Promise.all([
      supabase.from('membership_services').select('service_id').eq('membership_id', plan.id),
      supabase
        .from('membership_redemptions')
        .select('sessions')
        .eq('client_membership_id', held.id)
        .eq('redeemed_for_period_start', held.current_period_start),
    ])

    const scope = new Set((scoped ?? []).map((r) => r.service_id))
    const alreadySpent = (spent ?? []).reduce((n, r) => n + r.sessions, 0)
    const remaining = plan.included_sessions_per_period - alreadySpent

    // Dearest first: a session is worth what it saves, and a client who books a
    // $150 facial alongside a $40 brow wax means the facial. Duplicates are
    // dropped because the redemption's unique key is one row per service per
    // appointment.
    const eligible = lines
      .filter((l) => l.priceCents > 0 && (scope.size === 0 || scope.has(l.serviceId)))
      .sort((a, b) => b.priceCents - a.priceCents)

    const seen = new Set<number>()

    for (const line of eligible) {
      if (sessionsSpent >= remaining) break
      if (seen.has(line.serviceId)) continue
      seen.add(line.serviceId)

      const { data: row, error } = await supabase
        .from('membership_redemptions')
        .insert({
          client_membership_id: held.id,
          appointment_id: appointmentId,
          service_id: line.serviceId,
          redeemed_for_period_start: held.current_period_start,
          sessions: 1,
          value_cents: line.priceCents,
        })
        .select('id')
        .single()

      if (error || !row) {
        // 23514 is the allowance trigger: somebody else spent the session
        // between the count above and this insert. Nothing else is claimable
        // either, so stop asking. Any other failure is this line's problem —
        // 23505 means it was already claimed — so move on and price the rest.
        if (error?.code === '23514') break
        continue
      }

      claimed.push(row.id)
      coveredCents += line.priceCents
      sessionsSpent += 1
    }
  }

  const discountable = Math.max(subtotalCents - coveredCents, 0)
  const discountCents = membershipDiscountCents(discountable, plan.service_discount_pct)

  if (coveredCents === 0 && discountCents === 0) return null

  // `is('client_membership_id', null)` is the idempotency guard: a visit that
  // has already had a membership applied is left exactly as it is.
  const { data: stamped, error: stampError } = await supabase
    .from('appointments')
    .update({
      client_membership_id: held.id,
      membership_covered_cents: coveredCents,
      membership_discount_cents: discountCents,
    })
    .eq('id', appointmentId)
    .is('client_membership_id', null)
    .select('id')
    .maybeSingle()

  if (stampError || !stamped) {
    // The sessions were claimed but the discount never landed. Hand them back
    // rather than leave a member charged full price for a facial the ledger
    // thinks they used up.
    if (claimed.length > 0) {
      await supabase.from('membership_redemptions').delete().in('id', claimed)
    }
    if (stampError) {
      console.error('membership benefit could not be applied', stampError, { appointmentId })
    }
    return null
  }

  return {
    clientMembershipId: held.id,
    planName: plan.name,
    coveredCents,
    discountCents,
    sessionsSpent,
  }
}
