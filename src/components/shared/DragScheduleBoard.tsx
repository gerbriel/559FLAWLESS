'use client'

import * as React from 'react'
import { GripVertical } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'
import {
  addDaysToDateKey,
  dateKeyInTimeZone,
  dayLabelForDateKey,
  formatTimeInTimeZone,
  zonedTimeToUtc,
  zonedParts,
  hourLabel,
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
import { MoveAppointmentDialog } from './MoveAppointmentDialog'

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

/**
 * Google's column-splitting, in miniature: appointments that overlap in time
 * share the column side by side instead of burying one another. A sweep over
 * start-sorted intervals assigns each the lowest free lane; a "cluster" is a
 * run with no gap of silence, and everyone in it divides the width by the
 * cluster's widest moment, so cards in the same visual group line up.
 */
function assignLanes(
  appts: Array<{ id: string; startMs: number; endMs: number }>
): Map<string, { lane: number; lanes: number }> {
  const result = new Map<string, { lane: number; lanes: number }>()
  const sorted = [...appts].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs)

  let active: Array<{ endMs: number; lane: number }> = []
  let cluster: string[] = []
  let clusterLanes = 0

  const flush = () => {
    for (const id of cluster) result.get(id)!.lanes = clusterLanes
    cluster = []
    clusterLanes = 0
  }

  for (const a of sorted) {
    active = active.filter((x) => x.endMs > a.startMs)
    if (active.length === 0 && cluster.length > 0) flush()
    const used = new Set(active.map((x) => x.lane))
    let lane = 0
    while (used.has(lane)) lane++
    active.push({ endMs: a.endMs, lane })
    result.set(a.id, { lane, lanes: 1 })
    cluster.push(a.id)
    clusterLanes = Math.max(clusterLanes, lane + 1)
  }
  if (cluster.length > 0) flush()

  return result
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

  /**
   * Touch: hold a card ~a third of a second and it lifts; drag the ghost, let
   * go on a quarter-hour, and the same confirm dialog asks the same question.
   *
   * HTML5 drag-and-drop simply does not exist on touch, so this is pointer
   * events end to end. The long press is what keeps scrolling honest: a finger
   * that moves early is a scroll and cancels the press (the browser's own
   * scroll fires pointercancel); a finger that holds still earns the lift, and
   * only THEN is native scrolling suppressed — via a non-passive touchmove
   * preventDefault, because pointer capture alone cannot stop a pan the
   * browser has decided to start.
   *
   * `x`/`y` are the lift point, written once for the ghost's first paint; the
   * per-pixel follow mutates the ghost's style directly so a 364-cell board is
   * not re-rendered per finger movement. Only crossing into a different
   * quarter-hour touches state.
   */
  const [touchDrag, setTouchDrag] = React.useState<{
    appointment: CalendarAppointment
    x: number
    y: number
    over: { key: string; dateKey: string; time: string; providerId: string | null } | null
  } | null>(null)
  const touchPress = React.useRef<{
    pointerId: number
    x: number
    y: number
    timer: number
  } | null>(null)
  const ghostRef = React.useRef<HTMLDivElement | null>(null)
  /** When a touch drag last ended — the click that follows pointerup must not
   *  open the appointment somebody just finished moving. */
  const dragEndedAt = React.useRef(0)


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
   * Side-by-side lanes for overlapping cards, per column. Keyed by the
   * column's own key because "overlapping" is a per-column question: on a day
   * view two providers' 2pms are different columns and never share a lane.
   */
  const laneByColumn = React.useMemo(() => {
    const out = new Map<string, Map<string, { lane: number; lanes: number }>>()
    for (const c of columns) {
      const colAppts = visible
        .filter(
          (a) =>
            (!c.providerId || a.provider_id === c.providerId) &&
            dateKeyInTimeZone(new Date(a.starts_at), timezone) === c.dateKey
        )
        .map((a) => ({
          id: a.id,
          startMs: new Date(a.starts_at).getTime(),
          endMs: new Date(a.ends_at).getTime(),
        }))
      if (colAppts.length > 0) out.set(c.key, assignLanes(colAppts))
    }
    return out
  }, [columns, visible, timezone])

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
  // Fits the screen like the month grid — see CalendarView's template note.
  const template = `min(${metrics.gutter}, 12vw) repeat(${columns.length}, minmax(2.25rem, 1fr))`

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

  /**
   * A drop proposes; the dialog commits. Between letting go and Confirm the
   * card stays where it was — nothing is optimistic about a change the client
   * is going to be emailed about, and Escape costs nothing.
   */
  const [pendingDrop, setPendingDrop] = React.useState<{
    appointment: CalendarAppointment
    startsAt: Date
    providerId: string
  } | null>(null)

  const dropAppointment = React.useCallback(
    (
      appointment: CalendarAppointment,
      dateKey: string,
      time: string,
      providerId: string | null
    ) => {
      const startsAt = zonedTimeToUtc(dateKey, time, timezone)
      const target = providerId ?? appointment.provider_id
      if (
        startsAt.getTime() === new Date(appointment.starts_at).getTime() &&
        target === appointment.provider_id
      ) {
        // Dropped back where it started — nothing to confirm.
        return
      }
      announce(
        `Confirm moving ${clientName(appointment)} to ${dayLabelForDateKey(dateKey)} at ${time}.`
      )
      setPendingDrop({ appointment, startsAt, providerId: target })
    },
    // setPendingDrop listed for the React Compiler: it infers setters as
    // dependencies and refuses to preserve a memo whose list disagrees.
    [timezone, announce, setPendingDrop]
  )

  // The touch drag's document-level half. Attached only while a card is
  // lifted; re-attached when the hovered quarter changes, which is the only
  // time `touchDrag` itself changes mid-drag.
  React.useEffect(() => {
    if (!touchDrag) return
    const { appointment, over } = touchDrag

    const move = (e: PointerEvent) => {
      const g = ghostRef.current
      if (g) {
        g.style.left = `${e.clientX}px`
        g.style.top = `${e.clientY}px`
      }
      // Google-style edge scroll: the grid is taller than the screen, and the
      // finger holding the card cannot also scroll.
      if (e.clientY < 90) window.scrollBy(0, -14)
      else if (e.clientY > window.innerHeight - 90) window.scrollBy(0, 14)

      const el = document.elementFromPoint(e.clientX, e.clientY)
      const cell = (el?.closest?.('[data-drop-cell]') ?? null) as HTMLElement | null
      if (!cell) {
        if (over) {
          setTouchDrag((d) => (d ? { ...d, over: null } : d))
          setHoverKey(null)
        }
        return
      }
      const key = cell.dataset.dropCell!
      if (over?.key === key) return
      const next = {
        key,
        dateKey: cell.dataset.dropDate!,
        time: cell.dataset.dropTime!,
        providerId: cell.dataset.dropProvider || null,
      }
      setTouchDrag((d) => (d ? { ...d, over: next } : d))
      setHoverKey(key)
    }

    const finish = (commit: boolean) => {
      dragEndedAt.current = Date.now()
      setTouchDrag(null)
      setHoverKey(null)
      if (commit && over) {
        dropAppointment(appointment, over.dateKey, over.time, over.providerId)
      }
    }
    const up = () => finish(true)
    const cancel = () => finish(false)
    const prevent = (e: TouchEvent) => e.preventDefault()

    document.addEventListener('pointermove', move)
    document.addEventListener('pointerup', up)
    document.addEventListener('pointercancel', cancel)
    document.addEventListener('touchmove', prevent, { passive: false })
    return () => {
      document.removeEventListener('pointermove', move)
      document.removeEventListener('pointerup', up)
      document.removeEventListener('pointercancel', cancel)
      document.removeEventListener('touchmove', prevent)
    }
  }, [touchDrag, dropAppointment])

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
    dropAppointment(appointment, dateKey, time, providerId)
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
  const card = (a: CalendarAppointment, full: boolean, heightPx?: number) => {
    const movable = isMovable(a)
    const draggable = canDrag && movable
    const inFlight = movingId === a.id
    // Held for review. The card stays at full strength — a pending booking
    // holds its slot against the exclusion constraint exactly as a confirmed
    // one does, so anything that made it read as faint would invite a
    // double-booking. What changes is shape, texture and words.
    const pending = isAwaitingApproval(a)
    // Drawn to its minutes now, so a 15-minute card at a compact zoom is a
    // sliver: one line, and the tooltip carries what the sliver cannot.
    const oneLine = heightPx !== undefined && heightPx < 36

    return (
      <div
        key={a.id}
        draggable={draggable}
        style={pending ? PENDING_HATCH : undefined}
        title={
          pending
            ? PENDING_TITLE
            : `${formatTimeInTimeZone(new Date(a.starts_at), timezone)} · ${appointmentMinutes(a)} min — ${clientName(a)}`
        }
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
        onPointerDown={(e) => {
          // Long-press to lift, touch only. A finger that moves early is a
          // scroll: the slop check below and the browser's own pointercancel
          // both clear the timer before it fires.
          if (e.pointerType !== 'touch' || !movable) return
          const x = e.clientX
          const y = e.clientY
          const timer = window.setTimeout(() => {
            touchPress.current = null
            navigator.vibrate?.(15)
            setTouchDrag({ appointment: a, x, y, over: null })
            announce(`Picked up ${clientName(a)}. Drag to a time and let go.`)
          }, 350)
          touchPress.current = { pointerId: e.pointerId, x, y, timer }
        }}
        onPointerMove={(e) => {
          const p = touchPress.current
          if (!p || e.pointerId !== p.pointerId) return
          if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > 10) {
            clearTimeout(p.timer)
            touchPress.current = null
          }
        }}
        onPointerUp={() => {
          const p = touchPress.current
          if (p) {
            clearTimeout(p.timer)
            touchPress.current = null
          }
        }}
        onPointerCancel={() => {
          const p = touchPress.current
          if (p) {
            clearTimeout(p.timer)
            touchPress.current = null
          }
        }}
        onContextMenu={(e) => {
          // iOS long-press menu would land in the middle of the lift.
          if (touchPress.current || touchDrag) e.preventDefault()
        }}
        className={`group relative h-full select-none overflow-hidden border-l-4 [-webkit-touch-callout:none] ${colorFor(a.provider_id)} ${
          pending ? PENDING_CARD_CLASS : ''
        } ${draggingId === a.id || touchDrag?.appointment.id === a.id ? 'opacity-40' : ''} ${
          inFlight ? 'animate-pulse' : ''
        } ${draggable ? 'cursor-grab active:cursor-grabbing' : ''}`}
      >
        <button
          type="button"
          onClick={() => {
            // The click that trails a touch drag's pointerup is not a tap on
            // the card — it is the finger letting go of a move.
            if (Date.now() - dragEndedAt.current < 400) return
            onAppointmentClick(a)
          }}
          // `pr-8` either way: the Move button below is `w-8` and absolutely
          // placed at the right edge, so anything less than 2rem of reserved
          // padding lets the grip sit on top of the client's name.
          className={`block h-full w-full text-left ${
            oneLine ? 'px-1.5 py-px pr-7' : full ? 'p-2 pr-8' : 'px-1.5 py-1 pr-8'
          }`}
        >
          {oneLine ? (
            <span className="flex min-w-0 items-center gap-1 text-[0.6875rem] leading-tight">
              <span className="shrink-0 tabular-nums text-[var(--color-muted)]">
                {formatTimeInTimeZone(new Date(a.starts_at), timezone)}
              </span>
              <span className="min-w-0 truncate">{clientName(a)}</span>
              {pending && <PendingMark showLabel={false} className="ml-auto" />}
            </span>
          ) : (
            <>
              <span
                className={`flex items-center gap-1 tabular-nums text-[var(--color-muted)] ${
                  full ? 'text-xs' : 'text-[0.6875rem] leading-tight'
                }`}
              >
                {/* The minutes stay even though the card is now drawn to its
                    length — a height is a shape, "80 min" is a fact. */}
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
            </>
          )}
        </button>

        {/* The words, under the card's own content so they read as a note about
            it rather than as part of the client's name — but only where there
            is a line to spare. A narrow week column and a short compact row
            both take it away, and there the label rides the time line above
            instead, leaving the dashed ring, the hatch and the tooltip to carry
            a distinction that costs the card no height. */}
        {pending && full && !oneLine && <PendingMark className="px-2 pb-2" />}

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
              // hour. Cards are absolutely positioned now, so a row really is
              // four quarter-hour drop cells at `quarterPx` — the axis stays
              // true whatever lands on it, which is also what lets a card's
              // height mean its minutes.
              className="relative grid border-b border-[var(--color-border)] last:border-b-0"
              style={{ gridTemplateColumns: template }}
            >
              <div
                className={`tabular-nums text-[var(--color-muted)] ${
                  tight ? 'px-2 py-1 text-[0.6875rem]' : 'p-2 text-xs'
                }`}
              >
                {hourLabel(hour)}
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
                          className={`relative flex flex-col border-t border-dashed border-transparent px-1 ${
                            hoverKey === key
                              ? 'bg-[var(--color-accent)]/15 border-[var(--color-accent)]'
                              : ''
                          }`}
                          // A quarter of the density's hour. This was `min-h-6`
                          // — 24px, so 96px an hour and 1248px a day — which is
                          // the number that made the book feel zoomed in.
                          style={{ minHeight: metrics.quarterPx }}
                          data-drop-cell={key}
                          data-drop-date={c.dateKey}
                          data-drop-time={time}
                          data-drop-provider={c.providerId ?? ''}
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
                          {here.map((a) => {
                            // Drawn to its minutes, Google-style: top from the
                            // start's offset inside this quarter, height from
                            // the duration, width split with anything it
                            // overlaps. The wrapper is solid surface so grid
                            // lines don't read through the card's tint, and it
                            // goes inert while a drag is in flight so drops
                            // and elementFromPoint reach the cells beneath.
                            const wall = wallMinutes(new Date(a.starts_at), timezone)
                            const offsetPx =
                              ((wall - (hour * 60 + q * DROP_STEP_MINUTES)) /
                                DROP_STEP_MINUTES) *
                              metrics.quarterPx
                            const heightPx = Math.max(
                              (appointmentMinutes(a) / DROP_STEP_MINUTES) *
                                metrics.quarterPx -
                                2,
                              14
                            )
                            const lay = laneByColumn.get(c.key)?.get(a.id) ?? {
                              lane: 0,
                              lanes: 1,
                            }
                            return (
                              <div
                                key={a.id}
                                className={`absolute z-10 bg-[var(--color-surface)] ${
                                  draggingId || touchDrag ? 'pointer-events-none' : ''
                                }`}
                                style={{
                                  top: offsetPx,
                                  height: heightPx,
                                  left: `${(lay.lane / lay.lanes) * 100}%`,
                                  width: `calc(${100 / lay.lanes}% - 2px)`,
                                }}
                              >
                                {card(a, view === 'day' && metrics.roomForDetail, heightPx)}
                              </div>
                            )
                          })}
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
            Outside the {hourLabel(FIRST_HOUR)}–{hourLabel(LAST_HOUR + 1)} grid
          </p>
          {/* A list in a panel of its own: no row to fit inside and nothing
              below it to push down, so the zoom buys nothing here and these
              cards say everything regardless of it. */}
          <div className="mt-3 space-y-2">{offGrid.map((a) => card(a, true))}</div>
        </div>
      )}

      {!canDrag && (
        <p className="mt-3 text-xs text-[var(--color-muted)]">
          Hold a booking for a moment to pick it up, then drag it to a new time.
          Tapping it opens the details, where Move or extend does the same as a form.
        </p>
      )}

      {/* The card under the finger. Position is mutated directly by the drag
          effect — state only changes when the hovered quarter does. */}
      {touchDrag && (
        <div
          ref={ghostRef}
          className="pointer-events-none fixed z-[60] -translate-x-1/2 -translate-y-[130%]"
          style={{ left: touchDrag.x, top: touchDrag.y }}
        >
          <div
            className={`border border-[var(--color-border)] border-l-4 ${colorFor(
              touchDrag.appointment.provider_id
            )} bg-[var(--color-surface)] px-3 py-2 shadow-xl`}
          >
            <p className="text-sm font-medium">{clientName(touchDrag.appointment)}</p>
            <p className="text-xs tabular-nums text-[var(--color-muted)]">
              {touchDrag.over
                ? `${dayLabelForDateKey(touchDrag.over.dateKey)} · ${touchDrag.over.time}`
                : 'Drag to a time'}
            </p>
          </div>
        </div>
      )}

      <p aria-live="polite" className="sr-only">
        {announcement}
      </p>

      {moveTarget && (
        <MoveAppointmentDialog
          appointment={moveTarget}
          clientLabel={clientName(moveTarget)}
          serviceLabel={serviceName(moveTarget)}
          providers={columnProviders}
          timezone={timezone}
          busy={movingId === moveTarget.id}
          onClose={() => setMoveTarget(null)}
          onSubmit={async (dateKey, time, providerId, durationMinutes, override) => {
            const ok = await move({
              appointment: moveTarget,
              startsAt: zonedTimeToUtc(dateKey, time, timezone),
              providerId,
              durationMinutes,
              override,
            })
            if (ok) setMoveTarget(null)
            return ok
          }}
        />
      )}

      {pendingDrop && (
        <ConfirmDropDialog
          drop={pendingDrop}
          providers={columnProviders}
          timezone={timezone}
          busy={movingId === pendingDrop.appointment.id}
          onCancel={() => {
            setPendingDrop(null)
            announce('Move cancelled. Nothing changed.')
          }}
          onConfirm={async () => {
            const ok = await move({
              appointment: pendingDrop.appointment,
              startsAt: pendingDrop.startsAt,
              providerId: pendingDrop.providerId,
              override: allowOutsideHours,
            })
            if (ok) setPendingDrop(null)
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
 * The question between letting go and it being true.
 *
 * A drag is easy to fumble — a quarter-hour row is twenty-odd pixels — and the
 * client is emailed the moment a move commits, so the commit deserves one
 * deliberate click. Until Confirm, nothing has changed anywhere: not the row,
 * not the board, not Google, not the client's inbox.
 */
function ConfirmDropDialog({
  drop,
  providers,
  timezone,
  busy,
  onCancel,
  onConfirm,
}: {
  drop: { appointment: CalendarAppointment; startsAt: Date; providerId: string }
  providers: BoardProvider[]
  timezone: string
  busy: boolean
  onCancel: () => void
  onConfirm: () => Promise<void>
}) {
  const { appointment, startsAt } = drop
  const from = new Date(appointment.starts_at)
  const reassigned = drop.providerId !== appointment.provider_id
  const newProvider = providers.find((p) => p.id === drop.providerId)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="confirm_drop_title"
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
      >
        <h2 id="confirm_drop_title" className="display text-2xl">
          Move this appointment?
        </h2>
        <p className="mt-3 text-sm">
          {clientName(appointment)} — {serviceName(appointment) || 'appointment'}
        </p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {dayLabelForDateKey(dateKeyInTimeZone(from, timezone))} at{' '}
          {formatTimeInTimeZone(from, timezone)}
          {' → '}
          <span className="text-[var(--color-foreground)]">
            {dayLabelForDateKey(dateKeyInTimeZone(startsAt, timezone))} at{' '}
            {formatTimeInTimeZone(startsAt, timezone)}
          </span>
          {reassigned && newProvider && (
            <>
              {', with '}
              <span className="text-[var(--color-foreground)]">{providerName(newProvider)}</span>
            </>
          )}
          .
        </p>
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          The client is notified of the new time, in their account and by email.
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <Button
            autoFocus
            type="button"
            size="sm"
            disabled={busy}
            onClick={() => void onConfirm()}
          >
            {busy ? 'Moving…' : 'Confirm move'}
          </Button>
          <Button type="button" size="sm" variant="subtle" onClick={onCancel} disabled={busy}>
            Keep it where it was
          </Button>
        </div>
      </div>
    </div>
  )
}
