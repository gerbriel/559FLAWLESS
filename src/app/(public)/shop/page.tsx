import Link from 'next/link'
import Image from 'next/image'
import type { Metadata } from 'next'
import { ArrowUpRight } from 'lucide-react'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'

export const revalidate = 120

export const metadata: Metadata = {
  title: 'Shop',
  description:
    'Professional Rhonda Allison skincare, chosen by your esthetician. Shipped direct from the authorized 559 Flawless store.',
}

interface ShopCopy {
  external_store_url?: string
  external_store_name?: string
  heading?: string
  body?: string
  cta?: string
}

interface Props {
  searchParams: Promise<{ category?: string }>
}

export default async function ShopPage({ searchParams }: Props) {
  const { category } = await searchParams
  const supabase = createPublicClient()

  const [{ data: shopRow }, { data: categories }, { data: products }] = await Promise.all([
    supabase.from('site_content').select('value').eq('key', 'shop').maybeSingle(),
    supabase
      .from('product_categories')
      .select('id, name, slug')
      .eq('is_active', true)
      .order('sort_order'),
    // Explicit columns: `cost_cents` is on the row but must never reach a
    // public visitor.
    supabase
      .from('products')
      .select(
        'id, name, slug, description, image_url, price_cents, stock_qty, external_url, is_featured, category_id, brands(name)'
      )
      .eq('is_active', true)
      .eq('is_retail', true)
      .is('archived_at', null)
      .order('sort_order'),
  ])

  const shop = (shopRow?.value ?? {}) as ShopCopy
  const storeUrl = shop.external_store_url

  const activeCategory = (categories ?? []).find((c) => c.slug === category)
  const visible = activeCategory
    ? (products ?? []).filter((p) => p.category_id === activeCategory.id)
    : (products ?? [])

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow="Shop"
          title={shop.heading ?? 'The products I actually use on you.'}
          lede={shop.body}
        />

        {/* ── The external storefront ─────────────────── */}
        {storeUrl && (
          <a
            href={storeUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="group mt-12 grid overflow-hidden border border-[var(--color-accent)] md:grid-cols-[1fr_1.1fr]"
          >
            <div className="flex flex-wrap items-center justify-between gap-6 bg-[var(--color-clay-soft)] p-8 transition-colors group-hover:bg-[var(--color-accent)] group-hover:text-white dark:bg-[var(--color-surface)]">
              <div>
                <p className="label-caps mb-2 text-[var(--color-clay-deep)] transition-colors group-hover:text-white dark:text-[var(--color-accent)]">
                  {shop.external_store_name ?? 'Rhonda Allison'} · Ships direct to you
                </p>
                <p className="display text-2xl">
                  {shop.cta ?? 'Shop the full Rhonda Allison store'}
                </p>
              </div>
              <ArrowUpRight
                className="h-8 w-8 shrink-0 transition-transform group-hover:translate-x-1 group-hover:-translate-y-1"
                strokeWidth={1.25}
              />
            </div>
            <div className="relative order-first aspect-[16/9] w-full md:order-last md:aspect-auto">
              <Image
                src="/images/shop.jpg"
                alt=""
                fill
                sizes="(max-width: 768px) 100vw, 55vw"
                className="object-cover"
              />
            </div>
          </a>
        )}

        {(categories?.length ?? 0) > 0 && (
          <nav className="mt-14 flex flex-wrap gap-x-7 gap-y-3" aria-label="Product categories">
            <Link
              href="/shop"
              className={`label-caps -my-2 inline-flex min-h-11 items-center py-2 ${
                !activeCategory
                  ? 'border-b border-[var(--color-foreground)]'
                  : 'text-[var(--color-muted)]'
              }`}
            >
              All
            </Link>
            {(categories ?? []).map((c) => (
              <Link
                key={c.slug}
                href={`/shop?category=${c.slug}`}
                className={`label-caps -my-2 inline-flex min-h-11 items-center py-2 ${
                  activeCategory?.slug === c.slug
                    ? 'border-b border-[var(--color-foreground)]'
                    : 'text-[var(--color-muted)]'
                }`}
              >
                {c.name}
              </Link>
            ))}
          </nav>
        )}

        {visible.length === 0 ? (
          <div className="mt-12 border border-[var(--color-border)] bg-[var(--color-surface)] p-12 text-center">
            <p className="display text-2xl">
              {activeCategory ? `Nothing listed under ${activeCategory.name} yet.` : 'Picks coming soon.'}
            </p>
            <p className="mx-auto mt-3 max-w-md text-sm text-[var(--color-muted)]">
              {storeUrl
                ? 'The full range is on the Rhonda Allison store above. Ask at your next appointment and I will point you at the right things for your skin.'
                : 'Ask about home care at your next appointment.'}
            </p>
          </div>
        ) : (
          <div className="mt-12 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((p) => {
              const brand = p.brands as { name: string } | null
              // Stock decides where a product is bought, not whether it has a
              // marketplace link. The studio keeps these on the shelf and sells
              // them in the room; the link is what happens when she runs out.
              const inStock = Number(p.stock_qty) > 0 && p.price_cents > 0
              const canShip = !!p.external_url
              const external = !inStock && canShip
              const outOfStock = !inStock && !canShip

              const body = (
                <>
                  <div className="relative mb-6 aspect-square w-full overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-surface)]">
                    {p.image_url && (
                      <Image
                        src={p.image_url}
                        alt={p.name}
                        fill
                        sizes="(max-width: 640px) 50vw, (max-width: 1024px) 33vw, 25vw"
                        // Product shots are transparent PNGs of a bottle, so
                        // `contain` with padding rather than a cropping `cover`.
                        className="object-contain p-6 transition-transform duration-500 group-hover:scale-105"
                      />
                    )}
                    {outOfStock && (
                      <span className="absolute left-3 top-3">
                        <Badge tone="neutral">Out of stock</Badge>
                      </span>
                    )}
                    {external && (
                      <span className="absolute left-3 top-3">
                        <Badge tone="accent">Ships direct</Badge>
                      </span>
                    )}
                    {inStock && canShip && (
                      <span className="absolute left-3 top-3">
                        <Badge tone="success">In studio</Badge>
                      </span>
                    )}
                  </div>
                  {brand && (
                    <p className="label-caps mb-2 text-[var(--color-muted)]">{brand.name}</p>
                  )}
                  <h3 className="flex items-start gap-1.5 text-base">
                    {p.name}
                    {external && (
                      <ArrowUpRight
                        className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--color-muted)]"
                        strokeWidth={2}
                      />
                    )}
                  </h3>
                  {p.description && (
                    <p className="mt-1.5 line-clamp-2 text-sm text-[var(--color-muted)]">
                      {p.description}
                    </p>
                  )}
                  {/* Only the studio's own price is quoted. When it is out and
                      the client is sent to the marketplace, that price is
                      theirs and may differ, so we do not put a figure on it. */}
                  {inStock ? (
                    <p className="mt-4 tabular-nums">{formatMoney(p.price_cents)}</p>
                  ) : external ? (
                    <p className="label-caps mt-4 text-[var(--color-muted)]">
                      Order direct
                    </p>
                  ) : null}
                </>
              )

              const className =
                'group flex flex-col bg-[var(--color-background)] p-6 transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]'

              return external ? (
                <a
                  key={p.id}
                  href={p.external_url!}
                  target="_blank"
                  rel="noreferrer noopener"
                  className={className}
                >
                  {body}
                </a>
              ) : (
                <Link key={p.id} href={`/shop/${p.slug}`} className={className}>
                  {body}
                </Link>
              )
            })}
          </div>
        )}
      </Container>
    </Section>
  )
}
