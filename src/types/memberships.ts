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
  /** On the public /memberships page, paid through Stripe (078). */
  sell_online: boolean
  /** Whether the public page offers the renewing option (a Stripe subscription) for this plan (083). */
  auto_renew_offered: boolean
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
  /**
   * Null: this treatment draws from the plan's shared pool. Set (1 to 31):
   * this treatment has its own N per period and never touches the pool (088).
   */
  sessions_per_period: number | null
}

/**
 * What a member pays for one service while current (078) — a ceiling applied
 * after every other deal, never a further cut below it.
 */
export type MembershipMemberPrice = {
  membership_id: number
  service_id: number
  price_cents: number
}

/**
 * A retail perk on a plan (086). `percent_off` takes N% off every eligible
 * unit; `buy_get` makes the cheapest unit of every full group of
 * `buy_qty + 1` eligible units `percent_off` cheaper (100 = free). Scope is
 * one product, one category, or (both null) every retail product. The
 * arithmetic is src/lib/member-product-perks.ts.
 */
export type MembershipProductPerk = {
  id: number
  membership_id: number
  kind: 'percent_off' | 'buy_get'
  percent_off: number
  buy_qty: number | null
  product_id: number | null
  category_id: number | null
  label: string | null
  sort_order: number
  /** Orders this perk may win inside uses_window (087). Null is unlimited. */
  max_uses: number | null
  /** 'period' is the member's current period; 'month' the calendar month in the studio's zone. */
  uses_window: 'period' | 'month'
  /**
   * The most eligible units one use may discount (087). Null is unlimited.
   * percent_off takes the dearest N; buy_get discounts at most N units.
   */
  max_units_per_use: number | null
}

/**
 * One order a product perk won (087). Uses are counted from these rows,
 * joined to orders that are not cancelled, so an abandoned checkout gives its
 * use back once the webhook cancels the order. Written only by
 * claim_perk_use().
 */
export type MembershipPerkRedemption = {
  id: number
  /** Null once the perk is deleted; the row stays for the reports. */
  perk_id: number | null
  client_membership_id: number
  client_id: string | null
  order_id: number
  /** The deal's own cut, integer cents. */
  discount_cents: number
  /** Units the perk discounted on this order. */
  units: number
  created_at: string
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
  /**
   * True while a Stripe subscription is set to renew this (083). Always false
   * for pay-once and counter enrolments. cancel_at_period_end is still the
   * "asked to stop" flag.
   */
  auto_renew: boolean
  cancelled_at: string | null
  ended_at: string | null
  stripe_subscription_id: string | null
  stripe_customer_id: string | null
  note: string | null
  created_by: string | null
  created_at: string
  updated_at: string
}

/**
 * Whether a new member wants to book their first visit now or later, asked
 * once after joining (084). One row per client.
 */
