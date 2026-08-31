'use client'

import { useEffect } from 'react'

declare global {
  interface Window {
    fbq?: (...args: unknown[]) => void
  }
}

/**
 * Fire one Meta pixel conversion event for the page this renders on.
 *
 * The base pixel comes from the root layout, and only when an admin has set an
 * id in Marketing → Tracking, and only in production. This component therefore
 * never assumes `fbq` exists: it polls for it briefly (the base snippet loads
 * afterInteractive, so a fast mount beats it) and gives up silently. In dev, or
 * with no pixel configured, it does nothing at all — a missing marketing event
 * must never break a confirmation page, which is the one page a client must see.
 *
 * `id` does double duty against double-counting:
 *
 *  - sessionStorage: the same tab refreshing the page, or coming back from
 *    Stripe having already fired at the booking screen, does not fire again.
 *  - Meta's eventID: the same conversion reaching Meta twice anyway — a second
 *    tab, a cleared session — deduplicates server-side under the same name+id.
 *
 * This is marketing telemetry, deliberately downstream of the money. The
 * webhook remains the record that anything was actually paid; nothing here is
 * read back, and a forged value forges nothing but the forger's own ad
 * attribution.
 */
/**
 * Fire one Meta standard event at interaction time — AddToCart,
 * InitiateCheckout. No polling and no dedupe, on purpose: a click lands long
 * after the base pixel loaded, and clicking twice genuinely is two events.
 * Missing pixel (dev, unconfigured, blocked) means silently nothing — the same
 * contract as the component below: marketing must never break the shop.
 */
export function trackMetaEvent(
  event: 'AddToCart' | 'InitiateCheckout',
  params: Record<string, unknown> = {}
) {
  try {
    window.fbq?.('track', event, params)
  } catch {
    // Nothing — see above.
  }
}

export function MetaPixelEvent({
  event,
  id,
  value,
  currency = 'USD',
}: {
  event: 'CompleteRegistration' | 'Purchase' | 'Contact'
  /** Stable per conversion — `booking-<uuid>`, `order-<id>` — never per render. */
  id: string
  /** Dollars, not cents: Meta's `value` is decimal by contract. */
  value?: number
  currency?: string
}) {
  useEffect(() => {
    const key = `fbq:${event}:${id}`
    try {
      if (sessionStorage.getItem(key)) return
    } catch {
      // Storage unavailable (private mode) — eventID still dedupes at Meta.
    }

    let tries = 0
    const timer = setInterval(() => {
      if (window.fbq) {
        clearInterval(timer)
        try {
          window.fbq(
            'track',
            event,
            value != null ? { value, currency } : {},
            { eventID: id }
          )
          sessionStorage.setItem(key, '1')
        } catch {
          // Never let the pixel take the page down with it.
        }
      } else if ((tries += 1) > 20) {
        clearInterval(timer)
      }
    }, 500)
    return () => clearInterval(timer)
  }, [event, id, value, currency])

  return null
}
