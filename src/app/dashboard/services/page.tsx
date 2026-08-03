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

  const [{ data: categories }, { data: services }] = await Promise.all([
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
    </div>
  )
}
