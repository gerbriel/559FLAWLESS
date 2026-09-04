'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { pingEmailDispatch } from '@/lib/email-ping'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/field'
import type { AppointmentStatus } from '@/types/database'

/**
 * Client-side cancellation. The RLS policy on `appointments` allows a client to
 * update their own row only to `status = 'cancelled'`, so this cannot be turned
 * into a reschedule or a price edit by tampering with the request.
 *
 * ── Why this needs the status ────────────────────────────────
 *
 * The 24-hour rule is a rule about an APPOINTMENT: the studio held a slot it
 * agreed to give you, and pulling out the night before costs them the hour.
 * None of that is true of a booking still sitting in the approval queue. Nobody
 * has agreed to anything, and the studio's own promise on the confirmation
 * screen is that a booking it cannot take is refunded in full.
 *
 * Without `status` this component told a client withdrawing an UNAPPROVED
 * request, inside 24 hours, that their deposit would not be refunded — a
 * forfeiture notice for an appointment they were never given. It also called
 * the action "Cancel this appointment" when there was no appointment to cancel.
 */
export function CancelAppointment({
  appointmentId,
  hoursAway,
  depositPaid,
  status = 'confirmed',
}: {
  appointmentId: string
  hoursAway: number
  depositPaid: boolean
  /**
   * The appointment's own status. Defaults to 'confirmed' so an existing caller
   * that has not been updated keeps the stricter wording rather than silently
   * dropping the late-cancellation warning.
   */
  status?: AppointmentStatus
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const awaitingApproval = status === 'pending'
  // The late-cancellation policy governs a confirmed appointment only.
  const insideWindow = !awaitingApproval && hoursAway < 24

  async function cancel() {
    setBusy(true)
    const supabase = createClient()

    /*
      `.neq('status','cancelled')` and `.select()` are both load-bearing.

      This button is rendered from a server render that can be minutes old. The
      studio declining the booking in that window sets `status = 'cancelled'`
      and writes the reason the client is explicitly promised on the detail page
      ("it will say so and tell you why"). Without the guard, a stale tap
      overwrites that reason with 'Cancelled by client' — the client loses the
      only explanation they were given, and it looks like they did it.

      And without `.select()`, supabase-js sends `Prefer: return=minimal`, so a
      WHERE that matched nothing returns `{ data: null, error: null }` — the same
      shape as success — and the toast would announce a cancellation that never
      happened.
    */
    const { data, error } = await supabase
      .from('appointments')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason:
          reason.trim() ||
          (awaitingApproval ? 'Withdrawn by client before review' : 'Cancelled by client'),
      })
      .eq('id', appointmentId)
      .neq('status', 'cancelled')
      .select('id')

    setBusy(false)

    if (error) {
      toast.error('Could not cancel. Please call the studio.')
      return
    }

    if (!data || data.length === 0) {
      toast.error('This booking is already cancelled — refreshing.')
      router.refresh()
      return
    }

    pingEmailDispatch()
    toast.success(awaitingApproval ? 'Booking withdrawn.' : 'Appointment cancelled.')
    router.refresh()
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="label-caps min-h-11 text-[var(--color-muted)] underline underline-offset-4 hover:text-red-700 dark:hover:text-red-400"
      >
        {awaitingApproval ? 'Withdraw this booking' : 'Cancel this appointment'}
      </button>
    )
  }

  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <p className="display text-xl">
        {awaitingApproval ? 'Withdraw this booking?' : 'Cancel this appointment?'}
      </p>

      {/*
        No forfeiture notice on a booking the studio has not agreed to. The one
        certainty is that the held time goes back on the calendar — that is what
        `status = 'cancelled'` does, since the exclusion constraint covers every
        other status. Where a paid deposit ends up is a conversation, not a
        policy this app implements: nothing in the codebase calls
        stripe.refunds.create, so the only honest thing is to point at a person.
      */}
      {awaitingApproval ? (
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          This booking has not been confirmed yet, so there is no late-cancellation
          charge. Withdrawing it releases the time you were holding.
          {depositPaid &&
            ' Your deposit is still recorded against it — message the studio and they will sort it out with you.'}
        </p>
      ) : (
        insideWindow && (
          <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
            This is inside the 24-hour window.
            {depositPaid
              ? ' Your deposit will not be refunded.'
              : ' Late cancellations may affect future booking.'}
          </p>
        )
      )}

      <div className="mt-5">
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          maxLength={500}
          rows={3}
          placeholder="Anything you would like us to know? (optional)"
          aria-label="Cancellation reason"
        />
      </div>

      <div className="mt-5 flex flex-wrap gap-3">
        <Button variant="danger" onClick={cancel} disabled={busy}>
          {busy
            ? awaitingApproval
              ? 'Withdrawing…'
              : 'Cancelling…'
            : awaitingApproval
              ? 'Yes, withdraw it'
              : 'Yes, cancel it'}
        </Button>
        <Button variant="subtle" onClick={() => setOpen(false)} disabled={busy}>
          Keep it
        </Button>
      </div>
    </div>
  )
}
