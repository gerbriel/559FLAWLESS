'use client'

import * as React from 'react'
import {
  CalendarCheck,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  Settings2,
  Users,
} from 'lucide-react'
import { ButtonLink } from '@/components/ui/button'
import { Avatar, Panel, Toolbar } from '@/components/ui/dashboard'
import { addDaysToDateKey } from '@/lib/time'
import { cn } from '@/lib/utils'
import type { CalendarView } from './CalendarView'

/**
 * One row across the top of the diary, holding everything you steer it with.
 *
 * Moving through the book used to mean three separate clusters — a Day/Week/
 * Month group on the left, a Filters button and a prev/Today/next group on the
 * right, and the date itself printed as a heading somewhere below them. They
 * were the same job in three places, so nobody's eye had one place to go back
 * to. This is that place: the month, the jump to today, the date, the view, who
 * you are looking at, and the three things you most often leave the diary to do.
 *
 * It holds no state about the calendar. Every control calls up to
 * `CalendarClient`, which owns the view, the date and the provider filter, and
 * which is also what puts them in the URL.
 */

export interface CalendarToolbarProvider {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
}

interface CalendarToolbarProps {
  view: CalendarView
  /** The anchor date key the calendar is drawn from. */
  currentDate: string
  /** Today in the diary's zone, worked out once by the caller. */
  todayKey: string
  providers: CalendarToolbarProvider[]
  /** Empty means everyone — the filter's existing meaning, kept. */
  selectedProviders: string[]
  /**
   * Where the gear goes for this viewer. Decided on the server by role: a
   * manager gets the studio's scheduling rules, everyone else gets their own
   * hours. Sending a provider to a manager-only page would only bounce them.
   */
  settingsHref: string
  /**
   * `isFrontDesk`, decided on the server. Waitlist, the till and booking for a
   * client are all front-desk-and-above pages that redirect anyone below, so
   * the pills are only offered to someone the pages will actually let in.
   */
  canBookForClients: boolean
  onViewChange: (view: CalendarView) => void
  onDateChange: (dateKey: string) => void
  onProviderFilterChange: (providerIds: string[]) => void
}

const VIEW_LABELS: Record<CalendarView, string> = {
  day: 'Day',
  week: 'Week',
  month: 'Month',
}

/** The pill shape the whole right-hand run shares. 44px tall, thumb-sized. */
const PILL =
  'inline-flex min-h-11 items-center gap-2 rounded-full border border-[var(--color-border)] ' +
  'bg-[var(--color-surface)] px-4 text-sm transition-colors hover:border-[var(--color-accent)] ' +
  'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 ' +
  'focus-visible:outline-[var(--color-accent)]'

/**
 * The next or previous page of the book.
 *
 * A day at a time, a week at a time, or to the first of the next month — the
 * same three rules the prev/next buttons have always followed, kept in one
 * place now that two callers want them.
 */
export function shiftDateKey(
  dateKey: string,
  view: CalendarView,
  direction: 1 | -1
): string {
  if (view === 'day') return addDaysToDateKey(dateKey, direction)
  if (view === 'week') return addDaysToDateKey(dateKey, 7 * direction)

  const [year, month] = dateKey.split('-').map(Number)
  const shifted = month + direction
  const wrappedMonth = shifted === 0 ? 12 : shifted === 13 ? 1 : shifted
  const wrappedYear = shifted === 0 ? year - 1 : shifted === 13 ? year + 1 : year
  return `${wrappedYear}-${String(wrappedMonth).padStart(2, '0')}-01`
}

/**
 * "Sun Aug 2, 2026" and "Aug" for a date key.
 *
 * Built from the key's own numbers and read straight back in UTC, the way
 * `dayLabelForDateKey` does it. A date key is already a calendar day; putting
 * it through a timezone a second time is how you end up printing the day
 * before. The locale is pinned so the server and the browser render the same
 * string and hydration stays quiet.
 */
function shortDateLabel(dateKey: string): string {
  const [y, mo, d] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, d)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function shortMonthLabel(dateKey: string): string {
  const [y, mo] = dateKey.split('-').map(Number)
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    month: 'short',
  })
}

