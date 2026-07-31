'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/field'

/**
 * Client-side cancellation. The RLS policy on `appointments` allows a client to
 * update their own row only to `status = 'cancelled'`, so this cannot be turned
 * into a reschedule or a price edit by tampering with the request.
 */
export function CancelAppointment({
  appointmentId,
  hoursAway,
  depositPaid,
}: {
  appointmentId: string
  hoursAway: number
  depositPaid: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)

  const insideWindow = hoursAway < 24

  async function cancel() {
    setBusy(true)
    const supabase = createClient()

    const { error } = await supabase
      .from('appointments')
      .update({
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancellation_reason: reason.trim() || 'Cancelled by client',
      })
      .eq('id', appointmentId)

    setBusy(false)

    if (error) {
      toast.error('Could not cancel. Please call the studio.')
      return
    }

    toast.success('Appointment cancelled.')
    router.refresh()
  }

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="label-caps text-[var(--color-muted)] underline underline-offset-4 hover:text-red-700 dark:hover:text-red-400"
      >
        Cancel this appointment
      </button>
    )
  }

  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <p className="display text-xl">Cancel this appointment?</p>

      {insideWindow && (
        <p className="mt-3 text-sm text-amber-700 dark:text-amber-400">
          This is inside the 24-hour window.
          {depositPaid
            ? ' Your deposit will not be refunded.'
            : ' Late cancellations may affect future booking.'}
        </p>
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
          {busy ? 'Cancelling…' : 'Yes, cancel it'}
        </Button>
        <Button variant="subtle" onClick={() => setOpen(false)} disabled={busy}>
          Keep it
        </Button>
      </div>
    </div>
  )
}
