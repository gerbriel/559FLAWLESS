import Link from 'next/link'
import Image from 'next/image'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Badge } from '@/components/ui/badge'
import { formatServicePrice, formatDuration } from '@/lib/utils'

export const revalidate = 300

interface Props {
  params: Promise<{ category: string }>
}

/**
 * Prerender every category at build time. Without this the route stays
 * dynamic and each visit re-queries Supabase for a menu that changes maybe
 * once a month. Returns [] if the database is unreachable at build, which
 * degrades to on-demand rendering rather than failing the build.
 */
export async function generateStaticParams() {
  try {
    const supabase = createPublicClient()
    const { data } = await supabase
      .from('service_categories')
      .select('slug')
      .eq('is_active', true)
    return (data ?? []).map((c) => ({ category: c.slug }))
  } catch {
    return []
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { category } = await params
  const supabase = createPublicClient()
  const { data } = await supabase
    .from('service_categories')
    .select('name, description')
    .eq('slug', category)
    .maybeSingle()

  if (!data) return { title: 'Services' }
  return { title: data.name, description: data.description ?? undefined }
}

export default async function CategoryPage({ params }: Props) {
  const { category } = await params
  const supabase = createPublicClient()

  const { data: cat } = await supabase
    .from('service_categories')
    .select(
      'id, name, slug, description, is_intimate, image_url, services(id, name, slug, description, price_cents, price_is_starting, duration_minutes, is_active, sort_order, is_intimate, requires_consultation, patch_test_hours)'
    )
    .eq('slug', category)
    .eq('is_active', true)
    .maybeSingle()

  if (!cat) notFound()

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
    patch_test_hours: number
  }[])
    .filter((s) => s.is_active)
    .sort((a, b) => a.sort_order - b.sort_order)

  return (
    <Section>
      <Container>
        <Link href="/services" className="label-caps text-[var(--color-muted)]">
          ← All services
        </Link>

        <div className="mt-8 flex flex-wrap items-baseline gap-4">
          <SectionHeading title={cat.name} lede={cat.description ?? undefined} />
        </div>

        {cat.image_url && (
          <div className="relative mt-10 aspect-[21/9] w-full overflow-hidden">
            <Image
              src={cat.image_url}
              alt=""
              fill
              priority
              sizes="100vw"
              className="object-cover"
            />
          </div>
        )}

        {cat.is_intimate && (
          <div className="mt-8 max-w-2xl border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-5 text-sm leading-relaxed dark:bg-[var(--color-surface)]">
            <p className="label-caps mb-2 text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]">
              18+ · Private treatment room
            </p>
            <p className="text-[var(--color-muted)]">
              These services are for clients 18 and older and are performed privately by
              a licensed esthetician. You will be told exactly what is involved before
              anything begins, you may request that another person be present, and you
              can stop at any point without giving a reason.
            </p>
          </div>
        )}

        <ul className="mt-14 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {services.map((s) => (
            <li key={s.id}>
              <Link
                href={`/services/${cat.slug}/${s.slug}`}
                className="group flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 py-7 transition-colors hover:text-[var(--color-accent)]"
              >
                <div className="min-w-0 flex-1">
                  <h3 className="flex flex-wrap items-center gap-3 text-lg">
                    {s.name}
                    {/* Redundant inside an intimate category, so only shown
                        when the service is the exception in its menu. */}
                    {s.is_intimate && !cat.is_intimate && <Badge tone="accent">18+</Badge>}
                    {s.requires_consultation && <Badge tone="neutral">Consultation first</Badge>}
                    {s.patch_test_hours > 0 && <Badge tone="warning">Patch test</Badge>}
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
      </Container>
    </Section>
  )
}
