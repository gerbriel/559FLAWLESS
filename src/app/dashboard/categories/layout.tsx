import { SectionTabs } from '@/components/layout/SectionTabs'

/**
 * The shape of the catalogue, both halves of it.
 *
 * The studio sells time and it sells things, and each is grouped: services into
 * the headings the public menu is built from, products into the filter row
 * across the top of the shop. Two tables, `service_categories` and
 * `product_categories`, and until now only the first had anywhere to be edited.
 *
 * They are one job — "what are the groupings, and what is filed under each" —
 * so they are one sidebar entry with a tab bar, not two rows in the menu. The
 * screens behind the tabs are deliberately the same screen twice; where they
 * differ, it is because the database differs, and each says so where it does.
 *
 * No role check here, deliberately, and for the same reason the services
 * section has none: both tables are readable by `anon`, never mind by a
 * provider, so there is nothing for a gate in this layout to protect. Each page
 * decides for itself who gets controls — manager and above, matching the write
 * policies rather than guessing at them. A layout does not re-render on a
 * client-side transition between its own tabs anyway, which is exactly why the
 * checks that matter live in the pages.
 */
export default function CategoriesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <SectionTabs
        label="Categories"
        root="/dashboard/categories"
        tabs={[
          { href: '/dashboard/categories/services', label: 'Services' },
          { href: '/dashboard/categories/products', label: 'Products' },
        ]}
      />

      <div className="mt-8">{children}</div>
    </div>
  )
}
