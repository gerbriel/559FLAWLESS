import Link from 'next/link'
import { notFound } from 'next/navigation'
import { AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { AppointmentStatusControl } from '@/components/shared/AppointmentStatusControl'
import { ClientNoteForm } from '@/components/shared/ClientNoteForm'
import { TakePayment, type PaymentRecord } from '@/components/shared/TakePayment'
import { PhotoReminderPrompt } from '@/components/shared/PhotoReminderPrompt'
import { formatMoney, formatDuration } from '@/lib/utils'
import { formatDateTimeInTimeZone } from '@/lib/time'
import type { AppointmentStatus } from '@/types/database'
import type { AppointmentPhotoPrompt } from '@/types/clientprofile'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

interface Props {
  params: Promise<{ id: string }>
}

export default async function StaffAppointmentPage({ params }: Props) {
  const { id } = await params
  const supabase = await createClient()

  const { data: appointment } = await supabase
    .from('appointments')
    .select(
      'id, starts_at, ends_at, status, source, total_cents, deposit_cents, deposit_status, client_notes, staff_notes, client_id, guest_first_name, guest_last_name, guest_email, guest_phone, age_attested_at, profiles!appointments_client_id_fkey(first_name, last_name, email, phone), appointment_services(id, name_snapshot, price_cents, duration_minutes, sort_order)'
    )
    .eq('id', id)
    .maybeSingle()

  if (!appointment) notFound()

  const client = appointment.profiles as {
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
  } | null

  const name = client
    ? `${client.first_name ?? ''} ${client.last_name ?? ''}`.trim()
    : `${appointment.guest_first_name ?? ''} ${appointment.guest_last_name ?? ''}`.trim()

  const lines = ((appointment.appointment_services ?? []) as {
    id: number
    name_snapshot: string
    price_cents: number
    duration_minutes: number
    sort_order: number
  }[]).sort((a, b) => a.sort_order - b.sort_order)

  // Every payment against this appointment — the Stripe deposit and anything
  // taken at the counter. The balance is the arithmetic, not a stored flag.
  const { data: payments } = await supabase
    .from('payments')
    .select('id, amount_cents, method, kind, note, created_at, status')
    .eq('appointment_id', id)
    .eq('status', 'succeeded')
    .order('created_at')

  const takenCents = (payments ?? []).reduce((sum, p) => sum + p.amount_cents, 0)
  // A treatment that did not happen is not billed; a forfeited deposit has
  // already been taken and stays taken.
  const notBilled = appointment.status === 'cancelled' || appointment.status === 'no_show'
  const balanceCents = notBilled ? 0 : Math.max(appointment.total_cents - takenCents, 0)

  // Latest intake flags, if this booking is tied to an account.
  const { data: intake } = appointment.client_id
    ? await supabase
        .from('intake_submissions')
        .select('flags, reviewed_at, submitted_at')
        .eq('client_id', appointment.client_id)
        .order('submitted_at', { ascending: false })
        .limit(1)
        .maybeSingle()
    : { data: null }

  // Is a before/after photograph due on this visit? `photo_due` is null unless
  // a documented service is booked AND the client's consent covers it — the
  // gate is in `client_photo_consent_ok` (039), never in the component.
  const { data: photoPrompt } = await supabase
    .from('appointment_photo_prompts')
    .select(
      'appointment_id, client_id, provider_id, location_id, starts_at, status, photo_documented, intimate, documented_services, followup_days, before_count, after_count, progress_count, consent_ok, photo_due'
    )
    .eq('appointment_id', id)
    .maybeSingle()

  return (
    <div className="max-w-3xl">
      <Link href="/dashboard/calendar" className="label-caps text-[var(--color-muted)]">
        ← Calendar
      </Link>

      <div className="mt-8 flex flex-wrap items-start justify-between gap-6">
        <div>
          <h1 className="display text-3xl">{name || 'Guest'}</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            {client?.email ?? appointment.guest_email}
            {(client?.phone ?? appointment.guest_phone) &&
              ` · ${client?.phone ?? appointment.guest_phone}`}
          </p>
          {appointment.client_id && (
            <Link
              href={`/dashboard/clients/${appointment.client_id}`}
              className="label-caps mt-3 inline-block border-b border-[var(--color-foreground)] pb-0.5"
            >
              Full client record
            </Link>
          )}
        </div>

        <AppointmentStatusControl
          appointmentId={appointment.id}
          status={appointment.status as AppointmentStatus}
        />
      </div>

      {(intake?.flags.length ?? 0) > 0 && !intake?.reviewed_at && (
        <div className="mt-8 border-l-2 border-amber-600 bg-amber-50 p-5 dark:bg-transparent">
          <p className="label-caps mb-3 flex items-center gap-2 text-amber-800 dark:text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5" strokeWidth={2} />
            Unreviewed intake flags
          </p>
          <p className="text-sm text-[var(--color-muted)]">{intake!.flags.join(', ')}</p>
        </div>
      )}

      {photoPrompt && (
        <div className="mt-8">
          <PhotoReminderPrompt prompt={photoPrompt as unknown as AppointmentPhotoPrompt} />
        </div>
      )}

      <div className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <p className="display text-xl">
          {formatDateTimeInTimeZone(new Date(appointment.starts_at), STUDIO_TZ)}
        </p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          {formatDuration(lines.reduce((n, l) => n + l.duration_minutes, 0))} ·{' '}
          {appointment.source.replace('_', ' ')} booking
        </p>

        <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {lines.map((l) => (
            <li key={l.id} className="flex justify-between gap-6 py-3 text-sm">
              <span>{l.name_snapshot}</span>
              <span className="tabular-nums text-[var(--color-muted)]">
                {formatMoney(l.price_cents)}
              </span>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            {appointment.deposit_cents > 0 && (
              <Badge tone={appointment.deposit_status === 'paid' ? 'success' : 'warning'}>
                Deposit {formatMoney(appointment.deposit_cents)} · {appointment.deposit_status}
              </Badge>
            )}
            {appointment.age_attested_at && <Badge tone="neutral">18+ confirmed</Badge>}
          </div>
          <span className="tabular-nums">{formatMoney(appointment.total_cents)}</span>
        </div>
      </div>

      <div className="mt-8">
        <TakePayment
          appointmentId={appointment.id}
          totalCents={appointment.total_cents}
          balanceCents={balanceCents}
          payments={(payments ?? []) as PaymentRecord[]}
          settled={notBilled}
        />
      </div>

      {appointment.client_notes && (
        <div className="mt-8">
          <h2 className="label-caps mb-2 text-[var(--color-accent)]">Client wrote</h2>
          <p className="text-sm text-[var(--color-muted)]">{appointment.client_notes}</p>
        </div>
      )}

      {appointment.client_id && (
        <div className="mt-10">
          <h2 className="label-caps mb-4 text-[var(--color-accent)]">Treatment note</h2>
          <ClientNoteForm clientId={appointment.client_id} appointmentId={appointment.id} />
        </div>
      )}
    </div>
  )
}
