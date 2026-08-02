import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/types/database'
import type { Location } from '@/types/locations'
import {
  LocationsManager,
  type LocationUsage,
} from '@/app/dashboard/settings/locations/LocationsManager'

export const dynamic = 'force-dynamic'

/**
 * Locations — admin only.
 *
 * Where a location's details live is not a small decision: `locations.timezone`
 * is what every opening time at that site is read in, and the first open row is
 * what `public.default_location_id()` hands to every appointment, sale and
 * stock count that does not name a site of its own. That is why this is not on
 * the general Settings page with the opening hours.
 */
export default async function LocationsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/settings/locations')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || !isAdmin(profile.role)) redirect('/dashboard/settings')

  const { data: rows } = await supabase
    .from('locations')
    // One string literal — concatenating widens the select to `string` and
    // collapses the result type to SelectQueryError.
    .select(
      'id, name, slug, address_line1, city, state, postal, timezone, phone, email, is_active, sort_order'
    )
    .order('sort_order')
    .order('id')

  const locations = (rows ?? []) as Location[]

  // What points at each site. This is the difference between offering "Remove"
  // and explaining why it is not on the table — a location with a single
  // appointment against it can never be deleted, because every location_id is
  // ON DELETE RESTRICT so a visit can never lose the record of where it was.
  const usage: Record<number, LocationUsage> = {}
  await Promise.all(
    locations.map(async (location) => {
      const [appointments, orders, staff] = await Promise.all([
        supabase
          .from('appointments')
          .select('id', { count: 'exact', head: true })
          .eq('location_id', location.id),
        supabase
          .from('orders')
          .select('id', { count: 'exact', head: true })
          .eq('location_id', location.id),
        supabase
          .from('staff_locations')
          .select('profile_id', { count: 'exact', head: true })
          .eq('location_id', location.id),
      ])

      usage[location.id] = {
        appointments: appointments.count ?? 0,
        orders: orders.count ?? 0,
        staff: staff.count ?? 0,
      }
    })
  )

  return (
    <div className="max-w-3xl">
      <h1 className="display text-3xl">Locations</h1>
      <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
        Every appointment, sale and stock count is recorded against the site it
        happened at. Clients are not: one person has one record and one history,
        wherever they were seen.
      </p>

      {locations.length === 1 && (
        <p className="mt-6 max-w-prose border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm text-[var(--color-muted)] dark:bg-[var(--color-surface)]">
          There is one studio, so nobody is asked to choose one — the booking site
          shows no location step and the dashboard shows no switcher. Both appear on
          their own the moment a second location is open.
        </p>
      )}

      <div className="mt-8">
        <LocationsManager locations={locations} usage={usage} />
      </div>

      <section className="mt-14">
        <h2 className="display text-2xl">What is set per location</h2>
        <ul className="mt-5 space-y-3 text-sm text-[var(--color-muted)]">
          <li>
            <span className="text-[var(--color-foreground)]">Opening hours and closures</span>{' '}
            &mdash; each site keeps its own week and its own holidays.
          </li>
          <li>
            <span className="text-[var(--color-foreground)]">Working hours</span> &mdash; a
            provider can hold Tuesdays at one site and Thursdays at another. Set under My
            hours.
          </li>
          <li>
            <span className="text-[var(--color-foreground)]">The menu and the price</span>{' '}
            &mdash; a service can be offered at one site and not the other, and charged
            differently at each.
          </li>
          <li>
            <span className="text-[var(--color-foreground)]">Stock</span> &mdash; one
            catalogue, a separate count on each shelf.
          </li>
          <li>
            <span className="text-[var(--color-foreground)]">Sales tax</span> &mdash; still
            one rate for the business. Districts assess their own, so a second site in
            another district will need this split.
          </li>
        </ul>
      </section>
    </div>
  )
}
