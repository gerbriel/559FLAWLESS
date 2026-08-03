/**
 * What a package action can refuse, and how it reads to the person at the desk.
 *
 * Split out of `actions.ts` because a `'use server'` module may only export
 * async functions — a message table living beside the actions would break the
 * build. Same split, same reason, as any other action file that needs to share
 * a shape with its caller.
 *
 * The copy follows `BOOKING_ERROR_MESSAGES` in `src/lib/booking.ts`: one plain
 * sentence per outcome, never a SQLSTATE, and it says what to do next wherever
 * there is something to do.
 */

export type PackageError =
  | 'unauthorized'
  | 'forbidden'
  | 'unknown_package'
  | 'package_inactive'
  | 'client_required'
  | 'unknown_balance'
  | 'no_sessions_left'
  | 'balance_expired'
  | 'unknown_appointment'
  | 'wrong_client'
  | 'appointment_not_billable'
  | 'service_not_covered'
  | 'already_redeemed'
  | 'nothing_to_cover'
  | 'balance_moved'
  | 'sale_failed'
  | 'redeem_failed'

export const PACKAGE_ERROR_MESSAGES: Record<PackageError, string> = {
  unauthorized: 'Sign in again — that session has expired.',
  forbidden: 'Packages are a front-desk job. Ask a manager to do this one.',
  unknown_package: 'That package is no longer on the list.',
  package_inactive: 'That package has been switched off. Switch it back on to sell it.',
  client_required:
    'A package is a balance someone holds, so it has to be sold to a client account rather than a walk-in.',
  unknown_balance: 'That balance is no longer on file.',
  no_sessions_left: 'That package has no sessions left.',
  balance_expired: 'That package has expired. Sell a new one, or move its expiry date.',
  unknown_appointment: 'That appointment is no longer on file.',
  wrong_client: 'That package belongs to a different client.',
  appointment_not_billable:
    'A cancelled or no-show visit is not billed, so there is nothing for a session to cover.',
  service_not_covered: 'This visit does not include a service that package pays for.',
  // The unique constraint in 008 is what produces this one, and it is the whole
  // reason a second till cannot spend the same session twice.
  already_redeemed: 'A session from that package has already been spent on this visit.',
  nothing_to_cover:
    'This visit is already paid in full — spending a session would take it for nothing.',
  balance_moved: 'That balance changed while this was saving. Open it again and retry.',
  sale_failed: 'The sale did not go through. Nothing was charged.',
  redeem_failed: 'The session was not spent. Nothing has changed.',
}

export type PackageOutcome<T> = { ok: true; data: T } | { ok: false; error: PackageError }

export interface PackageSaleResult {
  orderId: number
  orderNumber: string | null
  clientPackageId: number
  /** What was charged, in cents. Read from the package, never from the till. */
  totalCents: number
  sessions: number
  expiresAt: string | null
  name: string
}

export interface RedemptionResult {
  redemptionId: number
  clientPackageId: number
  appointmentId: string
  sessionsRemaining: number
  /** What the session paid off this visit, in cents. */
  coveredCents: number
}

/** Turn an outcome into the sentence to put in a toast. */
export function packageErrorMessage(error: PackageError): string {
  return PACKAGE_ERROR_MESSAGES[error] ?? 'That did not work. Please try again.'
}
