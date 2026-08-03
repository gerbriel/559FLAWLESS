import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { ButtonLink } from '@/components/ui/button'
import { PageHeader } from '@/components/ui/dashboard'
import {
  ProductCategoryManager,
  type ManagedProductCategory,
  type ProductCategoryUsage,
} from '@/components/shared/ProductCategoryManager'
import { isManager, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

/**
 * The groupings the shop is filtered by.
 *
 * `product_categories` shipped in 007 with a read policy and nothing else — one
 * line, "public reads product categories", and no write policy at any role.
 * RLS denies what it is not told to allow, so for the whole life of the table
 * nobody could add, rename or remove a category: the eleven in it came from
 * 010's seed and stayed. Migration 052 is what opens writes to managers and, in the
 * same breath, tightens `products.category_id` from `on delete set null` to
 * `on delete restrict` — because a write policy on its own would have meant
 * deleting a category silently emptied the category out of every product in it
 * rather than refusing.
 *
 * Everything a delete would cost is counted here, on the server, so the screen
 * can say it before the button is pressed rather than after. Three counts, and
 * the split matters:
 *
 * - **every** product filed here, because a foreign key does not care whether a
 *   row is listed, retail, or archived — any one of them is enough to stop a
 *   delete;
 * - the ones a shopper can actually see, which is the number a manager has in
 *   their head;
 * - the archived ones, because they appear nowhere else in the dashboard and
 *   are the usual reason a category that looks empty is not.
 *
 * Staff read every product — 007's policy is `(is_active and is_retail and
 * archived_at is null) or public.is_staff()` — so these counts are the true
 * ones and not the storefront's view of them.
 *
 * The list is readable by any staff member, the same rows the shop reads. The
 * controls are manager-and-above, matching 052's policy rather than guessing at
 * it.
 */
export default async function ProductCategoriesPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/categories/products')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  // Least privilege on a missing profile, as everywhere else in the dashboard.
  const canManage = isManager((profile?.role ?? 'provider') as UserRole)

  const [{ data: categories }, { data: products }] = await Promise.all([
    supabase
      .from('product_categories')
      .select('id, name, slug, description, image_url, sort_order, is_active')
      .order('sort_order')
      .order('name'),
    // No filter at all, deliberately: back-bar stock, unlisted products and
    // archived ones all still hold the reference and all still block a delete.
    supabase.from('products').select('id, category_id, is_active, is_retail, archived_at'),
  ])

  const cats = (categories ?? []) as ManagedProductCategory[]
  const rows = products ?? []

  const usage: ProductCategoryUsage[] = cats.map((c) => {
    const mine = rows.filter((p) => p.category_id === c.id)
    return {
      category_id: c.id,
      products: mine.length,
      // What the shop shows, exactly as the shop decides it.
      listed: mine.filter((p) => p.is_active && p.is_retail && p.archived_at === null)
        .length,
      archived: mine.filter((p) => p.archived_at !== null).length,
    }
  })

  // `products.category_id` is nullable and always has been, so this is not
  // hypothetical — and an uncategorised product is invisible under every filter
  // while sitting in the shop as normal, which nothing else would tell anyone.
  const uncategorised = rows.filter((p) => p.category_id === null).length

  const live = cats.filter((c) => c.is_active).length

  return (
    <div>
      <PageHeader
        title="Product categories"
        lede={
          cats.length === 0
            ? 'Nothing here yet.'
            : `${cats.length} total · ${live} on the shop`
        }
        actions={
          <ButtonLink
            href="/shop"
            target="_blank"
            rel="noreferrer"
            variant="outline"
            size="sm"
          >
            View shop
          </ButtonLink>
        }
      />

      <div className="mt-8">
        <ProductCategoryManager
          categories={cats}
          usage={usage}
          uncategorised={uncategorised}
          canManage={canManage}
        />
      </div>
    </div>
  )
}
