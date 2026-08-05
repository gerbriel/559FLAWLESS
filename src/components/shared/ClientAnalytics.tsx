'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

const SESSION_KEY = 'fl_session'
const ANALYTICS_STORAGE_KEY = 'fl_analytics_consent'

/**
 * THE session id. Every analytics row, every cart snapshot, and the
 * sign-in stitch (claim_browsing_session, migration 060) key on this exact
 * value — a second implementation with its own storage key is how stitching
 * silently breaks. Import this one; don't copy it.
 */
export function sessionId(): string {
  if (typeof window === 'undefined') return ''
  let id = sessionStorage.getItem(SESSION_KEY)
  if (!id) {
    id = crypto.randomUUID()
    sessionStorage.setItem(SESSION_KEY, id)
  }
  return id
}

/**
 * Enhanced analytics tracking that respects user privacy while capturing
 * essential behavioral data. Tracks:
 * - Page views
 * - Cart interactions (add/remove)
 * - Booking flow progress and abandonment
 * - Form completion status
 *
 * All tracking is fire-and-forget; failures are silent to never break UX.
 */
export function ClientAnalytics() {
  const pathname = usePathname()
  const params = useSearchParams()
  const lastPath = useRef<string | null>(null)

  useEffect(() => {
    if (lastPath.current === pathname) return
    lastPath.current = pathname

    const supabase = createClient()

    async function record() {
      // Check if user has consented (default true, can be opted out)
      const consent = localStorage.getItem(ANALYTICS_STORAGE_KEY)
      if (consent === 'false') return

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

/**
 * Track cart interactions. Called from AddToCart and cart management components.
 */
export async function trackCartEvent(
  action: 'add' | 'remove' | 'clear',
  meta: Record<string, unknown> = {}
) {
  try {
    const consent = localStorage.getItem(ANALYTICS_STORAGE_KEY)
    if (consent === 'false') return

    const supabase = createClient()
    await supabase.from('analytics_events').insert({
      session_id: sessionId(),
      path: window.location.pathname,
      event: `cart_${action}`,
      meta: meta as never,
    })
  } catch {
    // Never let analytics break functionality.
  }
}

/**
 * Track booking flow progress. Called from BookingFlow component.
 */
export async function trackBookingEvent(
  step: string,
  meta: Record<string, unknown> = {}
) {
  try {
    const consent = localStorage.getItem(ANALYTICS_STORAGE_KEY)
    if (consent === 'false') return

    const supabase = createClient()
    await supabase.from('analytics_events').insert({
      session_id: sessionId(),
      path: window.location.pathname,
      event: `booking_${step}`,
      meta: meta as never,
    })
  } catch {
    // Never let analytics break a booking.
  }
}

/**
 * Track form events (started, completed, abandoned).
 */
export async function trackFormEvent(
  formType: 'intake' | 'consent',
  action: 'started' | 'completed' | 'abandoned',
  meta: Record<string, unknown> = {}
) {
  try {
    const consent = localStorage.getItem(ANALYTICS_STORAGE_KEY)
    if (consent === 'false') return

    const supabase = createClient()
    await supabase.from('analytics_events').insert({
      session_id: sessionId(),
      path: window.location.pathname,
      event: `form_${formType}_${action}`,
      meta: meta as never,
    })
  } catch {
    // Silent failure.
  }
}

/**
 * Update user's analytics consent preference.
 */
export function setAnalyticsConsent(enabled: boolean) {
  localStorage.setItem(ANALYTICS_STORAGE_KEY, String(enabled))
}

/**
 * Check current consent status.
 */
export function getAnalyticsConsent(): boolean {
  if (typeof window === 'undefined') return true
  const consent = localStorage.getItem(ANALYTICS_STORAGE_KEY)
  return consent !== 'false'
}
