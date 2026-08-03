import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone , requestNow } from '@/lib/time'
import { STATUS_LABEL, STATUS_TONE } from './_lib/status'

export const dynamic = 'force-dynamic'

const STUDIO_TZ = 'America/Los_Angeles'

export default async function AppointmentsPage() {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: appointments } = await supabase
    .from('appointments')
    .select(
      'id, starts_at, status, total_cents, deposit_cents, deposit_status, profiles!appointments_provider_id_fkey(display_name, first_name), appointment_services(name_snapshot, sort_order)'
    )
    .eq('client_id', user.id)
    .order('starts_at', { ascending: false })
    .limit(50)

  const now = requestNow()
  const upcoming = (appointments ?? []).filter(
    (a) => new Date(a.starts_at).getTime() >= now && a.status !== 'cancelled'
  )
  const past = (appointments ?? []).filter(
    (a) => new Date(a.starts_at).getTime() < now || a.status === 'cancelled'
  )

  function row(a: (typeof upcoming)[number]) {
    const provider = a.profiles as { display_name: string | null; first_name: string | null } | null
    const services = ((a.appointment_services ?? []) as {
      name_snapshot: string
      sort_order: number
    }[])
      .sort((x, y) => x.sort_order - y.sort_order)
      .map((s) => s.name_snapshot)
      .join(' + ')

    return (
      <li key={a.id}>
        <Link
          href={`/account/appointments/${a.id}`}
          className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-3 py-6 transition-colors hover:text-[var(--color-accent)]"
        >
          <div className="min-w-0 flex-1">
            <p className="text-base">
              {formatDateTimeInTimeZone(new Date(a.starts_at), STUDIO_TZ)}
            </p>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              {services}
              {provider && ` · ${provider.display_name ?? provider.first_name}`}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-4">
            <Badge tone={STATUS_TONE[a.status]}>{STATUS_LABEL[a.status]}</Badge>
            <span className="tabular-nums text-sm">{formatMoney(a.total_cents)}</span>
          </div>
        </Link>
      </li>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Appointments</h1>
        <ButtonLink href="/book" size="sm">
          Book another
        </ButtonLink>
      </div>

      <section className="mt-10">
        <h2 className="label-caps mb-4 text-[var(--color-accent)]">Upcoming</h2>
        {upcoming.length === 0 ? (
          <p className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
            Nothing booked.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {upcoming.map(row)}
          </ul>
        )}
      </section>

      {past.length > 0 && (
        <section className="mt-14">
          <h2 className="label-caps mb-4 text-[var(--color-muted)]">History</h2>
          <ul className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {past.map(row)}
          </ul>
        </section>
      )}
    </div>
  )
}
