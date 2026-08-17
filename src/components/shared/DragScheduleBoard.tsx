'use client'

import * as React from 'react'
import { GripVertical, CalendarClock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Select } from '@/components/ui/field'
import { formatMoney } from '@/lib/utils'
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
  dayLabelForDateKey,
  formatTimeInTimeZone,
  zonedTimeToUtc,
  zonedParts,
} from '@/lib/time'
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
} from '@/lib/calendar-blocks'
// The board draws its own cards, so it has to be handed the same idea of what
// "awaiting approval" looks like rather than growing a second one. CalendarView
// exports these for exactly this reason: on a machine with a pointer, day and
// week are drawn HERE and the calendar grid is never rendered, so a distinction
// that lives only over there is a distinction the studio never sees.
import {
  isAwaitingApproval,
  CALENDAR_DENSITY,
  CurrentTimeIndicator,
  DEFAULT_CALENDAR_DENSITY,
  PENDING_CARD_CLASS,
  PENDING_HATCH,
  PENDING_TITLE,
  PendingMark,
  type CalendarAppointment,
  type CalendarDensity,
} from './CalendarView'
import {
  useAppointmentMove,
  useDragCapable,
  dropSlotTime,
  appointmentMinutes,
  DROP_STEP_MINUTES,
} from './DragScheduleProvider'

/**
 * The day and week grid you can drag on.
 *
 * Two rules shape all of this. Dragging is a desktop gesture — on a phone it
 * competes with the scroll it shares a starting motion with, so touch keeps
 * tap-to-open untouched. And dragging is never the *only* way to reschedule:
 * every card carries a Move button that opens the same operation as a form,
 * which is what makes the feature usable with a keyboard, a screen reader, or a
 * trackpad someone finds fiddly.
 *
 * The drop itself is only a proposal. It goes to
 * /api/appointments/[id]/move, which re-derives availability for the target
 * provider and lets the exclusion constraint settle the race — so the honest
 * description of the card sliding under the cursor is "optimistic", and it
 * comes back if the server says no.
 */

const DRAG_MIME = 'application/x-559-appointment'

/** First and last hour rows. The studio's book never runs outside these. */
const FIRST_HOUR = 8
const LAST_HOUR = 20

const QUARTERS = [0, 1, 2, 3]

// Same five as the calendar grid, so a provider keeps their colour when the
// view changes.
const PROVIDER_COLORS = [
  'bg-[var(--series-1)]/20 border-l-[var(--series-1)]',
  'bg-[var(--series-2)]/20 border-l-[var(--series-2)]',
  'bg-[var(--color-clay)]/20 border-l-[var(--color-clay)]',
  'bg-[var(--color-sage)]/20 border-l-[var(--color-sage)]',
  'bg-[var(--color-gold)]/20 border-l-[var(--color-gold)]',
]

export interface BoardProvider {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
}

export interface DragScheduleBoardProps {
  view: 'day' | 'week'
  currentDate: string
  appointments: CalendarAppointment[]
  providers: BoardProvider[]
  timezone: string
  schedules: ProviderSchedule[]
  blocks: AvailabilityBlockRow[]
  busy: CalendarBusyRow[]
  closures: ClosureRow[]
  /** Empty means "everyone". Mirrors the calendar's own filter. */
  selectedProviders: string[]
  todayKey: string
  /**
   * How tightly to draw it, shared with the calendar grid so the two surfaces
   * agree on an hour. This board is the one that made the book feel zoomed in:
   * four quarter-hour rows at a hard-coded `min-h-6` put an hour at 96px and
   * the 08:00–20:59 day at 1248px, of which under five hours reached a laptop.
   */
  density?: CalendarDensity
  onAppointmentClick: (appointment: CalendarAppointment) => void
  onSlotClick?: (date: string, time: string) => void
  onMoved?: () => void
}

function providerName(p: BoardProvider): string {
  return (
    p.display_name ||
    `${p.first_name ?? ''} ${p.last_name ?? ''}`.trim() ||
    'Provider'
  )
}

