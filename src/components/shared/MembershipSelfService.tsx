'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { membershipErrorMessage } from '@/types/memberships'

type Action = 'stop_renewing' | 'resume_renewing' | 'billing_portal'

/**
 * A member's own renewal controls, for a membership Stripe bills on a
 * subscription. The page only mounts this when `stripe_subscription_id` is
 * set; a paid-once membership has nothing to stop or resume.
 *
 * The manage route acts on the signed-in member's own membership and Stripe is
 * still the record: this asks, then refreshes the page so what it shows is
 * what the server now holds, not what this component guessed.
 */
export function MembershipSelfService({
  renewing,
  periodEndLabel,
}: {
  /** auto_renew and not cancelling at period end. */
  renewing: boolean
  /** The current period end, already formatted for the sentence. */
  periodEndLabel: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState<Action | null>(null)

  async function run(action: Action) {
    if (
      action === 'stop_renewing' &&
      !window.confirm(
        `Stop renewing? Your membership stays as it is until ${periodEndLabel} and is not charged again.`
      )
    ) {
      return
    }
    setBusy(action)
    try {
      const res = await fetch('/api/stripe/membership/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || data.error) {
        toast.error(membershipErrorMessage(data.error, 'That did not go through. Please try again.'))
        setBusy(null)
        return
      }
      if (action === 'billing_portal') {
        if (!data.url) {
          toast.error('Could not open the card page. Please try again.')
          setBusy(null)
          return
        }
        window.location.assign(data.url)
        return
      }
      toast.success(
        data.auto_renew
          ? 'Renewing again. Nothing changes until your next renewal date.'
          : `Renewal stopped. Your membership runs until ${periodEndLabel}.`
      )
      setBusy(null)
      router.refresh()
    } catch {
      toast.error('Could not reach the studio. Please try again.')
      setBusy(null)
    }
  }

  return (
    <div className="mt-6 flex flex-wrap gap-3">
      {renewing ? (
        <Button variant="subtle" size="sm" disabled={busy !== null} onClick={() => run('stop_renewing')}>
          {busy === 'stop_renewing' ? 'Stopping…' : 'Stop renewing'}
        </Button>
      ) : (
        <Button variant="subtle" size="sm" disabled={busy !== null} onClick={() => run('resume_renewing')}>
          {busy === 'resume_renewing' ? 'Resuming…' : 'Resume renewing'}
        </Button>
      )}
      <Button variant="subtle" size="sm" disabled={busy !== null} onClick={() => run('billing_portal')}>
        {busy === 'billing_portal' ? 'Opening…' : 'Update card'}
      </Button>
    </div>
  )
}
