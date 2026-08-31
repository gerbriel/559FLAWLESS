'use client'

import { useEffect, useId, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  FolderTree,
  Layers,
  BarChart3,
  CalendarDays,
  ChevronDown,
  Circle,
  ClipboardCheck,
  ClipboardList,
  FileBarChart,
  FileSignature,
  LayoutDashboard,
  LayoutGrid,
  Megaphone,
  Menu,
  MessageSquare,
  Package,
  PanelLeftClose,
  PanelLeftOpen,
  Receipt,
  ScanLine,
  Scissors,
  Settings,
  ShoppingBag,
  SlidersHorizontal,
  Users,
  Wallet,
  X,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Avatar } from '@/components/ui/dashboard'
import {
  isAdmin,
  isFrontDesk,
  isManager,
  isStaff,
  ROLE_LABELS,
  type UserRole,
} from '@/types/database'

/**
 * Where "I keep the menu narrow" is stored.
 *
 * A cookie rather than localStorage, and the reason is the first paint. The
 * layout is already `force-dynamic`, so it reads this on the server and renders
 * the sidebar at the width the user chose — there is no moment where the wrong
 * one is on screen. localStorage cannot do that: read it during render and the
 * server and the client disagree, read it in an effect and you are calling
 * setState from an effect, which the React Compiler lint in this repo rejects,
 * and either way the menu visibly jumps on every page load.
 *
 * The name is repeated in `src/app/dashboard/layout.tsx`, which is what writes
 * it into a prop. A shared constant would have to live in a third module, and
 * a `'use client'` module's exports are client references on the server — a
 * server component importing this string would not get a string.
 */
const NAV_COOKIE = 'dash_nav'
const NAV_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

interface NavItem {
  href: string
  label: string
  /** Top-level rows wear an icon; rows inside a group are indented instead. */
  icon?: LucideIcon
  /** Lowest role that may see this item. */
  visible: (role: UserRole) => boolean
  badge?: 'threads'
}

interface NavGroup {
  id: string
  label: string
  icon: LucideIcon
  /**
   * Set only when the group is also somewhere to go. Calendar, Clients, Forms,
   * Marketing and Settings each have a real page of their own, so their row
   * navigates and the chevron beside it opens the section. Sales, Catalog
   * and Insights are containers with no page behind them, and a row that looks
   * like a link but only expands is a small lie told forty times a day.
   */
  href?: string
  /** The gate on the section itself. Children carry their own on top of it. */
  visible?: (role: UserRole) => boolean
  children: NavItem[]
}

type NavEntry = NavItem | NavGroup

const isGroup = (entry: NavEntry): entry is NavGroup => 'children' in entry

/**
 * The studio's work, grouped the way it is actually done.
 *
 * Fifteen flat rows made every screen equally important and buried the pages
 * that have no row at all — the ones you could only find by landing on their
 * parent and reading a tab bar. The children below are, deliberately, those
 * tab bars: the section tabs keep working exactly as they did, and the sidebar
 * now gives the same answer without having to be on the page already.
 *
 * Two shapes, and which one a thing gets is decided by the routes, not by
 * taste. Keeping them apart is what stops the sidebar and the section tabs
 * ever telling two different stories:
 *
 * - A **section** has a page. Calendar, Clients, Forms, Marketing: its children
 *   are exactly that section's `SectionTabs`, item for item and gate for gate.
 *   Nothing may be filed under one of these that its tab bar does not also
 *   list, or the menu claims a membership the page it lands on will deny.
 *   (Settings is the same shape against the directory its index renders — that
 *   section has no tab bar, and its index is the list.)
 * - A **category** has no page: Sales, Catalog, Insights. These collect
 *   top-level routes that were never inside anything — /dashboard/sell,
 *   /dashboard/orders, /dashboard/expenses are siblings with no parent screen
 *   and no chrome of their own, so a category can group them without
 *   contradicting anything.
 *
 * Each row keeps the gate it always had, and each child records the gate its
 * own page enforces — hiding a row is not a security control, the page-level
 * checks and RLS are, but a menu that offers a door it will not open is worse
 * than no menu.
 */
