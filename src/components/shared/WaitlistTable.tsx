'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  WAITLIST_STATUS_LABELS,
  WAITLIST_STATUS_TONES,
  claimMinutesLeft,
  describeDateRange,
  describeDays,
  describeTimeWindow,
  type WaitlistStatus,
} from '@/types/resources'

export interface WaitlistRow {
  id: string
  client_id: string
  client_name: string
  client_email: string | null
  provider_name: string | null
  service_names: string[]
  earliest_date: string
  latest_date: string
  days_of_week: number[]
  earliest_time: string | null
  latest_time: string | null
  note: string | null
  status: WaitlistStatus
  created_at: string
  claim_expires_at: string | null
  offers_sent: number
  /** Only set when the business has more than one site. */
  location_name: string | null
}

/**
 * Who is waiting, for what, and where they are in the queue.
 *
 * Ordered by `created_at` from the page, and that order is not decoration — it
 * is the fairness rule. The person at the top is the person the next matching
 * cancellation goes to, so the table reads top-down as "who is next".
 */
export function WaitlistTable({ rows, now }: { rows: WaitlistRow[]; now: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState<string | null>(null)

  /**
   * Give up a hold early. The offer stands — they can still book it — but the
   * queue stops waiting on them, which is what the front desk wants when
   * someone rings to say they cannot make it after all.
   */
  async function release(row: WaitlistRow) {
    setBusy(row.id)
    const { error } = await createClient()
      .from('waitlist_entries')
      .update({ status: 'waiting', claim_expires_at: null })
      .eq('id', row.id)
    setBusy(null)

    if (error) {
      toast.error(error.message || 'Could not release that hold.')
      return
    }
    toast.success(`${row.client_name} is back in the queue.`)
    router.refresh()
  }

  async function remove(row: WaitlistRow) {
    setBusy(row.id)
    const { error } = await createClient()
      .from('waitlist_entries')
      .delete()
      .eq('id', row.id)
    setBusy(null)

    if (error) {
      toast.error(error.message || 'Could not remove that entry.')
      return
    }
    toast.success(`${row.client_name} taken off the list.`)
    router.refresh()
  }

  return (
    <div className="mt-8 overflow-x-auto">
      <table className="w-full min-w-4xl text-sm">
        <thead>
          <tr className="border-y border-[var(--color-border)]">
            <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">
              Client
            </th>
            <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">
              Waiting for
            </th>
            <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">
              When they can come
            </th>
            <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">
              Since
            </th>
            <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">
              Status
            </th>
            <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const days = describeDays(row.days_of_week)
            const times = describeTimeWindow(row.earliest_time, row.latest_time)
            const claimLeft = claimMinutesLeft(row.claim_expires_at, now)
            const isNext = index === 0 && row.status === 'waiting'

            return (
              <tr key={row.id} className="border-b border-[var(--color-border)] align-top">
                <td className="px-3 py-4">
                  <Link
                    href={`/dashboard/clients/${row.client_id}`}
                    className="block hover:text-[var(--color-accent)]"
                  >
                    {row.client_name}
                  </Link>
                  {isNext && (
                    <span className="mt-1 block text-xs text-[var(--color-accent)]">
                      Next in line
                    </span>
                  )}
                  {row.location_name && (
                    <span className="mt-1 block text-xs text-[var(--color-muted)]">
                      {row.location_name}
                    </span>
                  )}
                </td>

                <td className="px-3 py-4">
                  <span className="block">
                    {row.service_names.join(', ') || 'Anything'}
                  </span>
                  <span className="mt-1 block text-xs text-[var(--color-muted)]">
                    {row.provider_name ? `With ${row.provider_name}` : 'Anyone free'}
                  </span>
                  {row.note && (
                    <span className="mt-1 block text-xs italic text-[var(--color-muted)]">
                      &ldquo;{row.note}&rdquo;
                    </span>
                  )}
                </td>

                <td className="px-3 py-4">
                  <span className="block">
                    {describeDateRange(row.earliest_date, row.latest_date)}
                  </span>
                  <span className="mt-1 block text-xs text-[var(--color-muted)]">
                    {[days ?? 'Any day', times ?? 'any time'].join(' · ')}
                  </span>
                </td>

                <td className="px-3 py-4 whitespace-nowrap text-[var(--color-muted)]">
                  {describeWait(row.created_at, now)}
                </td>

                <td className="px-3 py-4">
                  <Badge tone={WAITLIST_STATUS_TONES[row.status]}>
                    {WAITLIST_STATUS_LABELS[row.status]}
                  </Badge>
                  {claimLeft !== null && (
                    <span className="mt-1.5 block text-xs text-[var(--color-muted)]">
                      Held {claimLeft} more {claimLeft === 1 ? 'minute' : 'minutes'}
                    </span>
                  )}
                  {row.offers_sent > 0 && claimLeft === null && (
                    <span className="mt-1.5 block text-xs text-[var(--color-muted)]">
                      {row.offers_sent} {row.offers_sent === 1 ? 'offer' : 'offers'} sent
                    </span>
                  )}
                </td>

                <td className="px-3 py-4">
                  <div className="flex justify-end gap-2">
                    {row.status === 'notified' && (
                      <Button
                        variant="subtle"
                        size="sm"
                        disabled={busy === row.id}
                        onClick={() => release(row)}
                      >
                        Release hold
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy === row.id}
                      onClick={() => remove(row)}
                    >
                      Remove
                    </Button>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** "3 days" / "2 hours" / "Just now" — how long they have been in the queue. */
function describeWait(createdAt: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(createdAt).getTime()) / 60_000))
  if (minutes < 60) return minutes < 2 ? 'Just now' : `${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} ${hours === 1 ? 'hour' : 'hours'}`
  const days = Math.round(hours / 24)
  if (days < 14) return `${days} days`
  const weeks = Math.round(days / 7)
  return `${weeks} ${weeks === 1 ? 'week' : 'weeks'}`
}