export type MembershipBookingIntent = {
  client_id: string
  intent: 'now' | 'later'
  decided_at: string
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

/**
 * The sentence for an error code from /api/stripe/membership and its manage
 * route. The codes are for code; a person should never be shown one. Anything
 * unknown gets the caller's fallback.
 */
const MEMBERSHIP_ERROR_MESSAGES: Record<string, string> = {
  not_a_subscription: 'This membership does not renew through Stripe, so there is nothing to change there.',
  membership_ended: 'This membership has already ended.',
  subscription_ended: 'That subscription has already ended in Stripe.',
  unauthenticated: 'Please sign in and try again.',
  stripe_failed: 'Stripe did not accept that. Please try again in a moment.',
  stripe_not_configured: 'Online payments are not set up yet. Please ask the studio.',
  already_member: 'You already have a membership running.',
  not_for_sale: 'That membership is not available online.',
  suspended: 'This account is suspended. Please contact the studio.',
  not_found: 'We could not find that membership.',
}

export function membershipErrorMessage(code: unknown, fallback: string): string {
  return (typeof code === 'string' && MEMBERSHIP_ERROR_MESSAGES[code]) || fallback
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

/** "each month", "each quarter", "each year", "every 6 months": a saving's period. */
export function eachPeriodPhrase(periodMonths: number): string {
  const label = membershipPeriodLabel(periodMonths)
  return /^\d/.test(label) ? `every ${label}` : `each ${label}`
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

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth', 'eleventh']

/** "free", "half off", "25% off". */
function perkCutPhrase(percentOff: number): string {
  if (percentOff >= 100) return 'free'
  if (percentOff === 50) return 'half off'
  return `${percentOff}% off`
}

/**
 * One line for a product perk, for the plan card and the editor preview:
 * "15% off all products", "20% off Gentle Cleanser", "Buy 2 in Cleansers, get
 * the third half off", "Buy one Gentle Cleanser, get one free". Names are the
 * caller's to look up; a missing one falls back to a generic noun rather than
 * an empty gap.
 */
export function describeProductPerk(
  perk: Pick<MembershipProductPerk, 'kind' | 'percent_off' | 'buy_qty' | 'product_id' | 'category_id'> &
    Partial<Pick<MembershipProductPerk, 'max_uses' | 'uses_window' | 'max_units_per_use'>>,
  names: { product?: string | null; category?: string | null }
): string {
  const limit = describePerkLimit(perk)
  return limit ? `${describePerkOffer(perk, names)}, ${limit}` : describePerkOffer(perk, names)
}

const COUNT_WORDS = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']

/** "once", "twice", "3 times". */
function timesPhrase(n: number): string {
  if (n === 1) return 'once'
  if (n === 2) return 'twice'
  return `up to ${n} times`
}

/**
 * The limit on a perk (087) in plain words, or '' when it has none:
 * "once per period", "up to 3 times a month", "one item per use",
 * "twice a month, up to two items per use". No em dash, no leading comma;
 * describeProductPerk joins it to the offer.
 */
export function describePerkLimit(
  perk: Partial<Pick<MembershipProductPerk, 'max_uses' | 'uses_window' | 'max_units_per_use'>>
): string {
  const parts: string[] = []
  const uses = perk.max_uses == null ? 0 : Math.trunc(perk.max_uses)
  if (uses >= 1) {
    parts.push(`${timesPhrase(uses)} ${perk.uses_window === 'month' ? 'a month' : 'per period'}`)
  }
  const units = perk.max_units_per_use == null ? 0 : Math.trunc(perk.max_units_per_use)
  if (units >= 1) {
    const word = COUNT_WORDS[units] ?? String(units)
    const noun = units === 1 ? 'item' : 'items'
    parts.push(units === 1 ? `${word} ${noun} per use` : `up to ${word} ${noun} per use`)
  }
  return parts.join(', ')
}

/** The offer itself, without its limit. */
function describePerkOffer(
  perk: Pick<MembershipProductPerk, 'kind' | 'percent_off' | 'buy_qty' | 'product_id' | 'category_id'>,
  names: { product?: string | null; category?: string | null }
): string {
  const product = names.product?.trim() || 'this product'
  const category = names.category?.trim() || 'this category'
  const cut = perkCutPhrase(perk.percent_off)

  if (perk.kind === 'percent_off') {
    const what =
      perk.product_id !== null
        ? product
        : perk.category_id !== null
          ? `everything in ${category}`
          : 'all products'
    // "free all products" is not English; a whole-price perk reads the other way round.
    if (perk.percent_off >= 100) return `${what.charAt(0).toUpperCase()}${what.slice(1)} free`
    if (perk.percent_off === 50) return `Half off ${what}`
    return `${cut} ${what}`
  }

  const buy = Math.max(1, Math.trunc(perk.buy_qty ?? 1))
  if (buy === 1) {
    if (perk.product_id !== null) return `Buy one ${product}, get one ${cut}`
    if (perk.category_id !== null) return `Buy one in ${category}, get one ${cut}`
    return `Buy one product, get one ${cut}`
  }
  const next = ORDINALS[buy] ?? `${buy + 1}th`
  if (perk.product_id !== null) return `Buy ${buy} ${product}, get the ${next} ${cut}`
  if (perk.category_id !== null) return `Buy ${buy} in ${category}, get the ${next} ${cut}`
  return `Buy ${buy} products, get the ${next} ${cut}`
}

/**
 * One included allowance on a plan for the current period (088). A plan has
 * one per treatment that carries its own `sessions_per_period`, plus the
 * shared pool when `included_sessions_per_period` is above zero.
 * `serviceId: null` is the pool. `used` may exceed `total` (a session handed
 * out by hand, a plan shrunk mid-period); the labels clamp what is left.
 */
export interface IncludedAllowance {
  serviceId: number | null
  serviceName: string | null
  total: number
  used: number
}

/**
 * Every allowance a plan grants this period and how much of each is spent.
 * Per-treatment rows come first in scope order, the pool last. The counting
 * is the same sentence as membership_redemption_within_allowance() in 088: a
 * redemption on a treatment with its own allowance counts only there, and
 * the pool counts everything else in the period, including legacy rows with
 * no service. The trigger is the authority; this is for screens.
 */
export function includedAllowances(
  plan: { included_sessions_per_period: number },
  scope: { service_id: number; sessions_per_period: number | null; name?: string | null }[],
  redemptions: { service_id: number | null; sessions: number; redeemed_for_period_start: string }[],
  periodStart: string
): IncludedAllowance[] {
  const thisPeriod = redemptions.filter((r) => samePeriodStart(r.redeemed_for_period_start, periodStart))
  const out: IncludedAllowance[] = []
  const own = new Set<number>()

  for (const row of scope) {
    if (row.sessions_per_period == null || own.has(row.service_id)) continue
    own.add(row.service_id)
    out.push({
      serviceId: row.service_id,
      serviceName: row.name?.trim() || null,
      total: row.sessions_per_period,
      used: thisPeriod
        .filter((r) => r.service_id === row.service_id)
        .reduce((n, r) => n + r.sessions, 0),
    })
  }

  if (plan.included_sessions_per_period > 0) {
    out.push({
      serviceId: null,
      serviceName: null,
      total: plan.included_sessions_per_period,
      used: thisPeriod
        .filter((r) => r.service_id === null || !own.has(r.service_id))
        .reduce((n, r) => n + r.sessions, 0),
    })
  }
  return out
}

/**
 * Period starts arrive as timestamptz strings, and PostgREST and JS do not
 * always spell one instant the same way ("+00:00" against "Z", fractional
 * seconds). Compare the instant, falling back to the text when either side
 * does not parse.
 */
function samePeriodStart(a: string, b: string): boolean {
  if (a === b) return true
  const x = Date.parse(a)
  const y = Date.parse(b)
  return Number.isFinite(x) && Number.isFinite(y) && x === y
}

/** "A", "A and B", "A, B and C". */
function andList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** "A", "A or B", "A, B or C". */
function orList(items: string[]): string {
  if (items.length <= 1) return items.join('')
  return `${items.slice(0, -1).join(', ')} or ${items[items.length - 1]}`
}

const UNNAMED_TREATMENT = 'this treatment'

/**
 * "1 Custom Corrective Facial", "2 Custom Corrective Facial visits". A
 * treatment name is not a countable noun ("2 Full Brazilians" is wrong and
 * "2 Brow Waxs" worse), so a count above one reads as visits of it.
 */
function treatmentCount(count: number, name: string | null): string {
  return `${count} ${treatmentNoun(count, name)}`
}

/** "Custom Corrective Facial", "Custom Corrective Facial visits", "visits of this treatment". */
function treatmentNoun(count: number, name: string | null): string {
  if (count === 1) return name ?? UNNAMED_TREATMENT
  return name ? `${name} visits` : `visits of ${UNNAMED_TREATMENT}`
}

/**
 * What a plan includes, in one line (088):
 *   per-treatment  "1 Custom Corrective Facial and 1 Full Brazilian included each month"
 *   pool           "2 treatments included each month: Custom Corrective Facial or Full Brazilian"
 *   mixed          the two joined with ", plus "
 * `periodLabel` is membershipPeriodLabel()'s word. `poolServiceNames` are the
 * treatments the pool may be spent on; empty means any treatment and the
 * colon is left off. Returns '' when nothing is included.
 */
export function describeIncluded(
  allowances: IncludedAllowance[],
  periodLabel: string,
  poolServiceNames: string[]
): string {
  const parts: string[] = []
  const each = allowances.filter((a) => a.serviceId !== null && a.total > 0)
  if (each.length > 0) {
    parts.push(
      `${andList(each.map((a) => treatmentCount(a.total, a.serviceName)))} included each ${periodLabel}`
    )
  }
  const pool = allowances.find((a) => a.serviceId === null && a.total > 0)
  if (pool) {
    const names = poolServiceNames.map((n) => n.trim()).filter(Boolean)
    const head =
      pool.total === 1
        ? `1 treatment included each ${periodLabel}`
        : `${pool.total} treatments included each ${periodLabel}`
    parts.push(names.length > 0 ? `${head}: ${orList(names)}` : head)
  }
  return parts.join(', plus ')
}

/**
 * What is left this period, in one line (088):
 * "1 of 1 Custom Corrective Facial and 0 of 1 Full Brazilian left",
 * "1 of 2 Custom Corrective Facial visits left", "1 of 2 treatments left", or both joined with " and " (pool last).
 * Left never reads below zero. Returns '' when nothing is included.
 */
export function allowancesLeftLabel(allowances: IncludedAllowance[]): string {
  const parts = allowances
    .filter((a) => a.total > 0)
    .map((a) => {
      const left = Math.max(a.total - a.used, 0)
      if (a.serviceId !== null) {
        // "1 of 2 Custom Corrective Facial visits", "0 of 1 Full Brazilian".
        return `${left} of ${a.total} ${treatmentNoun(a.total, a.serviceName)}`
      }
      return `${left} of ${a.total} ${a.total === 1 ? 'treatment' : 'treatments'}`
    })
  return parts.length > 0 ? `${andList(parts)} left` : ''
}

/** Everything left across every allowance, never below zero per allowance. */
export function includedSessionsLeft(allowances: IncludedAllowance[]): number {
  return allowances.reduce((n, a) => n + Math.max(a.total - a.used, 0), 0)
}

/**
 * What the shared pool's one session is worth at the menu price: the dearest
 * treatment it may be spent on, because the benefit is spent dearest-first
 * (src/lib/memberships.ts). `scope` is the plan's membership_services rows
 * with each treatment's menu price. No rows means any treatment qualifies, so
 * the figure is `menuDearestCents`, the dearest active treatment on the menu.
 * Rows that carry their own allowance never draw from the pool and are left
 * out; a scope made only of those leaves the pool nothing to spend on (0).
 */
export function poolDearestCents(
  scope: { sessions_per_period: number | null; price_cents: number }[],
  menuDearestCents: number
): number {
  if (scope.length === 0) return Math.max(Math.trunc(menuDearestCents), 0)
  return scope
    .filter((r) => r.sessions_per_period === null)
    .reduce((n, r) => Math.max(n, Math.trunc(r.price_cents)), 0)
}

/**
 * What a plan's included treatments are worth at the menu price, in integer
 * cents, for one period. Per-treatment rows are that treatment's price times
 * its allowance; the pool row is `poolCents` (poolDearestCents()) times the
 * pool. `used` is ignored: this is what the plan grants, not what is left.
 * Member prices and product perks are not part of it. The editor's
 * "underwater" warning and the plan cards' "Menu value" both read this.
 */
export function includedWorthCents(
  allowances: IncludedAllowance[],
  priceOf: (serviceId: number) => number,
  poolCents: number
): number {
  return allowances.reduce((n, a) => {
    const count = Math.max(Math.trunc(a.total), 0)
    const each = a.serviceId === null ? poolCents : priceOf(a.serviceId)
    return n + Math.max(Math.trunc(each), 0) * count
  }, 0)
}
