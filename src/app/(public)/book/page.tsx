import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Container, Section } from '@/components/ui/section'
import { BookingFlow, type BookableService, type BookableProvider } from '@/components/booking/BookingFlow'
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
  searchParams: Promise<{ service?: string; location?: string }>
}

export default async function BookPage({ searchParams }: Props) {
  const { service: serviceSlug, location: locationSlug } = await searchParams
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
  ] = await Promise.all([
      supabase
        .from('services')
        // NB: one string literal, never `'a' + 'b'` — postgrest-js parses the
        // select at the type level and concatenation widens it to `string`,
        // which collapses the result type to SelectQueryError.
        .select(
          'id, name, slug, description, price_cents, duration_minutes, deposit_cents, is_intimate, requires_age_verification, min_age, patch_test_hours, sort_order, category_id, service_categories(name, slug, is_intimate, sort_order)'
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

  // Booking requires an account. The studio holds treatment history, consent
  // signatures and health answers against a person, and a guest booking has
  // nowhere to put any of it — the record would start over every visit.
  // The chosen studio rides along, so signing in does not drop them back to the
  // location step they just completed.
  const bookingParams = new URLSearchParams()
  if (locationSlug) bookingParams.set('location', locationSlug)
  if (serviceSlug) bookingParams.set('service', serviceSlug)
  const bookingUrl = `/book${bookingParams.size ? `?${bookingParams}` : ''}`
  if (!user) {
    redirect(`/login?next=${encodeURIComponent(bookingUrl)}`)
  }

  // Signed in but missing the details a booking needs. Same reasoning as the
  // auth callback; this catches the account made before that step existed.
  if (
    profile?.role === 'client' &&
    (!profile.first_name?.trim() || !profile.phone?.trim() || !profile.date_of_birth)
  ) {
    redirect(`/account/complete?next=${encodeURIComponent(bookingUrl)}`)
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
            services={scopedServices}
            providers={scopedProviders}
            initialServiceSlug={serviceSlug}
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
