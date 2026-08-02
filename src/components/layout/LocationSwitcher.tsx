import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { LocationSwitcherSelect } from '@/components/layout/LocationSwitcherSelect'
import {
  ALL_LOCATIONS,
  LOCATION_COOKIE,
  LOCATION_COOKIE_MAX_AGE,
  loadActiveLocations,
  readLocationScope,
} from '@/components/layout/LocationScope'

/**
 * Which studio the dashboard is showing, in the header chrome.
 *
 * Renders NOTHING when there is one site. A studio with one room should never
 * be asked which room it means, and shipping a switcher that only ever has one
 * option in it is how a small business ends up feeling like it is using
 * someone else's software.
 */
export async function LocationSwitcher() {
  const locations = await loadActiveLocations()
  if (locations.length < 2) return null

  const current = await readLocationScope()

  async function choose(formData: FormData) {
    'use server'
    const raw = String(formData.get('location') ?? ALL_LOCATIONS)
    const id = Number(raw)
    const value = Number.isInteger(id) && id > 0 ? String(id) : ALL_LOCATIONS

    const store = await cookies()
    store.set(LOCATION_COOKIE, value, {
      path: '/',
      maxAge: LOCATION_COOKIE_MAX_AGE,
      sameSite: 'lax',
      // Readable by the server on every request, which is the whole job. No
      // httpOnly: nothing here is a secret, and RLS is what stops a staff member
      // reading a site they should not.
    })

    // The chosen site changes what every page under /dashboard queries, not
    // just this one, so the whole subtree is refetched rather than the route
    // that happened to hold the form.
    revalidatePath('/dashboard', 'layout')
  }

  return (
    <LocationSwitcherSelect
      options={locations.map((l) => ({ id: l.id, name: l.name }))}
      current={current === null ? ALL_LOCATIONS : String(current)}
      action={choose}
    />
  )
}
