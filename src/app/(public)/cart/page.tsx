import type { Metadata } from 'next'
import { Container, Section } from '@/components/ui/section'
import { CartView } from '@/components/shared/CartView'

export const metadata: Metadata = {
  title: 'Your Bag',
  robots: { index: false, follow: false },
}

export default function CartPage() {
  return (
    <Section>
      <Container>
        <p className="label-caps mb-4 text-[var(--color-accent)]">Your bag</p>
        <h1 className="display text-4xl sm:text-5xl">Checkout</h1>
        <div className="mt-12">
          <CartView />
        </div>
      </Container>
    </Section>
  )
}
