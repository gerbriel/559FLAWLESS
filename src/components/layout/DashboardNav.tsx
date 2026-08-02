'use client'

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

export function DashboardNav({
  role,
  unreadThreads,
}: {
  role: UserRole
  unreadThreads: number
}) {
  const pathname = usePathname()
  const items = ITEMS.filter((i) => i.visible(role))

  return (
    <nav
      aria-label="Dashboard"
      className="shrink-0 border-b border-[var(--color-border)] lg:w-56 lg:border-b-0 lg:border-r"
    >
      <ul className="flex gap-1 overflow-x-auto px-4 py-3 lg:sticky lg:top-16 lg:flex-col lg:px-3 lg:py-6">
        {items.map((item) => {
          // `/dashboard` would otherwise match every child route.
          const active =
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

          const count = item.badge === 'threads' ? unreadThreads : 0

          const Icon = item.icon

          return (
            <li key={item.href}>
              <Link
                href={item.href}
                className={cn(
                  'flex items-center gap-3 whitespace-nowrap px-3 py-2.5 text-sm transition-colors',
                  active
                    ? 'bg-[var(--color-linen)] text-[var(--color-foreground)] dark:bg-[var(--color-surface)]'
                    : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
                )}
              >
                <Icon className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                {item.label}
                {count > 0 && (
                  <span className="ml-auto flex h-4 min-w-4 items-center justify-center bg-[var(--color-accent)] px-1 text-[0.5625rem] text-white">
                    {count}
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
