/**
 * Row shapes for the multi-location tables added in migration 032.
 *
 * These live here rather than in `database.ts` only because that file is being
 * regenerated; the entries belong there and this file should fold into it. Same
 * rule applies as everywhere else in this codebase: `type` aliases, never
 * `interface` — an interface has no implicit index signature and so fails
 * supabase-js's `Record<string, unknown>` constraint, which silently collapses
 * every query result to `never`.
 */

/** A physical site. Exactly one exists today; nothing may assume that stays true. */
export type Location = {
  id: number
  name: string
  slug: string
  address_line1: string | null
  city: string | null
  state: string | null
  postal: string | null
  /** Authoritative for this site's wall-clock. Never hardcode a zone against it. */
  timezone: string
  phone: string | null
  email: string | null
  is_active: boolean
  sort_order: number
}

/**
 * Which sites a staff member works at. A link table, not a column on `profiles`:
 * one esthetician can hold Tuesdays at one studio and Thursdays at another.
 */
export type StaffLocation = {
  profile_id: string
  location_id: number
  /** Their home site — what the dashboard opens on. At most one per person. */
  is_primary: boolean
  created_at: string
}

/**
 * The menu, per site. A service keeps one id and one history wherever it is
 * performed; what varies is whether a room offers it and what it charges.
 */
export type ServiceLocation = {
  service_id: number
  location_id: number
  /** Integer cents, or null to charge the catalogue price. */
  price_cents_override: number | null
  is_active: boolean
}

/**
 * How many are on that shelf. The catalogue is shared; the count is not.
 * `products.stock_qty` mirrors the primary site's row here.
 */
export type ProductStock = {
  product_id: number
  location_id: number
  qty: number
  /** Null = fall back to the product's own threshold. */
  low_stock_threshold: number | null
  updated_at: string
}

/** The subset the booking site and the switcher need. */
export type LocationSummary = Pick<
  Location,
  'id' | 'name' | 'slug' | 'city' | 'state' | 'address_line1' | 'timezone'
>

/** What the dashboard shows when no single site is chosen. */
export const ALL_LOCATIONS_LABEL = 'All locations'

/**
 * One line of address, skipping whatever is missing. Returns null rather than a
 * string of stray commas when the row holds nothing but a name.
 */
export function formatLocationAddress(
  location: Pick<Location, 'address_line1' | 'city' | 'state' | 'postal'>
): string | null {
  const street = location.address_line1?.trim()
  const town = [location.city?.trim(), location.state?.trim()].filter(Boolean).join(', ')
  const line = [street, town, location.postal?.trim()].filter(Boolean).join(', ')
  return line || null
}

/**
 * Is this a slug the database will accept? `locations.slug` is unique and ends
 * up in a booking URL, so it is lowercase, url-safe, and never empty.
 */
export function isValidLocationSlug(slug: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)
}

/** "Fig Garden Village" → "fig-garden-village". */
export function slugifyLocationName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * Does the runtime recognise this IANA zone? The studio's clock depends on it,
 * so a typo has to be caught before it is saved rather than at the next booking.
 */
export function isKnownTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}
