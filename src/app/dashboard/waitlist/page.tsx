import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { WaitlistTable, type WaitlistRow } from '@/components/shared/WaitlistTable'
import { WaitlistOpenings, type FreedSlot } from '@/components/shared/WaitlistOpenings'
import { readLocationScope, withLocation } from '@/components/layout/LocationScope'
import { requestNow } from '@/lib/time'
import { isFrontDesk, type UserRole } from '@/types/database'
import type { WaitlistStatus } from '@/types/resources'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ status?: string }>
}

const FILTERS: { key: string; label: string; statuses: WaitlistStatus[] }[] = [
  { key: 'open', label: 'Waiting', statuses: ['waiting', 'notified'] },
  { key: 'booked', label: 'Booked', statuses: ['converted'] },
  { key: 'closed', label: 'Closed', statuses: ['expired', 'cancelled'] },
  {
    key: 'all',
    label: 'Everyone',
    statuses: ['waiting', 'notified', 'converted', 'expired', 'cancelled'],
  },
]

/** How far back a cancellation still counts as a fresh opening worth filling. */
const FREED_LOOKBACK_DAYS = 7

type ProfileEmbed = { first_name: string | null; last_name: string | null } | null
type ProviderEmbed = { display_name: string | null; first_name: string | null } | null

