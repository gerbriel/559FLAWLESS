import { Check } from 'lucide-react'
import type { Metadata } from 'next'
import { Container, Section } from '@/components/ui/section'
import { ButtonLink } from '@/components/ui/button'
import { ClearCart } from '@/components/shared/ClearCart'
import { MetaPixelEvent } from '@/components/shared/MetaPixelEvent'

export const metadata: Metadata = {
  title: 'Order Confirmed',
  robots: { index: false, follow: false },
}

export default async function OrderConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ order?: string; amount?: string }>
}) {
  const { order, amount } = await searchParams

  // Both ride in from the checkout route's success_url; neither is trusted for
  // anything but the ad pixel. Digits-only or the event simply does not fire —
  // a mangled URL should cost a marketing datapoint, not render a broken page.
  const orderId = order && /^\d{1,12}$/.test(order) ? order : null
  const amountCents = amount && /^\d{1,9}$/.test(amount) ? Number(amount) : null

  return (
    <Section>
      <Container>
        {/* Emptying the bag is client-side; the order itself is confirmed by the
            Stripe webhook, not by anyone landing on this page. Same for the
            pixel: it tells Meta an ad worked, not the studio that money moved. */}
        {orderId && amountCents !== null && (
          <MetaPixelEvent
            event="Purchase"
            id={`order-${orderId}`}
            value={amountCents / 100}
          />
        )}
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
