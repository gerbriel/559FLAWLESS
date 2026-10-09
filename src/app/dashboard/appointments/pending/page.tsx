import { redirect } from 'next/navigation'

/**
 * "Waiting on you" moved onto Today (and folds above the Calendar) — see
 * PendingQueue.
 *
 * This stub is not optional. The notification triggers in 036, 048 and 049
 * write '/dashboard/appointments/pending' into every review notice, and the
 * rows already sent keep that link forever.
 */
export default function PendingMoved() {
  redirect('/dashboard#waiting')
}
