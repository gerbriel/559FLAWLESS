'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

/**
 * Hand off to Stripe Checkout for one plan. The route reads the price; this
 * only says which plan. Enrolment happens in the webhook, not on the way back.
 */
export function MembershipJoinButton({ membershipId, label }: { membershipId: number; label: string }) {
  const [busy, setBusy] = useState(false)

  async function join() {
    setBusy(true)
    try {
      const res = await fetch('/api/stripe/membership', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ membership_id: membershipId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.url) {
        toast.error(data.message ?? 'Could not start the payment. Please try again.')
        setBusy(false)
        return
      }
      window.location.href = data.url
    } catch {
      toast.error('Could not reach the studio. Please try again.')
      setBusy(false)
    }
  }

  return (
    <Button onClick={join} disabled={busy} className="mt-8 w-full sm:w-auto">
      {busy ? 'Opening secure checkout…' : label}
    </Button>
  )
}
