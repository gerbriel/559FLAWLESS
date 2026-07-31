'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

const LINKS = [
  { href: '/account', label: 'Overview', exact: true },
  { href: '/account/appointments', label: 'Appointments' },
  { href: '/account/forms', label: 'Forms & consent' },
  { href: '/account/messages', label: 'Messages', badge: true },
  { href: '/account/orders', label: 'Orders' },
  { href: '/account/settings', label: 'Settings' },
]

export function AccountNav({ unreadCount }: { unreadCount: number }) {
  const pathname = usePathname()

  return (
    <nav aria-label="Account" className="lg:sticky lg:top-8 lg:self-start">
      <ul className="flex gap-x-6 gap-y-2 overflow-x-auto pb-2 lg:flex-col lg:overflow-visible lg:pb-0">
        {LINKS.map((l) => {
          const active = l.exact ? pathname === l.href : pathname.startsWith(l.href)
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                className={cn(
                  'label-caps flex items-center gap-2 whitespace-nowrap py-2 transition-colors',
                  active
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
                )}
              >
                {l.label}
                {l.badge && unreadCount > 0 && (
                  <span className="flex h-4 min-w-4 items-center justify-center bg-[var(--color-accent)] px-1 text-[0.5625rem] text-white">
                    {unreadCount}
                  </span>
                )}
              </Link>
            </li>
          )
        })}
      </ul>
    </nav>
  )
}
