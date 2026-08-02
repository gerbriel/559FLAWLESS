'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

export interface SectionTab {
  href: string
  label: string
  /** Hidden entirely when false. A tab nobody may open is worse than no tab. */
  visible?: boolean
}

/**
 * The tab bar for a dashboard section that holds several pages.
 *
 * One sidebar entry, several related screens, and a toggle between them —
 * used where the pages are genuinely one job seen from different angles.
 * Each page keeps its own heading and its own flow; this only says where you
 * are and how to get to its neighbours.
 *
 * `exact` matters: a tab whose href is the section root would otherwise light
 * up on every child route, so the parent is matched exactly and children by
 * prefix.
 */
export function SectionTabs({
  tabs,
  label,
  root,
}: {
  tabs: SectionTab[]
  /** Names the nav for screen readers, e.g. "Schedule". */
  label: string
  /** The section root, matched exactly rather than by prefix. */
  root: string
}) {
  const pathname = usePathname()
  const shown = tabs.filter((t) => t.visible !== false)

  // One tab is not a choice; rendering a bar for it is just noise.
  if (shown.length < 2) return null

  return (
    <nav className="mt-8 flex flex-wrap gap-x-7 gap-y-2" aria-label={label}>
      {shown.map((tab) => {
        const active =
          tab.href === root ? pathname === root : pathname.startsWith(tab.href)

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'label-caps border-b border-[var(--color-foreground)] pb-1'
                : 'label-caps pb-1 text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)]'
            }
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
