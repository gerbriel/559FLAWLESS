'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { Bell } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import type { Notification } from '@/types/database'

export function NotificationBell({ count }: { count: number }) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Notification[]>([])
  // Derived, not mirrored: `count` comes from the server on every render, so
  // copying it into state with an effect would fight the fresh value. We only
  // need to remember that this session cleared it.
  const [clearedAt, setClearedAt] = useState<number | null>(null)
  const unread = clearedAt === null ? count : 0

  useEffect(() => {
    if (!open) return

    async function load() {
      const supabase = createClient()
      const { data } = await supabase
        .from('notifications')
        .select('*')
        .order('created_at', { ascending: false })
        .limit(15)

      setItems(data ?? [])
    }

    void load()
  }, [open])

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
    setClearedAt(Date.now())
    setItems((list) => list.map((n) => ({ ...n, read_at: n.read_at ?? now })))
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
            <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
              <span className="label-caps">Notifications</span>
              {unread > 0 && (
                <button
                  onClick={markAllRead}
                  className="label-caps text-[var(--color-accent)]"
                >
                  Mark all read
                </button>
              )}
            </div>

            {items.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-[var(--color-muted)]">
                Nothing new.
              </p>
            ) : (
              <ul className="max-h-96 divide-y divide-[var(--color-border)] overflow-y-auto">
                {items.map((n) => {
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
                    <li key={n.id}>
                      {n.link ? (
                        <Link
                          href={n.link}
                          onClick={() => setOpen(false)}
                          className="block transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)]"
                        >
                          {content}
                        </Link>
                      ) : (
                        content
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
