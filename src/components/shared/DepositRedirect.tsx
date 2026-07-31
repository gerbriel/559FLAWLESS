'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'

export function DepositRedirect({ appointmentId }: { appointmentId: string }) {
  const [busy, setBusy] = useState(false)

  async function go() {
    setBusy(true)
    try {
      const res = await fetch('/api/stripe/deposit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appointment_id: appointmentId }),
      })
      const data = await res.json()

      if (!res.ok || !data.url) {
        toast.error(
          data.error === 'stripe_not_configured'
            ? 'Online payment is not set up yet. Please call the studio.'
            : 'Could not start checkout. Please try again.'
        )
        return
      }

      window.location.assign(data.url)
    } catch {
      toast.error('Could not reach checkout. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button size="lg" onClick={go} disabled={busy}>
      {busy ? 'Redirecting…' : 'Continue to secure payment'}
    </Button>
  )
}
