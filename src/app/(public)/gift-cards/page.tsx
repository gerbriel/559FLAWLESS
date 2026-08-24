import type { Metadata } from 'next'
import { createPublicClient } from '@/lib/supabase/public'
import { Container, Section, SectionHeading } from '@/components/ui/section'
import { pageCopy } from '@/lib/page-copy'
import { ButtonLink } from '@/components/ui/button'
import { formatMoney } from '@/lib/utils'

export const revalidate = 300

export const metadata: Metadata = {
  title: 'Gift Cards & Packages',
  description: 'Gift cards and prepaid treatment series at 559 Flawless.',
}

export default async function GiftCardsPage() {
  const copy = await pageCopy('page_gift_cards')

  const supabase = createPublicClient()

  const { data: packages } = await supabase
    .from('service_packages')
    .select('id, name, slug, description, session_count, price_cents, valid_days, services(name)')
    .eq('is_active', true)
    .order('sort_order')

  return (
    <Section>
      <Container>
        <SectionHeading
          eyebrow={copy.eyebrow ?? 'Gift cards'}
          title={copy.title ?? 'Give someone their skin back.'}
          lede={
            copy.lede ??
            'Gift cards never expire and can be used against any service or product. Prepaid series are for treatments that genuinely need more than one session.'
          }
          editKey="page_gift_cards"
          editFields={{ eyebrow: 'eyebrow', title: 'title', lede: 'lede' }}
        />

        <div className="mt-14 border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
          <p className="display text-2xl">Gift cards</p>
          <p className="mx-auto mt-3 max-w-md text-sm text-[var(--color-muted)]">
            Any amount. Purchase in the studio or call us and we will email one directly
            to the recipient. Online gift card purchase is coming shortly.
          </p>
          <ButtonLink href="/contact?service=gift-card" className="mt-8" variant="subtle">
            Ask about a gift card
          </ButtonLink>
        </div>

        {(packages?.length ?? 0) > 0 && (
          <section className="mt-20">
            <h2 className="display text-3xl">Treatment series</h2>
            <p className="mt-3 max-w-2xl text-[var(--color-muted)]">
              Corrective work — pigment, texture, scarring — builds over a course. Buying
              the series up front costs less than the sessions individually.
            </p>

            <ul className="mt-10 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
              {(packages ?? []).map((p) => {
                const service = p.services as { name: string } | null
                return (
                  <li
                    key={p.id}
                    className="flex flex-wrap items-baseline justify-between gap-x-8 gap-y-2 py-7"
                  >
                    <div className="min-w-0 flex-1">
                      <h3 className="display text-xl">{p.name}</h3>
                      <p className="mt-1.5 text-sm text-[var(--color-muted)]">
                        {p.session_count} sessions
                        {service && ` of ${service.name}`} · valid {p.valid_days} days
                      </p>
                      {p.description && (
                        <p className="mt-1.5 max-w-2xl text-sm text-[var(--color-muted)]">
                          {p.description}
                        </p>
                      )}
                    </div>
                    <span className="shrink-0 text-lg tabular-nums">
                      {formatMoney(p.price_cents)}
                    </span>
                  </li>
                )
              })}
            </ul>
          </section>
        )}
      </Container>
    </Section>
  )
}
