'use client'

import type { CalendarAppointment } from '@/components/shared/CalendarView'

import * as React from 'react'
import { CircleDashed } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import { addDaysToDateKey, dateKeyInTimeZone, dayLabelForDateKey } from '@/lib/time'
import type {
  ProviderSchedule,
  AvailabilityBlockRow,
  CalendarBusyRow,
  ClosureRow,
} from '@/lib/calendar-blocks'
import {
  CalendarViewComponent,
  isAwaitingApproval,
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
}

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
  settingsHref,
  canBookForClients,
}: CalendarClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()

  const [view, setView] = React.useState<CalendarView>(initialView)
  const [currentDate, setCurrentDate] = React.useState(initialDate)
  const [selectedAppointment, setSelectedAppointment] = React.useState<CalendarAppointment | null>(null)
  const [selectedProviders, setSelectedProviders] = React.useState<string[]>([])

  const canDrag = useDragCapable()
  const todayKey = dateKeyInTimeZone(new Date(), timezone)

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
        settingsHref={settingsHref}
        canBookForClients={canBookForClients}
        onViewChange={handleViewChange}
        onDateChange={handleDateChange}
        onProviderFilterChange={setSelectedProviders}
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
              {selectedProviders.length > 0 && (
                <Badge tone="neutral">{selectedProviders.length} provider(s) filtered</Badge>
              )}
            </div>
          </>
        ) : (
          <CalendarViewComponent
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
            onViewChange={handleViewChange}
            onDateChange={handleDateChange}
            onAppointmentClick={handleAppointmentClick}
            onSlotClick={canBookForClients ? handleSlotClick : undefined}
            onProviderFilterChange={setSelectedProviders}
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
