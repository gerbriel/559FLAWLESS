import 'server-only'
import { cookies } from 'next/headers'
import { createClient } from '@/lib/supabase/server'
import type { LocationSummary } from '@/types/locations'

/**
 * Which studio the dashboard is currently looking at.
 *
 * Held in a cookie rather than a search param, deliberately. The dashboard is
 * fourteen pages that link to each other constantly; a search param would have
 * to be threaded through every one of those links, and the first link that
 * forgot it would silently drop whoever is standing in the second studio back
 * to "All locations" — showing them the other building's day. A cookie is read
 * once, in the layout, and survives every navigation and reload.
 *
 * It is also the right shape for the question. "Which site am I working at
 * today" is a property of the device on the desk, not of the URL — a link
 * pasted into a message should not quietly re-scope the person who opens it.
 *
 * Nothing here is a security boundary. RLS is. This only decides what is shown.
 */
export const LOCATION_COOKIE = 'fl_location'

/** Cookie value meaning "do not narrow" — the business-wide view. */
export const ALL_LOCATIONS = 'all'

/** A year: long enough that nobody re-picks it every morning. */
export const LOCATION_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** The chosen site, or null for every site. */
export async function readLocationScope(): Promise<number | null> {
  const raw = (await cookies()).get(LOCATION_COOKIE)?.value
  if (!raw || raw === ALL_LOCATIONS) return null
  const id = Number(raw)
  return Number.isInteger(id) && id > 0 ? id : null
}

/**
 * Narrow a query to one site, or leave it business-wide.
 *
 * Every location-aware report gets both halves from this: pass the scope
 * through and one location filters, null aggregates across all of them.
 *
 *   let q = supabase.from('appointments').select('id, starts_at, location_id')
 *   q = withLocation(q, await readLocationScope())
 */
export function withLocation<Q extends { eq(column: 'location_id', value: number): Q }>(
  query: Q,
  locationId: number | null
): Q {
  return locationId === null ? query : query.eq('location_id', locationId)
}

/**
 * Active sites, in the order the studio put them in.
 *
 * The first one is the primary — the same rule `public.default_location_id()`
 * uses, so the UI and the column defaults can never disagree about which studio
 * is "the" studio.
 */
export async function loadActiveLocations(): Promise<LocationSummary[]> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('locations')
    // One string literal. Concatenation widens the select to `string` and
    // collapses the result type to SelectQueryError.
    .select('id, name, slug, city, state, address_line1, timezone')
    .eq('is_active', true)
    .order('sort_order')
    .order('id')

  return (data ?? []) as LocationSummary[]
}

/**
 * The chosen site resolved against what actually exists.
 *
 * A cookie can outlive the location it names — a studio closes, or someone
 * restores a backup — so the id is only honoured when it is still an active
 * site. Otherwise this falls back to the business-wide view rather than
 * filtering everything down to nothing.
 */
export async function resolveLocationScope(): Promise<{
  locations: LocationSummary[]
  /** null = all locations. */
  locationId: number | null
  location: LocationSummary | null
}> {
  const [locations, chosen] = await Promise.all([loadActiveLocations(), readLocationScope()])
  const location = chosen === null ? null : (locations.find((l) => l.id === chosen) ?? null)
  return { locations, locationId: location?.id ?? null, location }
}
