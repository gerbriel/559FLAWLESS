'use client'

import * as React from 'react'
import { CircleDashed } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Panel } from '@/components/ui/dashboard'
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
  type BlockKind,
} from '@/lib/calendar-blocks'
import { cn, formatMoney } from '@/lib/utils'
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
  formatTimeInTimeZone,
  dayOfWeekForDateKey,
  dayLabelForDateKey,
  monthLabelForDateKey,
  zonedParts,
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

/**
 * First and last hour rows, matching the drag board exactly. The two grids draw
 * the same week, and a booking that fell inside one and outside the other would
 * appear and disappear as the pointer changed.
 */
const FIRST_HOUR = 8
const LAST_HOUR = 20

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

/**
 * A booking that is holding a time nobody has agreed to yet.
 *
 * `pending` is the only status that means this, and it is not a quiet state.
 * The row occupies its slot against the GiST exclusion constraint and against
 * availability exactly as a confirmed one does, so it has to be drawn. There
 * are two ways to get this wrong and they pull in opposite directions: draw it
 * so faintly that a provider reads the time as free and books over it, or draw
 * it so confidently that the studio treats a request as a commitment the client
 * has never been given. The card below is trying to be occupied and provisional
 * at the same time, because that is what the row actually is.
 */
export function isAwaitingApproval(appointment: { status: AppointmentStatus }): boolean {
  return appointment.status === 'pending'
}

/**
 * Three channels mark a held-but-unapproved card, so that none of them has to
 * carry the distinction alone:
 *
 *  - a dashed rule and a dashed outline where a confirmed booking has solid
 *    ones — shape, which survives a colour vision deficiency and a greyscale
 *    day sheet off the printer;
 *  - a diagonal hatch over the provider's fill — texture, and the reason the
 *    card still reads as *occupied* rather than fading towards empty;
 *  - the words "Awaiting approval", visible wherever the view has room for them
 *    and in the tooltip and screen-reader text where it does not.
 *
 * Hue is deliberately not one of them. The provider's colour is left exactly as
 * it is: whose booking this is and whether it has been approved are two
 * separate questions, and one colour cannot answer both.
 *
 * Exported because the drag board draws its own cards and has to agree with
 * these — a second, hand-rolled idea of what pending looks like is how the two
 * halves of the diary end up disagreeing about whether a slot is real.
 */
export const PENDING_CARD_CLASS =
  'border-dashed outline-1 outline-dashed outline-[var(--color-muted)]/60 -outline-offset-1'

/**
 * The hatch itself.
 *
 * `background-image` rather than `background-color`, so it layers *over* the
 * provider's tint instead of replacing it — the tint is how you tell whose
 * booking it is, and losing it would trade one distinction for another.
 * `color-mix` on `--color-muted` rather than a literal, because that token is
 * a mid-tone on both the porcelain and the espresso surface, so the same rule
 * stays legible in light and dark without a second selector.
 */
export const PENDING_HATCH: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(135deg, transparent 0 5px, color-mix(in srgb, var(--color-muted) 30%, transparent) 5px 6px)',
}

/**
 * Said the same way in the tooltip everywhere, including on the drag board.
 * It belongs on the card, once — the mark below deliberately carries no title
 * of its own so hovering the icon and hovering the card say one thing.
 */
export const PENDING_TITLE =
  'Awaiting approval — the time is held, but the client has not been confirmed'

/**
 * The words, at whatever size the view can afford.
 *
 * `showLabel={false}` is for the month grid, where a cell is a seventh of a row
 * and there is genuinely nowhere to put four syllables. It keeps the icon and
 * moves the label into screen-reader text, so the state is still *stated* —
 * dropping to a bare glyph would put the whole distinction back on something
 * someone might not recognise.
 */
export function PendingMark({
  showLabel = true,
  className = '',
}: {
  showLabel?: boolean
  className?: string
}) {
  return (
    <span className={`inline-flex items-center gap-1 text-[var(--color-muted)] ${className}`}>
      <CircleDashed className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden />
      <span className={showLabel ? 'label-caps text-[0.5625rem]' : 'sr-only'}>
        Awaiting approval
      </span>
    </span>
  )
}

