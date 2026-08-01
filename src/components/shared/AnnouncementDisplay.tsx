'use client'

import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'
import { X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'

type Announcement = {
  id: number
  title: string
  body: string | null
  link_url: string | null
  link_label: string | null
  variant: 'info' | 'promo' | 'urgent'
}

const DISMISS_KEY = 'fl_dismissed_announcements'

function getDismissed(): number[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = localStorage.getItem(DISMISS_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function addDismissed(id: number) {
  const dismissed = getDismissed()
  if (!dismissed.includes(id)) {
    localStorage.setItem(DISMISS_KEY, JSON.stringify([...dismissed, id]))
  }
}

/**
 * Displays active announcements targeted to the current page/user.
 * Announcements can be dismissed and the state persists in localStorage.
 * This component fetches fresh announcements periodically to catch new ones.
 */
export function AnnouncementDisplay({ userRole }: { userRole?: string }) {
  const pathname = usePathname()
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [dismissed, setDismissed] = useState<number[]>([])

  useEffect(() => {
    setDismissed(getDismissed())

    const supabase = createClient()
    let mounted = true

    async function fetch() {
      try {
        // Fetch active announcements
        const { data } = await supabase
          .from('announcements')
          .select('id, title, body, link_url, link_label, variant')
          .eq('is_active', true)
          .or(
            `starts_at.is.null,starts_at.lte.${new Date().toISOString()}`
          )
          .or(
            `ends_at.is.null,ends_at.gte.${new Date().toISOString()}`
          )
          .order('id', { ascending: false })
          .limit(5)

        if (mounted && data) {
          setAnnouncements(data as Announcement[])
        }
      } catch {
        // Silent failure - announcements are not critical.
      }
    }

    void fetch()

    // Refresh every 5 minutes to catch new announcements
    const interval = setInterval(fetch, 5 * 60 * 1000)

    return () => {
      mounted = false
      clearInterval(interval)
    }
  }, [])

  function dismiss(id: number) {
    addDismissed(id)
    setDismissed(getDismissed())
  }

  const visible = announcements.filter((a) => !dismissed.includes(a.id))

  if (visible.length === 0) return null

  return (
    <div className="space-y-0.5">
      {visible.map((announcement) => (
        <div
          key={announcement.id}
          className={cn(
            'relative flex items-center justify-center gap-4 px-12 py-3 text-center text-sm',
            announcement.variant === 'promo' &&
              'bg-[var(--color-clay-soft)] text-[var(--color-clay-deep)] dark:bg-[var(--color-clay-deep)] dark:text-[var(--color-linen)]',
            announcement.variant === 'info' &&
              'bg-[var(--color-linen)] text-[var(--color-espresso)] dark:bg-[var(--color-surface)] dark:text-[var(--color-foreground)]',
            announcement.variant === 'urgent' &&
              'bg-[var(--color-accent)] text-white'
          )}
        >
          <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-1">
            <span className="font-medium">{announcement.title}</span>
            {announcement.body && (
              <span className="opacity-90">{announcement.body}</span>
            )}
            {announcement.link_url && announcement.link_label && (
              <Link
                href={announcement.link_url}
                className="underline underline-offset-4 opacity-90 hover:opacity-100"
              >
                {announcement.link_label}
              </Link>
            )}
          </div>
          <button
            onClick={() => dismiss(announcement.id)}
            className="absolute right-3 top-1/2 -translate-y-1/2 p-1 opacity-70 hover:opacity-100"
            aria-label="Dismiss announcement"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  )
}
