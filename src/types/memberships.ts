/**
 * Memberships — the shapes from migration 050 and the pure arithmetic that
 * goes with them.
 *
 * Nothing here talks to the database. `src/lib/memberships.ts` is the server
 * side; this file is what a component may import.
 *
 * The one rule worth stating twice: every amount is an integer number of cents,
 * and `membershipDiscountCents` is the ONLY place a percentage is turned into
 * money. It does that with integer arithmetic — there is no float on the way in
 * or out — so the number a screen quotes and the number the appointment carries
 * are the same number, not two roundings of the same idea.
 */

export type MembershipStatus = 'active' | 'past_due' | 'cancelled' | 'expired'
export type MembershipChargeStatus = 'due' | 'paid' | 'failed' | 'refunded' | 'void'
export type MembershipChargeMethod = 'card' | 'cash' | 'stripe' | 'other'

/** A plan: what is sold. */
export type Membership = {
  id: number
  name: string
  slug: string
  description: string | null
  /** Per period, integer cents. */
  price_cents: number
  period_months: number
  /** Off the whole visit, after any included session has been applied. */
  service_discount_pct: number
  included_sessions_per_period: number
  /** Reserved for the Stripe Price when a follow-up builds the subscription. */
  stripe_price_id: string | null
  is_active: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

/**
 * Which treatments an included session may be spent on. No rows for a plan
 * means any treatment — see the table comment in 050.
 */
export type MembershipService = {
  membership_id: number
  service_id: number
}

/** Somebody holding a plan. */
export type ClientMembership = {
  id: number
  client_id: string
  membership_id: number
  status: MembershipStatus
  /** Frozen at enrolment by trigger. A later price rise does not reach here. */
  price_cents_snapshot: number
  started_at: string
  current_period_start: string
  /** The authority on whether the benefit applies. Not the status column. */
  current_period_end: string
  cancel_at_period_end: boolean
  cancelled_at: string | null
  ended_at: string | null
  stripe_subscription_id: string | null
  stripe_customer_id: string | null
  note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/** One included session, actually spent, inside a named period. */
export type MembershipRedemption = {
  id: number
  client_membership_id: number
  appointment_id: string
  service_id: number | null
  redeemed_for_period_start: string
  sessions: number
  /** List value of what was covered, integer cents. */
  value_cents: number
  created_at: string
}

/** One period billed, whether or not the money arrived. */
export type MembershipCharge = {
  id: number
  client_membership_id: number
  period_start: string
  period_end: string
  amount_cents: number
  status: MembershipChargeStatus
  method: MembershipChargeMethod
  paid_at: string | null
  stripe_invoice_id: string | null
  stripe_payment_intent_id: string | null
  recorded_by: string | null
  note: string | null
  created_at: string
}

export const MEMBERSHIP_STATUS_LABELS: Record<MembershipStatus, string> = {
  active: 'Active',
  past_due: 'Payment failed',
  cancelled: 'Cancelled',
  expired: 'Lapsed',
}

export const MEMBERSHIP_CHARGE_STATUS_LABELS: Record<MembershipChargeStatus, string> = {
  due: 'Due',
  paid: 'Paid',
  failed: 'Failed',
  refunded: 'Refunded',
  void: 'Void',
}

/**
 * The member percentage, in integer cents.
 *
 * `(cents * pct + 50) / 100` floored is round-half-up done entirely in
 * integers: `cents * pct` is exact, adding 50 before the division by 100 is
 * what rounds a half-cent, and the half-cent rounds toward the client rather
 * than the studio. No float ever exists, so this cannot drift from the value
 * stored on the appointment.
 */
export function membershipDiscountCents(subtotalCents: number, pct: number): number {
  if (subtotalCents <= 0 || pct <= 0) return 0
  const bounded = Math.min(Math.max(Math.trunc(pct), 0), 100)
  return Math.floor((Math.trunc(subtotalCents) * bounded + 50) / 100)
}

/**
 * Is this membership granting anything right now?
 *
 * The UI copy of `public.membership_is_current()`. It hides buttons and softens
 * copy; the SQL copy and the RLS policies are what actually stop a request.
 * Keep the two sentences identical — status narrows, the period end expires.
 */
export function membershipIsCurrent(
  membership: Pick<ClientMembership, 'status' | 'current_period_end'>,
  now: number
): boolean {
  return (
    membership.status === 'active' &&
    new Date(membership.current_period_end).getTime() > now
  )
}

/** 'month', 'year', 'every 3 months' — how a period reads in a sentence. */
export function membershipPeriodLabel(periodMonths: number): string {
  if (periodMonths === 1) return 'month'
  if (periodMonths === 12) return 'year'
  if (periodMonths === 3) return 'quarter'
  return `${periodMonths} months`
}

/**
 * What holding this grants, in one line. A plan always grants at least one of
 * the two — the database refuses a plan that grants neither — so this never
 * returns an empty string.
 */
export function describeMembershipBenefit(
  plan: Pick<Membership, 'service_discount_pct' | 'included_sessions_per_period' | 'period_months'>
): string {
  const parts: string[] = []
  if (plan.included_sessions_per_period > 0) {
    parts.push(
      plan.included_sessions_per_period === 1
        ? `1 treatment included each ${membershipPeriodLabel(plan.period_months)}`
        : `${plan.included_sessions_per_period} treatments included each ${membershipPeriodLabel(plan.period_months)}`
    )
  }
  if (plan.service_discount_pct > 0) {
    parts.push(
      parts.length > 0
        ? `${plan.service_discount_pct}% off the rest of the visit`
        : `${plan.service_discount_pct}% off every visit`
    )
  }
  return parts.join(' · ')
}
