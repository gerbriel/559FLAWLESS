import Link from 'next/link'
import type { Metadata } from 'next'
import { ArrowUpRight } from 'lucide-react'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { SearchField } from '@/components/ui/dashboard'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'

export const metadata: Metadata = {
  title: 'Search',
  description: 'Search treatments, products and answers at 559 Flawless.',
  // A results page is not a page: it has no content of its own, and every
  // query would otherwise be a URL asking to be indexed.
  robots: { index: false, follow: true },
}

interface Props {
  searchParams: Promise<{ q?: string }>
}

/**
 * One result, whatever it came from.
 *
 * `score` decides the order inside a group and nothing else — it is not shown.
 * A hit on the name beats a hit on the body, because someone typing "brazilian"
 * wants the service called that, not the three others that mention it.
 */
interface Hit {
  href: string
  title: string
  blurb: string | null
  meta: string | null
  badge: string | null
  external: boolean
  score: number
}

/** Every string in a JSON value, flattened. The site's editable copy is stored
 *  as jsonb of varying shape, and this is what makes it searchable without
 *  hard-coding which keys hold prose this week. */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(textOf).join(' ')
  if (value && typeof value === 'object') return Object.values(value).map(textOf).join(' ')
  return ''
}

/**
 * Every token has to appear somewhere. "green tea" then means both words, which
 * is what people expect and what a plain substring match gets wrong the moment
 * anyone types two of them.
 */
function scoreOf(tokens: string[], title: string, body: string): number {
  // No query matches nothing. `[].every()` is true and `''.startsWith('')` is
  // true, so without this the empty search scores every row on the site and the
  // landing page becomes a dump of the entire catalogue.
  if (tokens.length === 0) return 0

  const t = title.toLowerCase()
  const haystack = `${t} ${body.toLowerCase()}`
  if (!tokens.every((tok) => haystack.includes(tok))) return 0

  const phrase = tokens.join(' ')
  if (t === phrase) return 4
  if (t.startsWith(phrase)) return 3
  if (tokens.every((tok) => t.includes(tok))) return 2
  return 1
}

/** The site's own pages. Hand-written because they are hand-written pages —
 *  there is no table to read them from, and the keywords are the words people
 *  actually type for things the page never says outright ("parking", "cancel"). */
const PAGES: { title: string; href: string; blurb: string; keywords: string; contentKey?: string }[] =
  [
    {
      title: 'Book an appointment',
      href: '/book',
      blurb: 'Pick a treatment, a day and a time.',
      keywords: 'book booking appointment schedule reschedule availability deposit',
    },
    {
      title: 'Service menu',
      href: '/services',
      blurb: 'Every treatment, what it costs and how long it takes.',
      keywords: 'services treatments menu prices facial wax waxing peel nails',
    },
    {
      title: 'Shop',
      href: '/shop',
      blurb: 'The products used on you, available to take home.',
      keywords: 'shop products retail skincare home care buy',
      contentKey: 'shop',
    },
    {
      title: 'About',
      href: '/about',
      blurb: 'Who you are seeing, and how the studio works.',
      keywords: 'about studio cosmetologist esthetician licensed fresno story',
      contentKey: 'about',
    },
    {
      title: 'The team',
      href: '/team',
      blurb: 'Who works here and what they treat.',
      keywords: 'team staff provider cosmetologist esthetician who',
    },
    {
      title: 'Questions',
      href: '/faq',
      blurb: 'Common questions, answered plainly.',
      keywords: 'faq questions help what should i expect first time',
    },
    {
      title: 'Contact',
      href: '/contact',
      blurb: 'Where the studio is and how to reach it.',
      keywords: 'contact address directions parking phone email hours where located',
      contentKey: 'contact',
    },
    {
      title: 'Gift cards',
      href: '/gift-cards',
      blurb: 'A gift card for any amount.',
      keywords: 'gift card voucher present certificate',
    },
    {
      title: 'Policies',
      href: '/policies',
      blurb: 'Cancellations, lateness, deposits and refunds.',
      keywords: 'policy policies cancel cancellation late no show refund deposit rules',
      contentKey: 'policies',
    },
    {
      title: 'Privacy',
      href: '/privacy',
      blurb: 'What is collected and why.',
      keywords: 'privacy data gdpr personal information cookies',
    },
    {
      title: 'Terms',
      href: '/terms',
      blurb: 'The terms of using this site.',
      keywords: 'terms conditions legal',
    },
  ]

