'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TABS = [
  { href: '/dashboard/forms', label: 'Outstanding' },
  { href: '/dashboard/forms/consent', label: 'Consent forms' },
  { href: '/dashboard/forms/intake', label: 'Intake forms' },
]

export function FormsTabs() {
  const pathname = usePathname()

  return (
    <nav className="mt-8 flex flex-wrap gap-x-7 gap-y-2" aria-label="Forms">
      {TABS.map((tab) => {
        const active = pathname === tab.href
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={
              active
                ? 'label-caps border-b border-[var(--color-foreground)] pb-1'
                : 'label-caps pb-1 text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            }
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
