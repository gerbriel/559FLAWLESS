'use client'

import { useState, useSyncExternalStore } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Menu, X, User, ShoppingBag } from 'lucide-react'
import { ButtonLink } from '@/components/ui/button'
import { Container } from '@/components/ui/section'
import { cn } from '@/lib/utils'
import { useCart } from '@/store/cart'

interface NavCategory {
  name: string
  slug: string
  services: { name: string; slug: string }[]
}

const STATIC_LINKS = [
  { href: '/about', label: 'About' },
  { href: '/shop', label: 'Shop' },
  { href: '/faq', label: 'FAQ' },
  { href: '/contact', label: 'Contact' },
]

/**
 * The bag, with what is in it.
 *
 * The count comes through useSyncExternalStore with a server snapshot of zero:
 * the cart lives in localStorage (zustand persist), which the server cannot
 * read, so the hydration render shows an empty bag everywhere and the real
 * count arrives in the very next client render. No effect, no setState, no
 * mismatch — the one hydration-safe shape for client-only state in a header
 * that every public page server-renders.
 */
function CartButton() {
  const count = useSyncExternalStore(
    useCart.subscribe,
    () => useCart.getState().lines.reduce((n, l) => n + l.qty, 0),
    () => 0
  )

  return (
    <Link
      href="/cart"
      className="relative flex h-11 w-11 items-center justify-center transition-colors hover:text-[var(--color-accent)]"
      aria-label={count > 0 ? `Your bag, ${count} ${count === 1 ? 'item' : 'items'}` : 'Your bag'}
    >
      <ShoppingBag className="h-5 w-5" strokeWidth={1.5} />
      {count > 0 && (
        <span
          aria-hidden
          className="absolute right-1 top-1 flex h-4 min-w-4 items-center justify-center bg-[var(--color-accent)] px-1 text-[0.5625rem] tabular-nums text-white"
        >
          {count > 99 ? '99+' : count}
        </span>
      )}
    </Link>
  )
}

export function SiteHeader({ categories }: { categories: NavCategory[] }) {
  const [mobileOpen, setMobileOpen] = useState(false)
  const [openCategory, setOpenCategory] = useState<string | null>(null)
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-40 border-b border-[var(--color-border)] bg-[var(--color-background)]/95 backdrop-blur">
      <Container>
        <div className="flex h-20 items-center justify-between gap-6">
          <Link href="/" className="flex min-h-11 shrink-0 flex-col justify-center">
            <span className="display block text-2xl leading-none tracking-tight">559</span>
            <span className="label-caps block text-[0.625rem] text-[var(--color-accent)]">
              Flawless
            </span>
          </Link>

          {/* Desktop nav */}
          <nav className="hidden items-center gap-8 lg:flex" aria-label="Main">
            <div
              className="relative"
              onMouseLeave={() => setOpenCategory(null)}
            >
              <button
                className="label-caps py-2 transition-colors hover:text-[var(--color-accent)]"
                onMouseEnter={() => setOpenCategory('services')}
                onClick={() => setOpenCategory((c) => (c ? null : 'services'))}
                aria-expanded={openCategory === 'services'}
                aria-haspopup="true"
              >
                Services
              </button>
              {openCategory === 'services' && (
                <div className="absolute left-1/2 top-full z-50 w-[42rem] -translate-x-1/2 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 shadow-lg">
                  <div className="grid grid-cols-3 gap-x-8 gap-y-6">
                    {categories.map((cat) => (
                      <div key={cat.slug}>
                        <Link
                          href={`/services/${cat.slug}`}
                          className="label-caps mb-3 block text-[var(--color-accent)]"
                        >
                          {cat.name}
                        </Link>
                        <ul className="space-y-2">
                          {cat.services.slice(0, 5).map((s) => (
                            <li key={s.slug}>
                              <Link
                                href={`/services/${cat.slug}/${s.slug}`}
                                className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)]"
                              >
                                {s.name}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      </div>
                    ))}
                  </div>
                  <Link
                    href="/services"
                    className="label-caps mt-8 inline-block border-b border-[var(--color-foreground)] pb-1"
                  >
                    View full menu
                  </Link>
                </div>
              )}
            </div>

            {STATIC_LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className={cn(
                  'label-caps py-2 transition-colors hover:text-[var(--color-accent)]',
                  pathname.startsWith(l.href) && 'text-[var(--color-accent)]'
                )}
              >
                {l.label}
              </Link>
            ))}
          </nav>

          <div className="flex items-center gap-3">
            {/* Visible at every size — adding to a bag you cannot find again is
                the whole complaint this button answers. */}
            <CartButton />
            {/* Always /account — it redirects anonymous visitors to sign in and
                staff to the dashboard. Resolving that here would need a session,
                which would make every public page render dynamically. */}
            <Link
              href="/account"
              className="hidden h-11 w-11 items-center justify-center transition-colors hover:text-[var(--color-accent)] sm:flex"
              aria-label="Your account"
            >
              <User className="h-5 w-5" strokeWidth={1.5} />
            </Link>

            <ButtonLink href="/book" size="sm" className="hidden h-11 sm:inline-flex">
              Book now
            </ButtonLink>

            <button
              className="-mr-2 flex h-11 w-11 items-center justify-center lg:hidden"
              onClick={() => setMobileOpen((o) => !o)}
              aria-label={mobileOpen ? 'Close menu' : 'Open menu'}
              aria-expanded={mobileOpen}
            >
              {mobileOpen ? (
                <X className="h-5 w-5" strokeWidth={1.5} />
              ) : (
                <Menu className="h-5 w-5" strokeWidth={1.5} />
              )}
            </button>
          </div>
        </div>
      </Container>

      {/* Mobile nav */}
      {mobileOpen && (
        <div className="border-t border-[var(--color-border)] bg-[var(--color-background)] lg:hidden">
          <Container className="py-6">
            <nav className="space-y-6" aria-label="Mobile">
              <div>
                <p className="label-caps mb-3 text-[var(--color-accent)]">Services</p>
                <ul className="space-y-2.5 pl-1">
                  {categories.map((cat) => (
                    <li key={cat.slug}>
                      <Link
                        href={`/services/${cat.slug}`}
                        onClick={() => setMobileOpen(false)}
                        className="flex min-h-11 items-center text-sm text-[var(--color-muted)]"
                      >
                        {cat.name}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
              {STATIC_LINKS.map((l) => (
                <Link
                  key={l.href}
                  href={l.href}
                  onClick={() => setMobileOpen(false)}
                  className="label-caps flex min-h-11 items-center"
                >
                  {l.label}
                </Link>
              ))}
              <Link
                href="/account"
                onClick={() => setMobileOpen(false)}
                className="label-caps flex min-h-11 items-center"
              >
                My account
              </Link>
              <ButtonLink href="/book" className="w-full" onClick={() => setMobileOpen(false)}>
                Book now
              </ButtonLink>
            </nav>
          </Container>
        </div>
      )}
    </header>
  )
}
