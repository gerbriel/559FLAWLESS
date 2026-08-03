'use client'

import type { CalendarAppointment } from '@/components/shared/CalendarView'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import type {
  ProviderSchedule,
  AvailabilityBlockRow,
  CalendarBusyRow,
  ClosureRow,
} from '@/lib/calendar-blocks'
import { type CalendarView } from './CalendarView'
// Drop-in for CalendarViewComponent with identical props: adds drag-to-move on
// desktop, and passes month view and touch devices straight through unchanged.
import { DragScheduleCalendar } from './DragScheduleCalendar'
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
   * Whether the viewer may book on someone else's behalf — `isFrontDesk`,
   * decided on the server by the page that renders this.
   *
   * Without it, empty slots are not tappable at all. The booking page redirects
   * anyone below front desk to /dashboard, so an interactive slot would eject a
   * provider from the diary they were reading. Passing `undefined` for
   * `onSlotClick` is what makes that true all the way down: every consumer
   * (CalendarView's day grid, DragScheduleBoard's drop cells) renders inert
   * text instead of a button when the handler is absent, so there is no
   * pointer cursor and no hover affordance promising something that cannot
   * happen.
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
  canBookForClients,
}: CalendarClientProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  
  const [view, setView] = React.useState<CalendarView>(initialView)
  const [currentDate, setCurrentDate] = React.useState(initialDate)
  const [selectedAppointment, setSelectedAppointment] = React.useState<CalendarAppointment | null>(null)
  const [selectedProviders, setSelectedProviders] = React.useState<string[]>([])

  // Persist view preference in localStorage
  React.useEffect(() => {
    const savedView = localStorage.getItem('calendar-view')
    if (savedView && (savedView === 'day' || savedView === 'week' || savedView === 'month')) {
      setView(savedView)
    }
  }, [])

  const handleViewChange = (newView: CalendarView) => {
    setView(newView)
    localStorage.setItem('calendar-view', newView)
  }

  const handleDateChange = (date: string) => {
    setCurrentDate(date)
    // Update URL to reflect date change
    const params = new URLSearchParams(searchParams)
    params.set('from', date)
    params.set('view', view)
    // The diary is the root of the Calendar / My hours / Timesheets section, so
    // this pushes to the section root and stays on the tab it is rendered from.
    // `from` and `view` are read on the server and decide the range fetched.
    router.push(`/dashboard/calendar?${params.toString()}`, { scroll: false })
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

  return (
    <>
      <DragScheduleCalendar
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
