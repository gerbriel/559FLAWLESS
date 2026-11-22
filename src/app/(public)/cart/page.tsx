import type { Metadata } from 'next'
import { Suspense } from 'react'
import { Container, Section } from '@/components/ui/section'
import { CartView } from '@/components/shared/CartView'
import { CheckoutFromUrl } from '@/components/shared/CheckoutFromUrl'

export const metadata: Metadata = {
  title: 'Your Bag',
  robots: { index: false, follow: false },
}

export default function CartPage() {
  return (
    <Section>
      <Container>
        {/* Marketplace checkout links (Meta Shops) land here with the bag in
            the query string. The reader uses useSearchParams, which bails a
            prerendered page out unless it sits behind Suspense. */}
        <Suspense fallback={null}>
          <CheckoutFromUrl />
        </Suspense>
        <p className="label-caps mb-4 text-[var(--color-accent)]">Your bag</p>
        <h1 className="display text-4xl sm:text-5xl">Checkout</h1>
        <div className="mt-12">
          <CartView />
        </div>
      </Container>
    </Section>
  )
}