export default async function WaitlistPage({ searchParams }: Props) {
  const { status } = await searchParams
  const activeFilter = FILTERS.find((f) => f.key === status) ?? FILTERS[0]

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/waitlist')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'provider') as UserRole
  // A provider can see entries that named them, but the list as a whole — with
  // everyone's contact details on it — is front desk work.
  if (!isFrontDesk(role)) redirect('/dashboard')

  const locationId = await readLocationScope()
  const now = requestNow()
  const freedSince = new Date(now - FREED_LOOKBACK_DAYS * 86_400_000).toISOString()
  const nowIso = new Date(now).toISOString()

  let entriesQuery = supabase
    .from('waitlist_entries')
    // One string literal: postgrest-js parses the select at the type level, and
    // 'a' + 'b' widens to `string`, collapsing the result to SelectQueryError.
    // Both profile embeds name their constraint — this table has two FKs to
    // profiles, so `profiles(...)` alone is ambiguous.
    .select(
      'id, location_id, client_id, preferred_provider_id, earliest_date, latest_date, days_of_week, earliest_time, latest_time, note, status, created_at, notified_at, claim_expires_at, offers_sent, expires_at, client:profiles!waitlist_entries_client_id_fkey(first_name, last_name, email, phone), provider:profiles!waitlist_entries_preferred_provider_id_fkey(display_name, first_name), waitlist_services(service_id, services(name))'
    )
    .in('status', activeFilter.statuses)
    .order('created_at')
  entriesQuery = withLocation(entriesQuery, locationId)

  let freedQuery = supabase
    .from('appointments')
    .select(
      'id, starts_at, ends_at, location_id, cancelled_at, provider:profiles!appointments_provider_id_fkey(display_name, first_name), appointment_services(service_id, name_snapshot)'
    )
    .eq('status', 'cancelled')
    .gt('starts_at', nowIso)
    .gte('cancelled_at', freedSince)
    .order('starts_at')
  freedQuery = withLocation(freedQuery, locationId)

  const [{ data: entries }, { data: freed }, { data: locations }, { data: settings }] =
    await Promise.all([
      entriesQuery,
      freedQuery,
      supabase.from('locations').select('id, name, timezone'),
      supabase
        .from('waitlist_settings')
        .select('batch_size, claim_window_minutes, urgent_within_hours, auto_notify')
        .eq('id', 1)
        .maybeSingle(),
    ])

  const zoneFor = new Map<number, string>(
    (locations ?? []).map((l) => [l.id, l.timezone as string])
  )
  const nameFor = new Map<number, string>(
    (locations ?? []).map((l) => [l.id, l.name as string])
  )
  const manyLocations = (locations ?? []).length > 1

  const rows: WaitlistRow[] = (entries ?? []).map((e) => {
    const client = e.client as unknown as ProfileEmbed
    const provider = e.provider as unknown as ProviderEmbed
    const links = (e.waitlist_services ?? []) as unknown as {
      service_id: number
      services: { name: string } | null
    }[]

    return {
      id: e.id,
      client_name:
        [client?.first_name, client?.last_name].filter(Boolean).join(' ') || 'A client',
      client_id: e.client_id,
      client_email: null,
      provider_name: provider?.display_name ?? provider?.first_name ?? null,
      service_names: links.map((l) => l.services?.name ?? 'A service'),
      earliest_date: e.earliest_date,
      latest_date: e.latest_date,
      days_of_week: e.days_of_week ?? [],
      earliest_time: e.earliest_time,
      latest_time: e.latest_time,
      note: e.note,
      status: e.status as WaitlistStatus,
      created_at: e.created_at,
      claim_expires_at: e.claim_expires_at,
      offers_sent: e.offers_sent,
      location_name: manyLocations ? (nameFor.get(e.location_id) ?? null) : null,
    }
  })

  // How many people each freed slot could go to. `waitlist_matches` is the same
  // function the cancellation trigger uses, so the number shown here is exactly
  // who would be told — not an approximation of it.
  const openings: FreedSlot[] = await Promise.all(
    (freed ?? []).map(async (a) => {
      const provider = a.provider as unknown as ProviderEmbed
      const lines = (a.appointment_services ?? []) as unknown as {
        name_snapshot: string
      }[]
      const { data: matches } = await supabase.rpc('waitlist_matches', {
        p_appointment: a.id,
      })

      return {
        appointment_id: a.id,
        starts_at: a.starts_at,
        time_zone: zoneFor.get(a.location_id) ?? 'America/Los_Angeles',
        provider_name: provider?.display_name ?? provider?.first_name ?? 'A provider',
        service_names: lines.map((l) => l.name_snapshot),
        match_count: (matches ?? []).length,
        location_name: manyLocations ? (nameFor.get(a.location_id) ?? null) : null,
      }
    })
  )

  const waitingNow = rows.filter((r) => r.status === 'waiting').length
  const holding = rows.filter((r) => r.status === 'notified').length

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Waitlist</h1>
        <div className="flex flex-wrap items-center gap-2">
          {holding > 0 && <Badge tone="accent">{holding} holding an offer</Badge>}
          {waitingNow > 0 && <Badge tone="neutral">{waitingNow} waiting</Badge>}
        </div>
      </div>

      <p className="mt-4 max-w-2xl text-sm leading-relaxed text-[var(--color-muted)]">
        {settings?.auto_notify
          ? `A cancellation tells the ${
              settings.batch_size === 1
                ? 'person who has waited longest'
                : `first ${settings.batch_size} people`
            } automatically, and holds it for them for ${
              settings.claim_window_minutes
            } minutes before anyone else hears. Inside ${
              settings.urgent_within_hours
            } hours of the appointment everyone matching is told at once.`
          : 'Automatic offers are switched off, so nobody is told until someone here sends the offer.'}{' '}
        <Link
          href="/dashboard/settings"
          className="underline underline-offset-4 hover:text-[var(--color-foreground)]"
        >
          Change that
        </Link>
        .
      </p>

      <WaitlistOpenings openings={openings} />

      <nav className="mt-12 flex flex-wrap gap-x-7 gap-y-2" aria-label="Filter">
        {FILTERS.map((f) => (
          <Link
            key={f.key}
            href={`/dashboard/waitlist?status=${f.key}`}
            className={`label-caps pb-1 ${
              activeFilter.key === f.key
                ? 'border-b border-[var(--color-foreground)]'
                : 'text-[var(--color-muted)]'
            }`}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      {rows.length === 0 ? (
        <p className="mt-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          {activeFilter.key === 'open'
            ? 'Nobody is waiting. When the calendar is full, clients can add themselves from the booking page.'
            : 'Nothing here.'}
        </p>
      ) : (
        <WaitlistTable rows={rows} now={now} />
      )}
    </div>
  )
}
