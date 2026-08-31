'use client'

import { useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Gift } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'
import {
  applyReferralReward,
  REFERRAL_APPLY_ERROR_MESSAGES,
} from '@/app/dashboard/appointments/actions'

/**
 * The referral rewards this client has waiting (068), offered where the money
 * is settled. One tap takes a reward off this visit's total; the balance
 * below moves with it. The server re-derives everything — this only spares
 * the desk remembering that the client earned something.
 */

export interface WaitingReward {
  id: number
  /** "$20" or "15%", built server-side from the row. */
  label: string
}

export function ReferralRewardApply({
  appointmentId,
  rewards,
}: {
  appointmentId: string
  rewards: WaitingReward[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  if (rewards.length === 0) return null

  function apply(rewardId: number) {
    startTransition(async () => {
      const result = await applyReferralReward(appointmentId, rewardId)
      if (!result.ok) {
        toast.error(REFERRAL_APPLY_ERROR_MESSAGES[result.error])
        if (result.error === 'already_applied') router.refresh()
        return
      }
      toast.success(`Referral reward applied — ${formatMoney(result.cents)} off this visit.`)
      router.refresh()
    })
  }

  return (
    <div
      data-ui="tile"
      className="border border-[var(--color-border)] bg-[var(--color-linen)] p-5 dark:bg-[var(--color-background)]"
    >
      <p className="label-caps mb-1 flex items-center gap-2 text-[var(--color-accent)]">
        <Gift className="h-3.5 w-3.5" strokeWidth={2} />
        Referral reward waiting
      </p>
      <p className="text-sm text-[var(--color-muted)]">
        This client brought {rewards.length === 1 ? 'a friend' : 'friends'} in. Applying a
        reward takes it off this visit&rsquo;s total.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {rewards.map((r) => (
          <Button
            key={r.id}
            variant="subtle"
            size="sm"
            disabled={pending}
            onClick={() => apply(r.id)}
          >
            {pending ? 'Applying…' : `Apply ${r.label} off`}
          </Button>
        ))}
      </div>
    </div>
  )
}
