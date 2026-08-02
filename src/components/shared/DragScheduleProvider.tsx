'use client'

import * as React from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { MINUTE_MS } from '@/lib/time'

/**
 * The move itself — no grid, no drag, no DOM.
 *
 * Everything about rescheduling that is not "which pixel did you let go over"
 * lives here: the optimistic write, the rollback, and the single fetch to the
 * one route allowed to reposition a booking. Keeping it headless is what lets
 * the drag grid and the keyboard dialog be two front doors onto exactly the
 * same behaviour, rather than two implementations that agree until they don't.
 */

export interface MovableAppointment {
  id: string
  starts_at: string
  ends_at: string
  provider_id: string
}

/** What we are pretending is true while the server makes up its mind. */
interface PendingMove {
  /** Where it was, so we can tell "not caught up yet" from "someone else moved it". */
  from: string
  starts_at: string
  ends_at: string
  provider_id: string
}

export interface MoveRequest {
  appointment: MovableAppointment
  /** Absolute instant, already resolved through the provider's zone. */
  startsAt: Date
  providerId?: string
  /** Drop it outside published hours. Never bypasses the overlap guard. */
  override?: boolean
}

export interface AppointmentMoveApi<T extends MovableAppointment> {
  /** The list with any in-flight or just-committed move applied on top. */
  appointments: T[]
  move: (req: MoveRequest) => Promise<boolean>
  /** Id currently awaiting the server, if any. */
  movingId: string | null
  /** Live-region text describing the last thing that happened. */
  announcement: string
  announce: (message: string) => void
}

/**
 * Optimistic rescheduling with a real rollback.
 *
 * The card moves the instant you let go, because a calendar that waits 300ms
 * before responding feels broken. But an optimistic update that fails silently
 * is worse than none at all — the appointment slides back with no explanation
 * and staff are left unsure whether the client is at two o'clock or three. So
 * every rejection puts the card back AND says why, in the words the server
 * used.
 */
export function useAppointmentMove<T extends MovableAppointment>(
  appointments: T[],
  options: { onMoved?: () => void } = {}
): AppointmentMoveApi<T> {
  const router = useRouter()
  const [pending, setPending] = React.useState<Record<string, PendingMove>>({})
  const [movingId, setMovingId] = React.useState<string | null>(null)
  const [announcement, setAnnouncement] = React.useState('')

  const onMoved = options.onMoved
  const onMovedRef = React.useRef(onMoved)
  React.useEffect(() => {
    onMovedRef.current = onMoved
  }, [onMoved])

  /**
   * The list as the screen should show it.
   *
   * Derived, not synchronised: an override applies while the server still shows
   * where the appointment was (in flight) or already shows where we put it
   * (committed, and the two agree). If the incoming row says something else
   * entirely, somebody else has moved it since — their change is the newer
   * fact, and ours is dropped on the spot rather than papered over.
   */
  const view = React.useMemo(() => {
    if (Object.keys(pending).length === 0) return appointments
    return appointments.map((a) => {
      const p = pending[a.id]
      if (!p) return a
      if (a.starts_at !== p.from && a.starts_at !== p.starts_at) return a
      return { ...a, starts_at: p.starts_at, ends_at: p.ends_at, provider_id: p.provider_id }
    })
  }, [appointments, pending])

  const announce = React.useCallback((message: string) => {
    setAnnouncement(message)
  }, [])

  const move = React.useCallback(
    async (req: MoveRequest): Promise<boolean> => {
      const { appointment, startsAt } = req
      const providerId = req.providerId ?? appointment.provider_id

      const unchanged =
        startsAt.getTime() === new Date(appointment.starts_at).getTime() &&
        providerId === appointment.provider_id
      if (unchanged) return true

      // The card is only ever as long as it already was — a move changes when,
      // not what, and the server enforces the same thing from the row.
      const durationMs =
        new Date(appointment.ends_at).getTime() - new Date(appointment.starts_at).getTime()

      const optimistic: PendingMove = {
        from: appointment.starts_at,
        starts_at: startsAt.toISOString(),
        ends_at: new Date(startsAt.getTime() + durationMs).toISOString(),
        provider_id: providerId,
      }

      setPending((cur) => ({ ...cur, [appointment.id]: optimistic }))
      setMovingId(appointment.id)

      try {
        const res = await fetch(`/api/appointments/${appointment.id}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            startsAt: startsAt.toISOString(),
            providerId,
            overrideAvailability: req.override ?? false,
          }),
        })

        const data = (await res.json().catch(() => null)) as
          | { message?: string; appointment?: { startsAt: string; endsAt: string; providerId: string } }
          | null

        if (!res.ok) {
          // Roll back to exactly where it was. Not a refetch — the row we came
          // from is already correct, and a refetch would race the toast.
          setPending((cur) => {
            const next = { ...cur }
            delete next[appointment.id]
            return next
          })
          const message = data?.message ?? 'That move did not go through.'
          toast.error(message)
          setAnnouncement(`Move refused. ${message}`)
          return false
        }

        if (data?.appointment) {
          setPending((cur) => ({
            ...cur,
            [appointment.id]: {
              from: appointment.starts_at,
              starts_at: data.appointment!.startsAt,
              ends_at: data.appointment!.endsAt,
              provider_id: data.appointment!.providerId,
            },
          }))
        }

        setAnnouncement('Appointment moved.')
        onMovedRef.current?.()
        router.refresh()
        return true
      } catch {
        setPending((cur) => {
          const next = { ...cur }
          delete next[appointment.id]
          return next
        })
        toast.error('Could not reach the server. The appointment has not moved.')
        setAnnouncement('Move failed: the server could not be reached.')
        return false
      } finally {
        setMovingId(null)
      }
    },
    [router]
  )

  return { appointments: view, move, movingId, announcement, announce }
}

/**
 * Is this a machine you can drag on?
 *
 * `pointer: fine` is the question that matters — not screen width. A tablet
 * with a keyboard is still a finger, and drag-and-drop on a touch surface
 * fights the scroll it shares a gesture with. Touch keeps tap-to-open; the
 * move dialog is there for both.
 */
export function useDragCapable(): boolean {
  const [capable, setCapable] = React.useState(false)

  React.useEffect(() => {
    const query = window.matchMedia('(pointer: fine)')
    const apply = () => setCapable(query.matches)
    apply()
    query.addEventListener('change', apply)
    return () => query.removeEventListener('change', apply)
  }, [])

  return capable
}

/** Quarter-hour drop targets: the finest grid any of the studio's services use. */
export const DROP_STEP_MINUTES = 15

/** 'HH:MM' for a quarter-hour offset inside `hour`. */
export function dropSlotTime(hour: number, quarter: number): string {
  const minutes = quarter * DROP_STEP_MINUTES
  return `${String(hour).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** How long an appointment runs, in minutes. Used for the drag preview. */
export function appointmentMinutes(a: MovableAppointment): number {
  return Math.round(
    (new Date(a.ends_at).getTime() - new Date(a.starts_at).getTime()) / MINUTE_MS
  )
}
