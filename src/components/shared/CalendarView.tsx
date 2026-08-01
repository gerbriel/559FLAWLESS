'use client'

import * as React from 'react'
import { ChevronLeft, ChevronRight, Filter } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  blockedSpansForDay,
  spansOverlappingHour,
  formatSpan,
  BLOCK_STYLES,
  BLOCK_LABELS,
  type ProviderSchedule,
  type AvailabilityBlockRow,
  type CalendarBusyRow,
  type ClosureRow,
  type BlockedSpan,
} from '@/lib/calendar-blocks'
import { formatMoney } from '@/lib/utils'
import { 
  addDaysToDateKey, 
  dateKeyInTimeZone, 
  formatTimeInTimeZone,
  dayOfWeekForDateKey,
  monthLabelForDateKey,
  dayLabelForDateKey,
} from '@/lib/time'
import type { AppointmentStatus } from '@/types/database'

export type CalendarView = 'day' | 'week' | 'month'

/**
 * The one appointment shape the calendar and its modal both use.
 *
 * It was previously declared separately in three files, which drifted — the
 * grid's copy was missing the fields the modal needed, so passing a row from
 * one to the other did not typecheck even though the query returned them.
 */
export interface CalendarAppointment {
  id: string
  starts_at: string
  ends_at: string
  status: AppointmentStatus
  total_cents: number
  deposit_cents: number
  provider_id: string
  client_id: string | null
  client_notes: string | null
  staff_notes: string | null
  guest_first_name: string | null
  guest_last_name: string | null
  guest_email: string | null
  guest_phone: string | null
  profiles?: {
    first_name: string | null
    last_name: string | null
    email?: string | null
    phone?: string | null
  } | null
  provider?: {
    first_name: string | null
    last_name: string | null
    display_name: string | null
  } | null
  appointment_services?: Array<{
    name_snapshot: string
    sort_order?: number
    price_cents?: number
    duration_minutes?: number
  }>
}

interface Provider {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
}

