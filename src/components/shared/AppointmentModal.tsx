'use client'

import type { CalendarAppointment as AppointmentData } from '@/components/shared/CalendarView'

import * as React from 'react'
import { X, Calendar, Clock, User, FileText, DollarSign, Phone, Mail } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone, formatTimeInTimeZone } from '@/lib/time'
import type { AppointmentStatus } from '@/types/database'


interface AppointmentModalProps {
  appointment: AppointmentData | null
  timezone: string
  onClose: () => void
  onCancel?: (id: string) => void
  onReschedule?: (id: string) => void
  onComplete?: (id: string) => void
  onAddNote?: (id: string) => void
}

const statusColors: Record<AppointmentStatus, string> = {
  pending: 'bg-yellow-100 text-yellow-900 dark:bg-yellow-900/30 dark:text-yellow-200',
  confirmed: 'bg-blue-100 text-blue-900 dark:bg-blue-900/30 dark:text-blue-200',
  checked_in: 'bg-purple-100 text-purple-900 dark:bg-purple-900/30 dark:text-purple-200',
  completed: 'bg-green-100 text-green-900 dark:bg-green-900/30 dark:text-green-200',
  cancelled: 'bg-red-100 text-red-900 dark:bg-red-900/30 dark:text-red-200',
  no_show: 'bg-gray-100 text-gray-900 dark:bg-gray-900/30 dark:text-gray-200',
}

