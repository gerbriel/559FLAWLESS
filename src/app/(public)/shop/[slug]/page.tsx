import Link from 'next/link'
import Image from 'next/image'
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
  // Stock decides where this is bought. The studio keeps these on the shelf and
  // sells them in the room; the marketplace link is the fallback when she is
  // out, not a statement that she never holds any.
  const inStock = Number(product.stock_qty) > 0 && product.price_cents > 0
  const canShip = !!product.external_url
  const external = !inStock && canShip

  return (
    <Section>
      <Container className="grid gap-16 lg:grid-cols-2">
        <div data-edit-key={`products:${product.id}`}>
          <div
            data-edit-image="image_url"
            className="relative aspect-square w-full overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-surface)]"
          >
            {product.image_url && (
              <Image
                src={product.image_url}
                alt={product.name}
                fill
                priority
                sizes="(max-width: 1024px) 100vw, 45vw"
                className="object-contain p-10"
              />
            )}
          </div>
        </div>

        <div data-edit-key={`products:${product.id}`}>
          <Link href="/shop" className="label-caps -my-2 inline-flex min-h-11 items-center py-2 text-[var(--color-muted)]">
            ← Shop
          </Link>

          {brand && (
            <p className="label-caps mt-8 text-[var(--color-accent)]">{brand.name}</p>
          )}
          {/* The same row the shop grid edits — either page writes it, and
              the save revalidates both. */}
          <h1 data-edit-field="name" className="display mt-3 text-4xl">
            {product.name}
          </h1>

          {/* Only the studio's own price is quoted. Once she is out and the
              client is sent to the marketplace, the price is theirs and may
              differ, so we do not put a figure we cannot honour on it. */}
          {inStock ? (
            <>
              <p
                data-edit-field="price_cents"
                data-edit-type="money"
                className="mt-6 text-2xl tabular-nums"
              >
                {formatMoney(product.price_cents)}
              </p>
              {canShip && (
                <div className="mt-4">
                  <Badge tone="success">In the studio now</Badge>
                </div>
              )}
            </>
          ) : external ? (
            <div className="mt-4">
              <Badge tone="accent">Ships direct from {brand?.name ?? 'the brand'}</Badge>
            </div>
          ) : (
            <>
              <p
                data-edit-field="price_cents"
                data-edit-type="money"
                className="mt-6 text-2xl tabular-nums"
              >
                {formatMoney(product.price_cents)}
              </p>
              <div className="mt-4">
                <Badge tone="neutral">Out of stock</Badge>
              </div>
            </>
          )}

          {product.description && (
            <p
              data-edit-field="description"
              className="mt-8 leading-relaxed text-[var(--color-muted)]"
            >
              {product.description}
            </p>
          )}

          <div className="mt-8">
            {external ? (
              <>
                <ButtonLink
                  href={product.external_url!}
                  target="_blank"
                  rel="noreferrer noopener"
                  size="lg"
                >
                  Order it shipped
                  <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
                </ButtonLink>
                <p className="mt-3 text-sm text-[var(--color-muted)]">
                  We are out of this one at the moment. {brand?.name ?? 'The brand'} will
                  take payment and ship it to you directly.
                </p>
              </>
            ) : (
              <>
                <AddToCart productId={product.id} disabled={!inStock} />
                {!inStock && !canShip && (
                  <p className="mt-3 text-sm text-[var(--color-muted)]">
                    Ask us at your next visit — we can order it in.
                  </p>
                )}
              </>
            )}
          </div>

          {product.how_to_use && (
            <div className="mt-12 border-t border-[var(--color-border)] pt-8">
              <h2 className="label-caps mb-4 text-[var(--color-accent)]">How to use</h2>
              <p
                data-edit-field="how_to_use"
                className="whitespace-pre-line leading-relaxed text-[var(--color-muted)]"
              >
                {product.how_to_use}
              </p>
            </div>
          )}

          {product.ingredients && (
            <div className="mt-10 border-t border-[var(--color-border)] pt-8">
              <h2 className="label-caps mb-4 text-[var(--color-accent)]">Ingredients</h2>
              <p
                data-edit-field="ingredients"
                className="text-sm leading-relaxed text-[var(--color-muted)]"
              >
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
