import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { LegalDocument } from '@/components/shared/LegalDocument'

export const revalidate = 600

export const metadata: Metadata = {
  title: 'Privacy Policy',
  description: 'How 559 Flawless collects, uses, and protects your information.',
}

export default async function PrivacyPage() {
  const supabase = await createClient()
  
  // Fetch the latest active privacy policy from site_settings
  const { data: privacy } = await supabase
    .from('site_settings')
    .select('text_value, version, effective_at')
    .eq('key', 'privacy_policy')
    .eq('is_active', true)
    .order('version', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Migration 021 seeds this row with a null `text_value` so the admin editor
  // has something to open, which means the row existing does not mean a policy
  // has been published. The policy lives in the database and nowhere else — it
  // is a legal document and should never need a deploy to change. Lifted into
  // its own shape because narrowing the row does not narrow its property.
  const published = privacy?.text_value
    ? { text: privacy.text_value, version: privacy.version, effectiveAt: privacy.effective_at }
    : null

  if (!published) {
    return (
      <Section>
        <Container>
          <SectionHeading eyebrow="Legal" title="Privacy Policy" />
          <p className="mt-8 max-w-prose text-sm text-[var(--color-muted)]">
            The studio&rsquo;s privacy policy is not published here yet. Ask at your
            appointment or call{' '}
            <a href="tel:+15594772999" className="underline">
              (559) 477-2999
            </a>{' '}
            and we will send it to you. Your intake answers, consent forms, treatment notes
            and any clinical photographs are treated as confidential health information
            either way.
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
        <SectionHeading
          eyebrow="Legal"
          title="Privacy Policy"
          lede="How we collect, use, and protect your information."
        />

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
