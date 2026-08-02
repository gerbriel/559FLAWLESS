'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import type { DispatchSummary } from '@/types/notifications'

/**
 * "Send anything due now."
 *
 * Safe to lean on. The dispatcher writes one row per (recipient, kind, channel,
 * subject, intended instant), so pressing this twice — or pressing it while the
 * scheduled sweep is running — sends nothing the second time. Worth saying out
 * loud in the UI, because a button that might double-message clients is a
 * button nobody presses.
 */
export function NotificationDispatchNow() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [last, setLast] = useState<DispatchSummary | null>(null)

  async function run() {
    setBusy(true)
    try {
      const response = await fetch('/api/notifications/dispatch', { method: 'POST' })
      const result = (await response.json()) as DispatchSummary & { error?: string }

      if (!response.ok) {
        toast.error(
          result.error === 'forbidden'
            ? 'Only a manager can send these.'
            : 'Could not send. Nothing went out.'
        )
        return
      }

      setLast(result)
      toast.success(
        result.sent > 0
          ? `Sent ${result.sent}.`
          : 'Nothing was due — everything already went out.'
      )
      router.refresh()
    } catch {
      toast.error('Could not reach the server. Nothing went out.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-4">
      <Button variant="subtle" size="sm" onClick={run} disabled={busy}>
        {busy ? 'Sending…' : 'Send anything due now'}
      </Button>

      {last && (
        <p className="text-xs text-[var(--color-muted)]">
          {last.sent} sent · {last.skipped} skipped · {last.failed} failed
          {last.awaiting_sender > 0 && ` · ${last.awaiting_sender} waiting on email or SMS`}
        </p>
      )}
    </div>
  )
}
