/**
 * Who among the members needs a nudge, as one rule shared by the Members list
 * and the Today screen so the two numbers can never disagree.
 *
 * Pure: the callers fetch, this file only counts. "Needs follow-up" means the
 * membership is granting something right now, the member has included
 * sessions left in the current period, and nothing is booked before that
 * period ends to spend them on.
 */

import { membershipIsCurrent, type ClientMembership } from '@/types/memberships'

export type FollowUpRedemption = { sessions: number; redeemed_for_period_start: string }

/** Included sessions left in the current period. Never below zero. */
export function sessionsLeftThisPeriod(
  included: number,
  currentPeriodStart: string,
  redemptions: FollowUpRedemption[]
): number {
  const spent = redemptions
    .filter((r) => r.redeemed_for_period_start === currentPeriodStart)
    .reduce((n, r) => n + r.sessions, 0)
  return Math.max(0, included - spent)
}

/**
 * `upcomingStarts` is every pending or confirmed booking the member has from
 * now on, as starts_at. Only the ones before the period ends count: sessions
 * do not carry over, so a visit booked for next period spends nothing that is
 * left in this one.
 */
export function needsFollowUp(
  membership: Pick<ClientMembership, 'status' | 'current_period_end'>,
  sessionsLeft: number,
  upcomingStarts: string[],
  now: number
): boolean {
  const periodEnd = new Date(membership.current_period_end).getTime()
  const bookedThisPeriod = upcomingStarts.some((s) => new Date(s).getTime() < periodEnd)
  return membershipIsCurrent(membership, now) && sessionsLeft > 0 && !bookedThisPeriod
}

/**
 * Split ids for `.in()` reads. PostgREST carries the list in the URL, and a
 * few hundred uuids is enough to pass the length a proxy will accept.
 */
export function chunked<T>(items: T[], size = 100): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}
