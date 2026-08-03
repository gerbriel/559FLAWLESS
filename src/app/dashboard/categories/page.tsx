import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

/**
 * The section root has no screen of its own.
 *
 * Both tabs are real pages and neither is more "the section" than the other, so
 * rather than inventing a landing page that would only ever be two links, the
 * root forwards to the services tab — the older of the two and the one someone
 * arriving from the sidebar is most often after.
 *
 * Temporary rather than permanent: a 308 is cached by the browser and would
 * outlive any future change of mind about which tab opens first.
 */
export default function CategoriesIndexPage() {
  redirect('/dashboard/categories/services')
}
