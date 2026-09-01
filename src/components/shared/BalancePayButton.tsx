'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'

/**
 * "Pay remaining balance", from the client's side. The amount shown is the
 * page's arithmetic; the amount CHARGED is the server's own, re-derived in
 * /api/stripe/balance at the moment of the click — the same rule every price
 * in this codebase follows. The webhook records the money.
 */
export function BalancePayButton({ appointmentId, balanceCents }: {
  appointmentId: string
  balanceCents: number
}) {
  const [busy, setBusy] = useState(false)

  async function pay() {
    setBusy(true)
    try {
      const res = await fetch('/api/stripe/balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_id: appointmentId }),
      })
      const data = await res.json()
      if (!res.ok || !data.url) {
        toast.error(
          data.error === 'nothing_owed'
            ? 'Nothing is owed on this visit — you are all settled.'
            : 'Could not open payment. Please try again, or pay at the studio.'
        )
        return
      }
      window.location.assign(data.url)
    } catch {
      toast.error('Could not reach payment. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button variant="accent" onClick={pay} disabled={busy}>
      {busy ? 'Opening payment…' : `Pay ${formatMoney(balanceCents)} balance`}
    </Button>
  )
}
