import Link from 'next/link'
import type { Metadata } from 'next'
import { Container, Section, SectionHeading } from '@/components/ui/section'

export const metadata: Metadata = {
  title: 'Terms',
  description: 'Terms of service for booking and purchasing from 559 Flawless.',
}

export default function TermsPage() {
  return (
    <Section>
      <Container>
        <SectionHeading eyebrow="Terms" title="Terms of service." />

        <div className="mt-14 max-w-3xl space-y-10 text-[var(--color-muted)]">
          <Block title="Booking">
            Booking an appointment reserves a specific slot with a specific provider.
            Where a deposit is required, the slot is held on the understanding that the
            deposit is paid; it comes off your total on the day.
          </Block>

          <Block title="Cancellations">
            See the{' '}
            <Link href="/policies" className="underline underline-offset-4">
              studio policies
            </Link>{' '}
            for notice periods and what happens to a deposit on a late cancellation.
          </Block>

          <Block title="Services are cosmetic">
            Every service offered here is a cosmetic esthetic service. Your esthetician
            does not diagnose or treat medical conditions, and nothing performed here
            substitutes for care from a physician or dermatologist. If something needs
            medical attention we will tell you and refer you.
          </Block>

          <Block title="Results">
            Individual results vary. Some treatments need a series before any change is
            visible, and no specific outcome is promised or guaranteed.
          </Block>

          <Block title="Health disclosure">
            You are responsible for giving accurate health information and for telling us
            about changes before each visit. Some conditions and medications make certain
            treatments unsafe, and we may decline or postpone a treatment on that basis.
          </Block>

          <Block title="Age">
            Intimate services, chemical peels, and microneedling are for clients 18 and
            over. Clients under 18 may book basic facials and non-intimate waxing with a
            parent or guardian present to consent.
          </Block>

          <Block title="Products">
            Unopened retail products may be returned within 14 days. Opened skincare
            cannot be returned for hygiene reasons — if a product causes a reaction, tell
            us and we will work it out with you.
          </Block>

          <Block title="Right to decline">
            We may decline or end a service where it would be unsafe, where behaviour
            toward staff is abusive, or where repeated no-shows have made scheduling
            impractical.
          </Block>
        </div>
      </Container>
    </Section>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h2 className="display text-2xl text-[var(--color-foreground)]">{title}</h2>
      <p className="mt-3 leading-relaxed">{children}</p>
    </div>
  )
}
