'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { BellRing } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { StaffProfileLicenceBadge } from '@/components/shared/StaffProfileLicenceBadge'
import { daysUntilDateKey, formatDateKey, licenceStatus } from '@/types/team'

export interface LicenceRow {
  profile_id: string
  name: string
  licence_expires_on: string | null
}

/**
 * Every licence the studio holds, worst first.
 *
 * Someone working on a lapsed licence is not a paperwork problem — it is an
 * unlicensed treatment, uninsured, and citable against the establishment as
 * much as the individual. So this sorts by how much trouble each row is in
 * rather than by name, and the ones with no date on file are counted as
 * trouble too.
 *
 * The button sends whatever is due right now. It is the same function a nightly
 * job calls, and it is idempotent — pressing it twice does not send two of
 * anything.
 */
export function StaffProfileLicences({ rows, now }: { rows: LicenceRow[]; now: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  const rank = (row: LicenceRow) => {
    const status = licenceStatus(row.licence_expires_on)
    if (status === 'expired') return 0
    if (status === 'unknown') return 1
    if (status === 'expires_soon') return 2
    return 3
  }

  const sorted = [...rows].sort((a, b) => {
    const byRank = rank(a) - rank(b)
    if (byRank !== 0) return byRank
    const da = a.licence_expires_on ? daysUntilDateKey(a.licence_expires_on, now) : null
    const db = b.licence_expires_on ? daysUntilDateKey(b.licence_expires_on, now) : null
    if (da == null || db == null) return a.name.localeCompare(b.name)
    return da - db
  })

  const needsAttention = sorted.filter((r) => rank(r) < 3).length

  async function sendReminders() {
    setBusy(true)
    const { data, error } = await createClient().rpc('notify_expiring_licences')
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not run the check.')
      return
    }

    const sent = typeof data === 'number' ? data : 0
    toast.success(
      sent === 0
        ? 'Nothing due — everyone already knows where they stand.'
        : `Reminders sent about ${sent} licence${sent === 1 ? '' : 's'}.`
    )
    router.refresh()
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h2 className="display text-2xl">Licences</h2>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            {needsAttention === 0
              ? 'Everything current and on file.'
              : `${needsAttention} ${needsAttention === 1 ? 'needs' : 'need'} attention.`}{' '}
            Reminders go to the holder and to every manager at 60, 30, 14 and 7 days, and
            again the day it lapses.
          </p>
        </div>
        <Button type="button" variant="subtle" size="sm" onClick={sendReminders} disabled={busy}>
          <BellRing className="h-4 w-4" strokeWidth={1.5} />
          {busy ? 'Checking…' : 'Send anything due'}
        </Button>
      </div>

      {sorted.length === 0 ? (
        <p className="mt-6 text-sm text-[var(--color-muted)]">No staff on the books yet.</p>
      ) : (
        <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {sorted.map((row) => (
            <li
              key={row.profile_id}
              className="flex flex-wrap items-center justify-between gap-4 py-4"
            >
              <div>
                <p className="text-sm">{row.name}</p>
                <p className="text-xs tabular-nums text-[var(--color-muted)]">
                  {row.licence_expires_on
                    ? `Expires ${formatDateKey(row.licence_expires_on)}`
                    : 'No expiry date recorded'}
                </p>
              </div>
              <StaffProfileLicenceBadge expiresOn={row.licence_expires_on} now={now} />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
