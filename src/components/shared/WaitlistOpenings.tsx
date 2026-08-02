'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { formatDateTimeInTimeZone } from '@/lib/time'

export interface FreedSlot {
  appointment_id: string
  starts_at: string
  /** The location's zone. Never assume the studio's — see the multi-site rule. */
  time_zone: string
  provider_name: string
  service_names: string[]
  /** How many waitlist entries this slot would go to right now. */
  match_count: number
  location_name: string | null
}

/**
 * Cancellations in the next week that nobody has taken yet.
 *
 * The database already offered each of these to whoever was first in line when
 * it happened. This is for the two cases it cannot cover on its own: the person
 * at the front let their window lapse and nothing has run since, and the front
 * desk wants to push it along rather than wait.
 *
 * "Check for openings" is `waitlist_sweep()` — release every claim that has run
 * out, then pass each freed slot to the next person. It is the same call a cron
 * would make, exposed as a button because this project has no scheduler and a
 * chair going empty is not something to leave to one.
 */
export function WaitlistOpenings({ openings }: { openings: FreedSlot[] }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  async function sweep() {
    setBusy('sweep')
    const { data, error } = await createClient().rpc('waitlist_sweep')
    setBusy(null)

    if (error) {
      toast.error(error.message || 'Could not check the waitlist.')
      return
    }
    const sent = Number(data ?? 0)
    toast.success(
      sent === 0
        ? 'Nothing to pass on — every open slot is already with someone.'
        : `Offered to ${sent} ${sent === 1 ? 'person' : 'people'}.`
    )
    router.refresh()
  }

  async function tellNext(slot: FreedSlot) {
    setBusy(slot.appointment_id)
    // An explicit count is the override: it tells the next person even if
    // someone else is still inside their claim window.
    const { data, error } = await createClient().rpc('waitlist_notify_for_appointment', {
      p_appointment: slot.appointment_id,
      p_limit: 1,
    })
    setBusy(null)

    if (error) {
      toast.error(error.message || 'Could not send that offer.')
      return
    }
    toast.success(
      Number(data ?? 0) > 0
        ? 'Offer sent. It is held for them until the window runs out.'
        : 'Nobody on the list matches that slot.'
    )
    router.refresh()
  }

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h2 className="label-caps text-[var(--color-accent)]">Open slots</h2>
        <Button variant="subtle" size="sm" disabled={busy !== null} onClick={sweep}>
          <RefreshCw
            className={busy === 'sweep' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
            strokeWidth={1.5}
          />
          {busy === 'sweep' ? 'Checking…' : 'Check for openings'}
        </Button>
      </div>

      {openings.length === 0 ? (
        <p className="mt-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-sm text-[var(--color-muted)]">
          No cancellations in the last week. When one comes in, it appears here and the
          list is told automatically.
        </p>
      ) : (
        <ul className="mt-5 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2">
          {openings.map((slot) => (
            <li
              key={slot.appointment_id}
              className="flex flex-wrap items-start justify-between gap-4 bg-[var(--color-surface)] p-5"
            >
              <div>
                <p className="text-sm">
                  {formatDateTimeInTimeZone(new Date(slot.starts_at), slot.time_zone)}
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted)]">
                  {slot.service_names.join(', ') || 'Appointment'} · {slot.provider_name}
                  {slot.location_name ? ` · ${slot.location_name}` : ''}
                </p>
                <p className="mt-2">
                  {slot.match_count === 0 ? (
                    <Badge tone="neutral">Nobody waiting for this</Badge>
                  ) : (
                    <Badge tone="accent">
                      {slot.match_count} {slot.match_count === 1 ? 'match' : 'matches'}
                    </Badge>
                  )}
                </p>
              </div>

              {slot.match_count > 0 && (
                <Button
                  variant="subtle"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => tellNext(slot)}
                >
                  {busy === slot.appointment_id ? 'Sending…' : 'Tell the next one'}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
