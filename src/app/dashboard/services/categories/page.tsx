import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * Service categories moved to `/dashboard/categories/services`.
 *
 * They used to be the second tab of the Services section, on the reasoning that
 * a category is only ever a heading over some services. That held right up
 * until the product categories got a screen too — at which point the honest
 * grouping turned out to be "the shape of the catalogue", one question asked of
 * two tables, rather than a footnote to the service list.
 *
 * Kept as a stub rather than deleted because things still point here: the tab
 * bar in `dashboard/services/layout.tsx`, the link out of `ServicesCatalogue`,
 * and whatever a manager has bookmarked. There is no query string on this
 * screen to carry across, so the forward is bare.
 *
 * Temporary rather than permanent on purpose: a 308 is cached by the browser
 * and would outlive any future change of mind about where this page lives.
 */
export default function ServiceCategoriesMovedPage() {
  redirect('/dashboard/categories/services')
}
