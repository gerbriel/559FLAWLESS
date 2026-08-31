import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ButtonLink } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/dashboard'
import { ServiceEditor } from '@/components/shared/ServiceEditor'
import {
  ServicesCatalogue,
  type CatalogueCategory,
  type CatalogueService,
} from '@/components/shared/ServicesCatalogue'
import {
  AddonManager,
  type ManagedAddon,
  type ManagedPairDeal,
} from '@/components/shared/AddonManager'
import { isManager, isAdmin, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * The service menu, editable in place.
 *
 * This page loads the catalogue and decides who may change it; the catalogue
 * itself — search, category filter, the cards and the rail beside them — lives
 * in ServicesCatalogue, which needs state to do any of that.
 */
export default async function ServicesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'provider') as UserRole
  const canEdit = isManager(role)
  const admin = isAdmin(role)

  const [
    { data: categories },
    { data: services },
    { data: addons },
    { data: addonLinks },
    { data: pairDeals },
  ] = await Promise.all([
    supabase
      .from('service_categories')
      // slug and image_url are for the rail and the row thumbnails: the public
      // page a category has, and the photograph a service borrows when it has
      // none of its own.
      .select('id, name, slug, image_url, is_active, sort_order')
      .order('sort_order'),
    supabase
      .from('services')
      .select(
        'id, category_id, name, slug, description, details, aftercare, image_url, price_cents, price_is_starting, duration_minutes, buffer_minutes, is_active, is_featured, sort_order, is_intimate, requires_age_verification, min_age, requires_consultation, patch_test_hours, deposit_cents, cancellation_window_hours'
      )
      .order('sort_order')
      .order('name'),
    // The "add to this service" section, for the admin manager below.
    supabase
      .from('service_addons')
      .select('id, name, description, price_cents, duration_minutes, is_active')
      .order('sort_order')
      .order('name'),
    supabase.from('service_addon_links').select('service_id, addon_id'),
    supabase
      .from('service_pair_discounts')
      .select('id, trigger_service_id, discounted_service_id, percent_off, label, is_active'),
  ])

  const cats = (categories ?? []) as CatalogueCategory[]
  const all = (services ?? []) as CatalogueService[]

  return (
    <div>
      <PageHeader
        title="Services"
        lede={`${all.filter((s) => s.is_active).length} listed · ${all.length} total`}
        actions={
          <>
            <ButtonLink href="/services" target="_blank" rel="noreferrer" variant="outline" size="sm">
              View public menu
            </ButtonLink>
            {canEdit && cats.length > 0 && (
              // ServiceEditor owns its own trigger, and adding a service is the
              // one action on this page that should read as the primary one.
              // Restyling the button from here beats forking the editor over a
              // colour.
              <span className="[&>button]:border-transparent [&>button]:bg-[var(--color-foreground)] [&>button]:text-[var(--color-background)] [&>button:hover]:border-transparent [&>button:hover]:bg-[var(--color-clay-deep)]">
                <ServiceEditor
                  categories={cats.map((c) => ({ id: c.id, name: c.name }))}
                  isAdmin={admin}
                />
              </span>
            )}
          </>
        }
      />

      <ServicesCatalogue services={all} categories={cats} canEdit={canEdit} isAdmin={admin} />

      {/* Add-ons and pair deals, per service. Admin only — same as the RLS
          that actually enforces it (002, 067). */}
      {admin && all.length > 0 && (
        <AddonManager
          services={all.map((s) => ({
            id: s.id,
            name: s.name,
            price_cents: s.price_cents,
            category_id: s.category_id,
            is_active: s.is_active,
          }))}
          categories={cats.map((c) => ({ id: c.id, name: c.name }))}
          addons={(addons ?? []) as ManagedAddon[]}
          links={addonLinks ?? []}
          pairDeals={(pairDeals ?? []) as ManagedPairDeal[]}
        />
      )}
    </div>
  )
}