const TREE: NavEntry[] = [
  { href: '/dashboard', label: 'Today', icon: LayoutDashboard, visible: () => true },
  {
    id: 'calendar',
    label: 'Calendar',
    icon: CalendarDays,
    href: '/dashboard/calendar',
    // The diary, your own hours and the clock you punch are one job — where
    // your time goes. They were three sidebar rows, then one row and three
    // tabs; now the tabs are also here, which is where you look for them.
    children: [
      { href: '/dashboard/calendar/hours', label: 'My hours', visible: () => true },
      { href: '/dashboard/calendar/timesheets', label: 'Timesheets', visible: () => true },
    ],
  },
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
    id: 'clients',
    label: 'Clients',
    icon: Users,
    href: '/dashboard/clients',
    visible: (r) => isFrontDesk(r) || r === 'provider',
    // Someone can subscribe long before they ever book, which is why the list
    // lives under Clients rather than under Marketing. This is also the whole
    // of the Clients tab bar — see the rule above the group.
    children: [
      {
        href: '/dashboard/clients/newsletter',
        label: 'Newsletter',
        visible: (r) => isFrontDesk(r),
      },
    ],
  },
  // Messages and Waitlist stay rows of their own rather than joining Clients.
  //
  // Messages is the one item carrying a number, and a number inside a closed
  // group is a number nobody sees — the entire job of that badge is to be
  // visible from wherever you are standing.
  //
  // Waitlist is a route beside Clients, not inside it: /dashboard/waitlist has
  // its own layout and no section chrome, so filing it under Clients would put
  // a fourth thing in a section whose own tab bar shows two, and land you on a
  // page with nothing on it agreeing that you are in Clients. Sales and Catalog
  // can collect siblings like that because they are categories with no page of
  // their own; Clients has one, and it has tabs.
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
    id: 'forms',
    label: 'Forms',
    icon: FileSignature,
    // Everyone sees the parent: the Outstanding list is a provider's list of
    // who is arriving without paperwork. The two template pages end in an
    // `is_manager` gate and redirect out, so they are gated here too — for a
    // provider Forms *is* the outstanding list and the row is simply a row.
    href: '/dashboard/forms',
    visible: () => true,
    children: [
      {
        href: '/dashboard/forms/consent',
        label: 'Consent forms',
        visible: (r) => isManager(r),
      },
      { href: '/dashboard/forms/intake', label: 'Intake forms', visible: (r) => isManager(r) },
    ],
  },
  {
    // Taking money, what has been taken, and what went out again — one
    // section, in the order the day runs. The till was a row of its own here,
    // which put "ring this up" and "what did we ring up" three rows apart; it
    // keeps its position in the column, now as the first thing in the group.
    id: 'sales',
    label: 'Sales',
    icon: Wallet,
    children: [
      {
        href: '/dashboard/sell',
        label: 'Sell',
        icon: ScanLine,
        visible: (r) => isFrontDesk(r),
      },
      {
        href: '/dashboard/orders',
        label: 'Orders',
        icon: ShoppingBag,
        visible: (r) => isFrontDesk(r),
      },
      {
        href: '/dashboard/expenses',
        label: 'Expenses',
        icon: Receipt,
        // What the studio pays in rent is a term of the business, not
        // something the front desk needs to run the day.
        visible: (r) => isManager(r),
      },
    ],
  },
  {
    // What the studio sells: time, and things. A provider sees neither the
    // service editor nor a group wrapped around one row — see `resolve`.
    id: 'catalog',
    label: 'Catalog',
    icon: LayoutGrid,
    children: [
      {
        href: '/dashboard/services',
        label: 'Services',
        icon: Scissors,
        visible: (r) => isFrontDesk(r),
      },
      {
          href: '/dashboard/packages',
          label: 'Packages',
          icon: Layers,
          // isFrontDesk, not isStaff: client_packages is front-desk-and-above
          // for select, so a provider following this would get a heading over
          // an empty list.
          visible: (r) => isFrontDesk(r),
        },
        { href: '/dashboard/inventory', label: 'Inventory', icon: Package, visible: () => true },
        {
          href: '/dashboard/categories',
          label: 'Categories',
          icon: FolderTree,
          // The same threshold the tables use: 022 for service categories and
          // 052 for product ones both write against is_manager(). Other staff
          // can read the lists from the pages they are filed under.
          visible: (r) => isManager(r),
        },
    ],
  },
  {
    id: 'insights',
    label: 'Insights',
    icon: BarChart3,
    children: [
      {
        href: '/dashboard/reports',
        label: 'Reports',
        icon: FileBarChart,
        // Most reports show what the business earned or what it pays people,
        // and those are manager-and-above. But the Appointments report is
        // deliberately minRole 'front_desk' — it carries no money at all and
        // the front desk runs the book. The page filters its own cards by each
        // report's minRole and redirects anyone left with none, so opening the
        // door this far shows the front desk exactly the one report that is
        // theirs.
        visible: (r) => isFrontDesk(r),
      },
      {
        href: '/dashboard/reports/custom',
        label: 'Custom report',
        icon: SlidersHorizontal,
        visible: (r) => isManager(r),
      },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    icon: Megaphone,
    href: '/dashboard/marketing',
    visible: (r) => isManager(r),
    // Site traffic and the booking funnel are marketing's own scoreboard, so
    // Analytics stays under this section rather than under Insights, which is
    // financial reporting. The section's tab bar says the same.
    children: [
      {
        href: '/dashboard/marketing/analytics',
        label: 'Analytics',
        visible: (r) => isManager(r),
      },
      {
        href: '/dashboard/marketing/broadcast',
        label: 'Send newsletter',
        visible: (r) => isManager(r),
      },
      {
        href: '/dashboard/marketing/promotions',
        label: 'Promotions',
        // Admin like Tracking below: a promotion is a pricing decision, and
        // the table's only write policy is admin (068).
        visible: (r) => isAdmin(r),
      },
      {
        href: '/dashboard/marketing/tracking',
        label: 'Tracking',
        // Admin, not manager, unlike the rest of this section: the fields put
        // script tags on every public page, and site_content only has an admin
        // write policy behind them.
        visible: (r) => isAdmin(r),
      },
    ],
  },
]

