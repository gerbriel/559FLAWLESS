import type { Metadata } from 'next'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { pageCopy } from '@/lib/page-copy'
import { ButtonLink } from '@/components/ui/button'

export const revalidate = 600

export const metadata: Metadata = {
  title: 'FAQ',
  description: 'Common questions about facials, waxing, and skin treatments at 559 Flawless.',
}

export default async function FaqPage() {
  const copy = await pageCopy('page_faq')

  const supabase = createPublicClient()
  const { data: faqs } = await supabase
    .from('faqs')
    .select('id, question, answer, category, sort_order')
    .eq('is_active', true)
    .order('sort_order')

  // Group by category, preserving the sort order within each.
  const grouped = new Map<string, typeof faqs>()
  for (const f of faqs ?? []) {
    const key = f.category ?? 'General'
    grouped.set(key, [...(grouped.get(key) ?? []), f])
  }

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow={copy.eyebrow ?? 'Questions'}
          title={copy.title ?? 'Everything people ask.'}
          lede={
            copy.lede ??
            'If your question is not here, message us — nothing is too basic and nothing is too awkward.'
          }
          editKey="page_faq"
          editFields={{ eyebrow: 'eyebrow', title: 'title', lede: 'lede' }}
        />

        <div className="mt-20 space-y-16">
          {Array.from(grouped.entries()).map(([category, items]) => (
            <div key={category}>
              <h2 className="label-caps mb-8 text-[var(--color-accent)]">{category}</h2>
              <dl className="divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
                {(items ?? []).map((f) => (
                  // Search links here by id. scroll-mt clears the sticky header,
                  // which would otherwise land the question underneath it.
                  <div
                    key={f.id}
                    id={`faq-${f.id}`}
                    data-edit-key={`faqs:${f.id}`}
                    className="scroll-mt-28 py-7"
                  >
                    <dt data-edit-field="question" className="display text-xl">
                      {f.question}
                    </dt>
                    <dd
                      data-edit-field="answer"
                      className="mt-3 max-w-3xl leading-relaxed text-[var(--color-muted)]"
                    >
                      {f.answer}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
          ))}
        </div>

        <div className="mt-20 border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
          <p className="display text-2xl">Still not sure what to book?</p>
          <p className="mx-auto mt-3 max-w-md text-sm text-[var(--color-muted)]">
            Send us a message describing your skin and what is bothering you. We will
            tell you honestly what would help most.
          </p>
          <ButtonLink href="/contact" className="mt-8">
            Ask a question
          </ButtonLink>
        </div>
      </Container>
    </Section>
  )
}
