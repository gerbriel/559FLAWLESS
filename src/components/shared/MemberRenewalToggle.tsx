'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { membershipErrorMessage } from '@/types/memberships'

/**
 * Stop or resume a member's Stripe auto-renew on their behalf.
 *
 * The route re-checks that the caller is a manager and that the membership is
 * on a subscription; hiding this button from everyone else is a courtesy, not
 * the gate. Stopping does not end anything today: the member keeps what they
 * paid for until the period runs out.
 */
export function MemberRenewalToggle({
  clientMembershipId,
  renewing,
  memberName,
}: {
  clientMembershipId: number
  /** True when Stripe will charge again at the period end. */
  renewing: boolean
  memberName?: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function toggle() {
    const action = renewing ? 'stop_renewing' : 'resume_renewing'
    if (
      renewing &&
      !confirm(
        `Stop renewing${memberName ? ` for ${memberName}` : ''}? Their membership stays current until the period ends, and Stripe will not charge them again.`
      )
    ) {
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/stripe/membership/manage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, client_membership_id: clientMembershipId }),
      })
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean
        auto_renew?: boolean
        error?: string
      }
      if (!res.ok || !body.ok) {
        toast.error(membershipErrorMessage(body.error, 'Could not change the renewal. Try again in a moment.'))
        return
      }
      toast.success(
        body.auto_renew
          ? 'Renewing again. Stripe will charge at the end of the period.'
          : 'Stopped. The membership runs to the end of the period, then ends.'
      )
      router.refresh()
    } catch {
      toast.error('Could not reach the server. Try again in a moment.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button type="button" size="sm" variant="subtle" disabled={busy} onClick={toggle}>
      {busy ? 'Saving…' : renewing ? 'Stop renewing' : 'Resume renewing'}
    </Button>
  )
}
