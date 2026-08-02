import Link from 'next/link'
import { redirect } from 'next/navigation'
import { ChevronLeft } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import {
  ResourceManager,
  type ManagedResource,
  type ResourceLink,
} from '@/components/shared/ResourceManager'
import { readLocationScope, withLocation } from '@/components/layout/LocationScope'
import { isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function ResourceSettingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/settings/resources')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'provider') as UserRole
  // Buying a second wax warmer is operational, not financial — a manager can do
  // it. Pricing and the booking gates stay where 002 left them, with the admin.
  if (!isManager(role)) redirect('/dashboard')

  const locationId = await readLocationScope()

  let resourceQuery = supabase
    .from('resources')
    // One string literal — concatenation widens the select to `string` and
    // collapses the result type to SelectQueryError.
    .select('id, location_id, room_id, name, kind, quantity, is_active, sort_order, notes')
    .order('kind')
    .order('sort_order')
    .order('name')
  resourceQuery = withLocation(resourceQuery, locationId)

  const [{ data: resources }, { data: services }, { data: links }, { data: locations }] =
    await Promise.all([
      resourceQuery,
      supabase
        .from('services')
        .select('id, name')
        .eq('is_active', true)
        .order('sort_order')
        .order('name'),
      supabase.from('service_resources').select('service_id, resource_id, quantity'),
      supabase
        .from('locations')
        .select('id, name')
        .eq('is_active', true)
        .order('sort_order')
        .order('id'),
    ])

  const locationOptions = (locations ?? []).map((l) => ({ id: l.id, name: l.name }))
  // The same rule `public.default_location_id()` uses, so a new resource lands
  // where the column default would have put it.
  const defaultLocationId = locationId ?? locationOptions[0]?.id ?? 1

  return (
    <div>
      <Link
        href="/dashboard/settings"
        className="label-caps inline-flex items-center gap-1.5 text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
      >
        <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
        Settings
      </Link>

      <h1 className="display mt-6 text-3xl">Rooms &amp; equipment</h1>
      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[var(--color-muted)]">
        A treatment needs more than a free esthetician. List what it also needs — the
        room, the bed, the warmer, the LED mask — and say how many of each there are.
        Availability then accounts for all of it: a slot with a free provider but no
        free room is not a slot, and two clients cannot share the one mask however
        many hands are available.
      </p>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-[var(--color-muted)]">
        Leaving this empty is a valid answer. A single-room studio where the only
        constraint is the person needs nothing here, and nothing changes until a
        treatment is attached to something.
      </p>

      <div className="mt-10">
        <ResourceManager
          resources={(resources ?? []) as ManagedResource[]}
          services={services ?? []}
          links={(links ?? []) as ResourceLink[]}
          locations={locationOptions}
          defaultLocationId={defaultLocationId}
        />
      </div>
    </div>
  )
}
