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
import {
  REVIEW_REASON_LABELS,
  type ProviderSchedulingSettings,
  type SchedulingPolicy,
} from '@/types/scheduling'

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

  // `booking_settings.auto_confirm` is not edited here — it is the studio-wide
  // switch on the Settings index — but it is read here because it decides
  // whether anything on this page is doing anything. With it off, every online
  // booking is held for 'studio_policy' before the narrower rules are even
  // consulted (booking_review_reason, 036), so a page full of carefully aimed
  // rules would be silently moot. 003 makes the row readable by everyone.
  const [
    { data: policy },
    { data: providers },
    { data: gapRows },
    { data: services },
    { data: bookingSettings },
  ] = await Promise.all([
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
      supabase.from('booking_settings').select('auto_confirm').eq('id', 1).maybeSingle(),
    ])

  // Absent row means migration 003 never ran; its default is true, and true is
  // the behaviour that leaves this page in charge.
  const holdsEverything = bookingSettings?.auto_confirm === false

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
      <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
        The one approval rule that is not on this page is holding <em>every</em> online
        booking. That lives under{' '}
        <Link
          href="/dashboard/settings#booking-policy"
          className="text-[var(--color-foreground)] underline"
        >
          Booking policy
        </Link>{' '}
        on the Settings index, and it overrides all of this.
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

      {/* Precedence, because three of the four rules are on this page and the
          bluntest one is not. The quoted strings are REVIEW_REASON_LABELS — the
          same copy the queue and the notification bell show, so a reason read
          there is recognisable here.

          The ORDER is the order a booking meets these, which is not the order
          booking_review_reason() (036:535) reads them in. That function checks
          the per-service rule second, but only when it is given service ids, and
          appointment_route_approval passes null: at BEFORE INSERT the line items
          do not exist. The service rule is applied afterwards, by
          appointment_services_route_approval, and only `where a.status =
          'confirmed'` — so a booking already held for a first visit or a
          no-show record keeps that reason and never records 'service_policy'.
          Either way it is held; this list is about which reason is shown. */}
      <section className="mt-10 border-l-2 border-[var(--color-border)] pl-5">
        <h2 className="label-caps text-[var(--color-muted)]">Which rule wins</h2>
        <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
          A booking can match more than one of these. Only one reason is recorded against
          it, and it is the first that applies:
        </p>
        <ol className="mt-3 max-w-prose space-y-3 text-sm text-[var(--color-muted)]">
          <li className="flex gap-3">
            <span className="tabular-nums">1</span>
            <span>
              <span className="text-[var(--color-foreground)]">
                {REVIEW_REASON_LABELS.studio_policy}
              </span>{' '}
              — the studio-wide switch under Booking policy in Settings. Nothing below is
              consulted while it is on.
              {holdsEverything && (
                <span className="mt-1 block text-[var(--color-foreground)]">
                  It is on right now, so every rule on this page is currently moot.
                </span>
              )}
            </span>
          </li>
          <li className="flex gap-3">
            <span className="tabular-nums">2</span>
            <span>
              <span className="text-[var(--color-foreground)]">
                {REVIEW_REASON_LABELS.first_visit}
              </span>{' '}
              — Who gets looked at first, below. Only when that box is ticked.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="tabular-nums">3</span>
            <span>
              <span className="text-[var(--color-foreground)]">
                {REVIEW_REASON_LABELS.no_show_history}
              </span>{' '}
              — same section, once the count is reached. Counted against an account, so a
              booking that cannot be matched to one never reaches it.
            </span>
          </li>
          <li className="flex gap-3">
            <span className="tabular-nums">4</span>
            <span>
              <span className="text-[var(--color-foreground)]">
                {REVIEW_REASON_LABELS.service_policy}
              </span>{' '}
              — set per treatment in the Per service list further down. Last because it is
              settled once the treatments are on the booking: one already held for a reason
              above keeps that reason.
            </span>
          </li>
        </ol>
        <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
          None of it touches a booking made from the calendar or a client’s record. A held
          booking keeps its slot while it waits, and nothing expires or approves it — it
          sits in Waiting on you until a person decides.
        </p>
      </section>

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
