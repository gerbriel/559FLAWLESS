import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { Container, Section, SectionHeading } from '@/components/ui/section'

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

  const content = terms?.text_value || fallbackTerms
  const version = terms?.version || 1
  const effectiveDate = terms?.effective_at ? new Date(terms.effective_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }) : null

  return (
    <Section>
      <Container>
        <SectionHeading eyebrow="Legal" title="Terms of Service" />

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

const fallbackTerms = `# Terms of Service

## 1. Agreement to Terms
By creating an account or booking services at 559 Flawless, you agree to these Terms of Service.

## 2. Services
We provide professional esthetic services including facials, waxing, nail care, and corrective skin treatments. All services are performed by licensed professionals.

## 3. Booking & Cancellation
- Appointments require a deposit
- 24-hour cancellation notice required for full refund
- Late cancellations forfeit deposit
- Repeated no-shows may result in booking restrictions

## 4. Age Requirements
Certain services require clients to be 18 years or older. You attest that you meet age requirements for services you book.

## 5. Health & Safety
- Clients must disclose relevant health conditions
- We reserve the right to decline service if contraindications exist
- Follow aftercare instructions provided

## 6. Photography
Treatment photos are clinical records. Separate consent required for any marketing use.

## 7. Privacy
Your information is handled according to our Privacy Policy.

## 8. Limitation of Liability
Services are provided "as is". We are not liable for results that vary by individual skin type and condition.

## 9. Changes
We may update these terms. Continued use after changes constitutes acceptance.`
