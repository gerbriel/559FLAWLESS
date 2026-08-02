import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { PendingBookingActions } from '@/components/shared/PendingBookingActions'
import { formatMoney } from '@/lib/utils'
import {
  dateKeyInTimeZone,
  formatDateTimeInTimeZone,
  requestNow,
  timeZoneAbbreviation,
} from '@/lib/time'
import { isFrontDesk, isManager, type UserRole } from '@/types/database'
import { reviewReasonLabel } from '@/types/scheduling'

export const dynamic = 'force-dynamic'

export default async function PendingBookingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/appointments/pending')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, timezone')
    .eq('id', user.id)
    .maybeSingle()

  // Providers see their own queue; front desk and up see the whole studio.
  // The RLS policies from 004 already draw that line — this only decides what
  // the page says it is showing.
  const role = (profile?.role ?? 'provider') as UserRole
  const wholeStudio = isFrontDesk(role)
  // Everyone gets this page — the sidebar entry is ungated, because a provider
  // has her own queue to clear. The rules that put bookings here are a
  // different question: /dashboard/settings/scheduling bounces anyone below
  // manager back to /dashboard/settings, and the Booking policy form on the
  // Settings index is manager-only too. So the queue is for everyone and the
  // links out of it are not.
  const setsThePolicy = isManager(role)

  const { data: settings } = await supabase
    .from('booking_settings')
    .select('timezone, auto_confirm')
    .eq('id', 1)
    .maybeSingle()

  const timeZone = settings?.timezone ?? profile?.timezone ?? 'America/Los_Angeles'
  const now = new Date(requestNow())
  const today = dateKeyInTimeZone(now, timeZone)

  const { data: pending } = await supabase
    .from('appointments')
    .select(
      'id, starts_at, ends_at, status, source, total_cents, approval_reason, client_notes, guest_first_name, guest_last_name, guest_email, guest_phone, created_at, provider:profiles!appointments_provider_id_fkey(display_name, first_name), client:profiles!appointments_client_id_fkey(first_name, last_name, email, phone), appointment_services(name_snapshot, price_cents, duration_minutes, sort_order)'
    )
    .eq('status', 'pending')
    .order('starts_at')

  const rows = pending ?? []
  // A request for a time that has already been and gone is not a decision the
  // studio still needs to make, but it should not vanish either — someone has
  // to clear it, and they should be able to see why it is there.
  const upcoming = rows.filter((a) => a.starts_at >= now.toISOString())
  const stale = rows.filter((a) => a.starts_at < now.toISOString())

  return (
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Waiting on you</h1>
        {setsThePolicy && (
          <Link
            href="/dashboard/settings/scheduling"
            className="label-caps text-[var(--color-muted)] hover:text-[var(--color-accent)]"
          >
            Approval rules
          </Link>
        )}
      </div>

      <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
        {wholeStudio
          ? 'Bookings that came in through the website and matched one of the review rules.'
          : 'Your bookings that came in through the website and matched one of the review rules.'}{' '}
        They are holding their time on the calendar while they sit here, so
        confirming one can never fail. Declining releases it.
        {settings?.auto_confirm === false && (
          <>
            {' '}
            Every online booking is currently being held —{' '}
            {setsThePolicy ? (
              <>
                <Link href="/dashboard/settings" className="underline">
                  change that under Booking policy
                </Link>
                .
              </>
            ) : (
              <>a manager can change that under Settings.</>
            )}
          </>
        )}
      </p>

      {rows.length === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          Nothing waiting. Every booking that came in was confirmed on the spot.
        </p>
      ) : (
        <>
          <ul className="mt-10 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {upcoming.map((a) => (
              <PendingRow key={a.id} appointment={a} timeZone={timeZone} today={today} />
            ))}
          </ul>

          {stale.length > 0 && (
            <section className="mt-14">
              <h2 className="display text-2xl">Already passed</h2>
              <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
                Nobody answered these in time. Decline them to take the time back.
              </p>
              <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                {stale.map((a) => (
                  <PendingRow key={a.id} appointment={a} timeZone={timeZone} today={today} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

type PendingAppointment = {
  id: string
  starts_at: string
  ends_at: string
  total_cents: number
  approval_reason: string | null
  client_notes: string | null
  guest_first_name: string | null
  guest_last_name: string | null
  guest_email: string | null
  guest_phone: string | null
  created_at: string
  provider: { display_name: string | null; first_name: string | null } | null
  client: {
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
  } | null
  appointment_services: {
    name_snapshot: string
    price_cents: number
    duration_minutes: number
    sort_order: number
  }[]
}

function PendingRow({
  appointment,
  timeZone,
  today,
}: {
  appointment: PendingAppointment
  timeZone: string
  today: string
}) {
  const a = appointment
  const name =
    [a.client?.first_name, a.client?.last_name].filter(Boolean).join(' ') ||
    [a.guest_first_name, a.guest_last_name].filter(Boolean).join(' ') ||
    'A client'
  const contact = a.client?.email ?? a.guest_email ?? a.client?.phone ?? a.guest_phone
  const start = new Date(a.starts_at)
  const lines = [...a.appointment_services].sort((x, y) => x.sort_order - y.sort_order)
  const provider = a.provider?.display_name ?? a.provider?.first_name
  const isToday = dateKeyInTimeZone(start, timeZone) === today

  return (
    <li className="flex flex-col gap-5 py-6 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="text-base">{name}</p>
          <Badge tone="warning">{reviewReasonLabel(a.approval_reason)}</Badge>
          {isToday && <Badge tone="danger">Today</Badge>}
        </div>

        <p className="mt-2 text-sm tabular-nums">
          {formatDateTimeInTimeZone(start, timeZone)}{' '}
          <span className="text-[var(--color-muted)]">
            {timeZoneAbbreviation(start, timeZone)}
            {provider ? ` · with ${provider}` : ''}
          </span>
        </p>

        {lines.length > 0 && (
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            {lines.map((l) => l.name_snapshot).join(' + ')} ·{' '}
            {lines.reduce((n, l) => n + l.duration_minutes, 0)} min ·{' '}
            {formatMoney(a.total_cents)}
          </p>
        )}

        {contact && <p className="mt-1.5 text-xs text-[var(--color-muted)]">{contact}</p>}

        {a.client_notes && (
          <p className="mt-3 max-w-prose border-l-2 border-[var(--color-accent)] pl-3 text-sm text-[var(--color-muted)]">
            {a.client_notes}
          </p>
        )}

        <Link
          href={`/dashboard/appointments/${a.id}`}
          className="label-caps mt-3 inline-block text-[var(--color-muted)] hover:text-[var(--color-accent)]"
        >
          Open the booking
        </Link>
      </div>

      <PendingBookingActions appointmentId={a.id} clientName={name} />
    </li>
  )
}
