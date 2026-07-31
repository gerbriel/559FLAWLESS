import { Check } from 'lucide-react'
import type { Metadata } from 'next'
import { Container, Section } from '@/components/ui/section'
import { ButtonLink } from '@/components/ui/button'
import { ClearCart } from '@/components/shared/ClearCart'

export const metadata: Metadata = {
  title: 'Order Confirmed',
  robots: { index: false, follow: false },
}

export default function OrderConfirmationPage() {
  return (
    <Section>
      <Container>
        {/* Emptying the bag is client-side; the order itself is confirmed by the
            Stripe webhook, not by anyone landing on this page. */}
        <ClearCart />

        <div className="mx-auto max-w-lg py-16 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center border border-[var(--color-accent)]">
            <Check className="h-6 w-6 text-[var(--color-accent)]" strokeWidth={1.5} />
          </div>
          <h1 className="display mt-8 text-4xl">Thank you.</h1>
          <p className="mt-4 text-[var(--color-muted)]">
            Your order is in. You will get an email receipt, and we will let you know
            when it is ready.
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <ButtonLink href="/account/orders" variant="subtle">
              View my orders
            </ButtonLink>
            <ButtonLink href="/shop">Keep shopping</ButtonLink>
          </div>
        </div>
      </Container>
    </Section>
  )
}
