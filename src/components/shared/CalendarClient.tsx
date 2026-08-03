'use client'

import type { CalendarAppointment } from '@/components/shared/CalendarView'

import * as React from 'react'
import { CircleDashed } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import { addDaysToDateKey, dayLabelForDateKey } from '@/lib/time'
import type {
  ProviderSchedule,
  AvailabilityBlockRow,
  CalendarBusyRow,
  ClosureRow,
} from '@/lib/calendar-blocks'
import {
  CalendarViewComponent,
  isAwaitingApproval,
  useCalendarDensity,
  type CalendarView,
} from './CalendarView'
import { CalendarToolbar } from './CalendarToolbar'
// The two working surfaces. The board adds drag-to-move and its own Move
// dialog, and is what a machine with a real pointer gets for a day or a week;
// the calendar grid draws the month, and draws day and week on a touch screen
// where dragging fights the scroll it shares a gesture with. Both are steered
// by the one toolbar above them, which is why the swap lives here rather than
// inside a wrapper of its own.
import { DragScheduleBoard } from './DragScheduleBoard'
import { useDragCapable } from './DragScheduleProvider'
import { AppointmentModal } from './AppointmentModal'

interface Provider {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
}

interface CalendarClientProps {
  schedules: ProviderSchedule[]
  blocks: AvailabilityBlockRow[]
  busy: CalendarBusyRow[]
  closures: ClosureRow[]
  initialAppointments: CalendarAppointment[]
  providers: Provider[]
  timezone: string
  initialDate: string
  initialView: CalendarView
  /**
   * Today, in the diary's zone, read once on the server through `requestNow()`.
   *
   * A prop rather than a `new Date()` here, for two reasons that point the same
   * way. This component is server-rendered and then hydrated, so a clock read
   * during render is read twice — once by the server, once by the browser — and
   * the two straddle midnight often enough to matter for something that decides
   * which column is in accent and whether "Jump to today" is already there. And
   * a bare clock read during render is exactly what rule 3 routes through
   * `requestNow()`: one seam, greppable, stubbable.
   *
   * It does not tick, and is not meant to. The current-time line has its own
   * clock (`useStudioNow`) precisely because that one has to move; this is the
   * day the page was drawn for.
   */
  todayKey: string
  /**
   * Where the toolbar's gear goes for this viewer. Worked out on the server by
   * role, because the two candidates are gated differently — see the page.
   */
  settingsHref: string
  /**
   * Whether the viewer may book on someone else's behalf — `isFrontDesk`,
   * decided on the server by the page that renders this.
   *
   * Without it, empty slots are not tappable at all. The booking page redirects
   * anyone below front desk to /dashboard, so an interactive slot would eject a
   * provider from the diary they were reading. Passing `undefined` for
   * `onSlotClick` is what makes that true all the way down: every consumer
   * (CalendarView's hour grid, DragScheduleBoard's drop cells) renders inert
   * text instead of a button when the handler is absent, so there is no
   * pointer cursor and no hover affordance promising something that cannot
   * happen.
   *
   * It gates the toolbar's Waitlist, Quick sale and Add pills for the same
   * reason: all three pages redirect anyone below front desk.
   */
  canBookForClients: boolean
  /**
   * The signed-in staff member. Used to say which of the names in the staff
   * menu is theirs — with the diary now opening on one person by default, "whose
   * book is this" has to be answerable without counting heads.
   */
  viewerId: string
  /**
   * Whose book to open on: their own where they have one, everyone otherwise,
   * or whatever they last chose. Worked out on the server, because it has to be
   * right on the first paint — see the page, which explains the test and the
   * cookie behind it.
   */
  initialProviders: string[]
  /**
   * Whether this viewer is sent the whole studio's book or only their own.
   * Decided on the server by the same boolean that narrows the query, so the
   * toolbar never offers a staff filter over data that holds one person.
   */
  canSeeOtherBooks: boolean
}

/**
 * Where "whose book I was looking at" is stored. Spelled again in
 * `src/app/dashboard/calendar/page.tsx`, which reads it — see the note there
 * for why the constant cannot be shared across the server/client boundary.
 */
