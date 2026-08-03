import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Check, CircleDashed, ClipboardList } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { PendingBookingActions } from '@/components/shared/PendingBookingActions'
import { cn, formatMoney } from '@/lib/utils'
import {
  dateKeyInTimeZone,
  formatDateTimeInTimeZone,
  requestNow,
  timeZoneAbbreviation,
} from '@/lib/time'
import { formApplies, intakeIsCurrent, signatureIsCurrent } from '@/lib/forms'
import { isFrontDesk, isManager, type DepositStatus, type UserRole } from '@/types/database'
import { reviewReasonLabel } from '@/types/scheduling'

export const dynamic = 'force-dynamic'

/**
 * The approval queue.
 *
 * The studio's flow is: the client books, the client fills in their paperwork,
 * and the provider reviews the request while that is happening. So the question
 * this page has to answer is not "was a booking made" — the calendar says that —
 * it is "is this person ready to be treated". That means the forms, which is
 * what the readiness panel on each card shows.
 *
 * With `booking_settings.auto_confirm` off, every online booking lands here and
 * the provider becomes the main reader rather than the front desk. Copy is
 * written for both: a provider sees only her own queue, because that is all the
 * SELECT policies in 004 will hand her, and front desk and up see the studio.
 */
export default async function PendingBookingsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/appointments/pending')

  const nowMs = requestNow()
  const now = new Date(nowMs)

  // Everything that does not depend on the queue's contents goes out at once.
  const [
    { data: profile },
    { data: settings },
    { data: pending },
    { data: consentForms },
    { data: intakeForms },
  ] = await Promise.all([
    supabase.from('profiles').select('role, timezone').eq('id', user.id).maybeSingle(),
    supabase
      .from('booking_settings')
      .select('timezone, auto_confirm')
      .eq('id', 1)
      .maybeSingle(),
    supabase
      .from('appointments')
      .select(
        // The deposit columns are here because declining is a money decision:
        // a client can pay before anyone reviews the request, and whoever
        // declines has to be shown that before they tap. Same round trip, three
        // more columns — see PendingBookingActions for what happens with them.
        'id, starts_at, total_cents, deposit_cents, deposit_status, stripe_payment_intent_id, approval_reason, client_notes, client_id, guest_first_name, guest_last_name, guest_email, guest_phone, provider:profiles!appointments_provider_id_fkey(display_name, first_name), client:profiles!appointments_client_id_fkey(first_name, last_name, email, phone), appointment_services(name_snapshot, price_cents, duration_minutes, sort_order, services(id, category_id))'
      )
      .eq('status', 'pending')
      .order('starts_at'),
    supabase
      .from('consent_forms')
      .select('id, title, service_ids, category_ids')
      .eq('is_active', true),
    supabase
      .from('intake_forms')
      .select('id, title, service_ids, category_ids')
      .eq('is_active', true),
  ])

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

  const timeZone = settings?.timezone ?? profile?.timezone ?? 'America/Los_Angeles'
  const today = dateKeyInTimeZone(now, timeZone)

  const appointments = pending ?? []

  // One round trip each, not one per card. Same shape as /dashboard/forms:
  // collect the client ids first, then ask once.
  const clientIds = [
    ...new Set(appointments.map((a) => a.client_id).filter((id): id is string => !!id)),
  ]

  const [{ data: signatures }, { data: submissions }, { data: records }] =
    clientIds.length > 0
      ? await Promise.all([
          supabase
            .from('consent_signatures')
            .select('client_id, consent_form_id, expires_at')
            .in('client_id', clientIds),
          supabase
            .from('intake_submissions')
            .select('client_id, intake_form_id, submitted_at')
            .in('client_id', clientIds)
            .order('submitted_at', { ascending: false }),
          // Rolling stats kept by the trigger in 005 — the honest answer to
          // "have they been here before", which a per-provider count of
          // appointments could not give under RLS.
          supabase
            .from('client_records')
            .select('client_id, visit_count, no_show_count')
            .in('client_id', clientIds),
        ])
      : [{ data: [] }, { data: [] }, { data: [] }]

  // client → the consent forms they hold a live signature for.
  const currentConsent = new Map<string, Set<number>>()
  for (const s of signatures ?? []) {
    if (!signatureIsCurrent(s, nowMs)) continue
    const held = currentConsent.get(s.client_id) ?? new Set<number>()
    held.add(s.consent_form_id)
    currentConsent.set(s.client_id, held)
  }

  // client → most recent submission per intake form (rows arrive newest first).
  const latestIntake = new Map<string, Map<number, { submitted_at: string }>>()
  for (const s of submissions ?? []) {
    const byForm = latestIntake.get(s.client_id) ?? new Map()
    if (!byForm.has(s.intake_form_id)) byForm.set(s.intake_form_id, s)
    latestIntake.set(s.client_id, byForm)
  }

  const history = new Map<string, { visits: number; noShows: number }>()
  for (const r of records ?? []) {
    history.set(r.client_id, { visits: r.visit_count, noShows: r.no_show_count })
  }

  const cards: PendingCard[] = appointments.map((a) => {
    const lines = [...(a.appointment_services ?? [])].sort(
      (x, y) => x.sort_order - y.sort_order
    )
    const serviceIds = lines
      .map((l) => l.services?.id)
      .filter((id): id is number => typeof id === 'number')
    const categoryIds = lines
      .map((l) => l.services?.category_id)
      .filter((id): id is number => typeof id === 'number')

    const held = a.client_id ? currentConsent.get(a.client_id) : undefined
    const intakeByForm = a.client_id ? latestIntake.get(a.client_id) : undefined

    // A form counts as done only if it applies to what was booked AND the
    // client's last one is still current. Expiry is the part that is easy to
    // miss: a consent signature from two years ago is not a current one.
    const done: string[] = []
    const missing: string[] = []

    for (const form of intakeForms ?? []) {
      if (!formApplies(form, serviceIds, categoryIds)) continue
      if (intakeIsCurrent(intakeByForm?.get(form.id), nowMs)) done.push(form.title)
      else missing.push(form.title)
    }

    for (const form of consentForms ?? []) {
      if (!formApplies(form, serviceIds, categoryIds)) continue
      if (held?.has(form.id)) done.push(form.title)
      else missing.push(form.title)
    }

    const stats = a.client_id ? history.get(a.client_id) : undefined
    const start = new Date(a.starts_at)

    return {
      id: a.id,
      startsAt: a.starts_at,
      isToday: dateKeyInTimeZone(start, timeZone) === today,
      name:
        [a.client?.first_name, a.client?.last_name].filter(Boolean).join(' ') ||
        [a.guest_first_name, a.guest_last_name].filter(Boolean).join(' ') ||
        'A client',
      contact: a.client?.email ?? a.guest_email ?? a.client?.phone ?? a.guest_phone ?? null,
      providerName: a.provider?.display_name ?? a.provider?.first_name ?? null,
      services: lines.map((l) => l.name_snapshot).join(' + '),
      durationMinutes: lines.reduce((n, l) => n + l.duration_minutes, 0),
      totalCents: a.total_cents,
      depositCents: a.deposit_cents,
      depositStatus: a.deposit_status,
      depositPaymentIntentId: a.stripe_payment_intent_id,
      approvalReason: a.approval_reason,
      clientNotes: a.client_notes,
      // A booking with no account behind it is its own case, not a failing
      // one: there is nowhere to send a link, so the paperwork happens at the
      // studio. Colouring it amber would be telling the provider off for
      // something nobody can act on.
      forms: a.client_id
        ? { state: missing.length === 0 ? 'ready' : 'waiting', done, missing }
        : { state: 'no_account', done: [], missing },
      neverVisited: !!stats && stats.visits === 0,
      noShows: stats?.noShows ?? 0,
    }
  })

  // A request for a time that has already been and gone is not a decision the
  // studio still needs to make, but it should not vanish either — someone has
  // to clear it, and they should be able to see why it is there.
  const upcoming = cards.filter((c) => c.startsAt >= now.toISOString())
  const stale = cards.filter((c) => c.startsAt < now.toISOString())
  const readyCount = upcoming.filter((c) => c.forms.state === 'ready').length

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
          ? 'Bookings across the studio that came in through the website and matched one of the review rules.'
          : 'Bookings on your calendar that came in through the website and matched one of the review rules.'}{' '}
        They hold their time while they sit here, so confirming one can never
        clash with anything else. Declining releases it.
        {settings?.auto_confirm === false && (
          <>
            {' '}
            Every online booking is currently being held —{' '}
            {setsThePolicy ? (
              <>
                <Link href="/dashboard/settings#booking-policy" className="underline">
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

      <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
        Each one shows where the client has got to with their paperwork.{' '}
        {/* Forms are deliberately NOT a condition of confirming. They are
            needed before TREATMENT, not before the slot is granted: the whole
            point of the waiting period is that the client fills them in over
            the days between booking and the visit, so a provider will often
            want to approve the time first and let the paperwork follow.
            Blocking on it would also strand every guest booking — no account,
            nothing to fill anything in from. /dashboard/forms is where
            outstanding paperwork gets chased. */}
        It is there to tell you what to expect, not to stop you — nothing has to
        be signed before you confirm a time.
      </p>

      {cards.length === 0 ? (
        <div className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
          <Check className="mx-auto h-6 w-6 text-[var(--color-accent)]" strokeWidth={1.5} />
          <p className="mt-3 text-sm">
            {wholeStudio ? 'The studio is up to date.' : 'You are up to date.'}
          </p>
          <p className="mt-1 text-sm text-[var(--color-muted)]">
            {settings?.auto_confirm === false
              ? 'Nothing is waiting for a decision. New online bookings will appear here.'
              : 'Nothing is waiting for a decision. Bookings only appear here when a review rule catches one.'}
          </p>
        </div>
      ) : (
        <>
          {upcoming.length > 1 && (
            <p className="mt-8 text-sm">
              <strong className="tabular-nums">{upcoming.length}</strong> waiting
              {readyCount > 0 && (
                <span className="text-[var(--color-muted)]">
                  {' '}
                  · <span className="tabular-nums">{readyCount}</span> with their
                  paperwork already done
                </span>
              )}
            </p>
          )}

          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {upcoming.map((c) => (
              <PendingRow key={c.id} card={c} timeZone={timeZone} />
            ))}
          </ul>

          {stale.length > 0 && (
            <section className="mt-14">
              <h2 className="display text-2xl">Already passed</h2>
              <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
                Nobody answered these in time. Decline them to take the time back.
              </p>
              <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                {stale.map((c) => (
                  <PendingRow key={c.id} card={c} timeZone={timeZone} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  )
}

/** How far through their paperwork one client is, for one booking. */
type FormsReadiness = {
  state: 'ready' | 'waiting' | 'no_account'
  done: string[]
  missing: string[]
}

type PendingCard = {
  id: string
  startsAt: string
  isToday: boolean
  name: string
  contact: string | null
  providerName: string | null
  services: string
  durationMinutes: number
  totalCents: number
  /** Integer cents. What the deposit is, whether or not it has been paid. */
  depositCents: number
  depositStatus: DepositStatus
  depositPaymentIntentId: string | null
  approvalReason: string | null
  clientNotes: string | null
  forms: FormsReadiness
  neverVisited: boolean
  noShows: number
}

function PendingRow({ card, timeZone }: { card: PendingCard; timeZone: string }) {
  const start = new Date(card.startsAt)

  return (
    <li className="flex flex-col gap-5 py-6 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2.5">
          <p className="text-base">{card.name}</p>
          <Badge tone="warning">{reviewReasonLabel(card.approvalReason)}</Badge>
          {card.isToday && <Badge tone="danger">Today</Badge>}
          {/* The reason badge says why it is in the queue; these say who is
              turning up. Skipped when the reason already made the point. */}
          {card.neverVisited && card.approvalReason !== 'first_visit' && (
            <Badge tone="info">No visits yet</Badge>
          )}
          {card.noShows > 0 && (
            <Badge tone="warning">
              {card.noShows} missed before
            </Badge>
          )}
          {card.forms.state === 'no_account' && <Badge tone="neutral">No account</Badge>}
          {/* Money already taken on a booking nobody has agreed to yet. It is a
              badge rather than a line of prose because it has to survive a scan
              — the decline button is two inches away, and declining does not
              give it back. The tone follows the convention every other deposit
              in the app uses (paid is success); the weight is carried by the
              acknowledgement PendingBookingActions puts in front of Decline. */}
          {card.depositStatus === 'paid' && card.depositCents > 0 && (
            <Badge tone="success">Deposit paid · {formatMoney(card.depositCents)}</Badge>
          )}
        </div>

        <p className="mt-2 text-sm tabular-nums">
          {formatDateTimeInTimeZone(start, timeZone)}{' '}
          <span className="text-[var(--color-muted)]">
            {timeZoneAbbreviation(start, timeZone)}
            {card.providerName ? ` · with ${card.providerName}` : ''}
          </span>
        </p>

        {card.services && (
          <p className="mt-1.5 text-sm text-[var(--color-muted)]">
            {card.services} · {card.durationMinutes} min · {formatMoney(card.totalCents)}
            {/* Said out loud so the absence of the paid badge above is read as
                "no money has moved" rather than "nobody mentioned it". */}
            {card.depositCents > 0 && card.depositStatus === 'pending' && (
              <> · {formatMoney(card.depositCents)} deposit not paid yet</>
            )}
          </p>
        )}

        {card.contact && (
          <p className="mt-1.5 text-xs text-[var(--color-muted)]">{card.contact}</p>
        )}

        <FormsPanel forms={card.forms} />

        {card.clientNotes && (
          <p className="mt-3 max-w-prose border-l-2 border-[var(--color-accent)] pl-3 text-sm text-[var(--color-muted)]">
            {card.clientNotes}
          </p>
        )}

        <Link
          href={`/dashboard/appointments/${card.id}`}
          className="label-caps mt-3 inline-block text-[var(--color-muted)] hover:text-[var(--color-accent)]"
        >
          Open the booking
        </Link>
      </div>

      <PendingBookingActions
        appointmentId={card.id}
        clientName={card.name}
        depositCents={card.depositCents}
        depositStatus={card.depositStatus}
        depositPaymentIntentId={card.depositPaymentIntentId}
      />
    </li>
  )
}

/**
 * Ready / still waiting / nothing we can chase, told by colour first.
 *
 * A provider scanning ten of these should get the answer from the block, not
 * from the list inside it — the titles are for the one card she stops on. The
 * tones match the Badge component's, which is where the emerald and amber in
 * this file come from.
 */
const FORMS_TONE = {
  ready: {
    box: 'border-emerald-600/40 bg-emerald-50/60 dark:bg-transparent',
    text: 'text-emerald-800 dark:text-emerald-400',
  },
  waiting: {
    box: 'border-amber-600/40 bg-amber-50/60 dark:bg-transparent',
    text: 'text-amber-800 dark:text-amber-400',
  },
  no_account: {
    box: 'border-[var(--color-border)] bg-[var(--color-linen)] dark:bg-transparent',
    text: 'text-[var(--color-muted)]',
  },
} as const

function FormsPanel({ forms }: { forms: FormsReadiness }) {
  const tone = FORMS_TONE[forms.state]
  const applies = forms.done.length + forms.missing.length

  const Icon =
    forms.state === 'ready' ? Check : forms.state === 'waiting' ? CircleDashed : ClipboardList

  const headline =
    forms.state === 'no_account'
      ? applies === 0
        ? 'No forms for this booking'
        : `${applies} ${applies === 1 ? 'form' : 'forms'} to do at the studio`
      : forms.state === 'ready'
        ? applies === 0
          ? 'No forms needed for this booking'
          : 'Forms done — ready to be treated'
        : `${forms.missing.length} of ${applies} still outstanding`

  return (
    <div className={cn('mt-3 max-w-prose border p-3', tone.box)}>
      <p className={cn('label-caps flex items-center gap-1.5', tone.text)}>
        <Icon className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
        {headline}
      </p>

      {applies > 0 && (
        <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
          {forms.done.map((title) => (
            <li key={title} className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
              <Check className="h-3 w-3 shrink-0 text-emerald-700 dark:text-emerald-400" strokeWidth={2} />
              {title}
            </li>
          ))}
          {forms.missing.map((title) => (
            <li key={title} className="flex items-center gap-1.5 text-xs text-[var(--color-muted)]">
              <CircleDashed className="h-3 w-3 shrink-0" strokeWidth={1.75} />
              {title}
            </li>
          ))}
        </ul>
      )}

      {forms.state === 'no_account' && applies > 0 && (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Booked without an account, so there is nowhere to send a link. They fill
          these in when they arrive.
        </p>
      )}
    </div>
  )
}
