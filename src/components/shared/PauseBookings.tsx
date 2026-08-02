'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PauseCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

/**
 * "Stop taking online bookings", on the page a provider actually opens.
 *
 * Migration 045 lets anyone switch themselves off at any time, but Settings —
 * where the full visibility controls live — is manager-and-above, so a provider
 * had no way to exercise that. Someone who is ill, or leaving, or simply full
 * should not have to find an admin before the booking page stops offering their
 * time.
 *
 * Switching back ON is deliberately not here: that is the studio's decision
 * about whose time it sells, and 045 enforces it in the database regardless of
 * what any UI offers.
 */
export function PauseBookings({ providerId }: { providerId: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function pause() {
    if (
      !confirm(
        'Stop taking online bookings?\n\nAppointments already in the diary are untouched — this only stops new ones. An admin can put you back on the booking page.'
      )
    ) {
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('profiles')
      .update({ accepts_online_booking: false })
      .eq('id', providerId)
    setBusy(false)

    if (error) {
      toast.error('Could not do that. Please try again.')
      return
    }

    toast.success('You are off the booking page. Existing appointments are unchanged.')
    router.refresh()
  }

  return (
    <div className="mt-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <p className="text-sm">Taking online bookings</p>
      <p className="mt-1 max-w-prose text-sm text-[var(--color-muted)]">
        Clients can see your times and book them. Stopping affects new bookings only —
        anything already in the diary stays exactly as it is.
      </p>
      <Button variant="subtle" size="sm" className="mt-4" onClick={pause} disabled={busy}>
        <PauseCircle className="h-4 w-4" strokeWidth={1.75} />
        {busy ? 'Saving…' : 'Stop taking online bookings'}
      </Button>
    </div>
  )
}