/**
 * Time that is not on offer, drawn as texture rather than as a flat wash.
 *
 * An empty hour and an unbookable hour look identical when both are blank, and
 * staff read the difference all day — "nothing booked yet" and "cannot be
 * booked" call for opposite reactions. The hatch says the second out loud, and
 * it says it in a way a flat grey cannot: grey is a colour the eye files as
 * background, texture is a colour the eye files as a surface with a rule about
 * it.
 *
 * Built from `--color-border`, which is why it needs no dark-mode twin — it is
 * the line the panel edges are already drawn with, so it lands at the same
 * weight against porcelain and against espresso.
 *
 * The angle is deliberately 45°, against PENDING_HATCH's 135°. A pending card
 * can sit inside an unavailable hour (someone requested a time the provider
 * does not work), and two hatches leaning the same way would read as one.
 */
export const UNAVAILABLE_HATCH: React.CSSProperties = {
  backgroundImage:
    'repeating-linear-gradient(45deg, var(--color-border) 0 1px, transparent 1px 7px)',
}

/** A span covering midnight to midnight is a fact about the day, not an hour. */
function isAllDay(span: BlockedSpan): boolean {
  return span.startMinutes === 0 && span.endMinutes === 1440
}

function clientNameOf(appt: CalendarAppointment): string {
  const client = appt.profiles
  const name = client
    ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
    : `${appt.guest_first_name ?? ''} ${appt.guest_last_name ?? ''}`.trim()
  return name || 'Guest'
}

function serviceNameOf(appt: CalendarAppointment): string {
  const lines = (appt.appointment_services ?? []) as Array<{
    name_snapshot: string
    sort_order?: number
  }>
  return (
    [...lines].sort((x, z) => (x.sort_order ?? 0) - (z.sort_order ?? 0))[0]?.name_snapshot ?? ''
  )
}

/**
 * Which hour row a booking belongs in, as the studio's clock reads it.
 *
 * Through `zonedParts` rather than by parsing the formatted time: that string
 * is '9:00 AM', so splitting it on the colon put every afternoon booking in a
 * morning row or in no row at all. The viewer's own machine may be somewhere
 * else again, which is the other reason this is not `getHours()`.
 */
function wallHour(appt: CalendarAppointment, timezone: string): number {
  return zonedParts(new Date(appt.starts_at), timezone).hour
}

/**
 * The calendar's working surface.
 *
 * Grid only. The month, the date, the view switcher and the staff filter have
 * moved into `CalendarToolbar`, composed by `CalendarClient` — they were three
 * clusters this component drew for itself, and the eye had nowhere to return
 * to. The props are unchanged: `onViewChange` is still wanted here, because
 * clicking a day in the month grid opens it in day view.
 */
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
}: CalendarViewProps) {
  const filteredAppointments = React.useMemo(() => {
    if (selectedProviders.length === 0) return appointments
    return appointments.filter(a => selectedProviders.includes(a.provider_id))
  }, [appointments, selectedProviders])

  // Not a legend — the calendar has never had one and this is not the place to
  // invent one. It is the existing count line answering the one question the
  // cards raise once they stop looking alike: how many of these has nobody
  // agreed to yet.
  const pendingCount = React.useMemo(
    () => filteredAppointments.filter(isAwaitingApproval).length,
    [filteredAppointments]
  )

  const todayKey = dateKeyInTimeZone(new Date(), timezone)

  // Whose hours to shade. With several people on screen there is no single
  // answer, so `blockedSpansForDay` falls back to studio-wide closures — an
  // hour one esthetician has off is not an hour the studio is shut.
  const focusProvider = selectedProviders.length === 1 ? selectedProviders[0] : null

  const spansFor = React.useCallback(
    (dateKey: string) =>
      blockedSpansForDay(dateKey, timezone, {
        providerId: focusProvider,
        schedules,
        blocks,
        busy,
        closures,
      }),
    [timezone, focusProvider, schedules, blocks, busy, closures]
  )

  const days =
    view === 'day'
      ? [currentDate]
      : Array.from({ length: 7 }, (_, i) => addDaysToDateKey(currentDate, i))

  return (
    <div>
      {view !== 'month' && !focusProvider && (
        <p className="mb-3 text-xs text-[var(--color-muted)]">
          Filter to one provider to see their working hours and time off shaded in.
        </p>
      )}

      {view === 'month' ? (
        <MonthView
          month={currentDate}
          appointments={filteredAppointments}
          providers={providers}
          timezone={timezone}
          closures={closures}
          todayKey={todayKey}
          onAppointmentClick={onAppointmentClick}
          onDayClick={(date) => {
            onDateChange(date)
            onViewChange('day')
          }}
        />
      ) : (
        <HourGrid
          days={days}
          todayKey={todayKey}
          appointments={filteredAppointments}
          providers={providers}
          timezone={timezone}
          spansFor={spansFor}
          detailed={view === 'day'}
          onAppointmentClick={onAppointmentClick}
          onSlotClick={onSlotClick}
        />
      )}

      {/* Summary */}
      <div className="mt-6 flex flex-wrap items-center gap-6 text-sm text-[var(--color-muted)]">
        <span>{filteredAppointments.length} appointments</span>
        <span className="tabular-nums">
          {formatMoney(filteredAppointments.reduce((n, a) => n + a.total_cents, 0))} total
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
    </div>
  )
}