/**
 * Below the divider, the way the reference puts it.
 *
 * Settings pages have no tab bar of their own: moving from Scheduling to
 * Locations meant going back to the index every time. The children here are
 * the index's own list, in its own order, each carrying the gate its page
 * enforces — the index keeps its descriptions and stays where the parent row
 * goes, because a sentence about what a page decides does not fit in a sidebar.
 *
 * Commission is the one imperfect gate: its page admits an admin *or* anyone
 * holding the `manage_staff` permission, and a permission is a database read
 * this component has no business doing. It is listed for admins here and for
 * everyone the RPC allows on the index, so nobody who may open it is left
 * without a route to it.
 */
const BOTTOM: NavEntry[] = [
  {
    id: 'settings',
    label: 'Settings',
    icon: Settings,
    href: '/dashboard/settings',
    // All staff, not just managers. Settings is the only door to Locations and
    // to your own team profile, which is deliberately isStaff so a provider can
    // edit her bio and see her licence expiry.
    visible: (r) => isStaff(r),
    children: [
      { href: '/dashboard/settings/scheduling', label: 'Scheduling', visible: (r) => isManager(r) },
      {
        href: '/dashboard/settings/resources',
        label: 'Rooms & equipment',
        visible: (r) => isManager(r),
      },
      { href: '/dashboard/settings/waitlist', label: 'Waitlist rules', visible: (r) => isAdmin(r) },
      {
        href: '/dashboard/settings/notifications',
        label: 'Client notifications',
        visible: (r) => isManager(r),
      },
      { href: '/dashboard/settings/team', label: 'Team', visible: (r) => isStaff(r) },
      { href: '/dashboard/settings/users', label: 'Users', visible: (r) => isAdmin(r) },
      { href: '/dashboard/settings/permissions', label: 'Permissions', visible: (r) => isAdmin(r) },
      { href: '/dashboard/settings/commissions', label: 'Commission', visible: (r) => isAdmin(r) },
      { href: '/dashboard/settings/locations', label: 'Locations', visible: (r) => isAdmin(r) },
      {
          href: '/dashboard/settings/data',
          label: 'Import & export',
          visible: (r) => isManager(r),
        },
        { href: '/dashboard/settings/legal', label: 'Legal', visible: (r) => isAdmin(r) },
      { href: '/dashboard/settings/admin', label: 'Announcements', visible: (r) => isAdmin(r) },
    ],
  },
]

type Resolved =
  | { kind: 'item'; item: NavItem }
  | { kind: 'group'; group: NavGroup; children: NavItem[] }

/**
 * The menu one role actually gets.
 *
 * Three collapses matter, and they are what stops the grouping from producing
 * rows that lead nowhere:
 *
 * - a group whose own gate fails disappears whole;
 * - a group with a page behind it and nothing left inside is a plain row;
 * - a container with exactly one child left *becomes* that child, rather than
 *   asking someone to open a drawer to find a single thing in it.
 */
function resolve(entries: NavEntry[], role: UserRole): Resolved[] {
  const out: Resolved[] = []

  for (const entry of entries) {
    if (!isGroup(entry)) {
      if (entry.visible(role)) out.push({ kind: 'item', item: entry })
      continue
    }

    if (entry.visible && !entry.visible(role)) continue
    const children = entry.children.filter((child) => child.visible(role))

    if (entry.href) {
      out.push(
        children.length === 0
          ? {
              kind: 'item',
              item: {
                href: entry.href,
                label: entry.label,
                icon: entry.icon,
                visible: () => true,
              },
            }
          : { kind: 'group', group: entry, children }
      )
      continue
    }

    if (children.length === 0) continue
    if (children.length === 1) out.push({ kind: 'item', item: children[0] })
    else out.push({ kind: 'group', group: entry, children })
  }

  return out
}

/** Who is signed in, and where. The reference puts this above everything. */
function StudioIdentity({
  name,
  role,
  className,
}: {
  name: string
  role: UserRole
  className?: string
}) {
  return (
    <div
      data-ui="panel"
      className={cn(
        'flex min-w-0 items-center gap-3 bg-[var(--color-clay-soft)] px-3 py-3 dark:bg-[var(--color-surface)]',
        className
      )}
    >
      <Avatar name={name} size="sm" />
      <div className="min-w-0">
        <p className="display truncate text-base leading-tight">559 Flawless</p>
        <p className="truncate text-xs text-[var(--color-muted)]">
          {name} · {ROLE_LABELS[role]}
        </p>
      </div>
    </div>
  )
}

