import Link from 'next/link'
import Image from 'next/image'
import { ArrowRight, Star } from 'lucide-react'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { ButtonLink } from '@/components/ui/button'
import { formatServicePrice, formatDuration } from '@/lib/utils'
import { ConsideredService } from '@/components/shared/ConsideredService'
import { pageCopy } from '@/lib/page-copy'

export const revalidate = 300

interface HeroCopy {
  eyebrow?: string
  heading?: string
  sub?: string
  cta?: string
}

export default async function HomePage() {
  const supabase = createPublicClient()

  const [{ data: heroRow }, { data: aboutRow }, { data: categories }, { data: featured }, { data: reviews }] =
    await Promise.all([
      supabase.from('site_content').select('value').eq('key', 'hero').maybeSingle(),
      supabase.from('site_content').select('value').eq('key', 'about').maybeSingle(),
      supabase
        .from('service_categories')
        .select('id, name, slug, description, image_url')
        .eq('is_active', true)
        .order('sort_order'),
      supabase
        .from('services')
        .select('id, name, slug, description, price_cents, duration_minutes, price_is_starting, service_categories(slug)')
        .eq('is_active', true)
        .order('sort_order')
        .limit(6),
      supabase
        .from('testimonials')
        .select('id, client_name, service_name, rating, body')
        .eq('is_approved', true)
        .order('sort_order')
        .limit(3),
    ])

  // Section copy that used to be literals in this file. Until somebody edits
  // a line there is no row for it and the `??` fallback below renders, so the
  // page reads exactly as it always did.
  const copy = await pageCopy('page_home')
  const hero = (heroRow?.value ?? {}) as HeroCopy
  const about = (aboutRow?.value ?? {}) as {
    eyebrow?: string
    heading?: string
    body?: string
  }

  return (
    <>
      {/* ── Hero ─────────────────────────────────────────── */}
      <section className="relative overflow-hidden border-b border-[var(--color-border)]">
        <Container className="grid items-center gap-10 py-12 sm:gap-14 sm:py-20 lg:grid-cols-[1.1fr_1fr] lg:py-32">
          {/* data-edit-* is AdminEditKit's contract: the key names the
              site_content row, each field a property in its jsonb. Attributes
              only — no client boundary, and meaningless outside edit mode. */}
          <div data-edit-key="hero">
            {hero.eyebrow && (
              <p data-edit-field="eyebrow" className="label-caps mb-6 text-[var(--color-accent)]">
                {hero.eyebrow}
              </p>
            )}
            <h1
              data-edit-field="heading"
              className="display text-[2.75rem] leading-[1.02] sm:text-6xl lg:text-7xl"
            >
              {hero.heading ?? 'Skin that looks like itself, only better.'}
            </h1>
            <p
              data-edit-field="sub"
              className="mt-7 max-w-xl text-lg leading-relaxed text-[var(--color-muted)]"
            >
              {hero.sub}
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:mt-10 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
              <ButtonLink href="/book" size="lg" data-edit-field="cta" className="w-full sm:w-auto">
                {hero.cta ?? 'Book an appointment'}
              </ButtonLink>
              <ButtonLink href="/services" variant="outline" size="lg" className="w-full sm:w-auto">
                View the menu
              </ButtonLink>
            </div>
          </div>

          {/* Stock stand-in — see public/images/ATTRIBUTION.md. Swap for studio
              photography by replacing the file or pointing at the `site` bucket. */}
          <div
            data-edit-key="page_home"
            data-edit-image="hero_image"
            className="relative aspect-[4/5] w-full overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-surface)]"
          >
            <Image
              src={copy.hero_image ?? '/images/hero.jpg'}
              unoptimized={Boolean(copy.hero_image)}
              alt="A fan brush applying a treatment enzyme during a facial"
              fill
              priority
              sizes="(max-width: 1024px) 100vw, 45vw"
              className="object-cover"
            />
            <div className="pointer-events-none absolute -bottom-px -left-px h-24 w-24 border-b border-l border-[var(--color-accent)]" />
            <div className="pointer-events-none absolute -right-px -top-px h-24 w-24 border-r border-t border-[var(--color-accent)]" />
          </div>
        </Container>
      </section>

      {/* A service they carried into the booking flow and left there. Client
          component over a static page: nothing in the server HTML, and the
          reader in src/lib/interest.ts is what decides whether there is
          anything to say — including refusing intimate services here. */}
      <ConsideredService />

      {/* ── Categories ───────────────────────────────────── */}
      <Section>
        <Container>
          <SectionHeading
            eyebrow={copy.categories_eyebrow ?? 'What we do'}
            title={copy.categories_title ?? 'Treatments, not packages.'}
            lede={
              copy.categories_lede ??
              'Every service starts with a look at your skin that day. You will not be sold something you did not come in for.'
            }
            editKey="page_home"
            editFields={{
              eyebrow: 'categories_eyebrow',
              title: 'categories_title',
              lede: 'categories_lede',
            }}
          />

          <div className="mt-16 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-3">
            {(categories ?? []).map((cat) => (
              <Link
                key={cat.slug}
                href={`/services/${cat.slug}`}
                data-edit-key={`service_categories:${cat.id}`}
                className="group flex flex-col bg-[var(--color-background)] transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]"
              >
                {cat.image_url && (
                  <div data-edit-image="image_url" className="relative aspect-[3/2] w-full overflow-hidden">
                    <Image
                      src={cat.image_url}
                      alt=""
                      fill
                      sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                      className="object-cover transition-transform duration-500 group-hover:scale-[1.03]"
                    />
                  </div>
                )}
                <div className="flex flex-1 flex-col justify-between p-8">
                  <div>
                    <h3 data-edit-field="name" className="display text-2xl">
                      {cat.name}
                    </h3>
                    <p
                      data-edit-field="description"
                      className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]"
                    >
                      {cat.description}
                    </p>
                  </div>
                  <span className="label-caps mt-8 inline-flex items-center gap-2 text-[var(--color-accent)]">
                    Explore
                    <ArrowRight
                      className="h-3.5 w-3.5 transition-transform group-hover:translate-x-1"
                      strokeWidth={2}
                    />
                  </span>
                </div>
              </Link>
            ))}
          </div>
        </Container>
      </Section>

      {/* ── Featured services ────────────────────────────── */}
      <Section className="border-y border-[var(--color-border)] bg-[var(--color-linen)] dark:bg-[var(--color-surface)]">
        <Container>
          <div className="flex flex-wrap items-end justify-between gap-6">
            <SectionHeading
              eyebrow={copy.featured_eyebrow ?? 'Popular'}
              title={copy.featured_title ?? 'Where most people start'}
              editKey="page_home"
              editFields={{ eyebrow: 'featured_eyebrow', title: 'featured_title' }}
            />
            <Link
              href="/services"
              className="label-caps -my-2 inline-flex min-h-11 items-center border-b border-[var(--color-foreground)] py-2"
            >
              Full menu
            </Link>
          </div>

          <ul className="mt-14 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
            {(featured ?? []).map((s) => {
              const catSlug = (s.service_categories as { slug: string } | null)?.slug
              return (
                <li key={s.slug} data-edit-key={`services:${s.id}`}>
                  <Link
                    href={catSlug ? `/services/${catSlug}/${s.slug}` : '/services'}
                    className="group flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 py-6 transition-colors hover:text-[var(--color-accent)]"
                  >
                    <div className="min-w-0 flex-1">
                      <h3 data-edit-field="name" className="display text-xl sm:text-2xl">
                        {s.name}
                      </h3>
                      <p
                        data-edit-field="description"
                        className="mt-1.5 max-w-2xl text-sm text-[var(--color-muted)]"
                      >
                        {s.description}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-baseline gap-6 tabular-nums">
                      <span
                        data-edit-field="duration_minutes"
                        data-edit-type="minutes"
                        className="text-sm text-[var(--color-muted)]"
                      >
                        {formatDuration(s.duration_minutes)}
                      </span>
                      <span data-edit-field="price_cents" data-edit-type="money" className="text-lg">
                        {formatServicePrice(s)}
                      </span>
                    </div>
                  </Link>
                </li>
              )
            })}
          </ul>
        </Container>
      </Section>

      {/* ── About ────────────────────────────────────────── */}
      <Section>
        <Container className="grid gap-14 lg:grid-cols-2 lg:items-center">
          <div
            data-edit-key="page_home"
            data-edit-image="about_image"
            className="relative aspect-square w-full overflow-hidden bg-[var(--color-clay-soft)] dark:bg-[var(--color-surface)]"
          >
            <Image
              src={copy.about_image ?? '/images/about.jpg'}
              unoptimized={Boolean(copy.about_image)}
              alt="A facial treatment in progress at the studio"
              fill
              sizes="(max-width: 1024px) 100vw, 45vw"
              className="object-cover"
            />
            <div className="pointer-events-none absolute inset-8 border border-white/40" />
          </div>
          <div>
            <SectionHeading
              eyebrow={about.eyebrow ?? 'The studio'}
              title={about.heading ?? 'About the studio'}
              lede={about.body}
              editKey="about"
              editFields={{ eyebrow: 'eyebrow', title: 'heading', lede: 'body' }}
            />
            <ButtonLink href="/about" variant="outline" className="mt-10">
              More about us
            </ButtonLink>
          </div>
        </Container>
      </Section>

      {/* ── Testimonials ─────────────────────────────────── */}
      {(reviews?.length ?? 0) > 0 && (
        <Section className="border-t border-[var(--color-border)]">
          <Container>
            <SectionHeading
              eyebrow={copy.reviews_eyebrow ?? 'Reviews'}
              title={copy.reviews_title ?? 'In their words'}
              align="center"
              editKey="page_home"
              editFields={{ eyebrow: 'reviews_eyebrow', title: 'reviews_title' }}
            />
            <div className="mt-16 grid gap-10 md:grid-cols-3">
              {(reviews ?? []).map((r) => (
                <figure key={r.id} className="text-center">
                  {r.rating && (
                    <div className="mb-5 flex justify-center gap-1" aria-label={`${r.rating} out of 5`}>
                      {Array.from({ length: r.rating }).map((_, i) => (
                        <Star
                          key={i}
                          className="h-3.5 w-3.5 fill-[var(--color-accent)] text-[var(--color-accent)]"
                        />
                      ))}
                    </div>
                  )}
                  <blockquote className="display text-xl leading-snug">
                    &ldquo;{r.body}&rdquo;
                  </blockquote>
                  <figcaption className="label-caps mt-6 text-[var(--color-muted)]">
                    {r.client_name}
                    {r.service_name && ` · ${r.service_name}`}
                  </figcaption>
                </figure>
              ))}
            </div>
          </Container>
        </Section>
      )}

      {/* ── CTA ──────────────────────────────────────────── */}
      <section className="border-t border-[var(--color-border)] bg-[var(--color-espresso)] text-[var(--color-porcelain)]">
        <Container className="py-24 text-center">
          <h2 className="display mx-auto max-w-2xl text-4xl sm:text-5xl">
            Ready when you are.
          </h2>
          <p className="mx-auto mt-5 max-w-lg text-[var(--color-shell)]">
            Appointments only — it is a single-room studio, so booking ahead is the
            only way to hold a slot.
          </p>
          <ButtonLink href="/book" variant="accent" size="lg" className="mt-10">
            Book an appointment
          </ButtonLink>
        </Container>
      </section>
    </>
  )
}
