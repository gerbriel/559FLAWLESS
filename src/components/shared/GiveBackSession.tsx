'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

/**
 * Hand one used membership session back (079). Manager and up — the function
 * refuses anyone else; this button is only drawn for managers.
 */
export function GiveBackSession({ redemptionId, upcoming }: { redemptionId: number; upcoming: boolean }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function giveBack() {
    const ok = confirm(
      upcoming
        ? 'Give this facial back? The visit has not happened yet, so it goes back to its normal price.'
        : 'Give this facial back? They get the session again; this past visit stays as it was.'
    )
    if (!ok) return

    setBusy(true)
    const { data, error } = await createClient().rpc('give_back_membership_session', {
      p_redemption: redemptionId,
    })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not give that back.')
      return
    }
    toast.success(
      data === 'repriced'
        ? 'Facial given back. That visit is now at its normal price.'
        : 'Facial given back.'
    )
    router.refresh()
  }

  return (
    <button
      type="button"
      onClick={giveBack}
      disabled={busy}
      className="label-caps shrink-0 text-[var(--color-muted)] hover:text-[var(--color-accent)] disabled:opacity-50"
    >
      {busy ? 'Giving back…' : 'Give back'}
    </button>
  )
}
