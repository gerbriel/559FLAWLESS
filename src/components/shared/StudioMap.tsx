'use client'

import { useState } from 'react'
import { MapPin, ExternalLink } from 'lucide-react'
import { cn } from '@/lib/utils'
import { formatAddress, type StudioLocation } from '@/components/shared/DirectionsLink'

/**
 * OpenStreetMap embed of the studio.
 *
 * OSM rather than Google: no API key, no billing account, no consent banner for
 * a third-party tracker on a page a first-time client is reading. The iframe is
 * click-to-load, so the map costs nothing until someone actually wants it —
 * which also keeps it off the critical path of a page that is otherwise static.
 */
export function StudioMap({
  location,
  className,
  zoom = 16,
}: {
  location: StudioLocation
  className?: string
  zoom?: number
}) {
  const [loaded, setLoaded] = useState(false)

  const { lat, lon } = location
  if (typeof lat !== 'number' || typeof lon !== 'number') return null

  // A small box around the pin. OSM's embed takes a bbox rather than a zoom
  // level, so this converts one to the other — tighter box, closer view.
  const span = 0.012 / Math.max(1, zoom - 12)
  const bbox = [lon - span, lat - span / 2, lon + span, lat + span / 2].join('%2C')

  const embed =
    `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}` +
    `&layer=mapnik&marker=${lat}%2C${lon}`
  const full = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=${zoom}/${lat}/${lon}`

  return (
    <figure className={cn('relative overflow-hidden border border-[var(--color-border)]', className)}>
      <div className="relative aspect-[4/3] w-full bg-[var(--color-linen)] dark:bg-[var(--color-surface)] sm:aspect-[16/10]">
        {loaded ? (
          <iframe
            src={embed}
            title={`Map showing ${formatAddress(location)}`}
            loading="lazy"
            referrerPolicy="no-referrer-when-downgrade"
            className="absolute inset-0 h-full w-full border-0"
          />
        ) : (
          <button
            type="button"
            onClick={() => setLoaded(true)}
            className="group absolute inset-0 flex flex-col items-center justify-center gap-3 transition-colors hover:bg-[var(--color-shell)]/40"
            aria-label="Load the map"
          >
            {/* Placeholder that reads as a map without loading one. */}
            <span
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-[0.18]"
              style={{
                backgroundImage:
                  'linear-gradient(var(--color-stone) 1px, transparent 1px), linear-gradient(90deg, var(--color-stone) 1px, transparent 1px)',
                backgroundSize: '44px 44px',
              }}
            />
            <MapPin
              className="relative h-9 w-9 text-[var(--color-accent)] transition-transform group-hover:-translate-y-0.5"
              strokeWidth={1.25}
            />
            <span className="label-caps relative text-[var(--color-muted)]">Show map</span>
          </button>
        )}
      </div>

      <figcaption className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3">
        <span className="text-sm text-[var(--color-muted)]">{formatAddress(location)}</span>
        <a
          href={full}
          target="_blank"
          rel="noreferrer noopener"
          className="label-caps -my-2 inline-flex min-h-11 items-center gap-1.5 py-2 text-[var(--color-accent)]"
        >
          Larger map
          <ExternalLink className="h-3 w-3" strokeWidth={2} />
        </a>
      </figcaption>
    </figure>
  )
}
