'use client'

import * as React from 'react'
import { ChevronLeft, ChevronRight, Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
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
  type CalendarView,
  type CalendarAppointment,
} from './CalendarView'
import { DragScheduleBoard, type BoardProvider } from './DragScheduleBoard'
import { useDragCapable } from './DragScheduleProvider'

/**
 * The calendar, with dragging where dragging makes sense.
 *
 * A drop-in for `CalendarViewComponent` — same props, same callbacks — that
 * swaps in the draggable board for the day and week views on a machine with a
 * real pointer, and otherwise hands everything straight through to the calendar
 * that was already there. Month view is a month of small squares and is not a
 * sensible thing to drag onto, so it is never swapped.
 *
 * Written as a wrapper on purpose. CalendarView is shared ground; a drag layer
 * that has to be threaded through its internals would tie the two together for
 * good, and this keeps rescheduling something you can add or remove in one
 * line.
 */

interface DragScheduleCalendarProps {
  schedules: ProviderSchedule[]
  blocks: AvailabilityBlockRow[]
  busy: CalendarBusyRow[]
  closures: ClosureRow[]
  view: CalendarView
  currentDate: string
  appointments: CalendarAppointment[]
  providers: BoardProvider[]
  timezone: string
  selectedProviders: string[]
  onViewChange: (view: CalendarView) => void
  onDateChange: (date: string) => void
  onAppointmentClick: (appointment: CalendarAppointment) => void
  onSlotClick?: (date: string, time: string) => void
  onProviderFilterChange: (providerIds: string[]) => void
  /** Fired after a move commits, if the host wants to refetch something. */
  onMoved?: () => void
}

export function DragScheduleCalendar({ onMoved, ...props }: DragScheduleCalendarProps) {
  const canDrag = useDragCapable()
  const [showFilters, setShowFilters] = React.useState(false)

  const {
    view,
    currentDate,
    appointments,
    providers,
    timezone,
    selectedProviders,
    onViewChange,
    onDateChange,
    onProviderFilterChange,
  } = props

  const todayKey = dateKeyInTimeZone(new Date(), timezone)

  // Month, or a touch device: nothing to add, so add nothing.
  if (!canDrag || view === 'month') {
    return <CalendarViewComponent {...props} />
  }

  const step = view === 'day' ? 1 : 7

  const filtered =
    selectedProviders.length === 0
      ? appointments
      : appointments.filter((a) => selectedProviders.includes(a.provider_id))

  const heading =
    view === 'day'
      ? dayLabelForDateKey(currentDate)
      : `${dayLabelForDateKey(currentDate)} — ${dayLabelForDateKey(addDaysToDateKey(currentDate, 6))}`

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-2">
          <Button
            variant={view === 'day' ? 'accent' : 'subtle'}
            size="sm"
            onClick={() => onViewChange('day')}
          >
            Day
          </Button>
          <Button
            variant={view === 'week' ? 'accent' : 'subtle'}
            size="sm"
            onClick={() => onViewChange('week')}
          >
            Week
          </Button>
          <Button variant="subtle" size="sm" onClick={() => onViewChange('month')}>
            Month
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="subtle" size="sm" onClick={() => setShowFilters(!showFilters)}>
            <Filter className="h-4 w-4" />
            Filters
          </Button>
          <Button
            variant="subtle"
            size="sm"
            onClick={() => onDateChange(addDaysToDateKey(currentDate, -step))}
          >
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
            <span className="sr-only">Previous {view}</span>
          </Button>
          <Button variant="subtle" size="sm" onClick={() => onDateChange(todayKey)}>
            Today
          </Button>
          <Button
            variant="subtle"
            size="sm"
            onClick={() => onDateChange(addDaysToDateKey(currentDate, step))}
          >
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
            <span className="sr-only">Next {view}</span>
          </Button>
        </div>
      </div>

      {showFilters && (
        <div className="mt-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="mb-3 flex items-center justify-between">
            <p className="label-caps text-sm">Filter by provider</p>
            <button
              type="button"
              onClick={() => onProviderFilterChange([])}
              className="text-xs text-[var(--color-accent)] hover:underline"
            >
              {selectedProviders.length === 0 ? 'Clear' : 'All'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {providers.map((provider) => {
              const isSelected =
                selectedProviders.length === 0 || selectedProviders.includes(provider.id)
              const name =
                provider.display_name ||
                `${provider.first_name ?? ''} ${provider.last_name ?? ''}`.trim()
              return (
                <button
                  key={provider.id}
                  type="button"
                  aria-pressed={isSelected}
                  onClick={() =>
                    onProviderFilterChange(
                      selectedProviders.includes(provider.id)
                        ? selectedProviders.filter((id) => id !== provider.id)
                        : [...selectedProviders, provider.id]
                    )
                  }
                  className={`border px-3 py-1 text-sm transition-colors ${
                    isSelected
                      ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
                      : 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-muted)] hover:border-[var(--color-accent)]'
                  }`}
                >
                  {name}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <h2 className="display mt-6 text-2xl">
        {heading}
        {currentDate === todayKey && (
          <Badge tone="neutral" className="ml-3">
            Today
          </Badge>
        )}
      </h2>

      <div className="mt-4">
        <DragScheduleBoard
          view={view}
          currentDate={currentDate}
          appointments={appointments}
          providers={providers}
          timezone={timezone}
          schedules={props.schedules}
          blocks={props.blocks}
          busy={props.busy}
          closures={props.closures}
          selectedProviders={selectedProviders}
          todayKey={todayKey}
          onAppointmentClick={props.onAppointmentClick}
          onSlotClick={props.onSlotClick}
          onMoved={onMoved}
        />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-6 text-sm text-[var(--color-muted)]">
        <span>{filtered.length} appointments</span>
        <span className="tabular-nums">
          {formatMoney(filtered.reduce((n, a) => n + a.total_cents, 0))} total
        </span>
        {selectedProviders.length > 0 && (
          <Badge tone="neutral">{selectedProviders.length} provider(s) filtered</Badge>
        )}
      </div>
    </div>
  )
}
