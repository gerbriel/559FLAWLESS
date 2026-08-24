import Image from 'next/image'
import type { Metadata } from 'next'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { pageCopy } from '@/lib/page-copy'
import { ButtonLink } from '@/components/ui/button'

export const revalidate = 600

export const metadata: Metadata = {
  title: 'About',
  description:
    'A private, single-room skin studio in Fresno. Honest advice, no upselling, treatments chosen for your skin.',
}

const PRINCIPLES = [
  {
    title: 'One room, one client',
    body: 'You are not handed between stations or rushed to make room. The door closes and the time is yours.',
  },
  {
    title: 'No scripts, no upsells',
    body: 'You will be told what will actually help and what will not. If a treatment is wrong for your skin right now, we say so.',
  },
  {
    title: 'Licensed and current',
    body: 'Every treatment is performed by a Licensed Cosmetologist working within scope. Anything medical gets referred out, not improvised.',
  },
  {
    title: 'Your comfort sets the pace',
    body: 'You can ask questions, ask to pause, or stop entirely at any point. That is true of every service and always will be.',
  },
]

export default async function AboutPage() {
  const copy = await pageCopy('page_about')

  const supabase = createPublicClient()
  const { data: aboutRow } = await supabase
    .from('site_content')
    .select('value')
    .eq('key', 'about')
    .maybeSingle()

  const about = (aboutRow?.value ?? {}) as { heading?: string; body?: string }

  return (
    <>
      <Section>
        <Container className="grid gap-16 lg:grid-cols-2 lg:items-center">
          <div className="relative aspect-[4/5] w-full overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-surface)]">
            <Image
              src="/images/about.jpg"
              alt="A facial treatment in progress at the studio"
              fill
              priority
              sizes="(max-width: 1024px) 100vw, 45vw"
              className="object-cover"
            />
          </div>

          <div>
            <SectionHeading
              eyebrow={copy.eyebrow ?? 'The studio'}
              title={about.heading ?? 'About the studio'}
              lede={about.body}
            />
            <p className="mt-6 leading-relaxed text-[var(--color-muted)]">
              Skin changes. What worked last spring may not work now, and a routine that
              suits your friend may be actively making your barrier worse. Every visit
              starts with a look at where your skin actually is — not where it was at
              your last appointment, and not where a package deal says it should be.
            </p>
            <ButtonLink href="/book" className="mt-10" size="lg">
              Book an appointment
            </ButtonLink>
          </div>
        </Container>
      </Section>

      <Section className="border-t border-[var(--color-border)] bg-[var(--color-linen)] dark:bg-[var(--color-surface)]">
        <Container>
          <SectionHeading
            eyebrow={copy.how_eyebrow ?? 'How we work'}
            title={copy.how_title ?? 'What you can count on.'}
            editKey="page_about"
            editFields={{ eyebrow: 'how_eyebrow', title: 'how_title' }}
          />
          <div className="mt-16 grid gap-12 sm:grid-cols-2">
            {PRINCIPLES.map((p) => (
              <div key={p.title}>
                <h3 className="display text-2xl">{p.title}</h3>
                <p className="mt-3 leading-relaxed text-[var(--color-muted)]">{p.body}</p>
              </div>
            ))}
          </div>
        </Container>
      </Section>
    </>
  )
}
