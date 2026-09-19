'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Bell, Check, CircleDashed, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { approveBooking } from '@/lib/approve-booking'
import type { Notification } from '@/types/database'

/**
 * The bell.
 *
 * Three things happen here that used not to. A notification can be dismissed
 * and the whole list cleared — "mark all read" left a list that only ever grew,
 * so the bell stopped being somewhere anyone looked. A booking still waiting on
 * a person carries its own Approve button, because the queue's own screen is
 * two taps away and the answer is usually yes. And the count of what is waiting
 * rides at the top whether or not any notification survived being cleared:
 * clearing the bell is a statement about the bell, never about the queue.
 *
 * Deleting a notification that the email mirror (072) has not swept yet means
 * no email for it. That is the honest reading of dismissing something in the
 * app you were told it in, and it is why the sweep stamps rather than reads
 * back.
 */
export function NotificationBell({
  count,
  pendingCount = 0,
  canApprove = false,
}: {
  count: number
  /** Bookings waiting on a person, as RLS scopes them for this viewer. */
  pendingCount?: number
  /** Staff. A client has notifications about bookings but no say over them. */
  canApprove?: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[]>([])
  const [busyId, setBusyId] = useState<string | null>(null)

  /*
   * `count` and `pendingCount` come from the server on every render, so they
   * are never copied into state — an effect that mirrored them would fight the
   * fresh value. What is remembered is only what this session did to them:
   * how many unread ones were dismissed, and whether the lot was cleared.
   */
  const [clearedAll, setClearedAll] = useState(false)
  const [dismissedUnread, setDismissedUnread] = useState(0)
  const [approvedHere, setApprovedHere] = useState(0)
  const unread = clearedAll ? 0 : Math.max(0, count - dismissedUnread)
  const waiting = Math.max(0, pendingCount - approvedHere)

  /**
   * Which of these bookings is still waiting on somebody.
   *
   * Asked of `appointments`, never inferred from the notification: a row
   * written the moment a booking arrived says nothing about whether it has
   * since been answered — possibly by the person reading this list.
   */
  const [stillPending, setStillPending] = useState<Set<string>>(new Set())

  useEffect(() => {
    if (!open) return

    // Defined in here rather than hoisted: the setState calls below land after
    // an await, which is what keeps this a subscription to an external system
    // rather than a synchronous cascade out of the effect body.
    async function load() {
      const supabase = createClient()
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(15)

      const list = data ?? []
      setItems(list)

      if (!canApprove) return
      const ids = [
        ...new Set(list.map((n) => n.appointment_id).filter((id): id is string => !!id)),
      ]
      if (ids.length === 0) {
        setStillPending(new Set())
        return
      }
      const { data: appts } = await supabase
        .from('appointments')
        .select('id, status')
        .in('id', ids)
      setStillPending(
        new Set((appts ?? []).filter((a) => a.status === 'pending').map((a) => a.id))
      )
    }

    void load()
  }, [open, canApprove])

  async function markAllRead() {
    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return

    await supabase
      .from('notifications')
      .update({ read_at: new Date().toISOString() })
      .eq('user_id', user.id)
      .is('read_at', null)

    const now = new Date().toISOString()
    setClearedAll(true)
    setItems((list) => list.map((n) => ({ ...n, read_at: n.read_at ?? now })))
  }

  /** Everything of theirs, not only the fifteen on screen. */
  async function clearAll() {
    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()
    if (!user) return

    const { error } = await supabase.from('notifications').delete().eq('user_id', user.id)
    if (error) {
      toast.error('Could not clear those.')
      return
    }
    setItems([])
    setClearedAll(true)
  }

  async function dismiss(n: Notification) {
    const { error } = await createClient().from('notifications').delete().eq('id', n.id)
    if (error) {
      toast.error('Could not dismiss that.')
      return
    }
    setItems((list) => list.filter((x) => x.id !== n.id))
    if (!n.read_at) setDismissedUnread((d) => d + 1)
  }

  async function approve(n: Notification) {
    if (!n.appointment_id) return
    setBusyId(String(n.id))
    const outcome = await approveBooking(n.appointment_id)
    setBusyId(null)

    if (outcome === 'failed') {
      toast.error('Could not confirm that booking.')
      return
    }

    // Either way it has left the queue, so the button goes either way.
    setStillPending((s) => {
      const next = new Set(s)
      next.delete(n.appointment_id!)
      return next
    })

    if (outcome === 'already_answered') {
      toast.error('That booking is no longer waiting — someone else has answered it.')
    } else {
      setApprovedHere((c) => c + 1)
      toast.success('Confirmed — the client has a notification in their account.')
    }
    router.refresh()
  }

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative p-2 transition-colors hover:text-[var(--color-accent)]"
        aria-label={`Notifications${unread > 0 ? ` (${unread} unread)` : ''}`}
        aria-expanded={open}
      >
        <Bell className="h-4.5 w-4.5" strokeWidth={1.5} />
        {unread > 0 && (
          <span className="absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center bg-[var(--color-accent)] px-1 text-[0.5625rem] text-white">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click-away layer */}
          <button
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
            aria-label="Close notifications"
            tabIndex={-1}
          />
          {/* Capped to the viewport so a narrow phone never clips the left
              edge of a right-anchored panel. */}
          <div className="absolute right-0 top-full z-50 mt-2 w-80 max-w-[calc(100vw-1.5rem)] border border-[var(--color-border)] bg-[var(--color-surface)] shadow-lg">
            <div className="flex items-center justify-between gap-3 border-b border-[var(--color-border)] px-4 py-3">
              <span className="label-caps">Notifications</span>
              <span className="flex items-center gap-3">
                {unread > 0 && (
                  <button
                    onClick={markAllRead}
                    className="label-caps text-[var(--color-accent)]"
                  >
                    Mark read
                  </button>
                )}
                {items.length > 0 && (
                  <button
                    onClick={clearAll}
                    className="label-caps text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                  >
                    Clear all
                  </button>
                )}
              </span>
            </div>

            {/* The queue, not the list. Survives Clear all on purpose. */}
            {canApprove && waiting > 0 && (
              <Link
                href="/dashboard/appointments/pending"
                onClick={() => setOpen(false)}
                className="flex items-center gap-2 border-b border-[var(--color-border)] bg-[var(--color-linen)] px-4 py-3 text-sm transition-colors hover:text-[var(--color-accent)] dark:bg-[var(--color-background)]"
              >
                <CircleDashed className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                <span className="tabular-nums">{waiting}</span>
                <span>{waiting === 1 ? 'booking awaits approval' : 'bookings await approval'}</span>
              </Link>
            )}

            {items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">
                Nothing new.
              </p>
            ) : (
              <ul className="max-h-96 divide-y divide-[var(--color-border)] overflow-y-auto">
                {items.map((n) => {
                  const awaiting = !!n.appointment_id && stillPending.has(n.appointment_id)
                  const content = (
                    <div className="px-4 py-3">
                      <p className="flex items-start gap-2 text-sm">
                        {!n.read_at && (
                          <span className="mt-1.5 h-1.5 w-1.5 shrink-0 bg-[var(--color-accent)]" />
                        )}
                        <span>{n.title}</span>
                      </p>
                      {n.body && (
                        <p className="mt-1 pl-3.5 text-xs text-[var(--color-muted)]">
                          {n.body}
                        </p>
                      )}
                    </div>
                  )

                  return (
                    <li
                      key={n.id}
                      className="group relative transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)]"
                    >
                      {/* `pr-9` so the dismiss control never sits on the text. */}
                      <div className="pr-9">
                        {n.link ? (
                          <Link href={n.link} onClick={() => setOpen(false)} className="block">
                            {content}
                          </Link>
                        ) : (
                          content
                        )}
                      </div>

                      <button
                        onClick={() => dismiss(n)}
                        className="absolute right-1.5 top-2.5 flex h-7 w-7 items-center justify-center text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)]"
                        aria-label={`Dismiss: ${n.title}`}
                      >
                        <X className="h-3.5 w-3.5" strokeWidth={2} />
                      </button>

                      {awaiting && (
                        <div className="flex items-center gap-4 px-4 pb-3 pl-[1.875rem]">
                          <button
                            onClick={() => approve(n)}
                            disabled={busyId === String(n.id)}
                            className="label-caps inline-flex items-center gap-1.5 text-[var(--color-accent)] disabled:opacity-50"
                          >
                            <Check className="h-3.5 w-3.5" strokeWidth={2} />
                            {busyId === String(n.id) ? 'Confirming…' : 'Approve'}
                          </button>
                          <Link
                            href="/dashboard/appointments/pending"
                            onClick={() => setOpen(false)}
                            className="label-caps text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
                          >
                            Review
                          </Link>
                        </div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}
