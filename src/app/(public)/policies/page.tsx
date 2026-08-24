import type { Metadata } from 'next'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { pageCopy } from '@/lib/page-copy'

export const revalidate = 600

export const metadata: Metadata = {
  title: 'Studio Policies',
  description: 'Cancellation, deposit, lateness, and intimate service policies at 559 Flawless.',
}

interface Policies {
  cancellation?: string
  late?: string
  deposits?: string
  intimate?: string
}

export default async function PoliciesPage() {
  const copy = await pageCopy('page_policies')

  const supabase = createPublicClient()

  const [{ data: row }, { data: settings }] = await Promise.all([
    supabase.from('site_content').select('value').eq('key', 'policies').maybeSingle(),
    supabase
      .from('booking_settings')
      .select('cancellation_policy, late_policy')
      .eq('id', 1)
      .maybeSingle(),
  ])

  const p = (row?.value ?? {}) as Policies

  const sections = [
    {
      title: 'Cancellations and rescheduling',
      body: settings?.cancellation_policy ?? p.cancellation,
    },
    { title: 'Deposits', body: p.deposits },
    { title: 'Running late', body: settings?.late_policy ?? p.late },
    { title: 'Intimate services', body: p.intimate },
  ].filter((s) => s.body)

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow={copy.eyebrow ?? 'Policies'}
          title={copy.title ?? 'The house rules.'}
          lede={
            copy.lede ??
            'Short, and all of them exist so the studio can run on time and everyone gets the appointment they booked.'
          }
          editKey="page_policies"
          editFields={{ eyebrow: 'eyebrow', title: 'title', lede: 'lede' }}
        />

        <div className="mt-16 max-w-3xl space-y-12">
          {sections.map((s) => (
            <div key={s.title}>
              <h2 className="display text-2xl">{s.title}</h2>
              <p className="mt-3 leading-relaxed text-[var(--color-muted)]">{s.body}</p>
            </div>
          ))}

          <div>
            <h2 className="display text-2xl">Health and safety</h2>
            <p className="mt-3 leading-relaxed text-[var(--color-muted)]">
              You will complete a short health form before your first visit and confirm it
              is still accurate at each subsequent one. Some conditions and medications
              make certain treatments unsafe, and a few require a patch test first. If
              something in your history means we cannot proceed that day, we will tell you
              why and reschedule without penalty.
            </p>
          </div>

          <div>
            <h2 className="display text-2xl">Photographs</h2>
            <p className="mt-3 leading-relaxed text-[var(--color-muted)]">
              Before-and-after photographs are only taken with your written consent, are
              stored securely, and are visible only to you and the staff who treat you.
              Use in marketing is a separate permission you have to give explicitly. You
              can decline photography entirely and still receive your treatment, and you
              can ask us to delete your photographs at any time.
            </p>
          </div>

          <div>
            <h2 className="display text-2xl">Minors</h2>
            <p className="mt-3 leading-relaxed text-[var(--color-muted)]">
              Clients under 18 may book basic facials and non-intimate waxing with a
              parent or guardian present to give consent. Intimate services, peels, and
              microneedling are 18 and over only, without exception.
            </p>
          </div>
        </div>
      </Container>
    </Section>
  )
}
