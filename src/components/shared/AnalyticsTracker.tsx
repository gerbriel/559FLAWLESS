'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

const SESSION_KEY = 'fl_session'

function sessionId(): string {
  if (typeof window === 'undefined') return ''
  let id = sessionStorage.getItem(SESSION_KEY)
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem(SESSION_KEY, id)
  }
  return id
}

/**
 * Fire-and-forget pageview tracking. Writes go straight to Supabase under the
 * open insert policy on analytics_events; a failure is silent because a missing
 * analytics row must never break a page.
 *
 * The visitor's role is resolved here, in the browser, rather than passed down
 * from the layout. Reading the session server-side would opt every public page
 * into dynamic rendering for the sake of one analytics column — not a trade
 * worth making. `getSession()` reads local storage rather than calling out, so
 * the common anonymous case costs nothing.
 */
export function AnalyticsTracker() {
  const pathname = usePathname()
  const params = useSearchParams()
  const lastPath = useRef<string | null>(null)

  useEffect(() => {
    if (lastPath.current === pathname) return
    lastPath.current = pathname

    const supabase = createClient()

    async function record() {
      let userRole = 'anonymous'
      let userId: string | null = null

      try {
        const {
          data: { session },
        } = await supabase.auth.getSession()

        if (session?.user) {
          userId = session.user.id
          const { data } = await supabase
            .from('profiles')
            .select('role')
            .eq('id', session.user.id)
            .maybeSingle()
          userRole = data?.role ?? 'client'
        }
      } catch {
        // Fall through as anonymous.
      }

      await supabase.from('analytics_events').insert({
        session_id: sessionId(),
        path: pathname,
        event: 'pageview',
        referrer: document.referrer || null,
        utm_source: params.get('utm_source'),
        utm_medium: params.get('utm_medium'),
        utm_campaign: params.get('utm_campaign'),
        user_role: userRole,
        user_id: userId,
      })
    }

    void record().catch(() => undefined)
  }, [pathname, params])

  return null
}

/** Funnel step helper, called from the booking flow. */
export async function trackEvent(
  event: string,
  meta: Record<string, unknown> = {},
  path?: string
) {
  try {
    const supabase = createClient()
    await supabase.from('analytics_events').insert({
      session_id: sessionId(),
      path: path ?? window.location.pathname,
      event,
      meta: meta as never,
    })
  } catch {
    // Never let analytics break a booking.
  }
}
