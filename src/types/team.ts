/**
 * Team member profiles — see supabase/migrations/041_team_profiles.sql.
 *
 * Three row shapes because there are three audiences, and row-level security is
 * row-level: once a role can SELECT a row it reads every column of it. Keeping
 * the public half in its own table is what makes "the internet may read the
 * biography but not the emergency contact" a database fact rather than a habit
 * the application has to keep up.
 *
 * These are `type` aliases and not interfaces, deliberately. An interface has no
 * implicit index signature, so it fails supabase-js's `Record<string, unknown>`
 * constraint and silently collapses every query result to `never`.
 *
 * The matching `Tables` entries for src/types/database.ts are listed at the
 * bottom of this file.
 */

/** The page a client sees. Readable by `anon` when `is_public`. */
export type StaffProfile = {
  profile_id: string
  is_public: boolean
  display_name: string
  slug: string
  headline: string | null
  bio: string | null
  pronouns: string | null
  photo_url: string | null
  specialities: string[]
  certifications: string[]
  languages: string[]
  years_experience: number | null
  instagram_url: string | null
  tiktok_url: string | null
  website_url: string | null
  sort_order: number
  created_at: string
  updated_at: string
}

/** Licensure. The holder and managers. Never `anon`. */
export type StaffCredential = {
  profile_id: string
  licence_number: string | null
  licence_type: LicenceType | null
  licence_state: string
  licence_issued_on: string | null
  licence_expires_on: string | null
  verified_at: string | null
  verified_by: string | null
  /** Bookkeeping for notify_expiring_licences(); not a setting. */
  expiry_reminder_stage: number | null
  expiry_reminded_at: string | null
  created_at: string
  updated_at: string
}

/** Personnel record. Managers only, including on your own row. */
export type StaffEmployment = {
  profile_id: string
  started_on: string | null
  ended_on: string | null
  employment_type: EmploymentType | null
  emergency_contact_name: string | null
  emergency_contact_phone: string | null
  emergency_contact_relationship: string | null
  internal_notes: string | null
  updated_by: string | null
  created_at: string
  updated_at: string
}

export type LicenceType =
  | 'esthetician'
  | 'cosmetologist'
  | 'nail_technician'
  | 'barber'
  | 'electrologist'
  | 'instructor'
  | 'other'

export const LICENCE_TYPE_LABELS: Record<LicenceType, string> = {
  esthetician: 'Esthetician',
  cosmetologist: 'Cosmetologist',
  nail_technician: 'Nail technician',
  barber: 'Barber',
  electrologist: 'Electrologist',
  instructor: 'Instructor',
  other: 'Other',
}

export type EmploymentType =
  | 'employee'
  | 'independent_contractor'
  | 'booth_renter'
  | 'apprentice'
  | 'owner'

export const EMPLOYMENT_TYPE_LABELS: Record<EmploymentType, string> = {
  employee: 'Employee',
  independent_contractor: 'Independent contractor',
  booth_renter: 'Booth renter',
  apprentice: 'Apprentice',
  owner: 'Owner',
}

/** Mirrors public.licence_status(date, int) in 041. */
export type LicenceStatus = 'valid' | 'expires_soon' | 'expired' | 'unknown'

/**
 * The same question the SQL function answers, asked in the browser.
 *
 * Both exist for the reason the role helpers in 001 exist in both places: the
 * SQL copy is what drives the notification, the TypeScript copy is what colours
 * a badge. Days are compared as calendar dates, not instants — a licence
 * expires on a day, not at a moment, and 'YYYY-MM-DD' arithmetic never needs a
 * timezone.
 */
export function licenceStatus(expiresOn: string | null, soonDays = 60): LicenceStatus {
  if (!expiresOn) return 'unknown'
  const days = daysUntilDateKey(expiresOn)
  if (days === null) return 'unknown'
  if (days < 0) return 'expired'
  if (days <= soonDays) return 'expires_soon'
  return 'valid'
}

/**
 * Whole days from today to a 'YYYY-MM-DD' date key.
 *
 * Both sides are read as UTC midnight so the subtraction is calendar-day
 * arithmetic and cannot be shifted by the viewer's offset — the same rule
 * src/lib/time.ts applies to schedules. `now` is passed in rather than read
 * here so a Server Component can supply requestNow().
 */
export function daysUntilDateKey(dateKey: string, now = Date.now()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!m) return null
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const today = new Date(now)
  const start = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())
  return Math.round((target - start) / 86_400_000)
}