interface CalendarViewProps {
  schedules: ProviderSchedule[]
  blocks: AvailabilityBlockRow[]
  busy: CalendarBusyRow[]
  closures: ClosureRow[]
  view: CalendarView
  currentDate: string // YYYY-MM-DD format
  appointments: CalendarAppointment[]
  providers: Provider[]
  timezone: string
  selectedProviders: string[]
  onViewChange: (view: CalendarView) => void
  onDateChange: (date: string) => void
  onAppointmentClick: (appointment: CalendarAppointment) => void
  onSlotClick?: (date: string, time: string) => void
  onProviderFilterChange: (providerIds: string[]) => void
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const DAY_NAMES_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

// Generate provider colors consistently
const PROVIDER_COLORS = [
  'bg-[var(--series-1)]/20 border-l-[var(--series-1)]',
  'bg-[var(--series-2)]/20 border-l-[var(--series-2)]',
  'bg-[var(--color-clay)]/20 border-l-[var(--color-clay)]',
  'bg-[var(--color-sage)]/20 border-l-[var(--color-sage)]',
  'bg-[var(--color-gold)]/20 border-l-[var(--color-gold)]',
]

function getProviderColor(providerId: string, providers: Provider[]): string {
  const index = providers.findIndex(p => p.id === providerId)
  return PROVIDER_COLORS[index % PROVIDER_COLORS.length]
}

export function CalendarViewComponent({
  view,
  currentDate,
  appointments,
  providers,
  timezone,
  schedules,
  blocks,
  busy,
  closures,
  selectedProviders,
  onViewChange,
  onDateChange,
  onAppointmentClick,
  onSlotClick,
  onProviderFilterChange,
}: CalendarViewProps) {
  const [showFilters, setShowFilters] = React.useState(false)

  const filteredAppointments = React.useMemo(() => {
    if (selectedProviders.length === 0) return appointments
    return appointments.filter(a => selectedProviders.includes(a.provider_id))
  }, [appointments, selectedProviders])

  const todayKey = dateKeyInTimeZone(new Date(), timezone)

  const handlePrevious = () => {
    if (view === 'day') {
      onDateChange(addDaysToDateKey(currentDate, -1))
    } else if (view === 'week') {
      onDateChange(addDaysToDateKey(currentDate, -7))
    } else {
      // Month - go to previous month
      const [y, m] = currentDate.split('-').map(Number)
      const prevMonth = m === 1 ? 12 : m - 1
      const prevYear = m === 1 ? y - 1 : y
      onDateChange(`${prevYear}-${String(prevMonth).padStart(2, '0')}-01`)
    }
  }

  const handleNext = () => {
    if (view === 'day') {
      onDateChange(addDaysToDateKey(currentDate, 1))
    } else if (view === 'week') {
      onDateChange(addDaysToDateKey(currentDate, 7))
    } else {
      // Month - go to next month
      const [y, m] = currentDate.split('-').map(Number)
      const nextMonth = m === 12 ? 1 : m + 1
      const nextYear = m === 12 ? y + 1 : y
      onDateChange(`${nextYear}-${String(nextMonth).padStart(2, '0')}-01`)
    }
  }

  const handleToday = () => {
    onDateChange(todayKey)
  }

  const toggleProvider = (providerId: string) => {
    if (selectedProviders.includes(providerId)) {
      onProviderFilterChange(selectedProviders.filter(id => id !== providerId))
    } else {
      onProviderFilterChange([...selectedProviders, providerId])
    }
  }

  const selectAllProviders = () => {
    onProviderFilterChange([])
  }

  return (
    <div>
      {/* Header Controls */}
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
          <Button
            variant={view === 'month' ? 'accent' : 'subtle'}
            size="sm"
            onClick={() => onViewChange('month')}
          >
            Month
          </Button>
        </div>

        <div className="flex items-center gap-3">
          <Button variant="subtle" size="sm" onClick={() => setShowFilters(!showFilters)}>
            <Filter className="h-4 w-4" />
            Filters
          </Button>
          <Button variant="subtle" size="sm" onClick={handlePrevious}>
            <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
          </Button>
          <Button variant="subtle" size="sm" onClick={handleToday}>
            Today
          </Button>
          <Button variant="subtle" size="sm" onClick={handleNext}>
            <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
          </Button>
        </div>
      </div>

      {/* Filters Panel */}
      {showFilters && (
        <div className="mt-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <div className="flex items-center justify-between mb-3">
            <p className="label-caps text-sm">Filter by Provider</p>
            <button
              onClick={selectAllProviders}
              className="text-xs text-[var(--color-accent)] hover:underline"
            >
              {selectedProviders.length === 0 ? 'Clear' : 'All'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {providers.map((provider) => {
              const isSelected = selectedProviders.length === 0 || selectedProviders.includes(provider.id)
              const name = provider.display_name || `${provider.first_name ?? ''} ${provider.last_name ?? ''}`.trim()
              return (
                <button
                  key={provider.id}
                  onClick={() => toggleProvider(provider.id)}
                  className={`rounded border px-3 py-1 text-sm transition-colors ${
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

      {/* View Content */}
      <div className="mt-6">
        {view === 'day' && (
          <DayView
            date={currentDate}
            appointments={filteredAppointments}
            providers={providers}
            timezone={timezone}
            schedules={schedules}
            blocks={blocks}
            busy={busy}
            closures={closures}
            focusProvider={selectedProviders.length === 1 ? selectedProviders[0] : null}
            onAppointmentClick={onAppointmentClick}
            onSlotClick={onSlotClick}
            isToday={currentDate === todayKey}
          />
        )}
        {view === 'week' && (
          <WeekView
            startDate={currentDate}
            appointments={filteredAppointments}
            providers={providers}
            timezone={timezone}
            schedules={schedules}
            blocks={blocks}
            busy={busy}
            closures={closures}
            focusProvider={selectedProviders.length === 1 ? selectedProviders[0] : null}
            todayKey={todayKey}
            onAppointmentClick={onAppointmentClick}
            onSlotClick={onSlotClick}
          />
        )}
        {view === 'month' && (
          <MonthView
            month={currentDate}
            appointments={filteredAppointments}
            providers={providers}
            timezone={timezone}
            todayKey={todayKey}
            onAppointmentClick={onAppointmentClick}
            onDayClick={(date) => {
              onDateChange(date)
              onViewChange('day')
            }}
          />
        )}
      </div>

      {/* Summary */}
      <div className="mt-6 flex flex-wrap items-center gap-6 text-sm text-[var(--color-muted)]">
        <span>{filteredAppointments.length} appointments</span>
        <span className="tabular-nums">
          {formatMoney(filteredAppointments.reduce((n, a) => n + a.total_cents, 0))} total
        </span>
        {selectedProviders.length > 0 && (
          <Badge tone="neutral">{selectedProviders.length} provider(s) filtered</Badge>
        )}
      </div>
    </div>
  )
}

// Day View Component
interface DayViewProps {
  schedules: ProviderSchedule[]
  blocks: AvailabilityBlockRow[]
  busy: CalendarBusyRow[]
  closures: ClosureRow[]
  /** Whose availability to shade. Null when several providers are shown. */
  focusProvider: string | null
  date: string
  appointments: CalendarAppointment[]
  providers: Provider[]
  timezone: string
  onAppointmentClick: (appointment: CalendarAppointment) => void
  onSlotClick?: (date: string, time: string) => void
  isToday: boolean
}

function DayView({
  date, appointments, providers, timezone,
  schedules, blocks, busy, closures, focusProvider,
  onAppointmentClick, onSlotClick, isToday,
}: DayViewProps) {
  const dow = dayOfWeekForDateKey(date)

  const dayAppointments = appointments.filter(a => {
    const apptDate = dateKeyInTimeZone(new Date(a.starts_at), timezone)
    return apptDate === date
  })

  // Generate hourly slots from 8 AM to 8 PM
  const hours = Array.from({ length: 13 }, (_, i) => i + 8)

  // Everything making this day unbookable, so it can be shown rather than left
  // as an unexplained gap.
  const spans = blockedSpansForDay(date, timezone, {
    providerId: focusProvider,
    schedules,
    blocks,
    busy,
    closures,
  })

  // Whole-day reasons belong at the top, not smeared across every hour row.
  const allDay = spans.filter((s) => s.startMinutes === 0 && s.endMinutes === 1440)
  const partial = spans.filter((s) => !(s.startMinutes === 0 && s.endMinutes === 1440))

  return (
    <div>
      <h2 className="display mb-4 text-2xl">
        {dayLabelForDateKey(date)}
        {isToday && <Badge tone="neutral" className="ml-3">Today</Badge>}
      </h2>

      {allDay.length > 0 && (
        <ul className="mb-4 space-y-2">
          {allDay.map((s, i) => (
            <li
              key={`${s.kind}-${i}`}
              className={`border-l-2 px-4 py-3 text-sm ${BLOCK_STYLES[s.kind]}`}
            >
              <span className="label-caps mr-2 text-[var(--color-muted)]">
                {BLOCK_LABELS[s.kind]}
              </span>
              {s.label !== BLOCK_LABELS[s.kind] && s.label}
            </li>
          ))}
        </ul>
      )}

      {!focusProvider && (
        <p className="mb-4 text-xs text-[var(--color-muted)]">
          Filter to one provider to see their working hours and time off shaded in.
        </p>
      )}

      <div className="space-y-1 border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        {hours.map(hour => {
          const timeString = `${String(hour).padStart(2, '0')}:00`
          const hourAppointments = dayAppointments.filter(a => {
            const apptTime = formatTimeInTimeZone(new Date(a.starts_at), timezone)
            const apptHour = parseInt(apptTime.split(':')[0])
            return apptHour === hour
          })

          const hourSpans = spansOverlappingHour(partial, hour)
          const cover = hourSpans[0]

          return (
            <div
              key={hour}
              className={`flex min-h-16 gap-4 border-t border-[var(--color-border)] py-2 first:border-t-0 ${
                cover ? BLOCK_STYLES[cover.kind] : ''
              }`}
              title={cover ? `${cover.label} · ${formatSpan(cover)}` : undefined}
            >
              <div className="w-20 pt-1 text-sm text-[var(--color-muted)] tabular-nums">
                {timeString}
              </div>
              <div className="flex-1">
                {hourAppointments.length > 0 ? (
                  <div className="space-y-2">
                    {hourAppointments.map(appt => {
                      const client = appt.profiles
                      const name = client
                        ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
                        : `${appt.guest_first_name ?? ''} ${appt.guest_last_name ?? ''}`.trim()
                      const service = ((appt.appointment_services ?? []) as Array<{name_snapshot: string, sort_order: number}>)
                        .sort((x, z) => x.sort_order - z.sort_order)[0]?.name_snapshot
                      const providerColor = getProviderColor(appt.provider_id, providers)

                      return (
                        <button
                          key={appt.id}
                          onClick={() => onAppointmentClick(appt)}
                          className={`block w-full border-l-4 p-3 text-left text-sm transition-all hover:shadow-md ${providerColor}`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <p className="font-medium">{name || 'Guest'}</p>
                              <p className="text-xs text-[var(--color-muted)]">{service}</p>
                              <p className="mt-1 text-xs tabular-nums text-[var(--color-muted)]">
                                {formatTimeInTimeZone(new Date(appt.starts_at), timezone)} - {formatTimeInTimeZone(new Date(appt.ends_at), timezone)}
                              </p>
                            </div>
                            <span className="text-xs font-medium tabular-nums">
                              {formatMoney(appt.total_cents)}
                            </span>
                          </div>
                        </button>
                      )
                    })}
                  </div>
                ) : onSlotClick ? (
                  <button
                    onClick={() => onSlotClick(date, timeString)}
                    className="w-full text-left text-sm text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                  >
                    —
                  </button>
                ) : (
                  <p className="text-sm text-[var(--color-muted)]">—</p>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// Week View Component
interface WeekViewProps {
  schedules: ProviderSchedule[]
  blocks: AvailabilityBlockRow[]
  busy: CalendarBusyRow[]
  closures: ClosureRow[]
  focusProvider: string | null
  startDate: string
  appointments: CalendarAppointment[]
  providers: Provider[]
  timezone: string
  todayKey: string
  onAppointmentClick: (appointment: CalendarAppointment) => void
  onSlotClick?: (date: string, time: string) => void
}

function WeekView({
  startDate,
  appointments,
  providers,
  timezone,
  todayKey,
  schedules,
  blocks,
  busy,
  closures,
  focusProvider,
  onAppointmentClick,
}: WeekViewProps) {
  const days = Array.from({ length: 7 }, (_, i) => addDaysToDateKey(startDate, i))

  const byDay = new Map<string, CalendarAppointment[]>()
  for (const a of appointments) {
    const key = dateKeyInTimeZone(new Date(a.starts_at), timezone)
    byDay.set(key, [...(byDay.get(key) ?? []), a])
  }

  return (
    <div className="grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] md:grid-cols-2 xl:grid-cols-7">
      {days.map(key => {
        const list = byDay.get(key) ?? []
        const [, , d] = key.split('-').map(Number)
        const dow = dayOfWeekForDateKey(key)
        const isToday = key === todayKey

        // Why this day is (partly) unavailable, summarised in a line.
        const daySpans = blockedSpansForDay(key, timezone, {
          providerId: focusProvider,
          schedules,
          blocks,
          busy,
          closures,
        })
        const notable = daySpans.filter((s) => s.kind !== 'off_hours')
        const fullyOff = daySpans.some(
          (s) => s.startMinutes === 0 && s.endMinutes === 1440
        )

        return (
          <div
            key={key}
            className={`min-h-48 p-3 ${
              fullyOff ? 'bg-[var(--color-linen)] dark:bg-[var(--color-surface)]' : 'bg-[var(--color-background)]'
            }`}
          >
            <p
              className={`label-caps mb-3 flex items-baseline justify-between ${
                isToday ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'
              }`}
            >
              <span>{DAY_NAMES[dow]}</span>
              <span className="text-sm tracking-normal">{d}</span>
            </p>

            {/* Time that is off, so an empty day reads as a reason rather than
                just an absence. */}
            {notable.length > 0 && (
              <ul className="mb-2 space-y-1">
                {notable.map((sp, i) => (
                  <li
                    key={`${sp.kind}-${i}`}
                    className={`border-l-2 px-2 py-1 text-[0.6875rem] leading-tight ${BLOCK_STYLES[sp.kind]}`}
                    title={`${sp.label} · ${formatSpan(sp)}`}
                  >
                    <span className="block truncate">{sp.label}</span>
                    <span className="block text-[var(--color-muted)]">{formatSpan(sp)}</span>
                  </li>
                ))}
              </ul>
            )}

            {list.length === 0 ? (
              <p className="text-xs text-[var(--color-muted)]">
                {notable.length > 0 ? '' : '—'}
              </p>
            ) : (
              <ul className="space-y-2">
                {list.map(appt => {
                  const client = appt.profiles
                  const name = client
                    ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
                    : `${appt.guest_first_name ?? ''} ${appt.guest_last_name ?? ''}`.trim()
                  const service = ((appt.appointment_services ?? []) as Array<{name_snapshot: string, sort_order: number}>)
                    .sort((x, z) => x.sort_order - z.sort_order)[0]?.name_snapshot
                  const providerColor = getProviderColor(appt.provider_id, providers)

                  return (
                    <li key={appt.id}>
                      <button
                        onClick={() => onAppointmentClick(appt)}
                        className={`block w-full border-l-2 p-2 text-left text-xs transition-colors hover:shadow-sm ${providerColor}`}
                      >
                        <span className="block tabular-nums">
                          {formatTimeInTimeZone(new Date(appt.starts_at), timezone)}
                        </span>
                        <span className="mt-0.5 block truncate">{name || 'Guest'}</span>
                        <span className="mt-0.5 block truncate text-[var(--color-muted)]">
                          {service}
                        </span>
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        )
      })}
    </div>
  )
}

// Month View Component
interface MonthViewProps {
  month: string // YYYY-MM-DD format (first day of month)
  appointments: CalendarAppointment[]
  providers: Provider[]
  timezone: string
  todayKey: string
  onAppointmentClick: (appointment: CalendarAppointment) => void
  onDayClick: (date: string) => void
}

function MonthView({ month, appointments, providers, timezone, todayKey, onAppointmentClick, onDayClick }: MonthViewProps) {
  const [year, monthNum] = month.split('-').map(Number)
  
  // Get first and last day of month
  const firstDay = new Date(Date.UTC(year, monthNum - 1, 1))
  const lastDay = new Date(Date.UTC(year, monthNum, 0))
  const daysInMonth = lastDay.getUTCDate()
  
  // Which column the 1st sits in. Derived from the date KEY, not from an
  // instant: Date.UTC(2026, 7, 1) is midnight UTC, which in Pacific is
  // 31 July at 5pm — a Friday — so converting it through the timezone put
  // every day of the month one column to the left.
  const startDow = dayOfWeekForDateKey(`${month}-01`)
  
  // Calculate total cells needed
  const totalCells = startDow + daysInMonth
  const rows = Math.ceil(totalCells / 7)
  
  const byDay = new Map<string, CalendarAppointment[]>()
  for (const a of appointments) {
    const key = dateKeyInTimeZone(new Date(a.starts_at), timezone)
    byDay.set(key, [...(byDay.get(key) ?? []), a])
  }

  const monthLabel = monthLabelForDateKey(month)

  return (
    <div>
      <h2 className="display mb-4 text-2xl">{monthLabel}</h2>
      
      {/* Day headers */}
      <div className="grid grid-cols-7 gap-px border border-[var(--color-border)] bg-[var(--color-border)]">
        {DAY_NAMES.map(name => (
          <div key={name} className="bg-[var(--color-surface)] p-2 text-center">
            <span className="label-caps text-xs text-[var(--color-muted)]">{name}</span>
          </div>
        ))}
      </div>

      {/* Calendar grid */}
      <div className="mt-px grid grid-cols-7 gap-px border-x border-b border-[var(--color-border)] bg-[var(--color-border)]">
        {Array.from({ length: rows * 7 }).map((_, i) => {
          const dayNum = i - startDow + 1
          const isValidDay = dayNum >= 1 && dayNum <= daysInMonth
          
          if (!isValidDay) {
            return <div key={i} className="min-h-24 bg-[var(--color-linen)] dark:bg-[var(--color-ink)]" />
          }

          const dateKey = `${year}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`
          const dayAppointments = byDay.get(dateKey) ?? []
          const isToday = dateKey === todayKey

          return (
            <button
              key={i}
              onClick={() => onDayClick(dateKey)}
              className="group min-h-24 bg-[var(--color-background)] p-2 text-left transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]"
            >
              <p className={`mb-2 text-sm ${isToday ? 'flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-accent)] text-[var(--color-accent-fg)]' : 'text-[var(--color-muted)]'}`}>
                {dayNum}
              </p>
              {dayAppointments.length > 0 && (
                <div className="space-y-1">
                  {dayAppointments.slice(0, 3).map(appt => {
                    const providerColor = getProviderColor(appt.provider_id, providers)
                    return (
                      <div
                        key={appt.id}
                        onClick={(e) => {
                          e.stopPropagation()
                          onAppointmentClick(appt)
                        }}
                        className={`border-l-2 px-1 py-0.5 text-xs transition-all hover:shadow-sm ${providerColor}`}
                      >
                        <span className="block truncate tabular-nums">
                          {formatTimeInTimeZone(new Date(appt.starts_at), timezone)}
                        </span>
                      </div>
                    )
                  })}
                  {dayAppointments.length > 3 && (
                    <p className="text-xs text-[var(--color-muted)]">
                      +{dayAppointments.length - 3} more
                    </p>
                  )}
                </div>
              )}
            </button>
          )
        })}
      </div>
    </div>
  )
}
