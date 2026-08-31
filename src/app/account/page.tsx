import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CalendarDays, FileText, MessageSquare, Sparkles } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { ButtonLink } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone, requestNow } from '@/lib/time'
import { interestedServiceId } from '@/lib/interest'
import {
  DEPOSIT_LABEL,
  DEPOSIT_TONE,
  STATUS_LABEL,
  STATUS_TONE,
} from './appointments/_lib/status'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

export default async function AccountPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Server Component: the clock comes from the named seam, not a bare Date.
  const now = new Date(requestNow()).toISOString()

  const [
    { data: profile },
    { data: upcoming },
    { data: record },
    { count: unreadMessages },
    { data: pointsBalance },
  ] = await Promise.all([
      supabase.from('profiles').select('first_name').eq('id', user.id).maybeSingle(),
      supabase
        .from('appointments')
        // `appointments` has two FKs to profiles (provider_id, client_id), so
        // the embed has to name which constraint it means.
        .select(
          'id, starts_at, status, total_cents, deposit_cents, deposit_status, profiles!appointments_provider_id_fkey(display_name, first_name), appointment_services(name_snapshot, sort_order)'
        )
        .eq('client_id', user.id)
        .in('status', ['pending', 'confirmed'])
        .gte('starts_at', now)
        .order('starts_at')
        .limit(3),
      supabase
        .from('client_records')
        .select('visit_count, last_visit_at')
        .eq('client_id', user.id)
        .maybeSingle(),
      supabase
        .from('message_threads')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', user.id)
        .eq('client_unread', true),
      // Their points (067) — the sum of their own ledger, by RLS.
      supabase.rpc('loyalty_balance', { p_client: user.id }),
    ])

  const next = upcoming?.[0]

  // ── Pick up where you left off ───────────────────────────
  // Their OWN analytics events, read as them: migration 060's "client reads
  // own events" policy is what admits the rows, and every step here degrades
  // to "no card" — before the policy is applied, on any query error, when the
  // service has since been retired, or when it is already on their calendar
  // (nudging what is booked is noise). A personalization card must never be
  // the reason the account page errors (058's rule). No intimacy filter: this
  // is their private signed-in page, the one place that is allowed.
  let resume: { name: string; slug: string } | null = null
  const interestId = await interestedServiceId(supabase, user.id, requestNow())
  if (interestId !== null) {
    const [{ data: interestService }, { data: alreadyBooked }] = await Promise.all([
      supabase
        .from('services')
        .select('name, slug')
        .eq('id', interestId)
        .eq('is_active', true)
        // The booking flow cannot take a consultation-first service, so the
        // card must not point at one.
        .eq('requires_consultation', false)
        .maybeSingle(),
      supabase
        .from('appointments')
        .select('id, appointment_services!inner(service_id)')
        .eq('client_id', user.id)
        .in('status', ['pending', 'confirmed'])
        .gte('starts_at', now)
        .eq('appointment_services.service_id', interestId)
        .limit(1),
    ])
    if (interestService && (alreadyBooked ?? []).length === 0) {
      resume = { name: interestService.name, slug: interestService.slug }
    }
  }

  return (
    <div>
      <h1 className="display text-3xl">
        Hi{profile?.first_name ? `, ${profile.first_name}` : ''}.
      </h1>

      {next ? (
        <div className="mt-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
          {/* The query admits 'pending', so this heading has to as well — a
              booking the studio has not agreed to is not yet an appointment,
              and calling it one here undercuts the badge three lines down. */}
          <p className="label-caps mb-4 text-[var(--color-accent)]">
            {next.status === 'confirmed' ? 'Your next appointment' : 'Your next booking'}
          </p>

          <p className="display text-2xl">
            {formatDateTimeInTimeZone(new Date(next.starts_at), STUDIO_TZ)}
          </p>

          <p className="mt-2 text-[var(--color-muted)]">
            {((next.appointment_services ?? []) as { name_snapshot: string; sort_order: number }[])
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((s) => s.name_snapshot)
              .join(' + ')}
            {' with '}
            {(next.profiles as { display_name: string | null; first_name: string | null } | null)
              ?.display_name ??
              (next.profiles as { first_name: string | null } | null)?.first_name ??
              'your provider'}
          </p>

          {/* One vocabulary for the state of a booking, shared with the list
              and the detail page. A fourth private copy of these words is how
              they drifted apart the first time. */}
          <div className="mt-5 flex flex-wrap items-center gap-3">
            <Badge tone={STATUS_TONE[next.status]}>{STATUS_LABEL[next.status]}</Badge>
            {next.deposit_cents > 0 && (
              <Badge tone={DEPOSIT_TONE[next.deposit_status]}>
                {DEPOSIT_LABEL[next.deposit_status]}
              </Badge>
            )}
            <span className="text-sm tabular-nums text-[var(--color-muted)]">
              {formatMoney(next.total_cents)}
            </span>
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href={`/account/appointments/${next.id}`} variant="subtle" size="sm">
              Manage
            </ButtonLink>
            <ButtonLink href="/account/forms" variant="subtle" size="sm">
              Complete your forms
            </ButtonLink>
          </div>
        </div>
      ) : (
        <div className="mt-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
          <p className="display text-2xl">Nothing booked right now.</p>
          <p className="mx-auto mt-3 max-w-sm text-sm text-[var(--color-muted)]">
            {record?.last_visit_at
              ? 'Most people come back every four to six weeks.'
              : 'Book your first visit and we will take it from there.'}
          </p>
          <ButtonLink href="/book" className="mt-8">
            Book an appointment
          </ButtonLink>
        </div>
      )}

      {resume && (
        <div className="mt-8 flex flex-wrap items-center justify-between gap-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
          <div>
            <p className="label-caps mb-4 text-[var(--color-accent)]">
              Pick up where you left off
            </p>
            <p className="display text-2xl">{resume.name}</p>
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              You were looking at this recently and it never made it to the calendar.
            </p>
          </div>
          <ButtonLink href={`/book?service=${resume.slug}`} variant="subtle" size="sm">
            Book it
          </ButtonLink>
        </div>
      )}

      <div className="mt-10 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-4">
        <Link
          href="/account/appointments"
          className="flex flex-col gap-2 bg-[var(--color-background)] p-6 transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]"
        >
          <CalendarDays className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={1.5} />
          <span className="label-caps mt-2">Appointments</span>
          <span className="text-sm text-[var(--color-muted)]">
            {record?.visit_count ?? 0} completed
          </span>
        </Link>

        <Link
          href="/account/rewards"
          className="flex flex-col gap-2 bg-[var(--color-background)] p-6 transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]"
        >
          <Sparkles className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={1.5} />
          <span className="label-caps mt-2">Rewards</span>
          <span className="text-sm tabular-nums text-[var(--color-muted)]">
            {(pointsBalance ?? 0).toLocaleString()} points
          </span>
        </Link>

        <Link
          href="/account/forms"
          className="flex flex-col gap-2 bg-[var(--color-background)] p-6 transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]"
        >
          <FileText className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={1.5} />
          <span className="label-caps mt-2">Forms & consent</span>
          <span className="text-sm text-[var(--color-muted)]">Health history and releases</span>
        </Link>

        <Link
          href="/account/messages"
          className="flex flex-col gap-2 bg-[var(--color-background)] p-6 transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]"
        >
          <MessageSquare className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={1.5} />
          <span className="label-caps mt-2">Messages</span>
          <span className="text-sm text-[var(--color-muted)]">
            {(unreadMessages ?? 0) > 0 ? `${unreadMessages} unread` : 'No new replies'}
          </span>
        </Link>
      </div>
    </div>
  )
}
