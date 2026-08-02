import 'server-only'
import Link from 'next/link'
import { MapPin } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { loadActiveLocations } from '@/components/layout/LocationScope'
import { formatLocationAddress, type LocationSummary } from '@/types/locations'

/**
 * Choosing which studio to book at.
 *
 * The governing rule is that a studio with one room must not see ANY of this —
 * no step, no bar, no extra query, no "1 of 5" in the step rail. A single site
 * is not a choice, and presenting it as one is the tell that a feature was
 * built for somebody else's business. `mode: 'single'` is that case and it is
 * the one this codebase is in today.
 */

export type BookingLocationScope =
  /** One site (or none). Book exactly as before; render nothing. */
  | { mode: 'single'; location: LocationSummary | null; locations: LocationSummary[] }
  /** Several sites and none chosen yet. Ask first. */
  | { mode: 'choose'; locations: LocationSummary[] }
  /** Several sites, one chosen. Book against it, and offer a way back. */
  | { mode: 'selected'; location: LocationSummary; locations: LocationSummary[] }

/**
 * Resolve the requested `?location=` slug against the sites that are actually
 * open. An unknown or stale slug falls back to asking rather than to silently
 * booking somewhere the client did not pick.
 */
export async function resolveBookingLocation(slug?: string): Promise<BookingLocationScope> {
  const locations = await loadActiveLocations()

  if (locations.length < 2) {
    return { mode: 'single', location: locations[0] ?? null, locations }
  }

  const chosen = slug ? locations.find((l) => l.slug === slug) : undefined
  if (!chosen) return { mode: 'choose', locations }

  return { mode: 'selected', location: chosen, locations }
}

/**
 * What is bookable at one site: the services on that menu and the people who
 * work there.
 *
 * Returns nulls for the single-site case so the caller filters nothing at all.
 * With one location every service already has a row and every staff member is
 * assigned, so filtering would be a no-op that still cost two round trips.
 */
export async function bookableAtLocation(
  scope: BookingLocationScope
): Promise<{ serviceIds: Set<number> | null; providerIds: Set<string> | null }> {
  if (scope.mode !== 'selected') return { serviceIds: null, providerIds: null }

  const supabase = await createClient()
  const [{ data: menu }, { data: staff }] = await Promise.all([
    supabase
      .from('service_locations')
      .select('service_id')
      .eq('location_id', scope.location.id)
      .eq('is_active', true),
    supabase.from('staff_locations').select('profile_id').eq('location_id', scope.location.id),
  ])

  return {
    serviceIds: new Set((menu ?? []).map((r) => r.service_id)),
    providerIds: new Set((staff ?? []).map((r) => r.profile_id)),
  }
}

/** `/book` with whatever the client had already chosen kept intact. */
function bookHref(params: { location?: string; service?: string }): string {
  const qs = new URLSearchParams()
  if (params.location) qs.set('location', params.location)
  if (params.service) qs.set('service', params.service)
  const query = qs.toString()
  return query ? `/book?${query}` : '/book'
}

/**
 * Step zero: which studio. Only ever rendered when there is more than one, and
 * only until one is picked.
 */
export function LocationBookingStep({
  locations,
  serviceSlug,
}: {
  locations: LocationSummary[]
  serviceSlug?: string
}) {
  return (
    <div>
      <h2 className="display text-3xl">Which studio?</h2>
      <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
        Times, prices and what is on the menu can differ between our locations, so
        this comes first.
      </p>

      <div className="mt-8 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2">
        {locations.map((l) => {
          const address = formatLocationAddress({
            address_line1: l.address_line1,
            city: l.city,
            state: l.state,
            postal: null,
          })

          return (
            <Link
              key={l.id}
              href={bookHref({ location: l.slug, service: serviceSlug })}
              className="bg-[var(--color-background)] p-6 transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]"
            >
              <span className="display block text-xl">{l.name}</span>
              {address && (
                <span className="mt-2 block text-sm text-[var(--color-muted)]">{address}</span>
              )}
            </Link>
          )
        })}
      </div>
    </div>
  )
}

/**
 * The reminder that sits above the flow once a studio is chosen, with the way
 * back out. Someone who picked the wrong one should not have to guess that the
 * browser's back button is the fix.
 */
export function LocationBookingBar({
  location,
  serviceSlug,
}: {
  location: LocationSummary
  serviceSlug?: string
}) {
  const address = formatLocationAddress({
    address_line1: location.address_line1,
    city: location.city,
    state: location.state,
    postal: null,
  })

  return (
    <div className="mb-10 flex flex-wrap items-center justify-between gap-4 border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-4">
      <p className="flex items-center gap-3 text-sm">
        <MapPin className="h-4 w-4 text-[var(--color-accent)]" strokeWidth={1.5} aria-hidden />
        <span>
          <span className="label-caps mr-2 text-[var(--color-muted)]">Booking at</span>
          {location.name}
          {address && (
            <span className="ml-2 text-[var(--color-muted)]">&middot; {address}</span>
          )}
        </span>
      </p>
      <Link
        href={bookHref({ service: serviceSlug })}
        className="label-caps border-b border-[var(--color-foreground)] pb-0.5"
      >
        Change
      </Link>
    </div>
  )
}
