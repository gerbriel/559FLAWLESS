import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { LegalDocument } from '@/components/shared/LegalDocument'

export const revalidate = 600

export const metadata: Metadata = {
  title: 'Terms of Service',
  description: 'Terms of service for booking and purchasing from 559 Flawless.',
}

export default async function TermsPage() {
  const supabase = await createClient()

  // Fetch the latest active terms from site_settings
  const { data: terms } = await supabase
    .from('site_settings')
    .select('text_value, version, effective_at')
    .eq('key', 'terms_of_service')
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Migration 021 seeds this row with a null `text_value` so the admin editor
  // has something to open, so the row existing does not mean terms have been
  // published — only text does. The terms themselves live in the database and
  // nowhere else: they are a legal document, they change on their own schedule,
  // and neither of those should wait on a deploy.
  // Lifted into its own shape rather than aliasing the row: narrowing the row
  // on one of its properties does not narrow that property for the compiler.
  const published = terms?.text_value
    ? { text: terms.text_value, version: terms.version, effectiveAt: terms.effective_at }
    : null

  if (!published) {
    return (
      <Section>
        <Container>
          <SectionHeading eyebrow="Legal" title="Terms of Service" />
          <p className="mt-8 max-w-prose text-sm text-[var(--color-muted)]">
            The studio&rsquo;s terms are not published here yet. Ask at your appointment or
            call <a href="tel:+15594772999" className="underline">(559) 477-2999</a> and we
            will send them to you. Our{' '}
            <a href="/policies" className="underline">
              cancellation, deposit and lateness policies
            </a>{' '}
            are published in full.
          </p>
        </Container>
      </Section>
    )
  }

  const effectiveDate = published.effectiveAt
    ? new Date(published.effectiveAt).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null

  return (
    <Section>
      <Container>
        <SectionHeading eyebrow="Legal" title="Terms of Service" />

        <div className="mt-8 max-w-3xl space-y-4 text-sm text-[var(--color-muted)]">
          {effectiveDate && <p>Effective Date: {effectiveDate}</p>}
          <p>Version {published.version}</p>
        </div>

        <div className="mt-14">
          <LegalDocument content={published.text} />
        </div>
      </Container>
    </Section>
  )
}
