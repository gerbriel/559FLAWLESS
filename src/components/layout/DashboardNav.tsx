'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  LayoutDashboard,
  CalendarDays,
  Users,
  MessageSquare,
  BarChart3,
  FileBarChart,
  Package,
  Scissors,
  ScanLine,
  ShoppingBag,
  Megaphone,
  Settings,
  Clock,
  ClipboardList,
  Inbox,
  Timer,
  MapPin,
  Receipt,
  ClipboardCheck,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { isFrontDesk, isManager, isAdmin, type UserRole } from '@/types/database'

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
  { href: '/dashboard/schedule', label: 'My hours', icon: Clock, visible: () => true },
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
    href: '/dashboard/timesheets',
    label: 'Timesheets',
    icon: Timer,
    // Everyone sees their own; managers see everyone's.
    visible: () => true,
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
    href: '/dashboard/analytics',
    label: 'Analytics',
    icon: BarChart3,
    visible: (r) => isManager(r),
  },
  {
    href: '/dashboard/reports',
    label: 'Reports',
    icon: FileBarChart,
    // Sales, tax, commissions and profit. Every report here either shows what
    // the business earned or what it pays people, which is a manager's business
    // and not the front desk's.
    visible: (r) => isManager(r),
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
    // Managers need booking policy, hours and tax. The genuinely admin-only
    // sections inside the page hide themselves.
    visible: (r) => isManager(r),
  },
  {
    href: '/dashboard/settings/locations',
    label: 'Locations',
    icon: MapPin,
    // The first open location is what every appointment, sale and stock count
    // defaults to, and its timezone is what every opening hour is read in.
    // That is pricing-grade authority, so it sits with the admin.
    visible: (r) => isAdmin(r),
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
