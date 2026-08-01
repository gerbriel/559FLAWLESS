'use client'

import type { CalendarAppointment } from '@/components/shared/CalendarView'

import * as React from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CalendarViewComponent, type CalendarView } from './CalendarView'
import { AppointmentModal } from './AppointmentModal'
import { dateKeyInTimeZone } from '@/lib/time'
import type { AppointmentStatus } from '@/types/database'


interface Provider {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
}

interface CalendarClientProps {
  initialAppointments: CalendarAppointment[]
  providers: Provider[]
  timezone: string
  initialDate: string
  initialView: CalendarView
}

export function CalendarClient({
  initialAppointments,
  providers,
  timezone,
  initialDate,
  initialView,
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
    router.push(`/dashboard/calendar?${params.toString()}`, { scroll: false })
  }

  const handleAppointmentClick = (appointment: CalendarAppointment) => {
    setSelectedAppointment(appointment)
  }

  const handleSlotClick = (date: string, time: string) => {
    // Navigate to booking page with pre-filled date/time
    router.push(`/dashboard/appointments/new?date=${date}&time=${time}`)
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
      <CalendarViewComponent
        view={view}
        currentDate={currentDate}
        appointments={initialAppointments}
        providers={providers}
        timezone={timezone}
        selectedProviders={selectedProviders}
        onViewChange={handleViewChange}
        onDateChange={handleDateChange}
        onAppointmentClick={handleAppointmentClick}
        onSlotClick={handleSlotClick}
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
