import { Check } from 'lucide-react'
import type { Metadata } from 'next'
import { Container, Section } from '@/components/ui/section'
import { ButtonLink } from '@/components/ui/button'
import { MetaPixelEvent } from '@/components/shared/MetaPixelEvent'

export const metadata: Metadata = {
  title: 'Message sent',
  robots: { index: false, follow: false },
}

/**
 * Where the contact form lands after a successful send.
 *
 * A page rather than the form's old in-place "sent" panel for one reason: ads.
 * A URL that is only ever reached by sending a message is something Meta can
 * count — the pixel fires a Contact event here, and the URL itself can back a
 * destination-rule conversion if the pixel is ever off.
 *
 * `t` is the message thread's id, passed by the form purely as the event's
 * dedupe key. No fetch is made with it — this page shows nothing thread-shaped,
 * so a guessed id reveals nothing. Landing here without one (a bookmark, a
 * crawler that ignores robots) fires nothing rather than minting a fake
 * conversion for every stray visit.
 */
export default async function ContactThanksPage({
  searchParams,
}: {
  searchParams: Promise<{ t?: string }>
}) {
  const { t } = await searchParams
  const threadId = t && /^\d{1,12}$/.test(t) ? t : null

  return (
    <Section>
      <Container>
        {threadId && <MetaPixelEvent event="Contact" id={`contact-${threadId}`} />}
        <div className="mx-auto max-w-lg py-16 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center border border-[var(--color-accent)]">
            <Check className="h-6 w-6 text-[var(--color-accent)]" strokeWidth={1.5} />
          </div>
          <h1 className="display mt-8 text-4xl">Thanks for reaching out.</h1>
          <p className="mt-4 text-[var(--color-muted)]">
            Your message is in. We usually reply within one business day — if it is
            urgent, please call the studio.
          </p>
          <div className="mt-10 flex flex-wrap justify-center gap-3">
            <ButtonLink href="/services" variant="subtle">
              Browse services
            </ButtonLink>
            <ButtonLink href="/book">Book an appointment</ButtonLink>
          </div>
        </div>
      </Container>
    </Section>
  )
}