/* ── The day and week grid ────────────────────────────────── */

interface HourGridProps {
  /** One column per day. A day view is a week of one. */
  days: string[]
  todayKey: string
  appointments: CalendarAppointment[]
  providers: Provider[]
  timezone: string
  spansFor: (dateKey: string) => BlockedSpan[]
  /** A day column has room for the service and the price; a week column does not. */
  detailed: boolean
  onAppointmentClick: (appointment: CalendarAppointment) => void
  onSlotClick?: (date: string, time: string) => void
}

/**
 * Seven columns, the hours down the left, and the reason for every gap drawn
 * into the gap itself.
 *
 * The week used to be seven stacked lists, which answered "what is on" but not
 * "when am I free" — the two questions staff actually alternate between. An
 * hour grid answers both at a glance, and it is the same shape as the drag
 * board, so switching between a touch screen and a desk does not switch
 * calendars.
 */
function HourGrid({
  days,
  todayKey,
  appointments,
  providers,
  timezone,
  spansFor,
  detailed,
  onAppointmentClick,
  onSlotClick,
}: HourGridProps) {
  const hours = Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, i) => i + FIRST_HOUR)

  const columns = days.map((dateKey) => {
    const spans = spansFor(dateKey)
    return {
      dateKey,
      dayNumber: Number(dateKey.split('-')[2]),
      weekday: DAY_NAMES[dayOfWeekForDateKey(dateKey)],
      isToday: dateKey === todayKey,
      allDay: spans.filter(isAllDay),
      partial: spans.filter((s) => !isAllDay(s)),
    }
  })

  const template = `4.5rem repeat(${columns.length}, minmax(9rem, 1fr))`

  // The grid runs 08:00–20:59. A booking outside it has to be shown somewhere,
  // or a seven o'clock facial would exist only in the database.
  const offGrid = appointments.filter((appt) => {
    if (!days.includes(dateKeyInTimeZone(new Date(appt.starts_at), timezone))) return false
    const hour = wallHour(appt, timezone)
    return hour < FIRST_HOUR || hour > LAST_HOUR
  })

  // Only name the states actually on screen. A key listing four of them when
  // the week has one is noise.
  const kindsShown = new Set<BlockKind>()
  for (const column of columns) {
    for (const span of [...column.allDay, ...column.partial]) kindsShown.add(span.kind)
  }

  return (
    <div>
      <Panel className="overflow-hidden p-0">
        <div className="overflow-x-auto">
          {/* Seven columns need more width than a phone has, so the week
              scrolls sideways rather than crushing each day to a thumbnail. A
              single day fits, and is not made to scroll for the sake of it. */}
          <div className={columns.length > 1 ? 'min-w-3xl' : ''}>
            {/* The date over the weekday, today's number in accent. */}
            <div className="grid" style={{ gridTemplateColumns: template }}>
              <div />
              {columns.map((column) => (
                <div
                  key={column.dateKey}
                  className="border-l border-[var(--color-border)] px-2 py-4 text-center"
                >
                  <span
                    className={cn(
                      'display block text-2xl leading-none tabular-nums',
                      column.isToday && 'text-[var(--color-accent)]'
                    )}
                  >
                    {column.dayNumber}
                  </span>
                  <span
                    className={cn(
                      'label-caps mt-1.5 block',
                      column.isToday ? 'text-[var(--color-accent)]' : 'text-[var(--color-muted)]'
                    )}
                  >
                    {column.weekday}
                  </span>

                  {/* A whole day off belongs under the date, not smeared down
                      thirteen rows. */}
                  {column.allDay.map((span, i) => (
                    <span
                      key={`${span.kind}-${i}`}
                      title={`${span.label} · ${formatSpan(span)}`}
                      className={cn(
                        'mt-2 block truncate rounded-[var(--radius-control)] border-l-2 px-1.5 py-0.5 text-left text-[0.6875rem] leading-tight',
                        BLOCK_STYLES[span.kind]
                      )}
                      style={UNAVAILABLE_HATCH}
                    >
                      {span.label}
                    </span>
                  ))}
                </div>
              ))}
            </div>

            {hours.map((hour) => {
              const timeString = `${String(hour).padStart(2, '0')}:00`

              return (
                <div
                  key={hour}
                  className="grid border-t border-[var(--color-border)]"
                  style={{ gridTemplateColumns: template }}
                >
                  <div className="px-3 py-2 text-xs tabular-nums text-[var(--color-muted)]">
                    {timeString}
                  </div>

                  {columns.map((column) => {
                    // An hour-by-hour reason wins over the day-wide one, because
                    // it is the more specific answer to "why not then".
                    const shade =
                      spansOverlappingHour(column.partial, hour)[0] ?? column.allDay[0]

                    const here = appointments.filter(
                      (appt) =>
                        dateKeyInTimeZone(new Date(appt.starts_at), timezone) ===
                          column.dateKey && wallHour(appt, timezone) === hour
                    )

                    // The reason, written into the first hour it covers, when
                    // it is a reason someone typed — "Dentist", a closure's
                    // note. The generic ones say nothing the hatch has not
                    // already said, and repeating "Outside working hours" down
                    // a column is how a grid becomes wallpaper. A tooltip
                    // alone would have hidden the specific ones behind a hover
                    // nobody thinks to try.
                    const namedReason =
                      shade &&
                      !isAllDay(shade) &&
                      shade.label !== BLOCK_LABELS[shade.kind] &&
                      Math.floor(shade.startMinutes / 60) === hour
                        ? shade.label
                        : null

                    return (
                      <div
                        key={column.dateKey}
                        className={cn(
                          'min-h-16 border-l border-[var(--color-border)] p-1.5',
                          shade && BLOCK_STYLES[shade.kind]
                        )}
                        style={shade ? UNAVAILABLE_HATCH : undefined}
                        title={shade ? `${shade.label} · ${formatSpan(shade)}` : undefined}
                      >
                        {namedReason && (
                          <span className="mb-1 block truncate text-[0.625rem] leading-tight text-[var(--color-muted)]">
                            {namedReason}
                          </span>
                        )}

                        {here.length > 0 ? (
                          <div className="space-y-1.5">
                            {here.map((appt) => (
                              <AppointmentCard
                                key={appt.id}
                                appointment={appt}
                                providers={providers}
                                timezone={timezone}
                                detailed={detailed}
                                onClick={onAppointmentClick}
                              />
                            ))}
                          </div>
                        ) : onSlotClick ? (
                          <button
                            type="button"
                            onClick={() => onSlotClick(column.dateKey, timeString)}
                            aria-label={`Book ${dayLabelForDateKey(column.dateKey)} at ${timeString}`}
                            className="flex min-h-11 w-full items-center rounded-[var(--radius-control)] px-2 text-xs text-transparent transition-colors hover:bg-[var(--color-accent)]/10 hover:text-[var(--color-accent)] focus-visible:text-[var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
                          >
                            <span aria-hidden>+ Book</span>
                          </button>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              )
            })}
          </div>
        </div>
      </Panel>

      {offGrid.length > 0 && (
        <Panel className="mt-4 p-4">
          <p className="label-caps text-[var(--color-muted)]">
            Outside the {String(FIRST_HOUR).padStart(2, '0')}:00–
            {String(LAST_HOUR).padStart(2, '0')}:59 grid
          </p>
          <div className="mt-3 space-y-2">
            {offGrid.map((appt) => (
              <AppointmentCard
                key={appt.id}
                appointment={appt}
                providers={providers}
                timezone={timezone}
                detailed
                onClick={onAppointmentClick}
              />
            ))}
          </div>
        </Panel>
      )}

      {/* What the hatching means. The texture says "not offered"; the tint says
          which of the four reasons it is. */}
      {kindsShown.size > 0 && (
        <ul className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[var(--color-muted)]">
          {(['closed', 'blocked', 'external', 'off_hours'] as const)
            .filter((kind) => kindsShown.has(kind))
            .map((kind) => (
              <li key={kind} className="flex items-center gap-2">
                <span
                  aria-hidden
                  className={cn(
                    'block h-3.5 w-6 rounded-[var(--radius-control)] border',
                    BLOCK_STYLES[kind]
                  )}
                  style={UNAVAILABLE_HATCH}
                />
                {BLOCK_LABELS[kind]}
              </li>
            ))}
        </ul>
      )}
    </div>
  )
}

/** One booking, in a grid cell or in the off-grid list under it. */
function AppointmentCard({
  appointment,
  providers,
  timezone,
  detailed,
  onClick,
}: {
  appointment: CalendarAppointment
  providers: Provider[]
  timezone: string
  detailed: boolean
  onClick: (appointment: CalendarAppointment) => void
}) {
  const pending = isAwaitingApproval(appointment)

  return (
    <button
      type="button"
      onClick={() => onClick(appointment)}
      style={pending ? PENDING_HATCH : undefined}
      title={pending ? PENDING_TITLE : undefined}
      className={cn(
        'block w-full rounded-[var(--radius-control)] border-l-4 p-2 text-left transition-shadow hover:shadow-md',
        getProviderColor(appointment.provider_id, providers),
        pending && PENDING_CARD_CLASS
      )}
    >
      <span className="block truncate text-xs tabular-nums text-[var(--color-muted)]">
        {formatTimeInTimeZone(new Date(appointment.starts_at), timezone)}
        {detailed && (
          <>
            {' – '}
            {formatTimeInTimeZone(new Date(appointment.ends_at), timezone)}
          </>
        )}
      </span>
      <span className="mt-0.5 block truncate text-sm">{clientNameOf(appointment)}</span>
      <span className="mt-0.5 block truncate text-xs text-[var(--color-muted)]">
        {serviceNameOf(appointment)}
      </span>
      {detailed && (
        <span className="mt-1 block text-xs tabular-nums text-[var(--color-muted)]">
          {formatMoney(appointment.total_cents)}
        </span>
      )}
      {pending && <PendingMark className="mt-1" />}
    </button>
  )
}

/* ── The month ────────────────────────────────────────────── */

interface MonthViewProps {
  month: string // YYYY-MM-DD format (first day of month)
  appointments: CalendarAppointment[]
  providers: Provider[]
  timezone: string
  /** Only studio-wide closures. A month square has no room to say whose. */
  closures: ClosureRow[]
  todayKey: string
  onAppointmentClick: (appointment: CalendarAppointment) => void
  onDayClick: (date: string) => void
}

function MonthView({
  month,
  appointments,
  providers,
  timezone,
  closures,
  todayKey,
  onAppointmentClick,
  onDayClick,
}: MonthViewProps) {
  const [year, monthNum] = month.split('-').map(Number)

  // Get the length of the month
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

  const closedDays = new Map(closures.map((c) => [c.closure_date, c.reason]))

  return (
    <div>
      {/* The toolbar says "Aug" above this, and the date stepper carries the
          year — but a grid with no heading at all would leave the document
          outline with a gap where the month should be. */}
      <h2 className="sr-only">{monthLabelForDateKey(month)}</h2>

      <Panel className="overflow-hidden p-0">
        <div className="grid grid-cols-7">
          {DAY_NAMES.map(name => (
            <div key={name} className="px-2 py-3 text-center">
              <span className="label-caps text-[var(--color-muted)]">{name}</span>
            </div>
          ))}
        </div>

        <div className="grid grid-cols-7 border-t border-[var(--color-border)]">
          {Array.from({ length: rows * 7 }).map((_, i) => {
            const dayNum = i - startDow + 1
            const isValidDay = dayNum >= 1 && dayNum <= daysInMonth

            if (!isValidDay) {
              return (
                <div
                  key={i}
                  className="min-h-28 border-b border-l border-[var(--color-border)] first:border-l-0"
                  style={UNAVAILABLE_HATCH}
                />
              )
            }

            const dateKey = `${year}-${String(monthNum).padStart(2, '0')}-${String(dayNum).padStart(2, '0')}`
            const dayAppointments = byDay.get(dateKey) ?? []
            const isToday = dateKey === todayKey
            const closedReason = closedDays.get(dateKey)

            return (
              <button
                key={i}
                type="button"
                onClick={() => onDayClick(dateKey)}
                title={closedReason || undefined}
                className={cn(
                  'group min-h-28 border-b border-l border-[var(--color-border)] p-2 text-left transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]',
                  closedReason && BLOCK_STYLES.closed
                )}
                style={closedReason ? UNAVAILABLE_HATCH : undefined}
              >
                <span
                  className={cn(
                    'mb-2 flex h-7 w-7 items-center justify-center text-sm tabular-nums',
                    isToday
                      ? 'rounded-full bg-[var(--color-accent)] text-[var(--color-accent-fg)]'
                      : 'text-[var(--color-muted)]'
                  )}
                >
                  {dayNum}
                </span>

                {closedReason && (
                  <span className="mb-1 block truncate text-[0.6875rem] leading-tight">
                    {closedReason || BLOCK_LABELS.closed}
                  </span>
                )}

                {dayAppointments.length > 0 && (
                  <span className="block space-y-1">
                    {dayAppointments.slice(0, 3).map(appt => {
                      const providerColor = getProviderColor(appt.provider_id, providers)
                      const pending = isAwaitingApproval(appt)
                      return (
                        // Not a button, deliberately: the whole square already
                        // is one, and a focusable control inside a control is
                        // a worse answer than the one the square gives — it
                        // opens the day, where every card is a real button.
                        <span
                          key={appt.id}
                          onClick={(e) => {
                            e.stopPropagation()
                            onAppointmentClick(appt)
                          }}
                          style={pending ? PENDING_HATCH : undefined}
                          title={pending ? PENDING_TITLE : undefined}
                          className={cn(
                            'flex items-center gap-1 rounded-[var(--radius-control)] border-l-2 px-1.5 py-0.5 text-xs transition-all hover:shadow-sm',
                            providerColor,
                            pending && PENDING_CARD_CLASS
                          )}
                        >
                          <span className="block truncate tabular-nums">
                            {formatTimeInTimeZone(new Date(appt.starts_at), timezone)}
                          </span>
                          {/* A month cell is a seventh of a row: the icon and the
                              hatch carry it here, and the words are still there
                              for a screen reader and on hover. */}
                          {pending && <PendingMark showLabel={false} className="ml-auto" />}
                        </span>
                      )
                    })}
                    {dayAppointments.length > 3 && (
                      <span className="block text-xs text-[var(--color-muted)]">
                        +{dayAppointments.length - 3} more
                      </span>
                    )}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </Panel>
    </div>
  )
}
