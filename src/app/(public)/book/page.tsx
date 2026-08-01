import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Container, Section } from '@/components/ui/section'
import { BookingFlow, type BookableService, type BookableProvider } from '@/components/booking/BookingFlow'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Book an Appointment',
  description: 'Book a facial, waxing, or skin treatment at 559 Flawless in Fresno.',
}

interface Props {
  searchParams: Promise<{ service?: string }>
}

export default async function BookPage({ searchParams }: Props) {
  const { service: serviceSlug } = await searchParams
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()

  const [{ data: rawServices }, { data: rawProviders }, { data: links }, { data: addonLinks }, profileRes] =
    await Promise.all([
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
  const bookingUrl = `/book${serviceSlug ? `?service=${encodeURIComponent(serviceSlug)}` : ''}`
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
          <p className="mt-5 text-[var(--color-muted)]">
            Pick your service, choose a time that works, and we will take it from there.
            You will get a confirmation by email and a reminder before your visit.
          </p>
        </div>

        {services.length === 0 || providers.length === 0 ? (
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
            <p className="display text-2xl">Online booking is not open yet.</p>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              Once a provider sets their schedule and marks themselves bookable, times
              will appear here. In the meantime, please get in touch.
            </p>
          </div>
        ) : (
          <BookingFlow
            services={services}
            providers={providers}
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