function clientName(a: CalendarAppointment): string {
  const client = a.profiles
  const name = client
    ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
    : `${a.guest_first_name ?? ''} ${a.guest_last_name ?? ''}`.trim()
  return name || 'Guest'
}

function serviceName(a: CalendarAppointment): string {
  const lines = (a.appointment_services ?? []) as Array<{
    name_snapshot: string
    sort_order?: number
  }>
  return [...lines].sort((x, z) => (x.sort_order ?? 0) - (z.sort_order ?? 0))[0]?.name_snapshot ?? ''
}

/** A booking that has already happened is history, not a thing to drag. */
function isMovable(a: CalendarAppointment): boolean {
  return a.status !== 'cancelled' && a.status !== 'completed' && a.status !== 'no_show'
}

export function DragScheduleBoard({
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
  todayKey,
  density = DEFAULT_CALENDAR_DENSITY,
  onAppointmentClick,
  onSlotClick,
  onMoved,
}: DragScheduleBoardProps) {
  const metrics = CALENDAR_DENSITY[density]
  const tight = !metrics.roomForDetail

  const canDrag = useDragCapable()
  const { appointments: shown, move, movingId, announcement, announce } = useAppointmentMove(
    appointments,
    { onMoved }
  )

  const [draggingId, setDraggingId] = React.useState<string | null>(null)
  const [hoverKey, setHoverKey] = React.useState<string | null>(null)
  const [allowOutsideHours, setAllowOutsideHours] = React.useState(false)
  const [moveTarget, setMoveTarget] = React.useState<CalendarAppointment | null>(null)

  const days = React.useMemo(
    () =>
      view === 'day'
        ? [currentDate]
        : Array.from({ length: 7 }, (_, i) => addDaysToDateKey(currentDate, i)),
    [view, currentDate]
  )

  const visible = React.useMemo(() => {
    const inRange = shown.filter((a) =>
      days.includes(dateKeyInTimeZone(new Date(a.starts_at), timezone))
    )
    if (selectedProviders.length === 0) return inRange
    return inRange.filter((a) => selectedProviders.includes(a.provider_id))
  }, [shown, days, timezone, selectedProviders])

  /**
   * Day view puts one column per provider so an appointment can be handed over
   * by dragging sideways. Anyone with work on the board gets a column even if
   * they have since been suspended — otherwise their bookings would simply not
   * be drawn, which is the worst possible way to learn about them.
   */
  const columnProviders = React.useMemo(() => {
    const base =
      selectedProviders.length === 0
        ? providers
        : providers.filter((p) => selectedProviders.includes(p.id))
    const known = new Set(base.map((p) => p.id))
    const extra: BoardProvider[] = []
    for (const a of visible) {
      if (known.has(a.provider_id)) continue
      known.add(a.provider_id)
      extra.push({
        id: a.provider_id,
        first_name: a.provider?.first_name ?? null,
        last_name: a.provider?.last_name ?? null,
        display_name: a.provider?.display_name ?? null,
      })
    }
    const all = [...base, ...extra]
    return all.length > 0 ? all : providers.slice(0, 1)
  }, [providers, selectedProviders, visible])

  const colorFor = React.useCallback(
    (providerId: string) => {
      const index = providers.findIndex((p) => p.id === providerId)
      return PROVIDER_COLORS[(index < 0 ? 0 : index) % PROVIDER_COLORS.length]
    },
    [providers]
  )

  const hours = React.useMemo(
    () => Array.from({ length: LAST_HOUR - FIRST_HOUR + 1 }, (_, i) => i + FIRST_HOUR),
    []
  )

  const offGrid = React.useMemo(
    () =>
      visible.filter((a) => {
        const minutes = wallMinutes(new Date(a.starts_at), timezone)
        return minutes < FIRST_HOUR * 60 || minutes >= (LAST_HOUR + 1) * 60
      }),
    [visible, timezone]
  )

  /** Columns are providers on a day, days on a week. */
  const columns = React.useMemo(
    () =>
      view === 'day'
        ? columnProviders.map((p) => ({
            key: p.id,
            label: providerName(p),
            dateKey: currentDate,
            providerId: p.id as string | null,
          }))
        : days.map((d) => ({
            key: d,
            label: dayLabelForDateKey(d).replace(/,[^,]*$/, ''),
            dateKey: d,
            providerId: null as string | null,
          })),
    [view, columnProviders, days, currentDate]
  )

  /**
   * One template for the header row and every hour, so they cannot fall out of
   * step. Both were carrying their own copy of `5rem repeat(n, minmax(9rem,
   * 1fr))` — two places to forget, and the columns would have shifted under the
   * headers the moment one of them moved.
   *
   * Narrower columns are half of what makes a tighter zoom worth having: seven
   * days at 9rem plus a 5rem gutter is 1088px and scrolls sideways inside the
   * dashboard's main column, where seven at 7.5rem plus 3.25rem is 892px and
   * does not.
   */
  const template = `${metrics.gutter} repeat(${columns.length}, minmax(${metrics.columnMin}, 1fr))`

  /**
   * The current-time line reads the clock itself — see `CurrentTimeIndicator`.
   * It is handed `columns` because what a column IS differs between the two
   * views and only this file knows: a week is seven dates, a day is one date
   * across several providers, so `key` and `dateKey` come apart on a day and
   * the indicator needs both. Nothing about "now" is computed at this level,
   * which is the point — a tick that reached here would re-render all 364 drop
   * cells to move a rule by a pixel.
   */

  /**
   * Why each column is (partly) unbookable. Computed per column rather than
   * once for the whole board: on a day view every column is a different
   * person's hours, and shading them all with one provider's would be a lie.
   */
  const shadingFor = React.useCallback(
    (dateKey: string, providerId: string | null) =>
      blockedSpansForDay(dateKey, timezone, {
        providerId:
          providerId ?? (selectedProviders.length === 1 ? selectedProviders[0] : null),
        schedules,
        blocks,
        busy,
        closures,
      }),
    [timezone, selectedProviders, schedules, blocks, busy, closures]
  )

  const dropAppointment = React.useCallback(
    async (
      appointment: CalendarAppointment,
      dateKey: string,
      time: string,
      providerId: string | null
    ) => {
      const startsAt = zonedTimeToUtc(dateKey, time, timezone)
      announce(
        `Moving ${clientName(appointment)} to ${dayLabelForDateKey(dateKey)} at ${time}.`
      )
      await move({
        appointment,
        startsAt,
        providerId: providerId ?? appointment.provider_id,
        override: allowOutsideHours,
      })
    },
    [move, timezone, allowOutsideHours, announce]
  )

  function handleDrop(
    e: React.DragEvent,
    dateKey: string,
    time: string,
    providerId: string | null
  ) {
    e.preventDefault()
    setHoverKey(null)
    setDraggingId(null)
    const id = e.dataTransfer.getData(DRAG_MIME) || e.dataTransfer.getData('text/plain')
    const appointment = shown.find((a) => a.id === id)
    if (!appointment) return
    void dropAppointment(appointment, dateKey, time, providerId)
  }

  /**
   * `full` is the card that says everything — time, client, service, price;
   * anything else says the time and the client and stops.
   *
   * Two separate things narrow it, which is why the caller decides rather than
   * this function. A week column is *narrow*. A compact zoom is *short*. Either
   * is enough to drop the service and the price. The off-grid list below is
   * neither, so it asks for the full card whatever the zoom says.
   */
  const card = (a: CalendarAppointment, full: boolean) => {
    const movable = isMovable(a)
    const draggable = canDrag && movable
    const inFlight = movingId === a.id
    // Held for review. The card stays at full strength — a pending booking
    // holds its slot against the exclusion constraint exactly as a confirmed
    // one does, so anything that made it read as faint would invite a
    // double-booking. What changes is shape, texture and words.
    const pending = isAwaitingApproval(a)

    return (
      <div
        key={a.id}
        draggable={draggable}
        style={pending ? PENDING_HATCH : undefined}
        title={pending ? PENDING_TITLE : undefined}
        onDragStart={(e) => {
          e.dataTransfer.setData(DRAG_MIME, a.id)
          e.dataTransfer.setData('text/plain', a.id)
          e.dataTransfer.effectAllowed = 'move'
          setDraggingId(a.id)
          announce(`Picked up ${clientName(a)}. Drop it on a time, or press Escape.`)
        }}
        onDragEnd={() => {
          setDraggingId(null)
          setHoverKey(null)
        }}
        className={`group relative border-l-4 ${colorFor(a.provider_id)} ${
          pending ? PENDING_CARD_CLASS : ''
        } ${draggingId === a.id ? 'opacity-40' : ''} ${
          inFlight ? 'animate-pulse' : ''
        } ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
      >
        <button
          type="button"
          onClick={() => onAppointmentClick(a)}
          // `pr-8` either way: the Move button below is `w-8` and absolutely
          // placed at the right edge, so anything less than 2rem of reserved
          // padding lets the grip sit on top of the client's name.
          className={`block w-full text-left ${full ? 'p-2 pr-8' : 'px-1.5 py-1 pr-8'}`}
        >
          <span
            className={`flex items-center gap-1 tabular-nums text-[var(--color-muted)] ${
              full ? 'text-xs' : 'text-[0.6875rem] leading-tight'
            }`}
          >
            {/* The duration stays at every zoom. A card is not drawn to its
                length on this board, so "20 min" is the only thing telling you
                a brow wax is not a 90-minute peel. */}
            <span className="min-w-0 truncate">
              {formatTimeInTimeZone(new Date(a.starts_at), timezone)}
              {' · '}
              {appointmentMinutes(a)} min
            </span>
            {pending && !full && <PendingMark showLabel={false} className="ml-auto" />}
          </span>
          <span className={`mt-0.5 block truncate ${full ? 'text-sm' : 'text-xs leading-tight'}`}>
            {clientName(a)}
          </span>
          {full && (
            <span className="mt-0.5 block truncate text-xs text-[var(--color-muted)]">
              {serviceName(a)}
            </span>
          )}
          {full && (
            <span className="mt-1 block text-xs tabular-nums text-[var(--color-muted)]">
              {formatMoney(a.total_cents)}
            </span>
          )}
        </button>

        {/* The words, under the card's own content so they read as a note about
            it rather than as part of the client's name — but only where there
            is a line to spare. A narrow week column and a short compact row
            both take it away, and there the label rides the time line above
            instead, leaving the dashed ring, the hatch and the tooltip to carry
            a distinction that costs the card no height. */}
        {pending && full && <PendingMark className="px-2 pb-2" />}

        {movable && (
          <button
            type="button"
            onClick={() => setMoveTarget(a)}
            aria-haspopup="dialog"
            className="absolute right-0 top-0 flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-accent)] focus:opacity-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)]"
            title={`Move ${clientName(a)}`}
          >
            <GripVertical className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
            <span className="sr-only">Move {clientName(a)} to another time</span>
          </button>
        )}
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-4">
        <p className="text-xs text-[var(--color-muted)]">
          {canDrag ? (
            <>
              Drag an appointment to a new time
              {view === 'day' && columns.length > 1 ? ' or another provider' : ''}. Every card
              also has a <span className="whitespace-nowrap">Move</span> button.
            </>
          ) : (
            <>Tap an appointment for details, or use its Move button to reschedule.</>
          )}
        </p>

        <label className="flex cursor-pointer items-center gap-2 text-xs text-[var(--color-muted)]">
          <input
            type="checkbox"
            checked={allowOutsideHours}
            onChange={(e) => setAllowOutsideHours(e.target.checked)}
            className="h-4 w-4 accent-[var(--color-accent)]"
          />
          Allow times outside published hours
        </label>
      </div>

      <div className="overflow-x-auto border border-[var(--color-border)] bg-[var(--color-surface)]">
        <div className="min-w-3xl">
          {/* Column headers */}
          <div
            className="grid border-b border-[var(--color-border)]"
            style={{ gridTemplateColumns: template }}
          >
            <div className="p-2" />
            {columns.map((c) => (
              <div
                key={c.key}
                className={`border-l border-[var(--color-border)] ${tight ? 'px-2 py-1.5' : 'p-2'}`}
              >
                <span
                  className={`label-caps ${
                    c.dateKey === todayKey && view === 'week'
                      ? 'text-[var(--color-accent)]'
                      : 'text-[var(--color-muted)]'
                  }`}
                >
                  {c.label}
                </span>
              </div>
            ))}
          </div>

          {hours.map((hour) => (
            <div
              key={hour}
              // `relative` so the current-time line is positioned against THIS
              // hour. A row is four quarter-hour drop cells at `quarterPx`, but
              // only until a card lands in one and pushes it taller — a line
              // measured from the top of the board would slide off its own hour
              // on any day with bookings above it.
              className="relative grid border-b border-[var(--color-border)] last:border-b-0"
              style={{ gridTemplateColumns: template }}
            >
              <div
                className={`tabular-nums text-[var(--color-muted)] ${
                  tight ? 'px-2 py-1 text-[0.6875rem]' : 'p-2 text-xs'
                }`}
              >
                {String(hour).padStart(2, '0')}:00
              </div>

              {columns.map((c) => {
                const cover = spansOverlappingHour(
                  shadingFor(c.dateKey, c.providerId).filter(
                    (s) => !(s.startMinutes === 0 && s.endMinutes === 1440)
                  ),
                  hour
                )[0]

                return (
                  <div
                    key={c.key}
                    className={`border-l border-[var(--color-border)] ${
                      cover ? BLOCK_STYLES[cover.kind] : ''
                    }`}
                    title={cover ? `${cover.label} · ${formatSpan(cover)}` : undefined}
                  >
                    {QUARTERS.map((q) => {
                      const time = dropSlotTime(hour, q)
                      const key = `${c.key}|${time}`
                      const here = visible.filter((a) => {
                        if (c.providerId && a.provider_id !== c.providerId) return false
                        if (dateKeyInTimeZone(new Date(a.starts_at), timezone) !== c.dateKey) {
                          return false
                        }
                        const at = new Date(a.starts_at)
                        const wall = wallMinutes(at, timezone)
                        return (
                          wall >= hour * 60 + q * DROP_STEP_MINUTES &&
                          wall < hour * 60 + (q + 1) * DROP_STEP_MINUTES
                        )
                      })

                      return (
                        <div
                          key={key}
                          onDragOver={(e) => {
                            if (!e.dataTransfer.types.includes(DRAG_MIME)) return
                            e.preventDefault()
                            e.dataTransfer.dropEffect = 'move'
                            setHoverKey(key)
                          }}
                          onDragLeave={() => setHoverKey((k) => (k === key ? null : k))}
                          onDrop={(e) => handleDrop(e, c.dateKey, time, c.providerId)}
                          className={`flex flex-col border-t border-dashed border-transparent px-1 ${
                            hoverKey === key
                              ? 'bg-[var(--color-accent)]/15 border-[var(--color-accent)]'
                              : ''
                          }`}
                          // A quarter of the density's hour. This was `min-h-6`
                          // — 24px, so 96px an hour and 1248px a day — which is
                          // the number that made the book feel zoomed in.
                          style={{ minHeight: metrics.quarterPx }}
                          data-drop-time={time}
                        >
                          {here.length === 0 && onSlotClick ? (
                            <button
                              type="button"
                              onClick={() => onSlotClick(c.dateKey, time)}
                              // `flex-1 min-h-0` so it fills the drop row and
                              // never sets it: with its own padding it was 24px
                              // tall, which at a compact zoom would have made an
                              // hour with nothing in it taller than one with a
                              // booking.
                              //
                              // Rendered in EVERY empty quarter rather than only
                              // the first. Confining it to q === 0 left one
                              // quarter-row of the hour clickable and the other
                              // three inert — a target that shrank with the
                              // density and was invisible until the cursor was
                              // already on it. Per-quarter it is also more
                              // useful than it was: clicking at 10:45 books
                              // 10:45 rather than 10:00.
                              className={`flex min-h-0 flex-1 items-center text-left leading-none text-transparent hover:text-[var(--color-accent)] focus-visible:text-[var(--color-accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-accent)] ${
                                tight ? 'text-[0.6875rem]' : 'text-xs'
                              }`}
                              aria-label={`Book ${dayLabelForDateKey(c.dateKey)} at ${time}`}
                            >
                              <span aria-hidden>+ book</span>
                            </button>
                          ) : null}
                          {here.map((a) => card(a, view === 'day' && metrics.roomForDetail))}
                        </div>
                      )
                    })}
                  </div>
                )
              })}

              {/* After the columns in the DOM as well as above them in z: the
                  cards on this board are `relative`, so source order is what
                  settles it between two positioned siblings.

                  In every row, null in twelve of them — the hour test lives
                  inside, so the clock's subscription does too. */}
              <CurrentTimeIndicator
                hour={hour}
                timezone={timezone}
                template={template}
                columns={columns}
              />
            </div>
          ))}
        </div>
      </div>

      {/* Whole-day reasons, once, under the grid rather than smeared over it. */}
      <AllDayNotes
        columns={columns}
        shadingFor={shadingFor}
      />

      {/* The grid runs 08:00–20:59. Anything already booked outside it has to
          be shown somewhere, or a 7am facial would exist only in the database —
          and it needs a Move button most of all, since there is no row to drag
          it onto. */}
      {offGrid.length > 0 && (
        <div className="mt-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
          <p className="label-caps text-[var(--color-muted)]">
            Outside the {String(FIRST_HOUR).padStart(2, '0')}:00–
            {String(LAST_HOUR).padStart(2, '0')}:59 grid
          </p>
          {/* A list in a panel of its own: no row to fit inside and nothing
              below it to push down, so the zoom buys nothing here and these
              cards say everything regardless of it. */}
          <div className="mt-3 space-y-2">{offGrid.map((a) => card(a, true))}</div>
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {moveTarget && (
        <MoveDialog
          appointment={moveTarget}
          providers={columnProviders}
          timezone={timezone}
          busy={movingId === moveTarget.id}
          onClose={() => setMoveTarget(null)}
          onSubmit={async (dateKey, time, providerId, override) => {
            const ok = await move({
              appointment: moveTarget,
              startsAt: zonedTimeToUtc(dateKey, time, timezone),
              providerId,
              override,
            })
            if (ok) setMoveTarget(null)
            return ok
          }}
        />
      )}
    </div>
  )
}

/**
 * Minutes past midnight, as the studio's clock reads it.
 *
 * Through `zonedParts` rather than getHours(): the row an appointment belongs
 * in is a wall-clock question in the studio's zone, and the viewer's machine
 * may well be somewhere else.
 */
function wallMinutes(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone)
  return p.hour * 60 + p.minute
}

function AllDayNotes({
  columns,
  shadingFor,
}: {
  columns: Array<{ key: string; label: string; dateKey: string; providerId: string | null }>
  shadingFor: (dateKey: string, providerId: string | null) => ReturnType<typeof blockedSpansForDay>
}) {
  const notes = columns.flatMap((c) =>
    shadingFor(c.dateKey, c.providerId)
      .filter((s) => s.startMinutes === 0 && s.endMinutes === 1440)
      .map((s) => ({ column: c.label, span: s }))
  )
  if (notes.length === 0) return null

  return (
    <ul className="mt-4 space-y-2">
      {notes.map((n, i) => (
        <li
          key={`${n.column}-${i}`}
          className={`border-l-2 px-4 py-2 text-sm ${BLOCK_STYLES[n.span.kind]}`}
        >
          <span className="label-caps mr-2 text-[var(--color-muted)]">{n.column}</span>
          {n.span.label || BLOCK_LABELS[n.span.kind]}
        </li>
      ))}
    </ul>
  )
}

/**
 * Rescheduling without a mouse.
 *
 * This is not a courtesy fallback — it is the path that has to work when the
 * drag does not: a trackpad someone struggles with, a screen reader, a hand
 * that shakes, or simply moving a booking three weeks out, which no amount of
 * dragging will reach. It posts to the same route with the same rules.
 */
function MoveDialog({
  appointment,
  providers,
  timezone,
  busy,
  onClose,
  onSubmit,
}: {
  appointment: CalendarAppointment
  providers: BoardProvider[]
  timezone: string
  busy: boolean
  onClose: () => void
  onSubmit: (
    dateKey: string,
    time: string,
    providerId: string,
    override: boolean
  ) => Promise<boolean>
}) {
  const start = new Date(appointment.starts_at)
  const [dateKey, setDateKey] = React.useState(dateKeyInTimeZone(start, timezone))
  const [time, setTime] = React.useState(() => {
    const minutes = wallMinutes(start, timezone)
    return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  })
  const [providerId, setProviderId] = React.useState(appointment.provider_id)
  const [override, setOverride] = React.useState(false)
  const firstField = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    firstField.current?.focus()
  }, [])

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="move_dialog_title"
        onClick={(e) => e.stopPropagation()}
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
      >
        <h2 id="move_dialog_title" className="display flex items-center gap-2 text-2xl">
          <CalendarClock className="h-5 w-5 text-[var(--color-muted)]" strokeWidth={1.5} aria-hidden />
          Move appointment
        </h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {clientName(appointment)} — {serviceName(appointment) || 'appointment'}, currently{' '}
          {formatTimeInTimeZone(start, timezone)} on {dayLabelForDateKey(dateKeyInTimeZone(start, timezone))}.
        </p>

        <form
          className="mt-6 space-y-4"
          onSubmit={async (e) => {
            e.preventDefault()
            await onSubmit(dateKey, time, providerId, override)
          }}
        >
          <Field label="Date" htmlFor="move_date">
            <Input
              ref={firstField}
              id="move_date"
              type="date"
              required
              value={dateKey}
              onChange={(e) => setDateKey(e.target.value)}
            />
          </Field>

          <Field
            label="Start time"
            htmlFor="move_time"
            hint={`${appointmentMinutes(appointment)} minutes, in the studio's clock.`}
          >
            <Input
              id="move_time"
              type="time"
              step={DROP_STEP_MINUTES * 60}
              required
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </Field>

          {providers.length > 1 && (
            <Field label="Provider" htmlFor="move_provider">
              <Select
                id="move_provider"
                value={providerId}
                onChange={(e) => setProviderId(e.target.value)}
              >
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {providerName(p)}
                  </option>
                ))}
              </Select>
            </Field>
          )}

          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={override}
              onChange={(e) => setOverride(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Outside published hours
              <span className="block text-xs text-[var(--color-muted)]">
                Squeezing someone in. It still cannot land on top of another booking.
              </span>
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Button type="submit" size="sm" disabled={busy}>
              {busy ? 'Moving…' : 'Move'}
            </Button>
            <Button type="button" size="sm" variant="subtle" onClick={onClose}>
              Cancel
            </Button>
            {/* Named, not spelled out of the enum: "pending" in a neutral chip
                reads like a payment state, and the one thing whoever is moving
                this needs to know is that the client has not been told they
                have this booking at all. Moving it does send them "your
                appointment has moved" (038), which is why it is worth saying
                here rather than after. */}
            {isAwaitingApproval(appointment) ? (
              <Badge tone="warning" title={PENDING_TITLE}>
                Awaiting approval
              </Badge>
            ) : (
              <Badge tone="neutral">{appointment.status.replace('_', ' ')}</Badge>
            )}
          </div>
        </form>
      </div>
    </div>
  )
}
