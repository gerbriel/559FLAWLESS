'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Calendar, RefreshCw, AlertTriangle, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'

export interface CalendarConnectionState {
  google_email: string | null
  calendar_id: string
  last_synced_at: string | null
  last_sync_error: string | null
  revoked_at: string | null
  push_appointments: boolean
  pull_busy: boolean
}

/**
 * Connect, disconnect and steer the Google Calendar link.
 *
 * The two directions are separate switches because they answer different
 * questions. Pulling is about protecting slots — anything already in her
 * calendar stops a client booking over it. Pushing is about the calendar being
 * worth looking at. Most people want both, but somebody who keeps a strictly
 * personal calendar might want only the first.
 */
export function CalendarConnection({
  providerId,
  connection,
  configured,
  busyCount,
}: {
  providerId: string
  connection: CalendarConnectionState | null
  /** Whether this deployment has the Google credentials set at all. */
  configured: boolean
  busyCount: number
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function syncNow() {
    setBusy(true)
    try {
      const res = await fetch('/api/calendar/sync', { method: 'POST' })
      const data = await res.json()

      if (!res.ok) {
        toast.error(data.message ?? 'Could not sync.')
        return
      }
      const found = data.results?.[0]
      toast.success(
        found?.error
          ? `Sync failed: ${found.error}`
          : `Synced — ${found?.events ?? 0} entries read from your calendar.`
      )
      router.refresh()
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  async function disconnect() {
    if (
      !confirm(
        'Disconnect Google Calendar? Bookings already in your calendar stay there, but new ones will not appear and your personal events will stop blocking slots.'
      )
    ) {
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/calendar/disconnect', { method: 'POST' })
      if (!res.ok) {
        toast.error('Could not disconnect.')
        return
      }
      toast.success('Disconnected.')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function toggle(field: 'push_appointments' | 'pull_busy', value: boolean) {
    // Spelled out rather than a computed key: a computed key widens to
    // Record<string, boolean>, which supabase-js rejects against the row type.
    const patch =
      field === 'push_appointments' ? { push_appointments: value } : { pull_busy: value }

    const { error } = await createClient()
      .from('calendar_connections')
      .update(patch)
      .eq('provider_id', providerId)

    if (error) {
      toast.error('Could not save that.')
      return
    }
    router.refresh()
  }

  if (!configured) {
    return (
      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="flex items-center gap-2.5">
          <Calendar className="h-5 w-5 text-[var(--color-muted)]" strokeWidth={1.5} />
          <h2 className="display text-xl">Google Calendar</h2>
        </div>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          Not set up on this site yet. It needs Google credentials and an encryption key
          in the environment — see SETUP-GOOGLE-CALENDAR.md.
        </p>
      </section>
    )
  }

  const connected = !!connection && !connection.revoked_at

  return (
    <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2.5">
            <Calendar className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={1.5} />
            <h2 className="display text-xl">Google Calendar</h2>
            {connected ? (
              <Badge tone="success">
                <Check className="h-3 w-3" strokeWidth={2.5} />
                Connected
              </Badge>
            ) : connection?.revoked_at ? (
              <Badge tone="danger">Access revoked</Badge>
            ) : (
              <Badge tone="neutral">Not connected</Badge>
            )}
          </div>

          {connected ? (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              {connection.google_email ?? 'Connected'} ·{' '}
              {connection.last_synced_at
                ? `last synced ${new Date(connection.last_synced_at).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}`
                : 'never synced'}
              {busyCount > 0 && ` · ${busyCount} entries blocking slots`}
            </p>
          ) : (
            <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
              Connect it and your bookings appear in your calendar, while anything
              already there — a dentist appointment, the school run — stops a client
              booking over it.
            </p>
          )}
        </div>

        {connected ? (
          <div className="flex flex-wrap gap-2">
            <Button size="sm" variant="subtle" onClick={syncNow} disabled={busy}>
              <RefreshCw className={`h-4 w-4 ${busy ? 'animate-spin' : ''}`} strokeWidth={1.75} />
              Sync now
            </Button>
            <Button size="sm" variant="ghost" onClick={disconnect} disabled={busy}>
              Disconnect
            </Button>
          </div>
        ) : (
          <a href="/api/calendar/connect">
            <Button size="sm">
              {connection?.revoked_at ? 'Reconnect' : 'Connect calendar'}
            </Button>
          </a>
        )}
      </div>

      {connection?.last_sync_error && (
        <p className="mt-4 flex items-start gap-2 border-l-2 border-amber-500 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-transparent dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} />
          {connection.last_sync_error}
        </p>
      )}

      {connected && (
        <div className="mt-6 space-y-3 border-t border-[var(--color-border)] pt-5">
          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={connection.pull_busy}
              onChange={(e) => toggle('pull_busy', e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Block slots from my calendar
              <span className="block text-xs text-[var(--color-muted)]">
                Anything in your Google Calendar stops clients booking that time. Events
                you have marked &ldquo;free&rdquo; are ignored.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-3 text-sm">
            <input
              type="checkbox"
              checked={connection.push_appointments}
              onChange={(e) => toggle('push_appointments', e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Put my bookings in the calendar
              <span className="block text-xs text-[var(--color-muted)]">
                Client name and service only — never intake answers, notes, or anything
                clinical.
              </span>
            </span>
          </label>
        </div>
      )}
    </section>
  )
}