/** e.g. 'March 14, 2027'. A date key is a calendar day; reading it through a
 *  timezone is how you end up displaying the day before. */
export function formatDateKey(dateKey: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey)
  if (!m) return dateKey
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString(
    'en-US',
    { timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric' }
  )
}

// ── Locations ─────────────────────────────────────────────────

export type TeamLocation = {
  id: number
  name: string
  slug: string
  city: string | null
}

/**
 * Where a staff member works, keyed by profile id, home site first.
 *
 * `locations` and `staff_locations` are migration 032's, not this one's — it
 * owns the shape and the policies, and this only reads them. Two consequences
 * worth knowing at the call site:
 *
 *   • `anon` may read a staff_locations row only for a provider who takes
 *     online bookings (032's "public reads bookable provider locations"). A
 *     front-desk lead published on the team page therefore shows no location,
 *     which is 032's call and the right one — it keeps internal rostering
 *     internal.
 *   • The tables may not be in database.ts yet, so this goes through a loose
 *     client rather than the typed one. Swap it for a typed select once they
 *     are; nothing else here changes.
 *
 * Returns an empty map on any failure. A team page that cannot name a studio is
 * a much smaller problem than a team page that 500s.
 */
type LooseQuery<T> = PromiseLike<{ data: T[] | null; error: unknown }>
type LooseClient = {
  from: (table: string) => { select: <T>(columns: string) => LooseQuery<T> }
}

type StaffLocationLink = { profile_id: string; location_id: number; is_primary: boolean }
type LocationRow = {
  id: number
  name: string
  slug: string
  city: string | null
  is_active: boolean
}

export async function loadStaffLocations(
  client: unknown,
  profileIds: string[]
): Promise<Map<string, TeamLocation[]>> {
  const byProfile = new Map<string, TeamLocation[]>()
  if (profileIds.length === 0) return byProfile

  const loose = client as LooseClient

  try {
    const [links, locations] = await Promise.all([
      loose.from('staff_locations').select<StaffLocationLink>('profile_id, location_id, is_primary'),
      loose.from('locations').select<LocationRow>('id, name, slug, city, is_active'),
    ])
    if (links.error || locations.error) return byProfile

    const locationById = new Map<number, TeamLocation>()
    for (const row of locations.data ?? []) {
      if (row.is_active === false) continue
      locationById.set(row.id, {
        id: row.id,
        name: row.name,
        slug: row.slug,
        city: row.city,
      })
    }

    const wanted = new Set(profileIds)
    // Home site first — "she is at the Fresno studio, and sometimes Clovis"
    // reads better than the reverse, and matters more.
    const ordered = [...(links.data ?? [])].sort(
      (a, b) => Number(b.is_primary) - Number(a.is_primary)
    )

    for (const link of ordered) {
      if (!wanted.has(link.profile_id)) continue
      const location = locationById.get(link.location_id)
      if (!location) continue
      const list = byProfile.get(link.profile_id) ?? []
      if (!list.some((l) => l.id === location.id)) list.push(location)
      byProfile.set(link.profile_id, list)
    }
  } catch {
    return byProfile
  }

  return byProfile
}

/*
 * ── Entries for src/types/database.ts ────────────────────────
 * (that file is contested; these are listed here for whoever merges)
 *
 * Tables:
 *   staff_profiles: TableDef<StaffProfile, [ToProfile<'staff_profiles', 'profile_id'>]>
 *   staff_credentials: TableDef<
 *     StaffCredential,
 *     [ToProfile<'staff_credentials', 'profile_id'>, ToProfile<'staff_credentials', 'verified_by'>]
 *   >
 *   staff_employment: TableDef<
 *     StaffEmployment,
 *     [ToProfile<'staff_employment', 'profile_id'>, ToProfile<'staff_employment', 'updated_by'>]
 *   >
 *
 * These tables key on profile_id rather than id, so `Generated` in database.ts
 * ('id' | 'created_at' | 'updated_at') does not name their primary key. That
 * changes nothing in practice: `Insert` there is built on `Partial<Row>`, so
 * every column is optional on insert for every table in the file, and the
 * NOT NULLs in Postgres are what actually hold. Same bargain as the rest.
 *
 * Functions:
 *   notify_expiring_licences: { Args: Record<string, never>; Returns: number }
 *   licence_status: { Args: { p_expires_on: string | null; p_soon_days?: number }; Returns: string }
 *   is_listable_staff: { Args: { p_profile_id: string }; Returns: boolean }
 */
