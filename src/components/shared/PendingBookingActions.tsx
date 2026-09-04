'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { pingEmailDispatch } from '@/lib/email-ping'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/field'
import { cn, formatMoney } from '@/lib/utils'
import type { DepositStatus } from '@/types/database'

/**
 * Where a refund is issued.
 *
 * The payments list, not a deep link to the payment itself:
 * `/payments/<intent>` is mode-specific — test-mode payments live under
 * `/test/payments/<intent>` — and this build cannot know which key the studio
 * is running on. A dead link on the one screen telling somebody to move money
 * is worse than one extra search, so the reference to search for is printed
 * beside it instead.
 */
const STRIPE_PAYMENTS_URL = 'https://dashboard.stripe.com/payments'

/**
 * Approve or decline one booking that is waiting on a person.
 *
 * Approving is a plain status update and it cannot fail on availability: a
 * pending appointment already holds its slot — the exclusion constraint in
 * migration 004 covers everything that is not cancelled — so nobody can have
 * taken the time while it sat in the queue.
 *
 * Declining is a cancellation, which is what releases the slot. It writes a
 * reason because the client is told one: the notify trigger from 006 sends the
 * cancellation straight through to them, and "your booking was declined" with
 * nothing after it is the kind of message that generates a phone call.
 *
 * ── The deposit ──────────────────────────────────────────────
 *
 * A client can already have paid before anyone looks at the request:
 * /api/stripe/deposit takes any appointment that is not cancelled, so a booking
 * held for review comes to checkout like any other. Declining it therefore
 * cancels an appointment the studio has been paid for.
 *
 * NO REFUND IS ISSUED HERE, deliberately. That is judged, not overlooked:
 *
 *   1. There is no refund path in this codebase to call. `src/lib/stripe.ts` is
 *      three functions — client, configured?, site URL — and no route handler
 *      anywhere calls `stripe.refunds.create`. The only thing that ever writes
 *      `deposit_status = 'refunded'` is the `charge.refunded` webhook, which
 *      reacts to a refund somebody has already made in Stripe.
 *   2. `deposit_status = 'paid'` does not imply a Stripe charge exists.
 *      `record_payment` (migration 025) sets the same flag for cash and for the
 *      studio's own terminal, and those rows carry no payment intent. An
 *      "automatic refund" would quietly do nothing for every one of them and
 *      report success — the exact failure mode this screen exists to prevent.
 *   3. Whether a declined booking is refunded in full is a policy the owner has
 *      not written down, and a refund button is the wrong place to invent one.
 *
 * So the honest thing, which is what this does: show the money, make the
 * decliner acknowledge it in a separate deliberate tick, and say plainly where
 * to go and issue it. `deposit_status` is left on `paid` — not `forfeited`,
 * which would mean the studio kept it on purpose — so the appointment page
 * still reads "Deposit $X · paid" on a cancelled booking, which is precisely
 * the flag anybody reconciling needs to see.
 *
 * The client-side promise this is paired with lives on the booking confirmation
 * screen (BookingFlow): "if we cannot take this booking, it is returned to you
 * in full." Change one of those two and you have to change the other.
 */
