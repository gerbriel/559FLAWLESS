import Link from 'next/link'
import type { Metadata } from 'next'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Badge } from '@/components/ui/badge'
import { formatServicePrice, formatDuration } from '@/lib/utils'

export const revalidate = 300

export const metadata: Metadata = {
  title: 'Service Menu',
  description:
    'Facials, waxing, nails, and corrective skin treatments at 559 Flawless in Fresno.',
}

export default async function ServicesPage() {
  const supabase = createPublicClient()

  const { data: categories } = await supabase
    .from('service_categories')
    .select(
      'id, name, slug, description, is_intimate, services(id, name, slug, description, price_cents, price_is_starting, duration_minutes, is_active, sort_order, is_intimate, requires_consultation)'
    )
    .eq('is_active', true)
    .order('sort_order')

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow="Service menu"
          title="Everything we offer."
          lede="Prices are a starting point — the final quote depends on what your skin needs on the day, and you will always be told before anything begins."
        />

        <div className="mt-20 space-y-24">
          {(categories ?? []).map((cat) => {
            const services = ((cat.services ?? []) as {
              id: number
              name: string
              slug: string
              description: string | null
              price_cents: number
              price_is_starting: boolean
              duration_minutes: number
              is_active: boolean
              sort_order: number
              is_intimate: boolean
              requires_consultation: boolean
            }[])
              .filter((s) => s.is_active)
              .sort((a, b) => a.sort_order - b.sort_order)

            if (services.length === 0) return null

            return (
              <div key={cat.slug} id={cat.slug} className="scroll-mt-28">
                <div className="flex flex-wrap items-baseline gap-4">
                  <h2 className="display text-3xl sm:text-4xl">{cat.name}</h2>
                  {cat.is_intimate && <Badge tone="accent">18+</Badge>}
                </div>
                {cat.description && (
                  <p className="mt-4 max-w-2xl text-[var(--color-muted)]">{cat.description}</p>
                )}

                <ul className="mt-10 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                  {services.map((s) => (
                    <li key={s.id}>
                      <Link
                        href={`/services/${cat.slug}/${s.slug}`}
                        className="group flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 py-5 transition-colors sm:py-6 hover:text-[var(--color-accent)]"
                      >
                        <div className="min-w-0 flex-1">
                          <h3 className="flex flex-wrap items-center gap-3 text-lg">
                            {s.name}
                            {/* Per-service, not just per-category: a Brazilian
                                sits inside the general Waxing menu but still
                                needs its own 18+ mark. */}
                            {s.is_intimate && !cat.is_intimate && (
                              <Badge tone="accent">18+</Badge>
                            )}
                            {s.requires_consultation && (
                              <Badge tone="neutral">Consultation first</Badge>
                            )}
                          </h3>
                          {s.description && (
                            <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-[var(--color-muted)]">
                              {s.description}
                            </p>
                          )}
                        </div>
                        <div className="flex shrink-0 items-baseline gap-6 tabular-nums">
                          <span className="text-sm text-[var(--color-muted)]">
                            {formatDuration(s.duration_minutes)}
                          </span>
                          <span className="text-lg">
                            {formatServicePrice(s)}
                          </span>
                        </div>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            )
          })}
        </div>
      </Container>
    </Section>
  )
}
