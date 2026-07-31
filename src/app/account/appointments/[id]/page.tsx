import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { CancelAppointment } from '@/components/shared/CancelAppointment'
import { formatMoney, formatDuration } from '@/lib/utils'
import { formatDateTimeInTimeZone , requestNow } from '@/lib/time'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

interface Props {
  params: Promise<{ id: string }>
  searchParams: Promise<{ deposit?: string }>
}

export default async function AppointmentDetailPage({ params, searchParams }: Props) {
  const { id } = await params
  const { deposit } = await searchParams

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // RLS restricts this to the client's own rows, so a guessed id returns nothing.
  const { data: appointment } = await supabase
    .from('appointments')
    .select(
      'id, starts_at, ends_at, status, total_cents, deposit_cents, deposit_status, client_notes, cancellation_reason, profiles!appointments_provider_id_fkey(display_name, first_name, bio), appointment_services(id, name_snapshot, price_cents, duration_minutes, sort_order)'
    )
    .eq('id', id)
    .eq('client_id', user.id)
    .maybeSingle()

  if (!appointment) notFound()

  const provider = appointment.profiles as {
    display_name: string | null
    first_name: string | null
    bio: string | null
  } | null

  const lines = ((appointment.appointment_services ?? []) as {
    id: number
    name_snapshot: string
    price_cents: number
    duration_minutes: number
    sort_order: number
  }[]).sort((a, b) => a.sort_order - b.sort_order)

  const startsAt = new Date(appointment.starts_at)
  const hoursAway = (startsAt.getTime() - requestNow()) / 3_600_000
  const isUpcoming = hoursAway > 0 && appointment.status !== 'cancelled'
  const totalMinutes = lines.reduce((n, l) => n + l.duration_minutes, 0)

  return (
    <div>
      <Link href="/account/appointments" className="label-caps text-[var(--color-muted)]">
        ← Appointments
      </Link>

      {deposit === 'paid' && (
        <p className="mt-6 border border-emerald-600/40 bg-emerald-50 p-4 text-sm text-emerald-800 dark:bg-transparent dark:text-emerald-400">
          Deposit received — your appointment is secured.
        </p>
      )}
      {deposit === 'cancelled' && (
        <p className="mt-6 border border-amber-600/40 bg-amber-50 p-4 text-sm text-amber-800 dark:bg-transparent dark:text-amber-400">
          Deposit not completed. Your slot is held for now, but please pay to confirm it.
        </p>
      )}

      <h1 className="display mt-8 text-3xl">
        {formatDateTimeInTimeZone(startsAt, STUDIO_TZ)}
      </h1>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Badge tone={appointment.status === 'cancelled' ? 'danger' : 'success'}>
          {appointment.status.replace('_', ' ')}
        </Badge>
        {appointment.deposit_cents > 0 && (
          <Badge tone={appointment.deposit_status === 'paid' ? 'success' : 'warning'}>
            Deposit {appointment.deposit_status}
          </Badge>
        )}
        <span className="text-sm text-[var(--color-muted)]">
          {formatDuration(totalMinutes)}
        </span>
      </div>

      {provider && (
        <p className="mt-6 text-[var(--color-muted)]">
          With {provider.display_name ?? provider.first_name}
        </p>
      )}

      <div className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)]">
        <ul className="divide-y divide-[var(--color-border)]">
          {lines.map((l) => (
            <li key={l.id} className="flex items-baseline justify-between gap-6 px-6 py-4">
              <span>{l.name_snapshot}</span>
              <span className="tabular-nums text-[var(--color-muted)]">
                {formatMoney(l.price_cents)}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex items-baseline justify-between gap-6 border-t border-[var(--color-border)] px-6 py-4">
          <span className="label-caps">Total</span>
          <span className="tabular-nums">{formatMoney(appointment.total_cents)}</span>
        </div>
      </div>

      {appointment.client_notes && (
        <div className="mt-8">
          <h2 className="label-caps mb-2 text-[var(--color-accent)]">Your notes</h2>
          <p className="text-sm text-[var(--color-muted)]">{appointment.client_notes}</p>
        </div>
      )}

      {appointment.cancellation_reason && (
        <div className="mt-8">
          <h2 className="label-caps mb-2 text-[var(--color-muted)]">Cancellation</h2>
          <p className="text-sm text-[var(--color-muted)]">{appointment.cancellation_reason}</p>
        </div>
      )}

      {isUpcoming && (
        <div className="mt-12 space-y-6 border-t border-[var(--color-border)] pt-8">
          <div className="flex flex-wrap gap-3">
            <ButtonLink href="/account/forms" variant="subtle">
              Complete your forms
            </ButtonLink>
            {appointment.deposit_cents > 0 && appointment.deposit_status !== 'paid' && (
              <ButtonLink href={`/account/appointments/${appointment.id}/deposit`} variant="accent">
                Pay {formatMoney(appointment.deposit_cents)} deposit
              </ButtonLink>
            )}
          </div>

          <CancelAppointment
            appointmentId={appointment.id}
            hoursAway={hoursAway}
            depositPaid={appointment.deposit_status === 'paid'}
          />
        </div>
      )}
    </div>
  )
}
