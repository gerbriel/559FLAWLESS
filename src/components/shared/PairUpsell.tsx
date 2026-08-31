'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'
import {
  addPairedService,
  PAIR_UPSELL_ERROR_MESSAGES,
} from '@/app/dashboard/appointments/actions'

/**
 * The in-chair upsell (067), said ahead of the click: what can be added to
 * today's visit at the pair price. The server page decides what appears here
 * (a pairable service, on the day, not already on the visit) and the server
 * action re-derives all of it — this component only saves the desk a trip
 * through the booking form.
 *
 * The age checkbox mirrors the one a client ticks online: the staff member is
 * attesting they verified it in person, and the attestation lands on the
 * appointment the same way.
 */

export interface PairUpsellOption {
  serviceId: number
  name: string
  fullCents: number
  priceCents: number
  /** The service needs an 18+ attestation the visit does not yet have. */
  needsAge: boolean
  minAge: number
}

export function PairUpsell({
  appointmentId,
  options,
}: {
  appointmentId: string
  options: PairUpsellOption[]
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [ageConfirmed, setAgeConfirmed] = useState<Record<number, boolean>>({})

  if (options.length === 0) return null

  function add(option: PairUpsellOption) {
    startTransition(async () => {
      const result = await addPairedService(
        appointmentId,
        option.serviceId,
        ageConfirmed[option.serviceId] ?? false
      )
      if (!result.ok) {
        toast.error(PAIR_UPSELL_ERROR_MESSAGES[result.error])
        // The screen may be showing a state that is no longer true — an
        // appointment moved on, or someone else already added it.
        if (result.error === 'already_on_visit' || result.error === 'not_open') {
          router.refresh()
        }
        return
      }
      toast.success(`${result.name} added — ${formatMoney(result.priceCents)}.`, {
        description: `Pair deal: ${formatMoney(result.fullPriceCents - result.priceCents)} off the usual price. The balance below has moved.`,
      })
      router.refresh()
    })
  }

  return (
    <div
      data-ui="tile"
      className="border border-[var(--color-border)] bg-[var(--color-linen)] p-5 dark:bg-[var(--color-background)]"
    >
      <p className="label-caps mb-1 flex items-center gap-2 text-[var(--color-accent)]">
        <Sparkles className="h-3.5 w-3.5" strokeWidth={2} />
        Pair deal available
      </p>
      <p className="text-sm text-[var(--color-muted)]">
        Booked alongside today&rsquo;s visit, these come at the pair price. Adding one
        puts it on this appointment and extends the time.
      </p>

      <ul className="mt-4 divide-y divide-[var(--color-border)]">
        {options.map((o) => (
          <li key={o.serviceId} className="py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm">{o.name}</p>
                <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                  <s>{formatMoney(o.fullCents)}</s>{' '}
                  <span className="text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]">
                    {formatMoney(o.priceCents)}
                  </span>
                </p>
              </div>
              <Button
                variant="subtle"
                size="sm"
                disabled={pending || (o.needsAge && !ageConfirmed[o.serviceId])}
                onClick={() => add(o)}
              >
                {pending ? 'Adding…' : `Add — ${formatMoney(o.priceCents)}`}
              </Button>
            </div>

            {o.needsAge && (
              <label className="mt-2 flex cursor-pointer items-start gap-2.5 text-xs text-[var(--color-muted)]">
                <input
                  type="checkbox"
                  checked={ageConfirmed[o.serviceId] ?? false}
                  onChange={(e) =>
                    setAgeConfirmed((cur) => ({ ...cur, [o.serviceId]: e.target.checked }))
                  }
                  className="mt-0.5 h-3.5 w-3.5 accent-[var(--color-accent)]"
                />
                <span>
                  I confirmed in person that the client is {o.minAge} or older.
                </span>
              </label>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
