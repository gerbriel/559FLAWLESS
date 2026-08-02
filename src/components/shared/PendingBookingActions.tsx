'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/field'

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
 */
export function PendingBookingActions({
  appointmentId,
  clientName,
}: {
  appointmentId: string
  clientName: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [declining, setDeclining] = useState(false)
  const [reason, setReason] = useState('')

  async function approve() {
    setBusy(true)
    const { error } = await createClient()
      .from('appointments')
      .update({ status: 'confirmed', approval_reason: null })
      .eq('id', appointmentId)
      .eq('status', 'pending')
    setBusy(false)

    if (error) {
      toast.error('Could not confirm that booking.')
      return
    }

    toast.success(`Confirmed — ${clientName} has been told.`)
    router.refresh()
  }

  async function decline() {
    const note = reason.trim()
    if (note.length < 3) {
      toast.error('Give them a reason — they see it.')
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('appointments')
      .update({
        status: 'cancelled',
        cancellation_reason: note,
        cancelled_at: new Date().toISOString(),
      })
      .eq('id', appointmentId)
      .eq('status', 'pending')
    setBusy(false)

    if (error) {
      toast.error('Could not decline that booking.')
      return
    }

    toast.success('Declined, and the time is back on the calendar.')
    setDeclining(false)
    setReason('')
    router.refresh()
  }

  if (declining) {
    return (
      <div className="w-full space-y-3 sm:w-80">
        <Input
          autoFocus
          maxLength={200}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="We are fully booked that morning — call us?"
          aria-label={`Why ${clientName} is being declined`}
        />
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="danger" onClick={decline} disabled={busy}>
            {busy ? 'Declining…' : 'Decline and tell them'}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setDeclining(false)}
            disabled={busy}
          >
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
