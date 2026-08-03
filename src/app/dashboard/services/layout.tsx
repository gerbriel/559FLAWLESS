import { SectionTabs } from '@/components/layout/SectionTabs'

/**
 * The menu, and the shape of the menu.
 *
 * Two pages, one sidebar entry: what the studio sells, and the categories it is
 * grouped into. They are the same job seen from two angles — a service cannot
 * exist without a category, and a category is only ever a heading over some
 * services — so a tab bar rather than a second entry in the sidebar.
 *
 * No role check here, deliberately. Both pages are readable by every staff
 * member (`service_categories` and `services` are readable by the public, never
 * mind the front desk) and each decides for itself who gets controls, so there
 * is nothing for a gate in this layout to protect. A layout does not re-render
 * on a client-side transition between its own tabs anyway, which is why the
 * checks that matter live in the pages.
 */
export default function ServicesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <SectionTabs
        label="Services"
        root="/dashboard/services"
        tabs={[
          { href: '/dashboard/services', label: 'Services' },
          { href: '/dashboard/services/categories', label: 'Categories' },
        ]}
      />

      <div className="mt-8">{children}</div>
    </div>
  )
}
