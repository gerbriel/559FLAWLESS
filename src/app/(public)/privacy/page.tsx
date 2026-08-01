import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { Container, Section, SectionHeading } from '@/components/ui/section'

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

  const content = privacy?.text_value || fallbackPrivacy
  const version = privacy?.version || 1
  const effectiveDate = privacy?.effective_at ? new Date(privacy.effective_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }) : null

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
          <p>Version {version}</p>
        </div>

        <div className="prose prose-neutral dark:prose-invert mt-14 max-w-3xl">
          <div
            dangerouslySetInnerHTML={{
              __html: content.replace(/\n/g, '<br />').replace(/## /g, '<h2>').replace(/# /g, '<h1>'),
            }}
          />
        </div>
      </Container>
    </Section>
  )
}

const fallbackPrivacy = `# Privacy Policy

## Information We Collect
- **Account Information:** Name, email, phone, date of birth
- **Booking Information:** Service selections, appointment times, provider preferences
- **Health Information:** Intake forms, consent signatures, clinical notes, treatment photos
- **Payment Information:** Processed securely through Stripe (we do not store card details)
- **Usage Data:** Pages visited, booking funnel progression

## How We Use Your Information
- Provide and improve our services
- Send appointment reminders and confirmations
- Marketing communications (only if you opt in)
- Legal compliance and safety

## Data Security
Your information is encrypted in transit and at rest. Clinical records have restricted access.

## Your Rights
- Access your data
- Correct inaccuracies
- Request deletion (subject to legal record-keeping requirements)
- Opt out of marketing at any time
- Withdraw consent for treatment photography

## Third Parties
- **Stripe:** Payment processing
- **Supabase:** Data hosting (SOC 2 compliant)
- We do not sell your data

## Contact
Questions about your privacy? Contact us directly.`
