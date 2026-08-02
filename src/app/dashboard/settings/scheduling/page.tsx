import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { SchedulingPolicyForm } from '@/components/shared/SchedulingPolicyForm'
import {
  SchedulingProviderGaps,
  type GapProvider,
} from '@/components/shared/SchedulingProviderGaps'
import {
  SchedulingServiceRules,
  type SchedulableService,
} from '@/components/shared/SchedulingServiceRules'
import { isManager, type UserRole } from '@/types/database'
import type { ProviderSchedulingSettings, SchedulingPolicy } from '@/types/scheduling'

export const dynamic = 'force-dynamic'

interface Props {
  searchParams: Promise<{ location?: string }>
}

/**
 * Booking mechanics: which bookings need a person, and how tightly the day
 * packs. Manager and up — this decides what the public booking page offers,
 * which is closer to pricing than it is to counting stock.
 *
 * Scoped to one site at a time, with a switcher when there is more than one.
 * Gap rules are per provider per site on purpose: the drive between two studios
 * is real time.
 */
export default async function SchedulingSettingsPage({ searchParams }: Props) {
  const { location } = await searchParams
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/dashboard/settings/scheduling')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || !isManager(profile.role as UserRole)) redirect('/dashboard/settings')

  const { data: locations } = await supabase
    .from('locations')
    .select('id, name, is_active')
    .order('sort_order')
    .order('id')

  const sites = locations ?? []
  const requested = Number(location)
  const activeLocation =
    sites.find((l) => l.id === requested) ?? sites.find((l) => l.is_active) ?? sites[0]

  if (!activeLocation) {
    return (
      <div className="max-w-3xl">
        <h1 className="display text-3xl">Scheduling</h1>
        <p className="mt-8 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          No location on record — run migration 032.
        </p>
      </div>
    )
  }

  const [{ data: policy }, { data: providers }, { data: gapRows }, { data: services }] =
    await Promise.all([
      supabase
        .from('scheduling_policies')
        .select(
          'location_id, require_approval_new_client, no_show_threshold, default_min_gap_minutes, default_max_gap_minutes, default_min_fragment_minutes, allow_processing_overlap, updated_at'
        )
        .eq('location_id', activeLocation.id)
        .maybeSingle(),
      supabase
        .from('profiles')
        .select('id, first_name, last_name, display_name, role, suspended_at')
        .neq('role', 'client')
        .is('suspended_at', null)
        .order('first_name'),
      supabase
        .from('provider_scheduling_settings')
        .select(
          'provider_id, location_id, min_gap_minutes, max_gap_minutes, min_fragment_minutes, allow_processing_overlap, updated_at'
        )
        .eq('location_id', activeLocation.id),
      supabase
        .from('services')
        .select(
          'id, name, duration_minutes, processing_start_minutes, processing_minutes, requires_booking_approval, is_active, sort_order'
        )
        .eq('is_active', true)
        .order('sort_order')
        .order('name'),
    ])

  const settingsFor = new Map(
    (gapRows ?? []).map((r) => [r.provider_id, r as ProviderSchedulingSettings])
  )

  const gapProviders: GapProvider[] = (providers ?? []).map((p) => ({
    id: p.id,
    name:
      p.display_name ??
      [p.first_name, p.last_name].filter(Boolean).join(' ') ??
      'Unnamed',
    settings: settingsFor.get(p.id) ?? null,
  }))

  const serviceRows = (services ?? []) as SchedulableService[]
  const withProcessing = serviceRows.filter((s) => s.processing_minutes > 0).length
  const alwaysReviewed = serviceRows.filter((s) => s.requires_booking_approval).length

  return (
    <div className="max-w-3xl">
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="display text-3xl">Scheduling</h1>
        <Link
          href="/dashboard/appointments/pending"
          className="label-caps text-[var(--color-muted)] hover:text-[var(--color-accent)]"
        >
          Waiting on you
        </Link>
      </div>

      <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
        Everything here starts switched off, and switched off is exactly how the booking
        page has always behaved. Turn one on and it applies to the next page load.
      </p>

      {sites.length > 1 && (
        <nav className="mt-8 flex flex-wrap gap-x-7 gap-y-2" aria-label="Location">
          {sites.map((l) => (
            <Link
              key={l.id}
              href={`/dashboard/settings/scheduling?location=${l.id}`}
              className={`label-caps pb-1 ${
                l.id === activeLocation.id
                  ? 'border-b border-[var(--color-foreground)]'
                  : 'text-[var(--color-muted)]'
              }`}
            >
              {l.name}
            </Link>
          ))}
        </nav>
      )}

      <section className="mt-10">
        {policy ? (
          <SchedulingPolicyForm
            policy={policy as SchedulingPolicy}
            locationName={activeLocation.name}
          />
        ) : (
          <p className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
            No policy row for {activeLocation.name} — run migration 036.
          </p>
        )}
      </section>

      <section className="mt-14">
        <h2 className="display text-2xl">Per provider</h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          Anyone left on the studio defaults follows the rules above. These apply at{' '}
          {activeLocation.name} only.
        </p>

        {gapProviders.length === 0 ? (
          <p className="mt-6 text-sm text-[var(--color-muted)]">No staff on record.</p>
        ) : (
          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {gapProviders.map((p) => (
              <SchedulingProviderGaps
                key={p.id}
                provider={p}
                locationId={activeLocation.id}
                studioDefaults={{
                  min_gap_minutes: policy?.default_min_gap_minutes ?? 0,
                  max_gap_minutes: policy?.default_max_gap_minutes ?? null,
                  min_fragment_minutes: policy?.default_min_fragment_minutes ?? 0,
                }}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="mt-14">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="display text-2xl">Per service</h2>
          <span className="flex gap-2">
            {withProcessing > 0 && <Badge tone="info">{withProcessing} with processing</Badge>}
            {alwaysReviewed > 0 && <Badge tone="warning">{alwaysReviewed} reviewed</Badge>}
          </span>
        </div>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          Processing time and whether a booking always needs a look. Prices, durations and
          the safety gates stay on the service itself, under Services.
        </p>

        {serviceRows.length === 0 ? (
          <p className="mt-6 text-sm text-[var(--color-muted)]">No active services.</p>
        ) : (
          <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {serviceRows.map((s) => (
              <SchedulingServiceRules key={s.id} service={s} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