export function AppointmentModal({
  appointment,
  timezone,
  onClose,
  onCancel,
  onReschedule,
  onComplete,
  onAddNote,
}: AppointmentModalProps) {
  React.useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleEscape)
    return () => window.removeEventListener('keydown', handleEscape)
  }, [onClose])

  if (!appointment) return null

  const client = appointment.profiles
  const clientName = client
    ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
    : `${appointment.guest_first_name ?? ''} ${appointment.guest_last_name ?? ''}`.trim()
  
  const clientEmail = client?.email || appointment.guest_email
  const clientPhone = client?.phone || appointment.guest_phone

  const provider = appointment.provider
  const providerName = provider?.display_name || 
    `${provider?.first_name ?? ''} ${provider?.last_name ?? ''}`.trim()

  const services = appointment.appointment_services || []

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto bg-[var(--color-surface)] border border-[var(--color-border)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-start justify-between border-b border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          <div>
            <h2 className="display text-2xl">Appointment Details</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">ID: {appointment.id.slice(0, 8)}</p>
          </div>
          <button
            onClick={onClose}
            className="rounded p-1 hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-ink)]"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="space-y-6 p-6">
          {/* Status */}
          <div>
            <span className={`inline-block rounded px-3 py-1 text-xs font-medium uppercase tracking-wide ${statusColors[appointment.status]}`}>
              {appointment.status.replace('_', ' ')}
            </span>
          </div>

          {/* Date & Time */}
          <div className="space-y-3">
            <div className="flex items-start gap-3">
              <Calendar className="mt-0.5 h-5 w-5 text-[var(--color-muted)]" />
              <div>
                <p className="text-sm text-[var(--color-muted)]">Date & Time</p>
                <p className="font-medium">
                  {formatDateTimeInTimeZone(new Date(appointment.starts_at), timezone)}
                </p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Clock className="mt-0.5 h-5 w-5 text-[var(--color-muted)]" />
              <div>
                <p className="text-sm text-[var(--color-muted)]">Duration</p>
                <p className="font-medium">
                  {formatTimeInTimeZone(new Date(appointment.starts_at), timezone)} - {formatTimeInTimeZone(new Date(appointment.ends_at), timezone)}
                </p>
              </div>
            </div>
          </div>

          {/* Client Info */}
          <div className="space-y-3 border-t border-[var(--color-border)] pt-6">
            <div className="flex items-start gap-3">
              <User className="mt-0.5 h-5 w-5 text-[var(--color-muted)]" />
              <div>
                <p className="text-sm text-[var(--color-muted)]">Client</p>
                <p className="font-medium">{clientName || 'Guest'}</p>
              </div>
            </div>
            {clientEmail && (
              <div className="flex items-start gap-3">
                <Mail className="mt-0.5 h-5 w-5 text-[var(--color-muted)]" />
                <div>
                  <p className="text-sm text-[var(--color-muted)]">Email</p>
                  <a href={`mailto:${clientEmail}`} className="font-medium hover:text-[var(--color-accent)]">
                    {clientEmail}
                  </a>
                </div>
              </div>
            )}
            {clientPhone && (
              <div className="flex items-start gap-3">
                <Phone className="mt-0.5 h-5 w-5 text-[var(--color-muted)]" />
                <div>
                  <p className="text-sm text-[var(--color-muted)]">Phone</p>
                  <a href={`tel:${clientPhone}`} className="font-medium hover:text-[var(--color-accent)]">
                    {clientPhone}
                  </a>
                </div>
              </div>
            )}
          </div>

          {/* Provider */}
          {providerName && (
            <div className="space-y-3 border-t border-[var(--color-border)] pt-6">
              <div className="flex items-start gap-3">
                <User className="mt-0.5 h-5 w-5 text-[var(--color-muted)]" />
                <div>
                  <p className="text-sm text-[var(--color-muted)]">Provider</p>
                  <p className="font-medium">{providerName}</p>
                </div>
              </div>
            </div>
          )}

          {/* Services */}
          {services.length > 0 && (
            <div className="border-t border-[var(--color-border)] pt-6">
              <p className="mb-3 text-sm text-[var(--color-muted)]">Services</p>
              <ul className="space-y-2">
                {services.map((s, i) => (
                  <li key={i} className="flex items-start justify-between gap-4">
                    <span>{s.name_snapshot}</span>
                    <span className="font-medium tabular-nums">{formatMoney(s.price_cents)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Financials */}
          <div className="space-y-2 border-t border-[var(--color-border)] pt-6">
            <div className="flex items-start gap-3">
              <DollarSign className="mt-0.5 h-5 w-5 text-[var(--color-muted)]" />
              <div className="flex-1">
                <div className="flex items-baseline justify-between">
                  <p className="text-sm text-[var(--color-muted)]">Total</p>
                  <p className="text-xl font-medium tabular-nums">{formatMoney(appointment.total_cents)}</p>
                </div>
                {appointment.deposit_cents > 0 && (
                  <div className="mt-1 flex items-baseline justify-between">
                    <p className="text-xs text-[var(--color-muted)]">Deposit</p>
                    <p className="text-sm tabular-nums">{formatMoney(appointment.deposit_cents)}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Notes */}
          {(appointment.client_notes || appointment.staff_notes) && (
            <div className="space-y-3 border-t border-[var(--color-border)] pt-6">
              {appointment.client_notes && (
                <div className="flex items-start gap-3">
                  <FileText className="mt-0.5 h-5 w-5 text-[var(--color-muted)]" />
                  <div>
                    <p className="text-sm text-[var(--color-muted)]">Client Notes</p>
                    <p className="mt-1 text-sm">{appointment.client_notes}</p>
                  </div>
                </div>
              )}
              {appointment.staff_notes && (
                <div className="flex items-start gap-3">
                  <FileText className="mt-0.5 h-5 w-5 text-[var(--color-muted)]" />
                  <div>
                    <p className="text-sm text-[var(--color-muted)]">Staff Notes</p>
                    <p className="mt-1 text-sm">{appointment.staff_notes}</p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="sticky bottom-0 flex flex-wrap gap-3 border-t border-[var(--color-border)] bg-[var(--color-surface)] p-6">
          {onComplete && appointment.status !== 'completed' && appointment.status !== 'cancelled' && (
            <Button
              variant="accent"
              size="sm"
              onClick={() => onComplete(appointment.id)}
            >
              Mark Complete
            </Button>
          )}
          {onReschedule && appointment.status !== 'completed' && appointment.status !== 'cancelled' && (
            <Button
              variant="subtle"
              size="sm"
              onClick={() => onReschedule(appointment.id)}
            >
              Reschedule
            </Button>
          )}
          {onAddNote && (
            <Button
              variant="subtle"
              size="sm"
              onClick={() => onAddNote(appointment.id)}
            >
              Add Note
            </Button>
          )}
          {onCancel && appointment.status !== 'completed' && appointment.status !== 'cancelled' && (
            <Button
              variant="danger"
              size="sm"
              onClick={() => onCancel(appointment.id)}
            >
              Cancel Appointment
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            className="ml-auto"
          >
            Close
          </Button>
        </div>
      </div>
    </div>
  )
}