export function PendingBookingActions({
  appointmentId,
  clientName,
  depositCents,
  depositStatus,
  depositPaymentIntentId,
}: {
  appointmentId: string
  clientName: string
  /** Integer cents, straight off the appointment row. */
  depositCents: number
  depositStatus: DepositStatus
  /** Null whenever the money did not come through Stripe Checkout. */
  depositPaymentIntentId: string | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')
  const [refundAcknowledged, setRefundAcknowledged] = useState(false)

  // Only `paid` is money sitting with the studio that this decision strands.
  // `refunded` has already been handed back, `forfeited` was kept on purpose,
  // and `pending`/`none` never arrived.
  const depositHeld = depositStatus === 'paid' && depositCents > 0

  function closeDecline() {
    setDeclining(false)
    setReason('')
    setRefundAcknowledged(false)
  }

  /*
   * Both writes below ask for the changed row back.
   *
   * Without `.select()`, supabase-js sends `Prefer: return=minimal`, and a WHERE
   * that matched NOTHING comes back `{ data: null, error: null }` — the same
   * shape as success. Two guards on these updates can produce exactly that: the
   * `.eq('status','pending')` losing a race with whoever answered the booking
   * first, and an update the 004 policies do not admit, which RLS filters to
   * zero rows rather than rejecting.
   *
   * These toasts are load-bearing. One claims a notification that only exists
   * if the status actually changed — `appointment_notify_review` fires on the
   * transition, not on the request — and the other is the last thing standing
   * between the decision and a refund somebody owes. Neither may be printed on
   * the strength of a write that did not happen.
   */
  async function approve() {
    setBusy(true)
    const { data, error } = await createClient()
      .from('appointments')
      .update({ status: 'confirmed', approval_reason: null })
      .eq('id', appointmentId)
      .eq('status', 'pending')
      .select('id')
    setBusy(false)

    if (error) {
      toast.error('Could not confirm that booking.')
      return
    }

    if (!data || data.length === 0) {
      // Nothing was written, so nothing was sent. Refresh rather than explain —
      // whatever this booking is now, the queue is about to show it.
      toast.error('That booking is no longer waiting — someone else has answered it.')
      router.refresh()
      return
    }

    // Precise about the channel, because there is only one. 049 writes the
    // client a notification row and the bell in the account header is what
    // renders it; nothing in this app sends mail or SMS. "Has been told" read
    // as "we texted them", which nobody did.
    pingEmailDispatch()
    toast.success(`Confirmed — ${clientName} has a notification in their account.`)
    router.refresh()
  }

  async function decline() {
    const note = reason.trim()
    if (note.length < 3) {
      toast.error('Give them a reason — they see it.')
      return
    }
    if (depositHeld && !refundAcknowledged) {
      toast.error('Confirm you will refund the deposit first.')
      return
    }

    setBusy(true)
    const { data, error } = await createClient()
      .from('appointments')
      .update({
        status: 'cancelled',
        cancellation_reason: note,
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', appointmentId)
      .eq('status', 'pending')
      .select('id')
    setBusy(false)

    if (error) {
      toast.error('Could not decline that booking.')
      return
    }

    // Nothing was cancelled, so no refund is owed on the strength of this tap.
    // Saying so matters more here than on approve: the alternative is a
    // fifteen-second warning telling somebody to hand back money for a booking
    // that is still live.
    if (!data || data.length === 0) {
      toast.error('That booking is no longer waiting — someone else has answered it.')
      closeDecline()
      router.refresh()
      return
    }

    // The card leaves the queue on refresh, so this toast is the last thing
    // standing between the decision and a forgotten refund. It gets the amount
    // and it stays up long enough to be read.
    if (depositHeld) {
      toast.warning(
        `Declined. The ${formatMoney(depositCents)} deposit has NOT been refunded — issue it in Stripe.`,
        { duration: 15000 }
      )
    } else {
      pingEmailDispatch()
      toast.success('Declined, and the time is back on the calendar.')
    }

    closeDecline()
    router.refresh()
  }

  if (declining) {
    return (
      <div className={cn('w-full space-y-3', depositHeld ? 'sm:w-96' : 'sm:w-80')}>
        {depositHeld && (
          <div className="border border-red-600/40 bg-red-50 p-4 dark:bg-transparent">
            <p className="label-caps flex items-center gap-1.5 text-red-800 dark:text-red-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
              {formatMoney(depositCents)} deposit already paid
            </p>

            <p className="mt-2 text-sm leading-relaxed text-red-800 dark:text-red-400">
              <strong>Declining does not refund it.</strong> Nothing on this screen
              moves money. The deposit stays with the studio until a person issues
              the refund, and {clientName} has been told it comes back in full when
              the studio cannot take a booking.
            </p>

            {depositPaymentIntentId ? (
              <p className="mt-3 text-sm text-red-800 dark:text-red-400">
                Refund it in the{' '}
                <a
                  href={STRIPE_PAYMENTS_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="underline underline-offset-4"
                >
                  Stripe payments list
                </a>
                . Search for{' '}
                <span className="break-all font-mono text-xs">
                  {depositPaymentIntentId}
                </span>
                .
              </p>
            ) : (
              <p className="mt-3 text-sm text-red-800 dark:text-red-400">
                There is no Stripe payment on file for this deposit, so check how it
                was taken — cash and terminal payments are recorded the same way —
                and return it however it came in.
              </p>
            )}

            <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 py-1 text-sm text-red-800 dark:text-red-400">
              <input
                type="checkbox"
                checked={refundAcknowledged}
                onChange={(e) => setRefundAcknowledged(e.target.checked)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-red-700"
              />
              <span>
                I will refund the {formatMoney(depositCents)} myself. I understand
                declining does not.
              </span>
            </label>
          </div>
        )}

        <Input
          autoFocus
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="We are fully booked that morning — call us?"
          aria-label={`Why ${clientName} is being declined`}
        />
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="danger"
            onClick={decline}
            disabled={busy || (depositHeld && !refundAcknowledged)}
          >
            {busy ? 'Declining…' : 'Decline and tell them'}
          </Button>
          <Button size="sm" variant="ghost" onClick={closeDecline} disabled={busy}>
            Back
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" onClick={approve} disabled={busy}>
        {busy ? 'Confirming…' : 'Confirm'}
      </Button>
      <Button size="sm" variant="subtle" onClick={() => setDeclining(true)} disabled={busy}>
        Decline
      </Button>
    </div>
  )
}