function fullNameOf(p: CalendarToolbarProvider): string {
  return (
    p.display_name ||
    `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() ||
    'Provider'
  )
}

/** The chip is narrow, so it carries the name people are called by. */
function firstNameOf(p: CalendarToolbarProvider): string {
  return p.first_name?.trim() || fullNameOf(p).split(/\s+/)[0]
}

/**
 * A pill that opens a small panel under itself.
 *
 * Escape closes it and a pointer landing anywhere else closes it, because a
 * menu that only shuts when you find its trigger again is a menu you end up
 * fighting. Focus is left where the user put it — these are short lists, and
 * trapping focus in a two-item menu is worse than not.
 */
function ToolbarMenu({
  label,
  trigger,
  children,
  className,
}: {
  /**
   * Names the menu, and prefixes the trigger for a screen reader. It reads as
   * a phrase with the current value after it — "View, Week" — which is why it
   * is a noun rather than an instruction. An `aria-label` on the button would
   * have hidden the value instead of introducing it.
   */
  label: string
  trigger: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  const [open, setOpen] = React.useState(false)
  const root = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    if (!open) return

    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false)
    }

    document.addEventListener('pointerdown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('pointerdown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  return (
    <div ref={root} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={cn(PILL, open && 'border-[var(--color-accent)]')}
      >
        <span className="sr-only">{label},</span>
        {trigger}
        <ChevronDown
          className={cn('h-3.5 w-3.5 text-[var(--color-muted)] transition-transform', open && 'rotate-180')}
          strokeWidth={2}
          aria-hidden
        />
      </button>

      {open && (
        <Panel
          role="menu"
          aria-label={label}
          className="absolute right-0 z-30 mt-2 min-w-56 overflow-hidden p-1.5 shadow-lg"
          onClick={() => setOpen(false)}
        >
          {children}
        </Panel>
      )}
    </div>
  )
}

/** One row inside a ToolbarMenu. Checked rows show the tick on the right. */
function MenuRow({
  checked,
  role,
  onSelect,
  children,
}: {
  checked: boolean
  role: 'menuitemradio' | 'menuitemcheckbox'
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      onClick={onSelect}
      className="flex min-h-11 w-full items-center gap-2.5 rounded-[var(--radius-control)] px-3 text-left text-sm transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)]"
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {checked && (
        <Check className="h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={2} aria-hidden />
      )}
    </button>
  )
}

export function CalendarToolbar({
  view,
  currentDate,
  todayKey,
  providers,
  selectedProviders,
  settingsHref,
  canBookForClients,
  onViewChange,
  onDateChange,
  onProviderFilterChange,
}: CalendarToolbarProps) {
  const onToday = currentDate === todayKey

  // Empty has always meant "everyone", so the chip says so rather than
  // pretending nobody is shown.
  const chosen = providers.filter((p) => selectedProviders.includes(p.id))
  const staffLabel =
    chosen.length === 0
      ? 'All staff'
      : chosen.length === 1
        ? firstNameOf(chosen[0])
        : `${chosen.length} staff`

  const toggleProvider = (id: string) => {
    onProviderFilterChange(
      selectedProviders.includes(id)
        ? selectedProviders.filter((other) => other !== id)
        : [...selectedProviders, id]
    )
  }

  return (
    <Toolbar
      // The bar is how you move through the book, so it stays put while the
      // grid scrolls under it. The negative margin lets its background reach
      // the full width of the main column, which `px-6 lg:px-10` gives it.
      className="sticky top-16 z-20 -mx-6 border-b border-[var(--color-border)] bg-[var(--color-background)] px-6 py-3 lg:-mx-10 lg:px-10"
      left={
        <>
          <span className="display mr-1 text-3xl leading-none">
            {shortMonthLabel(currentDate)}
          </span>

          <button
            type="button"
            data-ui="tile"
            onClick={() => onDateChange(todayKey)}
            aria-current={onToday ? 'date' : undefined}
            className={cn(
              'flex h-11 w-11 items-center justify-center border bg-[var(--color-surface)] transition-colors',
              onToday
                ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                : 'border-[var(--color-border)] hover:border-[var(--color-accent)]'
            )}
          >
            <CalendarCheck className="h-4 w-4" strokeWidth={1.5} aria-hidden />
            <span className="sr-only">Jump to today</span>
          </button>

          <div className="flex items-center rounded-full border border-[var(--color-border)] bg-[var(--color-surface)]">
            <button
              type="button"
              onClick={() => onDateChange(shiftDateKey(currentDate, view, -1))}
              className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)]"
            >
              <ChevronLeft className="h-4 w-4" strokeWidth={2} aria-hidden />
              <span className="sr-only">Previous {VIEW_LABELS[view].toLowerCase()}</span>
            </button>

            <span className="whitespace-nowrap px-1 text-sm tabular-nums">
              {shortDateLabel(currentDate)}
            </span>

            <button
              type="button"
              onClick={() => onDateChange(shiftDateKey(currentDate, view, 1))}
              className="flex h-11 w-11 items-center justify-center rounded-full text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)]"
            >
              <ChevronRight className="h-4 w-4" strokeWidth={2} aria-hidden />
              <span className="sr-only">Next {VIEW_LABELS[view].toLowerCase()}</span>
            </button>
          </div>
        </>
      }
      right={
        <>
          {/* The shared Button shrinks to 36px from `sm` up, which is right for
              a form and wrong for a row of controls the studio steers the day
              with — and it would leave this one short beside the hand-rolled
              pills either side. Held at 44 in both directions. */}
          <ButtonLink
            href={settingsHref}
            variant="subtle"
            size="icon"
            aria-label="Scheduling settings"
            className="sm:h-11 sm:w-11"
          >
            <Settings2 className="h-4 w-4" strokeWidth={1.5} aria-hidden />
          </ButtonLink>

          <ToolbarMenu label="View" trigger={<span>{VIEW_LABELS[view]}</span>}>
            {(['day', 'week', 'month'] as const).map((option) => (
              <MenuRow
                key={option}
                role="menuitemradio"
                checked={option === view}
                onSelect={() => onViewChange(option)}
              >
                {VIEW_LABELS[option]}
              </MenuRow>
            ))}
          </ToolbarMenu>

          <ToolbarMenu
            label="Staff shown"
            trigger={
              <>
                {chosen.length === 1 ? (
                  <Avatar name={fullNameOf(chosen[0])} size="sm" className="-ml-1.5" />
                ) : (
                  <Users className="h-4 w-4 text-[var(--color-muted)]" strokeWidth={1.5} aria-hidden />
                )}
                <span>{staffLabel}</span>
              </>
            }
          >
            <MenuRow
              role="menuitemradio"
              checked={selectedProviders.length === 0}
              onSelect={() => onProviderFilterChange([])}
            >
              Everyone
            </MenuRow>

            <div className="my-1 h-px bg-[var(--color-border)]" aria-hidden />

            {providers.map((provider) => (
              <MenuRow
                key={provider.id}
                role="menuitemcheckbox"
                checked={selectedProviders.includes(provider.id)}
                onSelect={() => toggleProvider(provider.id)}
              >
                {fullNameOf(provider)}
              </MenuRow>
            ))}
          </ToolbarMenu>

          {/* The three places the diary sends you. All front-desk-and-above,
              which is the same gate that decides whether an empty slot is
              tappable — so a provider sees the book without the doors that
              would bounce them. */}
          {canBookForClients && (
            <>
              <ButtonLink
                href="/dashboard/waitlist"
                variant="outline"
                size="sm"
                className="sm:h-11"
              >
                Waitlist
              </ButtonLink>
              <ButtonLink
                href="/dashboard/sell"
                variant="outline"
                size="sm"
                className="sm:h-11"
              >
                Quick sale
              </ButtonLink>
              <ButtonLink
                // The day you are looking at travels with you: the booking form
                // reads `date` and opens on it.
                href={`/dashboard/appointments/book-for-client?date=${currentDate}`}
                variant="primary"
                size="sm"
                className="sm:h-11"
              >
                <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
                Add
              </ButtonLink>
            </>
          )}
        </>
      }
    />
  )
}
