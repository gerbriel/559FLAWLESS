'use client'

import { useEffect, useRef, useState } from 'react'
import { MapPin, Navigation, Check, Copy, X } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface StudioLocation {
  address?: string
  city?: string
  state?: string
  postal?: string
  lat?: number
  lon?: number
  /** What gets sent to the map apps. Falls back to the composed address. */
  directions_query?: string
}

/** "285 W Shaw Ave, Fresno, CA 93704" from the parts we hold. */
export function formatAddress(loc: StudioLocation): string {
  const cityLine = [loc.city, loc.state].filter(Boolean).join(', ')
  return [loc.address, [cityLine, loc.postal].filter(Boolean).join(' ')]
    .filter(Boolean)
    .join(', ')
}

function targets(loc: StudioLocation) {
  const q = encodeURIComponent(loc.directions_query || formatAddress(loc))
  const hasCoords = typeof loc.lat === 'number' && typeof loc.lon === 'number'
  const coords = hasCoords ? `${loc.lat},${loc.lon}` : ''

  return {
    // `api=1` is Google's documented, key-free directions URL.
    google: `https://www.google.com/maps/dir/?api=1&destination=${q}`,
    // Apple Maps opens natively on iOS/macOS and falls back to the web elsewhere.
    apple: `https://maps.apple.com/?daddr=${q}`,
    osm: hasCoords
      ? `https://www.openstreetmap.org/directions?to=${coords}`
      : `https://www.openstreetmap.org/search?query=${q}`,
  }
}

/**
 * The address, as a button that offers a choice of map app.
 *
 * Deliberately a choice rather than a guess: sniffing the platform gets it
 * wrong for anyone on a Mac who lives in Google Maps, or on Android in a
 * household of iPhones. Apple Maps is listed first on Apple platforms only
 * because that is where it opens natively.
 */
export function DirectionsLink({
  location,
  className,
  showIcon = true,
}: {
  location: StudioLocation
  className?: string
  showIcon?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const address = formatAddress(location)
  const links = targets(location)

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  async function copy() {
    try {
      await navigator.clipboard.writeText(address)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Clipboard blocked — the address is on screen to read anyway.
    }
  }

  // Read at render of the (interaction-only) menu rather than mirrored into
  // state by an effect — there is nothing to synchronise, it is just a fact
  // about the device.
  const isApple =
    typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent)

  const options = [
    { key: 'google', label: 'Google Maps', href: links.google },
    { key: 'apple', label: 'Apple Maps', href: links.apple },
    { key: 'osm', label: 'OpenStreetMap', href: links.osm },
  ]
  // Apple first where it opens as a native app.
  const ordered = isApple
    ? [options[1], options[0], options[2]]
    : options

  return (
    <div ref={ref} className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={cn(
          'group flex items-start gap-2.5 text-left transition-colors hover:text-[var(--color-accent)]',
          className
        )}
      >
        {showIcon && (
          <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} />
        )}
        <span>
          {location.address}
          {location.address && <br />}
          {[location.city, location.state].filter(Boolean).join(', ')} {location.postal}
          <span className="label-caps mt-1.5 flex items-center gap-1 text-[var(--color-accent)] opacity-80 group-hover:opacity-100">
            <Navigation className="h-3 w-3" strokeWidth={2} />
            Get directions
          </span>
        </span>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-50 mb-2 w-60 border border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-2.5">
            <span className="label-caps text-[var(--color-muted)]">Open in</span>
            <button
              onClick={() => setOpen(false)}
              className="p-0.5 text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
              aria-label="Close"
            >
              <X className="h-3.5 w-3.5" strokeWidth={2} />
            </button>
          </div>

          <ul>
            {ordered.map((o) => (
              <li key={o.key}>
                <a
                  href={o.href}
                  target="_blank"
                  rel="noreferrer noopener"
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 px-4 py-3 text-sm transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)]"
                >
                  <Navigation className="h-3.5 w-3.5 text-[var(--color-accent)]" strokeWidth={1.75} />
                  {o.label}
                </a>
              </li>
            ))}
            <li className="border-t border-[var(--color-border)]">
              <button
                onClick={copy}
                role="menuitem"
                className="flex w-full items-center gap-2.5 px-4 py-3 text-left text-sm transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)]"
              >
                {copied ? (
                  <>
                    <Check className="h-3.5 w-3.5 text-emerald-600" strokeWidth={2.5} />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="h-3.5 w-3.5 text-[var(--color-accent)]" strokeWidth={1.75} />
                    Copy address
                  </>
                )}
              </button>
            </li>
          </ul>
        </div>
      )}
    </div>
  )
}
