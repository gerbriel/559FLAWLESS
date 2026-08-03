import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ButtonLink } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/dashboard'
import {
  ServiceCategoryManager,
  type CategoryUsage,
  type ManagedCategory,
} from '@/components/shared/ServiceCategoryManager'
import { isManager, type UserRole } from '@/types/database'

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
  const canManage = isManager((profile?.role ?? 'provider') as UserRole)

  const [{ data: categories }, { data: services }, { data: schedules }, { data: rates }] =
    await Promise.all([
      supabase
        .from('service_categories')
        .select('id, name, slug, description, image_url, is_intimate, sort_order, is_active')
        .order('sort_order')
        .order('name'),
      // Hidden services count too: `restrict` does not care whether a row is
      // listed, only that it exists.
      supabase.from('services').select('id, category_id, is_active'),
      supabase
        .from('notification_schedules')
        .select('id, category_id')
        .not('category_id', 'is', null),
      // Readable only by someone who may see pay; when RLS says no this comes
      // back empty and the delete simply has one fewer thing to warn about.
      supabase.from('commission_category_rates').select('plan_id, category_id'),
    ])

  const cats = (categories ?? []) as ManagedCategory[]

  const usage: CategoryUsage[] = cats.map((c) => {
    const mine = (services ?? []).filter((s) => s.category_id === c.id)
    return {
      category_id: c.id,
      services: mine.length,
      listed: mine.filter((s) => s.is_active).length,
      schedules: (schedules ?? []).filter((s) => s.category_id === c.id).length,
      commission_rates: (rates ?? []).filter((r) => r.category_id === c.id).length,
    }
  })

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
        <ServiceCategoryManager categories={cats} usage={usage} canManage={canManage} />
      </div>
    </div>
  )
}
