'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  CalendarDays,
  Users,
  MessageSquare,
  FileBarChart,
  Package,
  Scissors,
  ScanLine,
  ShoppingBag,
  Megaphone,
  Settings,
  ClipboardList,
  Receipt,
  ClipboardCheck,
  FileSignature,
  Menu,
  X,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { isFrontDesk, isManager, isStaff, type UserRole } from '@/types/database'

interface NavItem {
  href: string
  label: string
  icon: typeof LayoutDashboard
  /** Lowest role that may see this item. */
  visible: (role: UserRole) => boolean
  badge?: 'threads'
}

const ITEMS: NavItem[] = [
  { href: '/dashboard', label: 'Today', icon: LayoutDashboard, visible: () => true },
  // One entry, three tabs: the diary, your own hours, and your timesheet. They
  // are one job — where your time goes — and were three sidebar rows saying so.
  { href: '/dashboard/calendar', label: 'Calendar', icon: CalendarDays, visible: () => true },
  // Bookings the approval rules held back. A provider sees their own; front
  // desk and up see the studio's — RLS on `appointments` already draws that
  // line, so the item itself is visible to everyone.
  {
    href: '/dashboard/appointments/pending',
    label: 'Waiting on you',
    icon: ClipboardCheck,
    visible: () => true,
  },
  {
    href: '/dashboard/clients',
    label: 'Clients',
    icon: Users,
    visible: (r) => isFrontDesk(r) || r === 'provider',
  },
  {
    href: '/dashboard/messages',
    label: 'Messages',
    icon: MessageSquare,
    visible: (r) => isFrontDesk(r),
    badge: 'threads',
  },
  {
    href: '/dashboard/waitlist',
    label: 'Waitlist',
    icon: ClipboardList,
    visible: (r) => isFrontDesk(r),
  },
  {
    href: '/dashboard/sell',
    label: 'Sell',
    icon: ScanLine,
    visible: (r) => isFrontDesk(r),
  },
  {
    href: '/dashboard/services',
    label: 'Services',
    icon: Scissors,
    visible: (r) => isFrontDesk(r),
  },
  {
    // Everyone sees it: the Outstanding tab is a provider's list of who is
    // arriving without paperwork. The template tabs behind it are manager-gated
    // by their own pages, and by RLS.
    href: '/dashboard/forms',
    label: 'Forms',
    icon: FileSignature,
    visible: () => true,
  },
  {
    href: '/dashboard/inventory',
    label: 'Inventory',
    icon: Package,
    visible: () => true,
  },
  {
    href: '/dashboard/orders',
    label: 'Orders',
    icon: ShoppingBag,
    visible: (r) => isFrontDesk(r),
  },
  {
    href: '/dashboard/reports',
    label: 'Reports',
    icon: FileBarChart,
    // Most reports here show what the business earned or what it pays people,
    // and those are manager-and-above. But the Appointments report is
    // deliberately minRole 'front_desk' — it carries no money at all and the
    // front desk runs the book. The page filters its own cards by each report's
    // minRole and redirects anyone left with none, so opening the door this far
    // shows the front desk exactly the one report that is theirs.
    visible: (r) => isFrontDesk(r),
  },
  {
    href: '/dashboard/expenses',
    label: 'Expenses',
    icon: Receipt,
    // What the studio pays in rent is a term of the business, not something the
    // front desk needs to run the day.
    visible: (r) => isManager(r),
  },
  {
    href: '/dashboard/marketing',
    label: 'Marketing',
    icon: Megaphone,
    visible: (r) => isManager(r),
  },
  {
    href: '/dashboard/settings',
    label: 'Settings',
    icon: Settings,
    // All staff, not just managers. Settings is now the only door to Locations
    // (its own sidebar row is gone) and to your own team profile, which is
    // deliberately isStaff so a provider can edit her bio and see her licence
    // expiry. Every row inside is gated individually, so a provider opening
    // this sees a short page rather than a wall of forms that reject her.
    visible: (r) => isStaff(r),
  },
]

/**
 * One row of the menu, rendered twice: in the lg+ sidebar and in the phone
 * panel. The sidebar's class strings are byte-for-byte what they always were —
 * `panel` only adds the padding and the 56px target a thumb needs.
 */
