'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { BadgeCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { applyMembershipToVisit } from '@/app/dashboard/appointments/actions'
import { formatMoney } from '@/lib/utils'

/** For a visit booked before the client joined: put the membership on it. */
export function UseMembershipButton({ appointmentId, planName }: { appointmentId: string; planName: string }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function apply() {
    setBusy(true)
    const result = await applyMembershipToVisit(appointmentId)
    setBusy(false)
    if (!result.ok) {
      toast.error(result.message)
      return
    }
    const off = result.coveredCents + result.discountCents
    toast.success(`${planName} applied — ${formatMoney(off)} off this visit.`)
    router.refresh()
  }

  return (
    <div
      data-ui="panel"
      className="mt-4 flex flex-wrap items-center justify-between gap-3 border border-[var(--color-border)] bg-[var(--color-linen)] p-4 text-sm dark:bg-[var(--color-background)]"
    >
      <p className="flex items-center gap-2">
        <BadgeCheck className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={2} />
        This client is a {planName} member, but this visit was booked before they joined.
      </p>
      <Button size="sm" variant="subtle" onClick={apply} disabled={busy}>
        {busy ? 'Applying…' : 'Use their membership'}
      </Button>
    </div>
  )
}
