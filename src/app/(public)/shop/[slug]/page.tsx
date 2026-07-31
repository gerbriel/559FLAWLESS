import Link from 'next/link'
import { notFound } from 'next/navigation'
import type { Metadata } from 'next'
import { ArrowUpRight } from 'lucide-react'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section } from '@/components/ui/section'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import { AddToCart } from '@/components/shared/AddToCart'
import { formatMoney } from '@/lib/utils'

export const revalidate = 120

interface Props {
  params: Promise<{ slug: string }>
}

/** Prerender every retail product page. See the note in the category route. */
export async function generateStaticParams() {
  try {
    const supabase = createPublicClient()
    const { data } = await supabase
      .from('products')
      .select('slug')
      .eq('is_active', true)
      .eq('is_retail', true)
      .is('archived_at', null)
    return (data ?? []).map((p) => ({ slug: p.slug }))
  } catch {
    return []
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params
  const supabase = createPublicClient()
  const { data } = await supabase
    .from('products')
    .select('name, description')
    .eq('slug', slug)
    .maybeSingle()

  if (!data) return { title: 'Product' }
  return { title: data.name, description: data.description ?? undefined }
}

export default async function ProductPage({ params }: Props) {
  const { slug } = await params
  const supabase = createPublicClient()

  const { data: product } = await supabase
    .from('products')
    .select('id, name, slug, description, ingredients, how_to_use, image_url, price_cents, stock_qty, external_url, brands(name), product_categories(name, slug)')
    .eq('slug', slug)
    .eq('is_active', true)
    .eq('is_retail', true)
    .is('archived_at', null)
    .maybeSingle()

  if (!product) notFound()

  const brand = product.brands as { name: string } | null
  const category = product.product_categories as { name: string; slug: string } | null
  const external = !!product.external_url
  const inStock = Number(product.stock_qty) > 0

  return (
    <Section>
      <Container className="grid gap-16 lg:grid-cols-2">
        <div>
          <div className="aspect-square w-full bg-[var(--color-linen)] dark:bg-[var(--color-surface)]" />
        </div>

        <div>
          <Link href="/shop" className="label-caps text-[var(--color-muted)]">
            ← Shop
          </Link>

          {brand && (
            <p className="label-caps mt-8 text-[var(--color-accent)]">{brand.name}</p>
          )}
          <h1 className="display mt-3 text-4xl">{product.name}</h1>

          {/* Price and stock are only ours to state for what we hold in the
              salon. An externally fulfilled product is priced and shipped by
              the marketplace, so we send the client there rather than quote a
              figure we cannot honour. */}
          {external ? (
            <div className="mt-4">
              <Badge tone="accent">Ships direct from {brand?.name ?? 'the brand'}</Badge>
            </div>
          ) : (
            <>
              <p className="mt-6 text-2xl tabular-nums">{formatMoney(product.price_cents)}</p>
              {!inStock && (
                <div className="mt-4">
                  <Badge tone="neutral">Out of stock</Badge>
                </div>
              )}
            </>
          )}

          {product.description && (
            <p className="mt-8 leading-relaxed text-[var(--color-muted)]">
              {product.description}
            </p>
          )}

          <div className="mt-8">
            {external ? (
              <ButtonLink
                href={product.external_url!}
                target="_blank"
                rel="noreferrer noopener"
                size="lg"
              >
                Add to cart
                <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
              </ButtonLink>
            ) : (
              <AddToCart productId={product.id} disabled={!inStock} />
            )}
          </div>

          {product.how_to_use && (
            <div className="mt-12 border-t border-[var(--color-border)] pt-8">
              <h2 className="label-caps mb-4 text-[var(--color-accent)]">How to use</h2>
              <p className="whitespace-pre-line leading-relaxed text-[var(--color-muted)]">
                {product.how_to_use}
              </p>
            </div>
          )}

          {product.ingredients && (
            <div className="mt-10 border-t border-[var(--color-border)] pt-8">
              <h2 className="label-caps mb-4 text-[var(--color-accent)]">Ingredients</h2>
              <p className="text-sm leading-relaxed text-[var(--color-muted)]">
                {product.ingredients}
              </p>
            </div>
          )}

          {category && (
            <p className="mt-10 text-sm text-[var(--color-muted)]">
              More in{' '}
              <Link
                href={`/shop?category=${category.slug}`}
                className="underline underline-offset-4"
              >
                {category.name}
              </Link>
            </p>
          )}
        </div>
      </Container>
    </Section>
  )
}
