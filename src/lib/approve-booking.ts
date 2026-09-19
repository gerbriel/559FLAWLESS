import { createClient } from '@/lib/supabase/client'
import { pingEmailDispatch } from '@/lib/email-ping'

/**
 * Approve one booking that is waiting on a person.
 *
 * The one implementation, because there are now two front doors onto it: the
 * approval queue's card and the bell in the dashboard header. Two copies of
 * this is how one of them quietly stops re-titling the Google event.
 *
 * Approving cannot fail on availability — a pending appointment already holds
 * its slot against the exclusion constraint in 004, so nobody can have taken
 * the time while it sat in the queue. What it can lose is a race with whoever
 * answered the booking first, which is what `already_answered` is for.
 *
 * `.select()` is load-bearing. Without it supabase-js sends
 * `Prefer: return=minimal` and a WHERE that matched NOTHING comes back
 * `{ data: null, error: null }` — the same shape as success. Both guards on
 * this update can produce exactly that: the `.eq('status','pending')` losing
 * the race, and an update the 004 policies do not admit, which RLS filters to
 * zero rows rather than rejecting. Callers print "the client has been told" on
 * the strength of this answer, and 049 only writes that notification on the
 * transition — so a write that did not happen must never read as one that did.
 */
export type ApproveOutcome = 'approved' | 'already_answered' | 'failed'

export async function approveBooking(appointmentId: string): Promise<ApproveOutcome> {
  const { data, error } = await createClient()
    .from('appointments')
    .update({ status: 'confirmed', approval_reason: null })
    .eq('id', appointmentId)
    .eq('status', 'pending')
    .select('id')

  if (error) return 'failed'
  if (!data || data.length === 0) return 'already_answered'

  // Re-title the provider's Google event — the push drops the HOLD: prefix now
  // that the row reads confirmed. Fire-and-forget: the booking is decided
  // either way, and the daily sync is not a fallback for pushes, so a failure
  // here costs a stale title, not the record.
  void fetch('/api/calendar/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind: 'appointment', id: appointmentId }),
  }).catch(() => {})

  pingEmailDispatch()
  return 'approved'
}
