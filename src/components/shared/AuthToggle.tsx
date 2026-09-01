'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'

/**
 * Sign in ⁄ Create account, as one visible switch. The old affordance was a
 * line of small text under the form ("No account? Create one"), which new
 * clients scrolled straight past — this puts the choice where the decision is
 * made, above the form, styled like the buttons they already press.
 */
export function AuthToggle() {
  const pathname = usePathname()

  const tabs = [
    { href: '/login', label: 'Sign in' },
    { href: '/signup', label: 'Create account' },
  ]

  return (
    <div className="grid grid-cols-2 border border-[var(--color-border)]">
      {tabs.map((t) => {
        const active = pathname.startsWith(t.href)
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'label-caps flex min-h-11 items-center justify-center transition-colors',
              active
                ? 'bg-[var(--color-foreground)] text-[var(--color-background)]'
                : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
            )}
          >
            {t.label}
          </Link>
        )
      })}
    </div>
  )
}
