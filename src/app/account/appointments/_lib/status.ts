import type { AppointmentStatus, DepositStatus } from '@/types/database'

/**
 * The words a client reads for the state of their own appointment.
 *
 * One vocabulary, one file, because the list and the detail page had drifted:
 * the list said "Awaiting confirmation" in amber while the detail page printed
 * the raw enum `pending` in a green SUCCESS badge. A client with a booking that
 * nobody has approved was being told, on the page for that booking, that it was
 * fine.
 *
 * `pending` is the load-bearing entry. It is a warning, never a success — the
 * time is held, the appointment is not confirmed, and those are different
 * facts. `no_show` reads "Missed" rather than the database's word, which is
 * staff shorthand and lands badly on the person it describes.
 *
 * `_lib` is a private folder: not routable, colocated with the only two pages
 * that use it (Next.js project-structure docs, "Colocation").
 */

type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export const STATUS_TONE: Record<AppointmentStatus, Tone> = {
  pending: 'warning',
  confirmed: 'success',
  checked_in: 'accent',
  completed: 'neutral',
  cancelled: 'danger',
  no_show: 'danger',
}

export const STATUS_LABEL: Record<AppointmentStatus, string> = {
  pending: 'Awaiting confirmation',
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'Missed',
}

/**
 * The deposit is a separate fact from the appointment, and it was being printed
 * as `Deposit {enum}` — "Deposit pending", "Deposit none". Same treatment.
 *
 * `pending` here means the money has not arrived: `src/lib/booking.ts` writes
 * `deposit_status: 'pending'` whenever a deposit is due, and only the Stripe
 * webhook moves it to 'paid'. "Deposit due" is what that means to the person
 * who owes it.
 */
export const DEPOSIT_TONE: Record<DepositStatus, Tone> = {
  none: 'neutral',
  pending: 'warning',
  paid: 'success',
  forfeited: 'danger',
  refunded: 'neutral',
}

export const DEPOSIT_LABEL: Record<DepositStatus, string> = {
  none: 'No deposit',
  pending: 'Deposit due',
  paid: 'Deposit paid',
  forfeited: 'Deposit forfeited',
  refunded: 'Deposit refunded',
}
