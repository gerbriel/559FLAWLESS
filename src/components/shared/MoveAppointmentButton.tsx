'use client'

import { useState } from 'react'
import { CalendarClock } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { zonedTimeToUtc } from '@/lib/time'
import { useAppointmentMove } from './DragScheduleProvider'
import {
  MoveAppointmentDialog,
  type MoveDialogAppointment,
  type MoveDialogProvider,
} from './MoveAppointmentDialog'

/**
 * The appointment page's door into the Move dialog.
 *
 * This is where `?action=reschedule` used to arrive and find nothing — the
 * calendar promised a reschedule lived here and the page had never heard of
 * one. Now the same dialog the drag board and the touch calendar use opens
 * here too, with the same /move route deciding what is allowed.
 */
export function MoveAppointmentButton({
  appointment,
  clientLabel,
  serviceLabel,
  providers,
  timezone,
}: {
  appointment: MoveDialogAppointment
  clientLabel: string
  serviceLabel: string
  providers: MoveDialogProvider[]
  timezone: string
}) {
  const [open, setOpen] = useState(false)
  const { move, movingId } = useAppointmentMove([appointment])

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <CalendarClock className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        Move or extend
      </Button>

      {open && (
        <MoveAppointmentDialog
          appointment={appointment}
          clientLabel={clientLabel}
          serviceLabel={serviceLabel}
          providers={providers}
          timezone={timezone}
          busy={movingId === appointment.id}
          onClose={() => setOpen(false)}
          onSubmit={async (dateKey, time, providerId, durationMinutes, override) => {
            const ok = await move({
              appointment,
              startsAt: zonedTimeToUtc(dateKey, time, timezone),
              providerId,
              durationMinutes,
              override,
            })
            if (ok) setOpen(false)
            return ok
          }}
        />
      )}
    </>
  )
}
