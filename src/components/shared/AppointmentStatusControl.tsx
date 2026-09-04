'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { pingEmailDispatch } from '@/lib/email-ping'
import { Select } from '@/components/ui/field'
import type { Appointment, AppointmentStatus } from '@/types/database'

const OPTIONS: { value: AppointmentStatus; label: string }[] = [
  { value: 'pending', label: 'Awaiting confirmation' },
  { value: 'confirmed', label: 'Confirmed' },
  { value: 'checked_in', label: 'Checked in' },
  { value: 'completed', label: 'Completed' },
  { value: 'no_show', label: 'No-show' },
  { value: 'cancelled', label: 'Cancelled' },
]

export function AppointmentStatusControl({
  appointmentId,
  status,
}: {
  appointmentId: string
  status: AppointmentStatus
}) {
  const router = useRouter()
  const [value, setValue] = useState(status)

  async function change(next: AppointmentStatus) {
    const previous = value
    setValue(next)

    // Completing an appointment fires the back-bar stock draw-down trigger, so
    // the timestamps here need to be right, not decorative.
    const now = new Date().toISOString()
    const patch: Partial<Appointment> = { status: next }
    if (next === 'checked_in') patch.checked_in_at = now
    if (next === 'completed') patch.completed_at = now
    if (next === 'cancelled') patch.cancelled_at = now

    const { error } = await createClient()
      .from('appointments')
      .update(patch)
      .eq('id', appointmentId)

    if (error) {
      setValue(previous)
      toast.error('Could not update the status.')
      return
    }

    pingEmailDispatch()
    toast.success('Updated.')
    router.refresh()
  }

  return (
    <Select
      value={value}
      onChange={(e) => change(e.target.value as AppointmentStatus)}
      aria-label="Appointment status"
      className="w-56"
    >
      {OPTIONS.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </Select>
  )
}