/**
 * One row of the menu, rendered in the lg+ sidebar and in the phone panel.
 * `panel` adds the padding and the target a thumb needs; `depth` is what tells
 * a row inside an open group apart from one at the top of the list — indented,
 * no icon, and a quieter fill when it is the page you are on.
 */
function NavRow({
  href,
  label,
  icon: Icon,
  active,
  depth,
  count,
  variant,
  onNavigate,
}: {
  href: string
  label: string
  icon?: LucideIcon
  active: boolean
  depth: 0 | 1
  count: number
  variant: 'sidebar' | 'panel'
  onNavigate?: () => void
}) {
  const panel = variant === 'panel'

  return (
    <Link
      href={href}
      onClick={onNavigate}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'flex min-h-11 items-center gap-3 whitespace-nowrap rounded-[var(--radius-tile)] pr-3 text-sm transition-colors',
        panel && 'min-h-14 gap-4 pr-4 text-base',
        // Spelled out rather than an indent added on top of `px-3`: which of
        // two padding utilities wins is a question about stylesheet order, and
        // this row is not the place to be asking it.
        depth === 0 ? (panel ? 'pl-4' : 'pl-3') : panel ? 'pl-14' : 'pl-10',
        active
          ? depth === 0
            ? 'bg-[var(--color-clay-soft)] text-[var(--color-clay-deep)] dark:bg-[var(--color-surface)] dark:text-[var(--color-accent)]'
            : 'bg-[var(--color-linen)] text-[var(--color-foreground)] dark:bg-[var(--color-surface)]'
          : 'text-[var(--color-muted)] hover:bg-[var(--color-linen)] hover:text-[var(--color-foreground)] dark:hover:bg-[var(--color-surface)]'
      )}
    >
      {Icon && <Icon className={cn('h-4 w-4 shrink-0', panel && 'h-5 w-5')} strokeWidth={1.5} />}
      {label}
      {count > 0 && (
        <span
          className={cn(
            'ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[0.5625rem] text-white',
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

/**
 * A group and its children. Open is decided by the caller, never stored here —
 * see the derivation in `DashboardNav`.
 *
 * The chevron is its own button whenever the parent is also a destination, so
 * "go to Calendar" and "show me what is under Calendar" stay two intentions
 * with two targets. A container group has nothing to go to, so the whole row
 * is the toggle.
 */
function NavGroupRow({
  group,
  items,
  open,
  active,
  activeHref,
  listId,
  variant,
  onToggle,
  onNavigate,
}: {
  group: NavGroup
  items: NavItem[]
  open: boolean
  active: boolean
  activeHref: string | null
  listId: string
  variant: 'sidebar' | 'panel'
  onToggle: () => void
  onNavigate?: () => void
}) {
  const Icon = group.icon
  const panel = variant === 'panel'

  const tint = 'bg-[var(--color-clay-soft)] text-[var(--color-clay-deep)] dark:bg-[var(--color-surface)] dark:text-[var(--color-accent)]'
  const quiet =
    'text-[var(--color-muted)] hover:text-[var(--color-foreground)] transition-colors'

  // The border is always there and usually transparent: an outline that
  // appears on expand would otherwise nudge every row below it by two pixels.
  const shell = cn(
    'flex items-center rounded-[var(--radius-tile)] border',
    open && !active ? 'border-[var(--color-border)]' : 'border-transparent',
    active && tint
  )

  const chevron = (
    <ChevronDown
      className={cn('h-4 w-4 shrink-0 transition-transform', open && 'rotate-180')}
      strokeWidth={1.5}
      aria-hidden
    />
  )

  // The chevron beside a destination row is an icon on its own, so it says out
  // loud which section it opens — "Calendar" alone would be a second row with
  // the same name as the link next to it.
  const toggleLabel = <span className="sr-only">{group.label} pages</span>

  return (
    <>
      {group.href ? (
        <div className={shell}>
          <Link
            href={group.href}
            onClick={onNavigate}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'flex min-h-11 flex-1 items-center gap-3 whitespace-nowrap rounded-[var(--radius-tile)] px-3 text-sm',
              panel && 'min-h-14 gap-4 px-4 text-base',
              !active && quiet
            )}
          >
            <Icon
              className={cn('h-4 w-4 shrink-0', panel && 'h-5 w-5')}
              strokeWidth={1.5}
            />
            {group.label}
          </Link>
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            className={cn(
              'flex h-11 w-11 shrink-0 items-center justify-center rounded-[var(--radius-tile)]',
              panel && 'h-14 w-14',
              !active && quiet
            )}
          >
            {chevron}
            {toggleLabel}
          </button>
        </div>
      ) : (
        <button
          type="button"
          // Named so the rail can hand focus here after widening the sidebar —
          // see `openSection`. The narrow row the click landed on is gone by
          // then, and focus falling to <body> would restart Tab at the top of
          // the document.
          id={`${listId}-toggle`}
          onClick={onToggle}
          aria-expanded={open}
          aria-controls={open ? listId : undefined}
          className={cn(
            shell,
            'w-full min-h-11 gap-3 px-3 text-left text-sm',
            panel && 'min-h-14 gap-4 px-4 text-base',
            quiet,
            'hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]'
          )}
        >
          <Icon className={cn('h-4 w-4 shrink-0', panel && 'h-5 w-5')} strokeWidth={1.5} />
          {/* No sr-only twin here: the whole row is the toggle, so its own
              label already names what aria-expanded is describing. */}
          <span className="truncate">{group.label}</span>
          <span className="ml-auto flex items-center">{chevron}</span>
        </button>
      )}

      {open && (
        <ul id={listId} className={cn('mt-0.5 space-y-0.5', panel && 'mt-1 space-y-1')}>
          {items.map((child) => (
            <li key={child.href}>
              <NavRow
                href={child.href}
                label={child.label}
                active={child.href === activeHref}
                depth={1}
                count={0}
                variant={variant}
                onNavigate={onNavigate}
              />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

/** One block of the menu — the long one above the divider, or Settings below. */
function NavList({
  entries,
  activeHref,
  openGroups,
  idPrefix,
  variant,
  unreadThreads,
  onToggle,
  onNavigate,
  className,
}: {
  entries: Resolved[]
  activeHref: string | null
  openGroups: Set<string>
  idPrefix: string
  variant: 'sidebar' | 'panel'
  unreadThreads: number
  onToggle: (id: string) => void
  onNavigate?: () => void
  className?: string
}) {
  const panel = variant === 'panel'

  return (
    <ul className={cn('space-y-0.5', panel && 'space-y-1', className)}>
      {entries.map((entry) =>
        entry.kind === 'item' ? (
          <li key={entry.item.href}>
            <NavRow
              href={entry.item.href}
              label={entry.item.label}
              icon={entry.item.icon}
              active={entry.item.href === activeHref}
              depth={0}
              count={entry.item.badge === 'threads' ? unreadThreads : 0}
              variant={variant}
              onNavigate={onNavigate}
            />
          </li>
        ) : (
          <li key={entry.group.id}>
            <NavGroupRow
              group={entry.group}
              items={entry.children}
              open={openGroups.has(entry.group.id)}
              active={entry.group.href === activeHref}
              activeHref={activeHref}
              listId={`${idPrefix}-${entry.group.id}`}
              variant={variant}
              onToggle={() => onToggle(entry.group.id)}
              onNavigate={onNavigate}
            />
          </li>
        )
      )}
    </ul>
  )
}

/** One 44px target in the narrow rail. Shared by the links and the buttons. */
const railRow = (active: boolean) =>
  cn(
    'relative flex h-11 w-11 items-center justify-center rounded-[var(--radius-tile)] transition-colors',
    active
      ? 'bg-[var(--color-clay-soft)] text-[var(--color-clay-deep)] dark:bg-[var(--color-surface)] dark:text-[var(--color-accent)]'
      : 'text-[var(--color-muted)] hover:bg-[var(--color-linen)] hover:text-[var(--color-foreground)] dark:hover:bg-[var(--color-surface)]'
  )

const RAIL_BADGE =
  'absolute right-0.5 top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--color-accent)] px-1 text-[0.5625rem] text-white'

/**
 * The menu with the sidebar collapsed: one icon per top-level row, in exactly
 * the order the full menu lists them, nothing else.
 *
 * Every row names itself twice — `title` for the pointer, an accessible name
 * for everything else. An icon with no name is not a shortcut, it is a riddle.
 *
 * Sections behave differently depending on whether they are somewhere to go.
 * Calendar, Clients, Forms, Marketing and Settings each have a page, so their
 * icon is a link straight to it and the section's own tab bar takes it from
 * there — one tap, same as before it was a group. Sales, Catalog and Insights
 * are containers with no page behind them, so their icon widens the sidebar
 * and opens the section instead of navigating somewhere that does not exist.
 * That is a plain <button>, so it works from the keyboard for free, and it is
 * why there is no hover flyout here: a popover anchored to a row inside a
 * scrolling sticky column is clipped by that column, and un-clipping it means
 * measuring the row in an effect and storing the result in state — the exact
 * shape this codebase's lint rejects.
 */
function NavRail({
  entries,
  activeHref,
  unreadThreads,
  onOpenSection,
  className,
}: {
  entries: Resolved[]
  activeHref: string | null
  unreadThreads: number
  onOpenSection: (id: string) => void
  className?: string
}) {
  return (
    <ul className={cn('space-y-0.5', className)}>
      {entries.map((entry) => {
        if (entry.kind === 'item') {
          // Only reachable for a row promoted out of a container group, and
          // every promotable child carries an icon. Present so a future one
          // that forgets gets a dot rather than a hole in the rail.
          const Icon = entry.item.icon ?? Circle
          const count = entry.item.badge === 'threads' ? unreadThreads : 0
          const active = entry.item.href === activeHref

          return (
            <li key={entry.item.href}>
              <Link
                href={entry.item.href}
                title={entry.item.label}
                aria-label={
                  count > 0 ? `${entry.item.label}, ${count} unread messages` : entry.item.label
                }
                aria-current={active ? 'page' : undefined}
                className={railRow(active)}
              >
                <Icon className="h-5 w-5" strokeWidth={1.5} aria-hidden />
                {count > 0 && (
                  <span aria-hidden className={RAIL_BADGE}>
                    {count}
                  </span>
                )}
              </Link>
            </li>
          )
        }

        const { group, children } = entry
        const Icon = group.icon
        // The rail has no room for the child that owns the page, so the
        // section itself carries the highlight — anywhere inside it counts.
        const active = group.href === activeHref || children.some((c) => c.href === activeHref)

        return (
          <li key={group.id}>
            {group.href ? (
              <Link
                href={group.href}
                title={group.label}
                aria-label={group.label}
                aria-current={group.href === activeHref ? 'page' : undefined}
                className={railRow(active)}
              >
                <Icon className="h-5 w-5" strokeWidth={1.5} aria-hidden />
              </Link>
            ) : (
              <button
                type="button"
                onClick={() => onOpenSection(group.id)}
                title={`${group.label} — open section`}
                className={railRow(active)}
              >
                <Icon className="h-5 w-5" strokeWidth={1.5} aria-hidden />
                <span className="sr-only">{group.label} — open section</span>
              </button>
            )}
          </li>
        )
      })}
    </ul>
  )
}

export function DashboardNav({
  role,
  unreadThreads,
  userName,
  initialCollapsed,
}: {
  role: UserRole
  unreadThreads: number
  userName: string
  /**
   * The stored width preference, read from the cookie on the server. The first
   * client render uses the same value, so there is nothing to reconcile and
   * nothing to flash.
   */
  initialCollapsed: boolean
}) {
  const pathname = usePathname()
  const top = resolve(TREE, role)
  const bottom = resolve(BOTTOM, role)

  // Every destination the menu offers this role, parents and children in one
  // list. `isActive` has always needed to see all of them at once — a parent
  // must not light up when something more specific owns the path — and now the
  // more specific thing is usually a row sitting underneath it.
  const flat: { href: string; label: string; badge?: 'threads' }[] = []
  for (const entry of [...top, ...bottom]) {
    if (entry.kind === 'item') {
      flat.push({ href: entry.item.href, label: entry.item.label, badge: entry.item.badge })
      continue
    }
    if (entry.group.href) flat.push({ href: entry.group.href, label: entry.group.label })
    for (const child of entry.children) flat.push({ href: child.href, label: child.label })
  }

  const active =
    flat.find((entry) =>
      // `/dashboard` would otherwise match every child route.
      entry.href === '/dashboard'
        ? pathname === '/dashboard'
        : pathname === entry.href ||
          (pathname.startsWith(`${entry.href}/`) &&
            !flat.some(
              (other) =>
                other.href !== entry.href &&
                other.href.startsWith(`${entry.href}/`) &&
                pathname.startsWith(other.href)
            ))
    ) ?? null
  const activeHref = active?.href ?? null

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
  const listId = useId()

  // Which groups are open is the same problem as the panel, and gets the same
  // answer. The default is not stored at all — the group holding the current
  // route is open, derived during render, so arriving anywhere by any means
  // (a link on the page, the back gesture, a redirect out of a closed door)
  // shows you where you landed. A tap on a chevron is an exception to that
  // default and is stamped with the pathname it happened on, so it lasts as
  // long as you stay on the page and no longer. An effect watching the
  // pathname would do the same job and is exactly what the compiler forbids.
  const [toggled, setToggled] = useState<{ at: string; groups: Record<string, boolean> } | null>(
    null
  )
  const overrides = toggled?.at === pathname ? toggled.groups : {}

  const onPath = (href: string) => pathname === href || pathname.startsWith(`${href}/`)

  const openGroups = new Set<string>()
  for (const entry of [...top, ...bottom]) {
    if (entry.kind !== 'group') continue
    const holdsRoute =
      (entry.group.href !== undefined && onPath(entry.group.href)) ||
      entry.children.some((child) => onPath(child.href))
    if (overrides[entry.group.id] ?? holdsRoute) openGroups.add(entry.group.id)
  }

  const toggleGroup = (id: string) => {
    setToggled({ at: pathname, groups: { ...overrides, [id]: !openGroups.has(id) } })
  }

  // Same shape as the two above: the server's answer is the default, a click
  // in this tab overrides it, and nothing is read from storage during render or
  // synced back in an effect.
  const [collapsedOverride, setCollapsedOverride] = useState<boolean | null>(null)
  const collapsed = collapsedOverride ?? initialCollapsed

  const setCollapsed = (next: boolean, remember: boolean) => {
    setCollapsedOverride(next)
    if (!remember) return
    // Written straight from the browser rather than through a server action:
    // this is a width, not a mutation, and a round trip would put a spinner in
    // front of a chevron. The next request carries it, so the next full page
    // load renders the right width first time.
    const secure = window.location.protocol === 'https:' ? '; secure' : ''
    document.cookie = `${NAV_COOKIE}=${next ? 'rail' : 'full'}; path=/; max-age=${NAV_COOKIE_MAX_AGE}; samesite=lax${secure}`
  }

  // Tapping Sales, Catalog or Insights in the rail. Widening is not the stored
  // preference — it is one look inside a drawer, so the cookie is left alone
  // and the narrow menu is back on the next reload.
  //
  // The row that was clicked stops existing at that moment, so where focus goes
  // has to be said out loud. A fresh object every time, deliberately: pressing
  // the same section twice must move focus twice, and identity is what makes
  // the effect below run again when the id has not changed.
  const [handOff, setHandOff] = useState<{ group: string } | null>(null)

  const openSection = (id: string) => {
    setCollapsed(false, false)
    setToggled({ at: pathname, groups: { ...overrides, [id]: true } })
    setHandOff({ group: id })
  }

  // Focus only — nothing is set here, which is what keeps this an effect the
  // compiler is happy with. The id is the one `NavGroupRow` puts on the row
  // that has just replaced the rail button.
  useEffect(() => {
    if (!handOff) return
    document.getElementById(`${listId}-side-${handOff.group}-toggle`)?.focus()
  }, [handOff, listId])

  // The sliding strip never told you where you were. The bar does — same
  // answer the active styling gives, so the two can never disagree.
  // Several real routes have no entry of their own — booking for a client, an
  // appointment detail page, one report. Falling back to the section they live
  // under names them honestly, longest match first so a page under a group is
  // named by its group rather than by whatever sits above it in the list.
  const currentLabel =
    active?.label ??
    flat
      .filter((entry) => entry.href !== '/dashboard' && pathname.startsWith(`${entry.href}/`))
      .sort((a, b) => b.href.length - a.href.length)[0]?.label ??
    'Dashboard'

  // With the panel shut the Messages badge is out of sight, so the bar carries
  // the count. Only for roles whose menu actually has Messages in it.
  const barUnread = flat.some((entry) => entry.badge === 'threads') ? unreadThreads : 0

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
      // Re-queried on every Tab, which is what keeps the trap honest when a
      // group has just been opened and put six more links inside it.
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
      {/* Below lg: the hamburger, top left, and nothing else you can press.
          Sticky under the h-16 header, so the menu stays one tap away however
          far down a client list you have scrolled.

          The bar used to be one full-width button reading [≡] Clients … MENU,
          which put the word and the icon at opposite ends of the same control
          and read as two. Now the button is the icon and only the icon; the
          page name sits beside it as text, because knowing which of fifteen
          screens you are on is worth a line and is not something to tap. The
          unread count rides on the hamburger itself rather than standing next
          to the name, where it would look like a second thing to press. */}
      <div className="sticky top-16 z-20 border-b border-[var(--color-border)] bg-[var(--color-background)] lg:hidden">
        <div className="flex items-center gap-2 px-3 py-2">
          <button
            ref={triggerRef}
            type="button"
            data-ui="button"
            onClick={() => setOpenedAt(pathname)}
            aria-expanded={open}
            // Only while the panel exists: aria-controls pointing at an id that
            // is not in the document is an invalid reference, not an empty one.
            aria-controls={open ? panelId : undefined}
            className="relative flex h-11 w-11 shrink-0 items-center justify-center text-[var(--color-foreground)]"
          >
            <Menu className="h-6 w-6" strokeWidth={1.5} aria-hidden />
            <span className="sr-only">
              Open menu
              {barUnread > 0 ? `, ${barUnread} unread messages` : ''}
            </span>
            {barUnread > 0 && (
              <span aria-hidden className={RAIL_BADGE}>
                {barUnread}
              </span>
            )}
          </button>
          <span className="truncate text-sm text-[var(--color-foreground)]">{currentLabel}</span>
        </div>
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
            <div className="flex shrink-0 items-center gap-3 border-b border-[var(--color-border)] p-3">
              <StudioIdentity name={userName} role={role} className="flex-1" />
              <button
                ref={closeRef}
                type="button"
                onClick={close}
                aria-label="Close menu"
                className="flex h-11 w-11 shrink-0 items-center justify-center text-[var(--color-foreground)]"
              >
                <X className="h-5 w-5" strokeWidth={1.5} />
              </button>
            </div>

            <nav aria-label="Dashboard" className="flex-1 overflow-y-auto overscroll-contain">
              {/* More rows than a phone screen holds even collapsed, so the
                  list scrolls inside the panel and pads past the home
                  indicator. */}
              <div className="px-2 py-3 pb-[max(1.5rem,env(safe-area-inset-bottom))]">
                <p className="label-caps px-4 pb-2 text-[var(--color-muted)]">Business</p>
                <NavList
                  entries={top}
                  activeHref={activeHref}
                  openGroups={openGroups}
                  idPrefix={`${listId}-panel`}
                  variant="panel"
                  unreadThreads={unreadThreads}
                  onToggle={toggleGroup}
                  // Closing here, not in an effect that watches the pathname:
                  // the React Compiler forbids that, and this is the moment the
                  // intent actually happens.
                  onNavigate={close}
                />
                <div className="mx-4 my-3 h-px bg-[var(--color-border)]" />
                <NavList
                  entries={bottom}
                  activeHref={activeHref}
                  openGroups={openGroups}
                  idPrefix={`${listId}-panel`}
                  variant="panel"
                  unreadThreads={unreadThreads}
                  onToggle={toggleGroup}
                  onNavigate={close}
                />
              </div>
            </nav>
          </div>
        </div>
      )}

      <nav
        aria-label="Dashboard"
        className={cn(
          'hidden shrink-0 border-b border-[var(--color-border)] lg:block lg:border-b-0 lg:border-r',
          // The one measurement that changes. Everything to the right is a
          // flex child, so the page reflows into the space on its own.
          collapsed ? 'lg:w-16' : 'lg:w-64'
        )}
      >
        {/* Sticky under the h-16 header, and scrolling inside itself: with a
            section open the menu is taller than a laptop screen, and a sticky
            column that overflows simply hides its own last rows. */}
        <div
          className={cn(
            'lg:sticky lg:top-16 lg:max-h-[calc(100vh-4rem)] lg:overflow-y-auto lg:py-5',
            collapsed ? 'lg:px-2.5' : 'lg:px-3'
          )}
        >
          {/* The reference puts this control beside the business name in the
              app header. Ours is a server component rendering the wordmark,
              the till and the notification bell, and none of it knows the
              sidebar exists — lifting this state up there would mean turning
              that whole header into a client component to move one chevron.
              So it sits at the top of the sidebar it controls, first in the
              column, in the same corner whether the menu is wide or narrow. */}
          <div className={cn('flex items-center', collapsed ? 'justify-center' : 'gap-2')}>
            <button
              type="button"
              data-ui="button"
              onClick={() => setCollapsed(!collapsed, true)}
              aria-label={collapsed ? 'Expand menu' : 'Collapse menu'}
              title={collapsed ? 'Expand menu' : 'Collapse menu'}
              className="flex h-11 w-11 shrink-0 items-center justify-center text-[var(--color-muted)] transition-colors hover:bg-[var(--color-linen)] hover:text-[var(--color-foreground)] dark:hover:bg-[var(--color-surface)]"
            >
              {collapsed ? (
                <PanelLeftOpen className="h-5 w-5" strokeWidth={1.5} aria-hidden />
              ) : (
                <PanelLeftClose className="h-5 w-5" strokeWidth={1.5} aria-hidden />
              )}
            </button>
            {/* Narrow, the studio card is the one thing that cannot shrink to
                44px and stay legible. The header above already carries the
                wordmark and the role, so nothing is actually lost. */}
            {!collapsed && <StudioIdentity name={userName} role={role} className="min-w-0 flex-1" />}
          </div>

          {collapsed ? (
            <>
              <NavRail
                entries={top}
                activeHref={activeHref}
                unreadThreads={unreadThreads}
                onOpenSection={openSection}
                className="mt-4"
              />
              <div className="mx-1 my-3 h-px bg-[var(--color-border)]" />
              <NavRail
                entries={bottom}
                activeHref={activeHref}
                unreadThreads={unreadThreads}
                onOpenSection={openSection}
              />
            </>
          ) : (
            <>
              <p className="label-caps px-3 pb-2 pt-6 text-[var(--color-muted)]">Business</p>
              <NavList
                entries={top}
                activeHref={activeHref}
                openGroups={openGroups}
                idPrefix={`${listId}-side`}
                variant="sidebar"
                unreadThreads={unreadThreads}
                onToggle={toggleGroup}
              />

              <div className="mx-3 my-4 h-px bg-[var(--color-border)]" />

              <NavList
                entries={bottom}
                activeHref={activeHref}
                openGroups={openGroups}
                idPrefix={`${listId}-side`}
                variant="sidebar"
                unreadThreads={unreadThreads}
                onToggle={toggleGroup}
              />
            </>
          )}
        </div>
      </nav>
    </>
  )
}
