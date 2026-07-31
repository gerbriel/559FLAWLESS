import type { Metadata } from 'next'
import { Container, Section, SectionHeading } from '@/components/ui/section'

export const metadata: Metadata = {
  title: 'Privacy',
  description: 'How 559 Flawless collects, uses, and protects your information.',
}

export default function PrivacyPage() {
  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow="Privacy"
          title="What we hold, and why."
          lede="Plain terms. If anything here is unclear, ask us and we will explain it."
        />

        <div className="mt-14 max-w-3xl space-y-10 text-[var(--color-muted)]">
          <Block title="What we collect">
            Your name, contact details, and appointment history. If you complete a health
            form, we also hold the answers you give about your skin, medications, and
            relevant medical history — that information exists so your treatment is safe.
            If you consent to photography, we hold those images.
          </Block>

          <Block title="Who can see it">
            Your health information and treatment notes are visible to you and to the
            licensed staff who treat you. Front desk staff can see your appointments and
            contact details in order to book you. Nobody outside the studio sees any of it.
          </Block>

          <Block title="Photographs">
            Clinical before-and-after photographs are taken only with your written
            consent, stored in private storage, and served through short-lived links —
            they are not on a public address. Marketing use is a separate permission that
            you have to give explicitly, and you can withdraw either at any time, after
            which we delete the images.
          </Block>

          <Block title="Payments">
            Card details are handled entirely by Stripe. We never see or store your card
            number. We keep a record of what was paid, when, and for what.
          </Block>

          <Block title="Email and text">
            Appointment confirmations and reminders are transactional — you get those
            because you booked. Marketing email only goes out if you opted in, and every
            message has a one-click unsubscribe that does not require signing in.
          </Block>

          <Block title="Analytics">
            We record which pages get visited and where bookings drop off, tied to a
            random session id rather than to you. It tells us the booking page is
            confusing; it does not tell us who you are.
          </Block>

          <Block title="How long we keep it">
            Treatment records are kept for as long as required for a health record of
            this kind, because they matter if you have a reaction later. Everything else
            we delete on request.
          </Block>

          <Block title="Your choices">
            You can see everything we hold about you, correct it, withdraw any consent,
            ask for your photographs to be deleted, and ask us to close your account.
            Message us and we will do it.
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