export default async function SearchPage({ searchParams }: Props) {
  const { q } = await searchParams
  const query = (q ?? '').trim()
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  const supabase = createPublicClient()

  const [{ data: categories }, { data: products }, { data: faqs }, { data: content }] =
    await Promise.all([
      supabase
        .from('service_categories')
        .select(
          'id, name, slug, is_intimate, services(id, name, slug, description, details, price_cents, price_is_starting, duration_minutes, is_active, is_intimate, requires_consultation)'
        )
        .eq('is_active', true)
        .order('sort_order'),
      // Explicit columns: `cost_cents` is on the row and must never reach a
      // public visitor.
      supabase
        .from('products')
        .select(
          'id, name, slug, description, price_cents, stock_qty, external_url, category_id, brands(name), product_categories(name)'
        )
        .eq('is_active', true)
        .eq('is_retail', true)
        .is('archived_at', null)
        .order('sort_order'),
      supabase
        .from('faqs')
        .select('id, question, answer, category')
        .eq('is_active', true)
        .order('sort_order'),
      supabase.from('site_content').select('key, value'),
    ])

  const nameOf = (embed: unknown) => (embed as { name: string } | null)?.name ?? null
  const rank = (a: Hit, b: Hit) => b.score - a.score || a.title.localeCompare(b.title)

  // ── Services ────────────────────────────────────────────────
  type ServiceRow = {
    id: number
    name: string
    slug: string
    description: string | null
    details: string | null
    price_cents: number
    price_is_starting: boolean
    duration_minutes: number
    is_active: boolean
    is_intimate: boolean
    requires_consultation: boolean
  }
  const serviceHits: Hit[] = []
  for (const cat of categories ?? []) {
    for (const s of ((cat.services ?? []) as ServiceRow[]).filter((s) => s.is_active)) {
      const score = scoreOf(
        tokens,
        s.name,
        `${s.description ?? ''} ${s.details ?? ''} ${cat.name}`
      )
      if (!score) continue
      serviceHits.push({
        href: `/services/${cat.slug}/${s.slug}`,
        title: s.name,
        blurb: s.description,
        meta: [
          s.requires_consultation
            ? 'Consultation first'
            : `${s.price_is_starting ? 'From ' : ''}${formatMoney(s.price_cents)}`,
          `${s.duration_minutes} min`,
          cat.name,
        ].join(' · '),
        // The 18+ gate is a fact about the service, and the menu already shows
        // it. Dropping it here would make search the one place it is not said.
        badge: s.is_intimate || cat.is_intimate ? '18+' : null,
        external: false,
        score,
      })
    }
  }
  serviceHits.sort(rank)

  // ── Products ────────────────────────────────────────────────
  const productHits: Hit[] = (products ?? [])
    .map((p): Hit | null => {
      const brand = nameOf(p.brands)
      const category = nameOf(p.product_categories)
      const score = scoreOf(
        tokens,
        p.name,
        `${p.description ?? ''} ${brand ?? ''} ${category ?? ''}`
      )
      if (!score) return null
      const inStock = Number(p.stock_qty) > 0 && p.price_cents > 0
      return {
        href: `/shop/${p.slug}`,
        title: p.name,
        blurb: p.description,
        meta: [p.price_cents > 0 ? formatMoney(p.price_cents) : null, brand, category]
          .filter(Boolean)
          .join(' · '),
        badge: inStock ? null : p.external_url ? 'Ships from the brand' : 'Out of stock',
        external: false,
        score,
      }
    })
    .filter((h): h is Hit => h !== null)
    .sort(rank)

  // ── Questions ───────────────────────────────────────────────
  const faqHits: Hit[] = (faqs ?? [])
    .map((f): Hit | null => {
      const score = scoreOf(tokens, f.question, `${f.answer} ${f.category ?? ''}`)
      if (!score) return null
      return {
        href: `/faq#faq-${f.id}`,
        title: f.question,
        blurb: f.answer,
        meta: f.category,
        badge: null,
        external: false,
        score,
      }
    })
    .filter((h): h is Hit => h !== null)
    .sort(rank)

  // ── Pages ───────────────────────────────────────────────────
  const contentFor = (key?: string) =>
    key ? textOf((content ?? []).find((r) => r.key === key)?.value) : ''
  const pageHits: Hit[] = PAGES.map((page): Hit | null => {
    const score = scoreOf(
      tokens,
      page.title,
      `${page.blurb} ${page.keywords} ${contentFor(page.contentKey)}`
    )
    if (!score) return null
    return {
      href: page.href,
      title: page.title,
      blurb: page.blurb,
      meta: null,
      badge: null,
      external: false,
      score,
    }
  })
    .filter((h): h is Hit => h !== null)
    .sort(rank)

  const groups: { label: string; hits: Hit[] }[] = [
    { label: 'Treatments', hits: serviceHits },
    { label: 'Products', hits: productHits },
    { label: 'Questions', hits: faqHits },
    { label: 'Pages', hits: pageHits },
  ].filter((g) => g.hits.length > 0)

  const total = groups.reduce((n, g) => n + g.hits.length, 0)

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow="Search"
          title={query ? `Results for “${query}”` : 'Search the site.'}
          lede={
            query
              ? undefined
              : 'Treatments, products, answers — all of it, in one box.'
          }
        />

        <form method="get" action="/search" className="mt-12 max-w-xl">
          <SearchField
            label="Search treatments, products and answers"
            name="q"
            defaultValue={query}
            autoFocus={!query}
          />
        </form>

        {query && (
          <p className="mt-6 text-sm text-[var(--color-muted)]">
            {total === 0
              ? 'Nothing found.'
              : `${total} ${total === 1 ? 'result' : 'results'} across ${groups.length} ${
                  groups.length === 1 ? 'section' : 'sections'
                }.`}
          </p>
        )}

        {query && total === 0 && (
          <div className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-12 text-center">
            <p className="display text-2xl">Nothing matches “{query}”.</p>
            <p className="mx-auto mt-3 max-w-md text-sm text-[var(--color-muted)]">
              Try a treatment name, a concern like acne or pigmentation, or a product. If
              you would rather just ask, a message gets a real answer.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-x-7 gap-y-3">
              <Link href="/services" className="label-caps border-b border-[var(--color-foreground)] pb-1">
                Service menu
              </Link>
              <Link href="/shop" className="label-caps border-b border-[var(--color-foreground)] pb-1">
                Shop
              </Link>
              <Link href="/contact" className="label-caps border-b border-[var(--color-foreground)] pb-1">
                Ask us
              </Link>
            </div>
          </div>
        )}

        {groups.map((group) => (
          <div key={group.label} className="mt-16">
            <h2 className="label-caps text-[var(--color-accent)]">
              {group.label} <span className="text-[var(--color-muted)]">({group.hits.length})</span>
            </h2>

            <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {group.hits.map((hit) => (
                <li key={hit.href}>
                  <Link
                    href={hit.href}
                    className="group flex flex-col gap-1.5 py-6 transition-colors hover:bg-[var(--color-surface)]"
                  >
                    <span className="flex flex-wrap items-center gap-3">
                      <span className="text-base group-hover:text-[var(--color-accent)]">
                        {hit.title}
                      </span>
                      {hit.badge && (
                        <Badge tone={hit.badge === '18+' ? 'accent' : 'neutral'} size="sm">
                          {hit.badge}
                        </Badge>
                      )}
                      {hit.external && (
                        <ArrowUpRight
                          className="h-3.5 w-3.5 text-[var(--color-muted)]"
                          strokeWidth={1.5}
                          aria-hidden
                        />
                      )}
                    </span>
                    {hit.blurb && (
                      <span className="line-clamp-2 max-w-3xl text-sm leading-relaxed text-[var(--color-muted)]">
                        {hit.blurb}
                      </span>
                    )}
                    {hit.meta && (
                      <span className="label-caps text-[0.625rem] text-[var(--color-muted)]">
                        {hit.meta}
                      </span>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Container>
    </Section>
  )
}