const STAFF_COOKIE = 'dash_cal_staff'
const STAFF_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export function CalendarClient({
  initialAppointments,
  providers,
  timezone,
  schedules,
  blocks,
  busy,
  closures,
  initialDate,
  initialView,
  todayKey,
  settingsHref,
  canBookForClients,
  viewerId,
  initialProviders,
  canSeeOtherBooks,
}: CalendarClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [view, setView] = React.useState<CalendarView>(initialView)
  const [currentDate, setCurrentDate] = React.useState(initialDate)
  const [selectedAppointment, setSelectedAppointment] = React.useState<CalendarAppointment | null>(null)
  const [selectedProviders, setSelectedProviders] = React.useState<string[]>(initialProviders)

  const canDrag = useDragCapable()

  /**
   * How tightly the book is drawn, saved per browser like the view is.
   *
   * Deliberately NOT the shape the view preference uses below. That effect is
   * a `react-hooks/set-state-in-effect` error the React Compiler is right
   * about — it renders the default and then immediately renders again — and a
   * second copy of it would be a second cascading render on the same screen.
   * `useCalendarDensity` subscribes to localStorage through
   * `useSyncExternalStore`, which is what it actually is: an external store.
   * Left as one line here on purpose; the state lives in the hook.
   */
  const [density, setDensity] = useCalendarDensity()

  // Persist view preference in localStorage
  React.useEffect(() => {
    const savedView = localStorage.getItem('calendar-view')
    if (savedView && (savedView === 'day' || savedView === 'week' || savedView === 'month')) {
      setView(savedView)
    }
  }, [])

  /**
   * The range the server fetches is decided by `view` as well as by `from`, so
   * changing the view has to reach the URL the same way changing the date does
   * — otherwise a switch to Month redraws a month of squares over a week's
   * worth of appointments.
   */
  const pushRange = (nextDate: string, nextView: CalendarView) => {
    const params = new URLSearchParams(searchParams)
    params.set('from', nextDate)
    params.set('view', nextView)
    // The diary is the root of the Calendar / My hours / Timesheets section, so
    // this pushes to the section root and stays on the tab it is rendered from.
    router.push(`/dashboard/calendar?${params.toString()}`, { scroll: false })
  }

  const handleViewChange = (newView: CalendarView) => {
    setView(newView)
    localStorage.setItem('calendar-view', newView)
    pushRange(currentDate, newView)
  }

  const handleDateChange = (date: string) => {
    setCurrentDate(date)
    pushRange(date, view)
  }

  /**
   * Changing who is on the board, and remembering it.
   *
   * Written straight from the browser rather than through a server action, for
   * the same reason the sidebar's width is: this is a preference, not a
   * mutation, and a round trip would put a spinner in front of a filter that is
   * instant today. The server reads it on the next load, so the diary opens on
   * the book you left it on rather than snapping back a beat later.
   *
   * A click handler, not an effect — the React Compiler lint in this repo
   * rejects setState in an effect body, and there is nothing here that needs to
   * happen at mount anyway. The server already decided the opening state.
   */
  const handleProviderFilterChange = (providerIds: string[]) => {
    setSelectedProviders(providerIds)
    const secure = window.location.protocol === 'https:' ? '; secure' : ''
    // Empty means everyone, and an empty cookie value cannot say that — hence
    // the literal. The page treats an unreadable or stale value as "no
    // preference" and falls back to whose book this person owns.
    const value = providerIds.length === 0 ? 'all' : providerIds.join(',')
    // Stamped with whose preference it is. A cookie belongs to a browser and
    // this belongs to a person; the studio shares machines, and the page throws
    // the value away rather than opening the next person who signs in here on
    // somebody else's book.
    document.cookie = `${STAFF_COOKIE}=${viewerId}:${value}; path=/; max-age=${STAFF_COOKIE_MAX_AGE}; samesite=lax${secure}`
  }

  const handleAppointmentClick = (appointment: CalendarAppointment) => {
    setSelectedAppointment(appointment)
  }

  const handleSlotClick = (date: string, time: string) => {
    // book-for-client is the staff booking page — /dashboard/appointments/new
    // has never existed, so every tap on an empty slot used to be a 404.
    //
    // `date` is a date key and `time` is 'HH:MM' wall clock in the diary's
    // timezone, which is exactly what the form needs to reopen on the slot that
    // was tapped. URLSearchParams so the colon is encoded properly.
    const params = new URLSearchParams({ date, time })
    router.push(`/dashboard/appointments/book-for-client?${params.toString()}`)
  }

  const handleCloseModal = () => {
    setSelectedAppointment(null)
  }

  const handleCancel = (id: string) => {
    // Navigate to the appointment page where cancellation can be handled
    router.push(`/dashboard/appointments/${id}?action=cancel`)
  }

  const handleReschedule = (id: string) => {
    router.push(`/dashboard/appointments/${id}?action=reschedule`)
  }

  const handleComplete = (id: string) => {
    router.push(`/dashboard/appointments/${id}?action=complete`)
  }

  const handleAddNote = (id: string) => {
    router.push(`/dashboard/appointments/${id}?action=note`)
  }

  // Month, or a touch screen: the calendar grid. Otherwise the drag board.
  const onBoard = canDrag && view !== 'month'

  const filtered =
    selectedProviders.length === 0
      ? initialAppointments
      : initialAppointments.filter((a) => selectedProviders.includes(a.provider_id))
  const pendingCount = filtered.filter(isAwaitingApproval).length

  return (
    <>
      <CalendarToolbar
        view={view}
        currentDate={currentDate}
        todayKey={todayKey}
        providers={providers}
        selectedProviders={selectedProviders}
        viewerId={viewerId}
        canSeeOtherBooks={canSeeOtherBooks}
        settingsHref={settingsHref}
        canBookForClients={canBookForClients}
        density={density}
        onViewChange={handleViewChange}
        onDateChange={handleDateChange}
        onDensityChange={setDensity}
        onProviderFilterChange={handleProviderFilterChange}
      />

      <div className="mt-6">
        {onBoard ? (
          <>
            {/* The board's own columns are labelled by day or by provider, so
                the span it covers is only ever implied. Said once, here, for
                anyone reading the page as an outline. */}
            <h2 className="sr-only">
              {view === 'day'
                ? dayLabelForDateKey(currentDate)
                : `${dayLabelForDateKey(currentDate)} — ${dayLabelForDateKey(addDaysToDateKey(currentDate, 6))}`}
            </h2>

            <DragScheduleBoard
              view={view}
              currentDate={currentDate}
              appointments={initialAppointments}
              providers={providers}
              timezone={timezone}
              schedules={schedules}
              blocks={blocks}
              busy={busy}
              closures={closures}
              selectedProviders={selectedProviders}
              todayKey={todayKey}
              density={density}
              onAppointmentClick={handleAppointmentClick}
              onSlotClick={canBookForClients ? handleSlotClick : undefined}
            />

            {/* The board draws cards, not counts. This is the same line the
                calendar grid ends with, so the two surfaces close the same
                way — including the queue, which is the one number the cards
                raise and cannot answer. */}
            <div className="mt-6 flex flex-wrap items-center gap-6 text-sm text-[var(--color-muted)]">
              <span>{filtered.length} appointments</span>
              <span className="tabular-nums">
                {formatMoney(filtered.reduce((n, a) => n + a.total_cents, 0))} total
              </span>
              {pendingCount > 0 && (
                <span className="inline-flex items-center gap-1.5">
                  <CircleDashed className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden />
                  <span className="tabular-nums">{pendingCount}</span> awaiting approval
                </span>
              )}
              {/* Only where there is a filter to have used. A provider is sent
                  their own book and nothing else, and the toolbar hides the
                  staff control for them — a permanent "1 provider" note would
                  claim colleagues were being hidden, offer no way to stop it,
                  and be wrong. Matches the calendar grid's copy exactly, so the
                  two surfaces still close the same way. */}
              {canSeeOtherBooks && selectedProviders.length > 0 && (
                <Badge tone="neutral">
                  {selectedProviders.length === 1
                    ? '1 provider shown'
                    : `${selectedProviders.length} providers shown`}
                </Badge>
              )}
            </div>
          </>
        ) : (
          <CalendarViewComponent
            view={view}
            currentDate={currentDate}
            todayKey={todayKey}
            appointments={initialAppointments}
            providers={providers}
            timezone={timezone}
            schedules={schedules}
            blocks={blocks}
            busy={busy}
            closures={closures}
            selectedProviders={selectedProviders}
            canSeeOtherBooks={canSeeOtherBooks}
            density={density}
            onViewChange={handleViewChange}
            onDateChange={handleDateChange}
            onAppointmentClick={handleAppointmentClick}
            onSlotClick={canBookForClients ? handleSlotClick : undefined}
            onProviderFilterChange={handleProviderFilterChange}
          />
        )}
      </div>

      {selectedAppointment && (
        <AppointmentModal
          appointment={selectedAppointment}
          timezone={timezone}
          onClose={handleCloseModal}
          onCancel={handleCancel}
          onReschedule={handleReschedule}
          onComplete={handleComplete}
          onAddNote={handleAddNote}
        />
      )}
    </>
  )
}
