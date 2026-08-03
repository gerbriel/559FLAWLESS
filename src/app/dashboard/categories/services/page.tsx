import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ButtonLink } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/dashboard'
import {
  ServiceCategoryManager,
  type CategoryFormTemplate,
  type CategoryServiceGates,
  type CategoryUsage,
  type ManagedCategory,
} from '@/components/shared/ServiceCategoryManager'
import { isAdmin, isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * The groupings the service menu is built from.
 *
 * Migration 022 handed these to managers — it dropped 002's "admin writes
 * categories" for "manager writes categories" — and until now there was nowhere
 * to exercise that: the services screen read the table only to fill a dropdown.
 *
 * This screen used to live at `/dashboard/services/categories`, under the
 * services tab bar. It moved here when the product categories got a screen of
 * their own, because "what are the groupings" turned out to be one question
 * asked of two tables rather than a footnote to the service list. The old
 * address still works and forwards here.
 *
 * Everything a delete would cost is counted here, on the server, rather than
 * discovered by pressing the button. `services.category_id` is
 * `on delete restrict`, so a category with anything filed under it cannot be
 * deleted at all and the screen says so with the number; the schedules and
 * commission rates are `on delete cascade` and would go quietly, which is
 * exactly why they are counted and named before the confirm.
 *
 * The whole list is readable by any staff member — the same rows the public
 * site reads — so providers and the front desk see the menu structure. The
 * controls are manager-and-above, matching the policy rather than guessing at
 * it.
 *
 * The forms and the services' booking gates are read here for the same reason
 * the delete costs are: so the panel can describe what is actually true before
 * anything is pressed. Neither is stored on the category. The forms are read
 * from `consent_forms` / `intake_forms`, whose `category_ids` is the storage
 * the panel writes; the gates are read off the services themselves, which the
 * page was already querying, because there is no category-level copy of a gate
 * and inventing one would be the second source of truth this screen exists to
 * avoid.
 */
export default async function ServiceCategoriesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/categories/services')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  // Least privilege on a missing profile, as everywhere else in the dashboard.
  const role = (profile?.role ?? 'provider') as UserRole
  const canManage = isManager(role)

  const [
    { data: categories },
    { data: services },
    { data: schedules },
    { data: rates },
    intake,
    consent,
  ] = await Promise.all([
    supabase
      .from('service_categories')
      .select('id, name, slug, description, image_url, is_intimate, sort_order, is_active')
      .order('sort_order')
      .order('name'),
    // Hidden services count too: `restrict` does not care whether a row is
    // listed, only that it exists — and nor does a booking gate, which is
    // still the rule the day the service is listed again. The gate columns
    // ride along on the query that was already being made.
    supabase
      .from('services')
      .select(
        'id, category_id, name, is_active, price_cents, is_intimate, requires_age_verification, min_age, requires_consultation, requires_booking_approval, patch_test_hours, deposit_cents, cancellation_window_hours'
      )
      .order('sort_order')
      .order('name'),
    supabase
      .from('notification_schedules')
      .select('id, category_id')
      .not('category_id', 'is', null),
    // Readable only by someone who may see pay; when RLS says no this comes
    // back empty and the delete simply has one fewer thing to warn about.
    supabase.from('commission_category_rates').select('plan_id, category_id'),
    // Active only: a superseded version is never asked for, so showing it as a
    // requirement of this category would be describing something that cannot
    // happen. Intake first — a client fills in a health history before being
    // asked to consent to anything, and the list reads in that order.
    supabase
      .from('intake_forms')
      .select('id, title, service_ids, category_ids')
      .eq('is_active', true)
      .order('title'),
    supabase
      .from('consent_forms')
      .select('id, title, service_ids, category_ids')
      .eq('is_active', true)
      .order('title'),
  ])

  const cats = (categories ?? []) as ManagedCategory[]
  const svcs = (services ?? []) as CategoryServiceGates[]

  const usage: CategoryUsage[] = cats.map((c) => {
    const mine = svcs.filter((s) => s.category_id === c.id)
    return {
      category_id: c.id,
      services: mine.length,
      listed: mine.filter((s) => s.is_active).length,
      schedules: (schedules ?? []).filter((s) => s.category_id === c.id).length,
      commission_rates: (rates ?? []).filter((r) => r.category_id === c.id).length,
    }
  })

  // Null rather than empty when either read failed: "no forms exist" and "you
  // cannot see the forms" are different sentences, and the panel says whichever
  // is true instead of implying the first.
  const forms: CategoryFormTemplate[] | null =
    intake.error || consent.error
      ? null
      : [
          ...(intake.data ?? []).map((f) => ({
            kind: 'intake' as const,
            id: f.id,
            title: f.title,
            service_ids: f.service_ids ?? [],
            category_ids: f.category_ids ?? [],
          })),
          ...(consent.data ?? []).map((f) => ({
            kind: 'consent' as const,
            id: f.id,
            title: f.title,
            service_ids: f.service_ids ?? [],
            category_ids: f.category_ids ?? [],
          })),
        ]

  const live = cats.filter((c) => c.is_active).length

  return (
    <div>
      <PageHeader
        title="Service categories"
        lede={
          cats.length === 0
            ? 'Nothing here yet.'
            : `${cats.length} total · ${live} on the site`
        }
        actions={
          <ButtonLink
            href="/services"
            target="_blank"
            rel="noreferrer"
            variant="outline"
            size="sm"
          >
            View public menu
          </ButtonLink>
        }
      />

      <div className="mt-8">
        <ServiceCategoryManager
          categories={cats}
          usage={usage}
          services={svcs}
          forms={forms}
          canManage={canManage}
          // Not the same permission: 022's trigger refuses the safety gates
          // from a manager, column by column, so those controls are admin's
          // and the rest of this screen is not.
          isAdmin={isAdmin(role)}
        />
      </div>
    </div>
  )
}
