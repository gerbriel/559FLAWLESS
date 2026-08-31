import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { Clock, ShieldCheck, CalendarClock, FlaskConical } from 'lucide-react'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section } from '@/components/ui/section'
import { ButtonLink } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatMoney, formatServicePrice, formatDuration } from '@/lib/utils'
import { pairDiscountCents } from '@/lib/pair-discounts'

export const revalidate = 300

interface Props {
  params: Promise<{ category: string; service: string }>
}

/** Prerender every service page. See the note in the category route. */
export async function generateStaticParams() {
  try {
    const supabase = createPublicClient()
    const { data } = await supabase
      .from('services')
      .select('slug, service_categories(slug)')
      .eq('is_active', true)
    return (data ?? [])
      .map((s) => ({
        category: (s.service_categories as { slug: string } | null)?.slug ?? '',
        service: s.slug,
      }))
      .filter((p) => p.category !== '')
  } catch {
    return []
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { service } = await params
  const supabase = createPublicClient()
  const { data } = await supabase
    .from('services')
    .select('name, description')
    .eq('slug', service)
    .maybeSingle()

  if (!data) return { title: 'Service' }
  return { title: data.name, description: data.description ?? undefined }
}

export default async function ServiceDetailPage({ params }: Props) {
  const { category, service: serviceSlug } = await params
  const supabase = createPublicClient()

  const { data: service } = await supabase
    .from('services')
    .select(
      'id, name, slug, description, details, aftercare, price_cents, price_is_starting, duration_minutes, deposit_cents, cancellation_window_hours, is_intimate, requires_age_verification, requires_consultation, patch_test_hours, min_age, service_categories(name, slug, is_intimate)'
    )
    .eq('slug', serviceSlug)
    .eq('is_active', true)
    .maybeSingle()

  if (!service) notFound()

  const cat = service.service_categories as { name: string; slug: string } | null
  if (cat?.slug !== category) notFound()

  const [{ data: addonLinks }, { data: pairRules }, { data: dealsOnThis }] = await Promise.all([
    supabase
      .from('service_addon_links')
      .select('service_addons(id, name, description, price_cents, duration_minutes, is_active)')
      .eq('service_id', service.id),
    // The pair deal (067), from this page's side of it: what gets cheaper when
    // booked alongside THIS service.
    supabase
      .from('service_pair_discounts')
      .select(
        'id, percent_off, services!service_pair_discounts_discounted_service_id_fkey(id, name, slug, description, price_cents, is_active)'
      )
      .eq('trigger_service_id', service.id)
      .eq('is_active', true),
    // And the other side: is THIS service the one a deal makes cheaper?
    supabase
      .from('service_pair_discounts')
      .select('label')
      .eq('discounted_service_id', service.id)
      .eq('is_active', true)
      .limit(1),
  ])

  const addons = (addonLinks ?? [])
    .map((l) => l.service_addons as unknown as {
      id: number
      name: string
      description: string | null
      price_cents: number
      duration_minutes: number
      is_active: boolean
    })
    .filter((a) => a?.is_active)

  const pairDeals = (pairRules ?? [])
    .map((r) => {
      const target = r.services as unknown as {
        id: number
        name: string
        slug: string
        description: string | null
        price_cents: number
        is_active: boolean
      } | null
      if (!target?.is_active) return null
      const off = pairDiscountCents(target.price_cents, r.percent_off)
      if (off === 0) return null
      return {
        id: r.id,
        name: target.name,
        slug: target.slug,
        description: target.description,
        percentOff: r.percent_off,
        fullCents: target.price_cents,
        priceCents: target.price_cents - off,
      }
    })
    .filter((d): d is NonNullable<typeof d> => d !== null)

  const dealNote = dealsOnThis?.[0]?.label ?? null

  return (
    <Section>
      <Container className="grid gap-16 lg:grid-cols-[1.4fr_1fr]">
        <div data-edit-key={`services:${service.id}`}>
          <Link href={`/services/${cat.slug}`} className="label-caps -my-2 inline-flex min-h-11 items-center py-2 text-[var(--color-muted)]">
            ← {cat.name}
          </Link>

          <div className="mt-8 flex flex-wrap items-center gap-3">
            {service.is_intimate && <Badge tone="accent">18+</Badge>}
            {service.requires_consultation && <Badge tone="neutral">Consultation first</Badge>}
            {service.patch_test_hours > 0 && (
              <Badge tone="warning">Patch test {service.patch_test_hours}h before</Badge>
            )}
          </div>

          {/* The same row the menu edits. Whichever page it is typed on,
              both show it — and the save revalidates both. */}
          <h1 data-edit-field="name" className="display mt-5 text-4xl sm:text-5xl">
            {service.name}
          </h1>

          {service.description && (
            <p
              data-edit-field="description"
              className="mt-6 text-lg leading-relaxed text-[var(--color-muted)]"
            >
              {service.description}
            </p>
          )}

          {service.details && (
            <div className="mt-10 border-t border-[var(--color-border)] pt-10">
              <h2 className="label-caps mb-5 text-[var(--color-accent)]">What to expect</h2>
              <p
                data-edit-field="details"
                className="whitespace-pre-line leading-relaxed text-[var(--color-muted)]"
              >
                {service.details}
              </p>
            </div>
          )}

          {service.aftercare && (
            <div className="mt-10 border-t border-[var(--color-border)] pt-10">
              <h2 className="label-caps mb-5 text-[var(--color-accent)]">Aftercare</h2>
              <p
                data-edit-field="aftercare"
                className="whitespace-pre-line leading-relaxed text-[var(--color-muted)]"
              >
                {service.aftercare}
              </p>
            </div>
          )}

          {(addons.length > 0 || pairDeals.length > 0) && (
            <div className="mt-10 border-t border-[var(--color-border)] pt-10">
              <h2 className="label-caps mb-6 text-[var(--color-accent)]">Add to this service</h2>
              <ul className="divide-y divide-[var(--color-border)]">
                {/* The pair deal leads: list price crossed out, the pair price
                    in green. The booking flow applies it automatically when
                    both are in the visit. */}
                {pairDeals.map((d) => (
                  <li key={`pair-${d.id}`}>
                    {/* The row IS the offer — clicking it opens the booking
                        with both services pre-ticked and the deal applied. */}
                    <Link
                      href={`/book?service=${service.slug}&add=${d.slug}`}
                      className="flex items-baseline justify-between gap-6 py-4 transition-colors hover:text-[var(--color-accent)]"
                    >
                      <div>
                        <p className="text-base">
                          {d.name}
                          <span className="ml-2 label-caps text-[0.5625rem] text-[var(--color-clay-deep)]">
                            {d.percentOff}% off together
                          </span>
                        </p>
                        <p className="mt-1 text-sm text-[var(--color-muted)]">
                          {d.description ?? `Booked in the same visit, it is ${d.percentOff}% off.`}
                        </p>
                      </div>
                      <span className="shrink-0 tabular-nums">
                        <s className="text-[var(--color-muted)]">{formatMoney(d.fullCents)}</s>{' '}
                        <span className="text-emerald-800 dark:text-emerald-400">
                          {formatMoney(d.priceCents)}
                        </span>
                      </span>
                    </Link>
                  </li>
                ))}
                {addons.map((a) => (
                  <li key={a.id} className="flex items-baseline justify-between gap-6 py-4">
                    <div>
                      <p className="text-base">{a.name}</p>
                      {a.description && (
                        <p className="mt-1 text-sm text-[var(--color-muted)]">{a.description}</p>
                      )}
                    </div>
                    <span className="shrink-0 tabular-nums">{formatMoney(a.price_cents)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Booking rail */}
        <aside className="lg:sticky lg:top-28 lg:self-start">
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
            <div className="flex items-baseline justify-between">
              {/* Never formatMoney() directly here — a consultation-priced
                  service has price_cents = 0 and would render "$0". */}
              {/* Parsed back to integer cents on save, and refused outright if
                  it does not read as a price. "from" is the price_is_starting
                  column, so typing it in or out sets that too. */}
              <span
                data-edit-key={`services:${service.id}`}
                data-edit-field="price_cents"
                data-edit-type="money"
                className="display text-4xl"
              >
                {formatServicePrice(service)}
              </span>
            </div>

            <dl className="mt-8 space-y-4 text-sm">
              <div className="flex gap-3">
                <Clock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} />
                <div>
                  <dt className="sr-only">Duration</dt>
                  <dd data-edit-key={`services:${service.id}`} data-edit-field="duration_minutes" data-edit-type="minutes">
                    {formatDuration(service.duration_minutes)}
                  </dd>
                </div>
              </div>

              {service.deposit_cents > 0 && (
                <div className="flex gap-3">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} />
                  <div>
                    <dt className="sr-only">Deposit</dt>
                    <dd>
                      {formatMoney(service.deposit_cents)} deposit to book
                      <span className="block text-[var(--color-muted)]">
                        Applied to your total.
                      </span>
                    </dd>
                  </div>
                </div>
              )}

              <div className="flex gap-3">
                <CalendarClock className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} />
                <div>
                  <dt className="sr-only">Cancellation</dt>
                  <dd className="text-[var(--color-muted)]">
                    {service.cancellation_window_hours}h notice to cancel or reschedule
                  </dd>
                </div>
              </div>

              {service.patch_test_hours > 0 && (
                <div className="flex gap-3">
                  <FlaskConical className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} />
                  <div>
                    <dt className="sr-only">Patch test</dt>
                    <dd className="text-[var(--color-muted)]">
                      Patch test required {service.patch_test_hours} hours beforehand
                    </dd>
                  </div>
                </div>
              )}
            </dl>

            {service.requires_consultation ? (
              <>
                <ButtonLink
                  href={`/contact?service=${service.slug}`}
                  className="mt-8 w-full"
                  size="lg"
                >
                  Request a consultation
                </ButtonLink>
                <p className="mt-4 text-xs leading-relaxed text-[var(--color-muted)]">
                  This treatment starts with a consultation so we can confirm it is right
                  for your skin before booking.
                </p>
              </>
            ) : (
              <ButtonLink
                href={`/book?service=${service.slug}`}
                className="mt-8 w-full"
                size="lg"
              >
                Book this service
              </ButtonLink>
            )}

            {/* This service is the cheaper half of a pair deal — say so where
                the price is. */}
            {dealNote && (
              <p className="mt-5 border-t border-[var(--color-border)] pt-5 text-xs leading-relaxed text-emerald-800 dark:text-emerald-400">
                {dealNote}.
              </p>
            )}

            {service.requires_age_verification && (
              <p className="mt-5 border-t border-[var(--color-border)] pt-5 text-xs leading-relaxed text-[var(--color-muted)]">
                You must be {service.min_age} or older. You will be asked to confirm your
                age and sign a consent form before your appointment.
              </p>
            )}
          </div>
        </aside>
      </Container>
    </Section>
  )
}
