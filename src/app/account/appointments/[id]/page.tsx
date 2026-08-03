import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { CancelAppointment } from '@/components/shared/CancelAppointment'
import { formatMoney, formatDuration } from '@/lib/utils'
import { formatDateTimeInTimeZone , requestNow } from '@/lib/time'
import {
  DEPOSIT_LABEL,
  DEPOSIT_TONE,
  STATUS_LABEL,
  STATUS_TONE,
} from '../_lib/status'

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
      'id, starts_at, ends_at, status, total_cents, membership_covered_cents, membership_discount_cents, deposit_cents, deposit_status, client_notes, cancellation_reason, profiles!appointments_provider_id_fkey(display_name, first_name, bio), appointment_services(id, name_snapshot, price_cents, duration_minutes, sort_order)'
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

  // 'pending' means a person has not agreed to this yet. Every sentence on this
  // page that promises the client an appointment has to check it first.
  const awaitingApproval = appointment.status === 'pending'
  // The webhook is the record that money moved; `?deposit=paid` only says the
  // browser came back from Checkout. They are usually seconds apart and
  // occasionally are not.
  const depositSettled = appointment.deposit_status === 'paid'
  const providerName = provider?.first_name ?? provider?.display_name ?? 'the studio'

  return (
    <div>
      <Link href="/account/appointments" className="label-caps text-[var(--color-muted)]">
        ← Appointments
      </Link>

      {/*
        This is the screen Stripe sends a paying client to. Two things it must
        not say: that the money has landed (only the webhook knows that), and
        that the appointment is theirs (only the provider decides that).
      */}
      {deposit === 'paid' && (
        <div
          className={
            awaitingApproval
              ? 'mt-6 border border-amber-600/40 bg-amber-50 p-5 text-sm text-amber-800 dark:bg-transparent dark:text-amber-400'
              : 'mt-6 border border-emerald-600/40 bg-emerald-50 p-5 text-sm text-emerald-800 dark:bg-transparent dark:text-emerald-400'
          }
        >
          <p className="label-caps">{depositSettled ? 'Deposit received' : 'Payment sent'}</p>
          <p className="mt-2 leading-relaxed">
            {depositSettled
              ? `Your ${formatMoney(appointment.deposit_cents)} deposit comes off your total on the day.`
              : 'Stripe has your payment. It shows here as paid once Stripe confirms it — refresh this page in a moment if it has not caught up.'}
          </p>
          {awaitingApproval && (
            <p className="mt-2 leading-relaxed">
              Your appointment is still awaiting confirmation. The time is held for you
              while {providerName} reviews it — paying the deposit does not confirm it.
            </p>
          )}
        </div>
      )}
      {deposit === 'cancelled' && (
        <div className="mt-6 border border-amber-600/40 bg-amber-50 p-5 text-sm text-amber-800 dark:bg-transparent dark:text-amber-400">
          <p className="label-caps">Deposit not paid</p>
          <p className="mt-2 leading-relaxed">
            You left checkout before paying. Your time is still held, and you can pay the
            deposit from this page whenever you are ready.
            {awaitingApproval &&
              ' The booking is waiting on the studio either way — the deposit is not what confirms it.'}
          </p>
        </div>
      )}

      <h1 className="display mt-8 text-3xl">
        {formatDateTimeInTimeZone(startsAt, STUDIO_TZ)}
      </h1>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Badge tone={STATUS_TONE[appointment.status]}>{STATUS_LABEL[appointment.status]}</Badge>
        {appointment.deposit_cents > 0 && (
          <Badge tone={DEPOSIT_TONE[appointment.deposit_status]}>
            {DEPOSIT_LABEL[appointment.deposit_status]}
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

      {/*
        What "Awaiting confirmation" actually means, said once, in the client's
        words.

        Two things are certain and only two. The slot is held — the exclusion
        constraint in 004 covers every status except cancelled, so nobody can
        take the time while it sits in the queue. And the answer lands on THIS
        page: the status flips to Confirmed, or to Cancelled with the reason the
        decliner had to type, which the block below already renders.

        The notification is now promised, and only because it is now deliverable.
        049's `was_approved` branch writes the client a `notifications` row on
        exactly the transition PendingBookingActions performs (pending ->
        confirmed), and NotificationBell is mounted in the account header, so
        there is a place the client can read it. It is an IN-APP notification and
        the wording says so — there is no mail or SMS sender anywhere in this
        codebase, and "we'll let you know" without naming the channel is how a
        client ends up watching an inbox that will never have anything in it.
      */}
      {awaitingApproval && (
        <div className="mt-6 border border-amber-600/40 bg-amber-50 p-6 text-sm text-amber-800 dark:bg-transparent dark:text-amber-400">
          <p className="label-caps">Awaiting confirmation</p>
          <p className="mt-3 leading-relaxed">
            This time is held for you, but the appointment is not confirmed until{' '}
            {providerName} has reviewed it. The answer shows up on this page: it will read
            Confirmed once the studio agrees, and if they cannot take that time it will say
            so and tell you why.
          </p>
          <p className="mt-2 leading-relaxed">
            Filling in your forms now means nothing is waiting on you.
          </p>
          {/*
            A deposit taken on a booking nobody has approved yet. Declining sets
            the appointment to cancelled and touches no money: no route in this
            codebase calls `stripe.refunds.create`, and the only thing that ever
            writes `deposit_status = 'refunded'` is the `charge.refunded`
            webhook reacting to a refund a person made in Stripe. So this says
            where the deposit stands and offers somebody to ask, and promises no
            policy the app does not implement.
          */}
          {depositSettled && (
            <>
              <p className="mt-2 leading-relaxed">
                Your {formatMoney(appointment.deposit_cents)} deposit is recorded against
                this booking.
              </p>
              <Link
                href="/account/messages"
                className="label-caps mt-2 inline-flex min-h-11 items-center underline underline-offset-4"
              >
                Message the studio about it
              </Link>
            </>
          )}
        </div>
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
        {/* The lines are the menu price. What a membership takes off comes
            after them, named, so the total is never a smaller number with no
            explanation attached to it. */}
        {(appointment.membership_covered_cents > 0 ||
          appointment.membership_discount_cents > 0) && (
          <ul className="divide-y divide-[var(--color-border)] border-t border-[var(--color-border)]">
            {appointment.membership_covered_cents > 0 && (
              <li className="flex items-baseline justify-between gap-6 px-6 py-4">
                <span className="text-[var(--color-muted)]">
                  Included with your membership
                </span>
                <span className="tabular-nums text-[var(--color-muted)]">
                  &minus;{formatMoney(appointment.membership_covered_cents)}
                </span>
              </li>
            )}
            {appointment.membership_discount_cents > 0 && (
              <li className="flex items-baseline justify-between gap-6 px-6 py-4">
                <span className="text-[var(--color-muted)]">Member discount</span>
                <span className="tabular-nums text-[var(--color-muted)]">
                  &minus;{formatMoney(appointment.membership_discount_cents)}
                </span>
              </li>
            )}
          </ul>
        )}
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
          {/*
            While the booking waits on a person, the forms are the thing the
            client can usefully do and the deposit is not: paying does not move
            it any closer to confirmed. So the emphasis swaps rather than the
            deposit disappearing — it is still payable, just not the loud
            button on a booking nobody has agreed to yet.
          */}
          <div className="flex flex-wrap gap-3">
            <ButtonLink href="/account/forms" variant={awaitingApproval ? 'accent' : 'subtle'}>
              Complete your forms
            </ButtonLink>
            {appointment.deposit_cents > 0 && appointment.deposit_status !== 'paid' && (
              <ButtonLink
                href={`/account/appointments/${appointment.id}/deposit`}
                variant={awaitingApproval ? 'subtle' : 'accent'}
              >
                Pay {formatMoney(appointment.deposit_cents)} deposit
              </ButtonLink>
            )}
          </div>

          {/* `status` is load-bearing, not decoration: without it the 24-hour
              forfeiture warning fires on a booking the studio never agreed to,
              and the client is told they lose a deposit for withdrawing a
              request. */}
          <CancelAppointment
            appointmentId={appointment.id}
            hoursAway={hoursAway}
            depositPaid={appointment.deposit_status === 'paid'}
            status={appointment.status}
          />
        </div>
      )}
    </div>
  )
}
