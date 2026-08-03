import Link from 'next/link'
import { redirect } from 'next/navigation'
import { CalendarDays, FileText, MessageSquare } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { ButtonLink } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone, requestNow } from '@/lib/time'
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

  const [{ data: profile }, { data: upcoming }, { data: record }, { count: unreadMessages }] =
    await Promise.all([
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
    ])

  const next = upcoming?.[0]

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

      <div className="mt-10 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3">
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
