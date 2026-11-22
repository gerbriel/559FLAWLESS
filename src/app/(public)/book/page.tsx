import type { Metadata } from 'next'
import { isProfileComplete } from '@/lib/profile'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { requestNow } from '@/lib/time'
import { interestedServiceId } from '@/lib/interest'
import {
  includedAllowances,
  includedSessionsLeft,
  membershipIsCurrent,
  membershipPeriodLabel,
} from '@/types/memberships'
import { Container, Section } from '@/components/ui/section'
import {
  BookingFlow,
  type BookableService,
  type BookableProvider,
  type BookingMembership,
} from '@/components/booking/BookingFlow'
import {
  LocationBookingBar,
  LocationBookingStep,
  bookableAtLocation,
  resolveBookingLocation,
} from '@/components/layout/LocationBooking'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Book an Appointment',
  description: 'Book a facial, waxing, or skin treatment at 559 Flawless in Fresno.',
}

interface Props {
  searchParams: Promise<{ service?: string; location?: string; add?: string; membership?: string }>
}

export default async function BookPage({ searchParams }: Props) {
  const {
    service: serviceSlug,
    location: locationSlug,
    add,
    membership: membershipParam,
  } = await searchParams
  // The pair-deal row on a service page pre-ticks its service alongside the
  // deep link — comma-separated, unknown slugs simply don't match anything.
  const addSlugs = (add ?? '').split(',').filter(Boolean)
  const supabase = await createClient()

  // Which studio. With one location this resolves to `single` without a second
  // query and nothing below changes — no step, no bar, no filtering.
  const locationScope = await resolveBookingLocation(locationSlug)

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const [
    { data: rawServices },
    { data: rawProviders },
    { data: links },
    { data: addonLinks },
    profileRes,
    { data: bookingSettings },
    { data: pairRules },
    { data: promoRules },
  ] = await Promise.all([
      supabase
        .from('services')
        // NB: one string literal, never `'a' + 'b'` — postgrest-js parses the
        // select at the type level and concatenation widens it to `string`,
        // which collapses the result type to SelectQueryError.
        .select(
          'id, name, slug, description, price_cents, duration_minutes, deposit_cents, is_intimate, requires_age_verification, min_age, patch_test_hours, is_featured, sort_order, category_id, service_categories(name, slug, is_intimate, sort_order, is_active)'
        )
        .eq('is_active', true)
        .eq('requires_consultation', false)
        .order('sort_order'),
      supabase
        .from('profiles')
        .select('id, display_name, first_name, bio, timezone')
        // Bookable is `accepts_online_booking`, not role — a solo owner is
        // admin AND the person doing the treatment. See migration 020.
        .neq('role', 'client')
        .eq('accepts_online_booking', true)
        .is('suspended_at', null),
      supabase.from('provider_services').select('provider_id, service_id').eq('is_active', true),
      supabase
        .from('service_addon_links')
        .select('service_id, service_addons(id, name, price_cents, duration_minutes, is_active)'),
      user
        ? supabase
            .from('profiles')
            .select('role, first_name, last_name, email, phone, date_of_birth')
            .eq('id', user.id)
            .maybeSingle()
        : Promise.resolve({ data: null }),
      // Whether website bookings are confirmed on the spot. Publicly readable
      // (003), and it is what the paragraph below is allowed to promise.
      supabase.from('booking_settings').select('auto_confirm').eq('id', 1).maybeSingle(),
      // The pair deal (067). The flow previews it; priceService() decides it.
      supabase
        .from('service_pair_discounts')
        .select('id, trigger_service_id, discounted_service_id, percent_off, label')
        .eq('is_active', true),
      // The deal board (068), same arrangement: preview here, decided there.
      supabase
        .from('promotions')
        .select(
          'id, name, kind, percent_off, amount_cents, sale_price_cents, min_items, service_ids, starts_at, ends_at, is_active'
        )
        .eq('is_active', true)
        .in('kind', ['service_sale', 'second_service', 'new_client']),
    ])

  // Map add-ons to their services once, rather than per render.
  const addonsByService = new Map<number, BookableService['addons']>()
  for (const link of addonLinks ?? []) {
    const addon = link.service_addons as unknown as {
      id: number
      name: string
      price_cents: number
      duration_minutes: number
      is_active: boolean
    } | null
    if (!addon?.is_active) continue
    const list = addonsByService.get(link.service_id) ?? []
    list.push({
      id: addon.id,
      name: addon.name,
      price_cents: addon.price_cents,
      duration_minutes: addon.duration_minutes,
    })
    addonsByService.set(link.service_id, list)
  }

  const services: BookableService[] = (rawServices ?? [])
    // A retired (inactive) category takes its services off the public menu
    // while the engine still books them — which is what makes an unlisted,
    // link-only service possible (a payment test, a private offer). The deep
    // link is the one door back in.
    .filter((s) => {
      const cat = s.service_categories as unknown as { is_active?: boolean } | null
      return (cat?.is_active ?? true) || s.slug === serviceSlug
    })
    .map((s) => {
      const cat = s.service_categories as unknown as {
        name: string
        slug: string
        is_intimate: boolean
        sort_order: number
      } | null
      return {
        id: s.id,
        name: s.name,
        slug: s.slug,
        description: s.description,
        price_cents: s.price_cents,
        duration_minutes: s.duration_minutes,
        deposit_cents: s.deposit_cents,
        is_featured: s.is_featured,
        is_intimate: s.is_intimate,
        requires_age_verification: s.requires_age_verification,
        min_age: s.min_age,
        patch_test_hours: s.patch_test_hours,
        category_id: s.category_id,
        category: {
          name: cat?.name ?? 'Other',
          slug: cat?.slug ?? '',
          is_intimate: cat?.is_intimate ?? false,
        },
        _catOrder: cat?.sort_order ?? 99,
        addons: addonsByService.get(s.id) ?? [],
      }
    })
    .sort((a, b) => a._catOrder - b._catOrder)
    .map(({ _catOrder, ...s }) => {
      void _catOrder
      return s
    })

  const servicesByProvider = new Map<string, number[]>()
  for (const l of links ?? []) {
    const list = servicesByProvider.get(l.provider_id) ?? []
    list.push(l.service_id)
    servicesByProvider.set(l.provider_id, list)
  }

  const providers: BookableProvider[] = (rawProviders ?? []).map((p) => ({
    id: p.id,
    display_name: p.display_name ?? p.first_name ?? 'Provider',
    bio: p.bio,
    timezone: p.timezone,
    service_ids: servicesByProvider.get(p.id) ?? [],
  }))

  // A chosen studio narrows the menu to what that room offers and the list to
  // the people who work there. Both are null for a single-location studio, so
  // this is two no-op filters and no extra round trip.
  const { serviceIds: offeredHere, providerIds: worksHere } =
    await bookableAtLocation(locationScope)
  const scopedServices = offeredHere ? services.filter((s) => offeredHere.has(s.id)) : services
  const scopedProviders = worksHere ? providers.filter((p) => worksHere.has(p.id)) : providers

  // ── Booking a covered visit (?membership=1) ──────────────
  // From the membership page or the welcome page after joining. Only a live
  // membership (active, period not ended) with sessions left this period
  // counts; anything else and the flow is exactly the ordinary one. This is
  // presentation: whether a visit is actually covered is decided when the
  // studio confirms it, by the redemption, not by this banner.
  let membership: BookingMembership | undefined
  // Any current member books without a deposit, whichever way they got here.
  // Same test as membership_is_current(): active, period not over.
  let memberNoDeposit = false
  if (user) {
    const { data: current } = await supabase
      .from('client_memberships')
      .select('id')
      .eq('client_id', user.id)
      .eq('status', 'active')
      .gt('current_period_end', new Date(requestNow()).toISOString())
      .limit(1)
      .maybeSingle()
    memberNoDeposit = !!current
  }
  if (membershipParam === '1' && user) {
    const { data: held } = await supabase
      .from('client_memberships')
      .select(
        'id, status, current_period_start, current_period_end, memberships!client_memberships_membership_id_fkey(name, included_sessions_per_period, period_months, membership_services(service_id, sessions_per_period, services(slug, name))), membership_redemptions(service_id, sessions, redeemed_for_period_start)'
      )
      .eq('client_id', user.id)
      .eq('status', 'active')
      .order('current_period_end', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (held && membershipIsCurrent(held, requestNow())) {
      const plan = held.memberships as unknown as {
        name: string
        included_sessions_per_period: number
        period_months: number
        membership_services:
          | {
              service_id: number
              sessions_per_period: number | null
              services: { slug: string; name: string } | null
            }[]
          | null
      } | null
      const scope = plan?.membership_services ?? []
      // Each allowance this period (088): one per treatment with its own
      // number, or the shared pool.
      const allowances = plan
        ? includedAllowances(
            plan,
            scope.map((r) => ({
              service_id: r.service_id,
              sessions_per_period: r.sessions_per_period,
              name: r.services?.name ?? null,
            })),
            (held.membership_redemptions ?? []) as {
              service_id: number | null
              sessions: number
              redeemed_for_period_start: string
            }[],
            held.current_period_start
          )
        : []
      const left = includedSessionsLeft(allowances)
      const total = allowances.reduce((n, a) => n + a.total, 0)
      if (plan && left > 0) {
        const leftOf = (a: (typeof allowances)[number]) => Math.max(a.total - a.used, 0)
        const pool = allowances.find((a) => a.serviceId === null)
        const poolLeft = pool ? leftOf(pool) : 0
        // A treatment is still covered when its own allowance has something
        // left, or when it draws from a pool that does.
        const stillCovered = (r: (typeof scope)[number]) => {
          if (r.sessions_per_period === null) return poolLeft > 0
          const own = allowances.find((a) => a.serviceId === r.service_id)
          return !!own && leftOf(own) > 0
        }
        // Only what this studio's menu actually offers, so the pre-tick lands.
        const bookable = new Set(scopedServices.map((s) => s.slug))
        const poolNames = scope
          .filter((r) => r.sessions_per_period === null)
          .map((r) => r.services?.name)
          .filter((n): n is string => !!n)
        // "1 Custom Corrective Facial and 1 Full Brazilian", what is left of
        // each allowance, empty ones left out.
        const parts = allowances.flatMap((a) => {
          const n = leftOf(a)
          if (n === 0) return []
          if (a.serviceId !== null) {
            const name = a.serviceName ?? 'treatment'
            return [n === 1 ? `1 ${name}` : `${n} ${name} visits`]
          }
          const noun = n === 1 ? 'treatment' : 'treatments'
          return [
            poolNames.length > 0
              ? `${n} ${noun} (${poolNames.join(' or ')})`
              : `${n} ${noun}, any on the menu`,
          ]
        })
        const listed =
          parts.length <= 1
            ? parts.join('')
            : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
        const span = [1, 3, 12].includes(plan.period_months)
          ? `this ${membershipPeriodLabel(plan.period_months)}`
          : 'this period'
        membership = {
          planName: plan.name,
          left,
          total,
          leftLabel: `Covered ${span}: ${listed}`,
          // Only an empty scope is "any treatment". An empty
          // coveredServiceSlugs can also mean every covered treatment was
          // filtered out as not bookable here.
          anyTreatment: scope.length === 0,
          coveredServiceSlugs: scope
            .filter(stillCovered)
            .map((m) => m.services?.slug)
            .filter((slug): slug is string => !!slug && bookable.has(slug)),
        }
      }
    }
  }
  // A deep-linked service wins; otherwise the plan's first covered service is
  // pre-ticked through the same initial-selection path. No scope rows (any
  // treatment) means nothing is pre-ticked.
  const initialSlug = serviceSlug ?? membership?.coveredServiceSlugs[0]

  const profile = profileRes?.data as
    | {
        role: string
        first_name: string | null
        last_name: string | null
        email: string | null
        phone: string | null
        date_of_birth: string | null
      }
    | null

  // Booking still requires an account — the studio holds treatment history,
  // consent and health answers against a person. What changed is WHEN: a
  // visitor browses services, picks a provider and a time first, and creates
  // the account at the moment of confirming, inline in the details step.
  // Bouncing them to /login before they had seen a single open slot was the
  // funnel's biggest leak.
  const bookingParams = new URLSearchParams()
  if (locationSlug) bookingParams.set('location', locationSlug)
  if (serviceSlug) bookingParams.set('service', serviceSlug)
  if (addSlugs.length > 0) bookingParams.set('add', addSlugs.join(','))
  if (membershipParam === '1') bookingParams.set('membership', '1')
  const bookingUrl = `/book${bookingParams.size ? `?${bookingParams}` : ''}`

  // Signed in but missing the details a booking needs. Same reasoning as the
  // auth callback; this catches the account made before that step existed.
  if (user && profile?.role === 'client' && !isProfileComplete(profile)) {
    redirect(`/account/complete?next=${encodeURIComponent(bookingUrl)}`)
  }

  // First visit? The flow shows the new-client deal only to someone it can
  // apply to. Presentation only — the engine re-derives this at booking, so a
  // stale answer here can never mis-price anyone.
  let isNewClient = !user
  if (user) {
    const { count: priorVisits } = await supabase
      .from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('client_id', user.id)
      .not('status', 'in', '(cancelled,no_show)')
    isNewClient = (priorVisits ?? 0) === 0
  }

  // ── The gentle reorder ───────────────────────────────────
  // When their own recent events point at a service (interest.ts, under
  // migration 060's "client reads own events" policy), that service's whole
  // CATEGORY floats to the top — the category, not the lone service pinned
  // above its group, so the flow's grouping survives and the nudge stays
  // gentle. The partition is stable, so order within every category is
  // untouched. A deep link has already chosen a service, so the query is
  // skipped; and every failure — policy not applied yet, no events, a service
  // not on this studio's menu — leaves the order exactly as it was.
  let orderedServices = scopedServices
  if (!initialSlug && user) {
    const interestId = await interestedServiceId(supabase, user.id, requestNow())
    const interestCategoryId =
      interestId !== null
        ? scopedServices.find((s) => s.id === interestId)?.category_id
        : undefined
    if (interestCategoryId !== undefined) {
      orderedServices = [
        ...scopedServices.filter((s) => s.category_id === interestCategoryId),
        ...scopedServices.filter((s) => s.category_id !== interestCategoryId),
      ]
    }
  }

  return (
    <Section>
      <Container>
        <div className="mb-14 max-w-2xl">
          <p className="label-caps mb-4 text-[var(--color-accent)]">Booking</p>
          <h1 className="display text-4xl sm:text-5xl">Reserve your time.</h1>
          {/*
            What this paragraph used to say was "you will get a confirmation by
            email and a reminder before your visit", and neither half was true.
            There is no mail or SMS sender in this codebase — every notification
            is in-app — and with `auto_confirm` off the studio reviews website
            bookings before confirming them, so the confirmation being promised
            here is the very thing that has not happened yet. It is the first
            sentence a client reads, and it set the expectation the booking
            screen then has to walk back.

            Both branches are checked against the code: the appointments page
            genuinely does show the state (STATUS_LABEL in
            account/appointments/_lib/status.ts), and the notification really
            does arrive — in the bell in the account header.
          */}
          <p className="mt-5 text-[var(--color-muted)]">
            {bookingSettings?.auto_confirm === false ? (
              <>
                Pick your service and choose a time. It is held for you the moment you
                book, and the studio confirms website bookings themselves — so it shows
                as awaiting confirmation on your appointments page until they do, and
                you will be told there as soon as it is confirmed.
              </>
            ) : (
              <>
                Pick your service, choose a time that works, and we will take it from
                there. Some bookings are checked by the studio before they are
                confirmed; your appointments page always shows where yours stands.
              </>
            )}
          </p>
        </div>

        {/* Only ever rendered when a second studio is open and none is chosen. */}
        {locationScope.mode === 'choose' && (
          <LocationBookingStep locations={locationScope.locations} serviceSlug={serviceSlug} />
        )}

        {locationScope.mode === 'selected' && (
          <LocationBookingBar location={locationScope.location} serviceSlug={serviceSlug} />
        )}

        {locationScope.mode === 'choose' ? null : scopedServices.length === 0 ||
          scopedProviders.length === 0 ? (
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
            <p className="display text-2xl">Online booking is not open yet.</p>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              {locationScope.mode === 'selected'
                ? 'Nothing is bookable online at this location yet. Please pick another studio, or get in touch and we will find you a time.'
                : 'Once a provider sets their schedule and marks themselves bookable, times will appear here. In the meantime, please get in touch.'}
            </p>
          </div>
        ) : (
          <BookingFlow
            services={orderedServices}
            providers={scopedProviders}
            pairDiscounts={pairRules ?? []}
            promotions={(promoRules ?? []).map((p) => ({
              ...p,
              service_ids: p.service_ids ?? [],
            }))}
            isNewClient={isNewClient}
            initialServiceSlug={initialSlug}
            membership={membership}
            memberNoDeposit={memberNoDeposit}
            initialAddSlugs={addSlugs}
            // Everything the profile already holds, so the details step can ask
            // for what is missing and nothing else — and write back whatever
            // they end up supplying.
            signedInUserId={user?.id ?? null}
            signedInEmail={profile?.email ?? user?.email ?? null}
            signedInName={
              profile?.first_name
                ? { first: profile.first_name, last: profile.last_name ?? '' }
                : null
            }
            signedInPhone={profile?.phone ?? null}
          />
        )}
      </Container>
    </Section>
  )
}