function NavRow({
  item,
  active,
  count,
  variant,
  onNavigate,
}: {
  item: NavItem
  active: boolean
  count: number
  variant: 'sidebar' | 'panel'
  onNavigate?: () => void
}) {
  const Icon = item.icon
  const panel = variant === 'panel'

  return (
    <Link
      href={item.href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex items-center gap-3 whitespace-nowrap px-3 py-2.5 text-sm transition-colors',
        panel && 'min-h-14 gap-4 px-6 py-4 text-base',
        active
          ? 'bg-[var(--color-linen)] text-[var(--color-foreground)] dark:bg-[var(--color-surface)]'
          : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
      )}
    >
      <Icon className={cn('h-4 w-4 shrink-0', panel && 'h-5 w-5')} strokeWidth={1.5} />
      {item.label}
      {count > 0 && (
        <span
          className={cn(
            'ml-auto flex h-4 min-w-4 items-center justify-center bg-[var(--color-accent)] px-1 text-[0.5625rem] text-white',
            panel && 'h-5 min-w-5 text-[0.6875rem]'
          )}
        >
          {count}
          {panel && <span className="sr-only"> unread messages</span>}
        </span>
      )}
    </Link>
  )
}

export function DashboardNav({
  role,
  unreadThreads,
}: {
  role: UserRole
  unreadThreads: number
}) {
  const pathname = usePathname()
  const items = ITEMS.filter((i) => i.visible(role))

  // The panel belongs to the route it was opened on, and `open` is derived from
  // that rather than stored. Closing on a row tap is not enough: on a phone the
  // back gesture is the primary way people move, and a soft navigation does not
  // unmount this component — so a stored boolean leaves a full-screen menu, and
  // its scroll lock, sitting on top of a page the user never opened it from.
  // Deriving it during render closes the panel on *every* navigation (back,
  // forward, redirect, row tap) without an effect that watches the pathname,
  // which is the thing the React Compiler forbids.
  const [openedAt, setOpenedAt] = useState<string | null>(null)
  const open = openedAt === pathname
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)
  const panelId = useId()

  // Unchanged, and load-bearing on both sides of the breakpoint now that
  // Calendar, Marketing, Forms and Settings all have children.
  const isActive = (item: NavItem) =>
    // `/dashboard` would otherwise match every child route.
    item.href === '/dashboard'
      ? pathname === '/dashboard'
      : pathname === item.href ||
        (pathname.startsWith(`${item.href}/`) &&
          // A parent must not light up when a more specific item owns
          // the current path.
          !items.some(
            (other) =>
              other !== item &&
              other.href.startsWith(`${item.href}/`) &&
              pathname.startsWith(other.href)
          ))

  // The sliding strip never told you where you were. The bar does — same
  // answer the active styling gives, so the two can never disagree.
  // Several real routes have no sidebar entry of their own — booking for a
  // client, an appointment detail page. Falling back to the section they live
  // under names them honestly; falling back to "Dashboard" told you nothing and
  // was wrong on the page the diary now sends you to most.
  const currentLabel =
    items.find((item) => isActive(item))?.label ??
    items.find((item) => item.href !== '/dashboard' && pathname.startsWith(`${item.href}/`))
      ?.label ??
    'Dashboard'

  // With the panel shut the Messages badge is out of sight, so the bar carries
  // the count. Only for roles whose menu actually has Messages in it.
  const barUnread = items.some((i) => i.badge === 'threads') ? unreadThreads : 0

  const close = () => setOpenedAt(null)

  // Everything the open panel owns — escape, the focus trap, the scroll lock,
  // handing focus back — in one effect, so the cleanup can never run half way.
  // A lock left behind here makes the entire app unscrollable.
  useEffect(() => {
    if (!open) return

    const trigger = triggerRef.current
    const body = document.body
    const previousOverflow = body.style.overflow
    const previousPaddingRight = body.style.paddingRight
    // Below lg is not only phones — it is any browser window under 1024px, and
    // on a classic (non-overlay) scrollbar, hiding the overflow reclaims its
    // width and shunts the whole app, sticky header included, sideways. Pad by
    // exactly what was taken so nothing moves. Phones have overlay scrollbars,
    // so this measures 0 and does nothing there.
    const scrollbar = window.innerWidth - document.documentElement.clientWidth
    body.style.overflow = 'hidden'
    if (scrollbar > 0) body.style.paddingRight = `${scrollbar}px`

    closeRef.current?.focus()

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setOpenedAt(null)
        return
      }
      if (e.key !== 'Tab') return

      const panel = panelRef.current
      if (!panel) return
      const focusable = panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')
      if (focusable.length === 0) return

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const inside = panel.contains(document.activeElement)

      if (e.shiftKey) {
        if (!inside || document.activeElement === first) {
          e.preventDefault()
          last.focus()
        }
      } else if (!inside || document.activeElement === last) {
        e.preventDefault()
        first.focus()
      }
    }

    // Growing past the breakpoint hands the sidebar back and hides the trigger
    // with it. Closing here is what guarantees the scroll lock goes too —
    // otherwise a rotate-to-landscape leaves the page frozen with no way out.
    const wide = window.matchMedia('(min-width: 64rem)')
    const onWide = (e: MediaQueryListEvent) => {
      if (e.matches) setOpenedAt(null)
    }

    document.addEventListener('keydown', onKeyDown)
    wide.addEventListener('change', onWide)

    return () => {
      document.removeEventListener('keydown', onKeyDown)
      wide.removeEventListener('change', onWide)
      body.style.overflow = previousOverflow
      body.style.paddingRight = previousPaddingRight
      // Crossing to lg hides the trigger, and focus() on a display:none element
      // is a no-op — the sidebar is back, so there is somewhere sensible to Tab
      // to either way.
      trigger?.focus()
    }
  }, [open])

  return (
    <>
      {/* Below lg: a slim bar that names the page you are on and opens the
          menu. Sticky under the h-16 header, so the menu stays one tap away
          however far down a client list you have scrolled. */}
      <div className="sticky top-16 z-20 border-b border-[var(--color-border)] bg-[var(--color-background)] lg:hidden">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpenedAt(pathname)}
          aria-expanded={open}
          // Only while the panel exists: aria-controls pointing at an id that is
          // not in the document is an invalid reference, not an empty one.
          aria-controls={open ? panelId : undefined}
          className="flex min-h-11 w-full items-center gap-3 px-4 py-3 text-left"
        >
          <Menu className="h-5 w-5 shrink-0" strokeWidth={1.5} />
          <span className="text-sm text-[var(--color-foreground)]">{currentLabel}</span>
          <span className="label-caps ml-auto text-[var(--color-muted)]">Menu</span>
          {barUnread > 0 && (
            <span className="flex h-4 min-w-4 items-center justify-center bg-[var(--color-accent)] px-1 text-[0.5625rem] text-white">
              {barUnread}
              <span className="sr-only"> unread messages</span>
            </span>
          )}
        </button>
      </div>

      {open && (
        // Above the sticky header, which is z-30.
        <div className="fixed inset-0 z-50 lg:hidden">
          {/* Full screen on a phone. From sm up — tablets, landscape — it is a
              sheet, which is what makes the backdrop something you can
              actually tap. */}
          <button
            type="button"
            onClick={close}
            aria-label="Close menu"
            tabIndex={-1}
            className="absolute inset-0 cursor-default bg-black/50"
          />

          <div
            ref={panelRef}
            id={panelId}
            role="dialog"
            aria-modal="true"
            aria-label="Dashboard menu"
            className="absolute inset-0 flex flex-col bg-[var(--color-background)] sm:right-auto sm:w-[22rem] sm:border-r sm:border-[var(--color-border)]"
          >
            <div className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-[var(--color-border)] px-4">
              <span className="label-caps text-[var(--color-muted)]">Studio menu</span>
              <button
                ref={closeRef}
                type="button"
                onClick={close}
                aria-label="Close menu"
                className="-mr-2 flex h-11 w-11 items-center justify-center text-[var(--color-foreground)]"
              >
                <X className="h-5 w-5" strokeWidth={1.5} />
              </button>
            </div>

            <nav
              aria-label="Dashboard"
              className="flex-1 overflow-y-auto overscroll-contain"
            >
              {/* Fifteen rows outrun a phone screen, so the list scrolls
                  inside the panel and pads past the home indicator. */}
              <ul className="py-2 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
                {items.map((item) => (
                  <li key={item.href}>
                    <NavRow
                      item={item}
                      active={isActive(item)}
                      count={item.badge === 'threads' ? unreadThreads : 0}
                      variant="panel"
                      // Closing here, not in an effect that watches the
                      // pathname: the React Compiler forbids that, and this is
                      // the moment the intent actually happens.
                      onNavigate={close}
                    />
                  </li>
                ))}
              </ul>
            </nav>
          </div>
        </div>
      )}

      {/* lg+ is untouched: same widths, borders, sticky offset and active
          styling as before, down to the class strings. */}
      <nav
        aria-label="Dashboard"
        className="hidden shrink-0 border-b border-[var(--color-border)] lg:block lg:w-56 lg:border-b-0 lg:border-r"
      >
        <ul className="flex gap-1 overflow-x-auto px-4 py-3 lg:sticky lg:top-16 lg:flex-col lg:px-3 lg:py-6">
          {items.map((item) => (
            <li key={item.href}>
              <NavRow
                item={item}
                active={isActive(item)}
                count={item.badge === 'threads' ? unreadThreads : 0}
                variant="sidebar"
              />
            </li>
          ))}
        </ul>
      </nav>
    </>
  )
}
