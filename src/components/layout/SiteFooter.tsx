import Link from 'next/link'
import { Mail, Phone } from 'lucide-react'
import { Container } from '@/components/ui/section'
import { Logo } from '@/components/layout/Logo'
import { NewsletterForm } from '@/components/shared/NewsletterForm'
import { DirectionsLink, type StudioLocation } from '@/components/shared/DirectionsLink'

/** Lucide v1 dropped brand marks, so the Instagram glyph is inlined. */
function InstagramIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="2" y="2" width="20" height="20" rx="5" />
      <circle cx="12" cy="12" r="4" />
      <circle cx="17.5" cy="6.5" r="1" fill="currentColor" stroke="none" />
    </svg>
  )
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function formatHour(time: string | null): string {
  if (!time) return ''
  const [h, m] = time.split(':').map(Number)
  const suffix = h >= 12 ? 'pm' : 'am'
  const hour12 = h % 12 === 0 ? 12 : h % 12
  return m === 0 ? `${hour12}${suffix}` : `${hour12}:${String(m).padStart(2, '0')}${suffix}`
}

export type FooterContact = StudioLocation & {
  phone?: string
  email?: string
  instagram?: string
}

export function SiteFooter({
  contact,
  hours,
  categories,
  copy = {},
}: {
  contact: FooterContact
  hours: { day_of_week: number; opens_at: string | null; closes_at: string | null; is_closed: boolean }[]
  categories: { name: string; slug: string }[]
  /**
   * The footer's own words, from the `page_footer` row. It renders on every
   * page, so editing it anywhere edits it everywhere — which is the point, and
   * why the layout passes the row down rather than each page fetching it.
   */
  copy?: Record<string, string>
}) {
  const year = new Date().getFullYear()

  return (
    <footer className="mt-auto border-t border-[var(--color-border)] bg-[var(--color-linen)] dark:bg-[var(--color-surface)]">
      <Container className="py-16">
        <div className="grid gap-12 md:grid-cols-2 lg:grid-cols-4">
          <div data-edit-key="page_footer">
            <Logo className="h-16 text-[var(--color-accent)]" />
            <p
              data-edit-field="tagline"
              className="mt-5 max-w-xs text-sm leading-relaxed text-[var(--color-muted)]"
            >
              {copy.tagline ??
                'A private skin studio. Facials, hard-wax hair removal, and corrective treatments by a Licensed Cosmetologist.'}
            </p>
            {contact.instagram && (
              <a
                href={`https://instagram.com/${contact.instagram.replace('@', '')}`}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-5 inline-flex min-h-11 items-center gap-2 text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-accent)]"
              >
                <InstagramIcon className="h-4 w-4" />
                {contact.instagram}
              </a>
            )}
          </div>

          <div>
            <p data-edit-key="page_footer" data-edit-field="col_services" className="label-caps mb-5 text-[var(--color-accent)]">
              {copy.col_services ?? 'Services'}
            </p>
            <ul className="space-y-2.5">
              {categories.map((c) => (
                <li key={c.slug}>
                  <Link
                    href={`/services/${c.slug}`}
                    className="flex min-h-11 items-center text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)] sm:min-h-0"
                  >
                    {c.name}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  href="/shop"
                  className="flex min-h-11 items-center text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)] sm:min-h-0"
                >
                  Shop products
                </Link>
              </li>
              <li>
                <Link
                  href="/gift-cards"
                  className="flex min-h-11 items-center text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)] sm:min-h-0"
                >
                  Gift cards
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p data-edit-key="page_footer" data-edit-field="col_hours" className="label-caps mb-5 text-[var(--color-accent)]">
              {copy.col_hours ?? 'Hours'}
            </p>
            <ul className="space-y-2 text-sm text-[var(--color-muted)]">
              {hours
                .slice()
                .sort((a, b) => ((a.day_of_week + 6) % 7) - ((b.day_of_week + 6) % 7))
                .map((h) => (
                  <li key={h.day_of_week} className="flex justify-between gap-4">
                    <span>{DAYS[h.day_of_week]}</span>
                    <span className="tabular-nums">
                      {h.is_closed
                        ? 'Closed'
                        : `${formatHour(h.opens_at)} – ${formatHour(h.closes_at)}`}
                    </span>
                  </li>
                ))}
            </ul>
          </div>

          <div>
            <p data-edit-key="page_footer" data-edit-field="col_visit" className="label-caps mb-5 text-[var(--color-accent)]">
              {copy.col_visit ?? 'Visit'}
            </p>
            <ul className="space-y-3 text-sm text-[var(--color-muted)]">
              {(contact.address || contact.city) && (
                <li>
                  <DirectionsLink location={contact} />
                </li>
              )}
              {contact.phone && (
                <li className="flex min-h-11 items-center gap-2.5 sm:min-h-0">
                  <Phone className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                  <a
                    href={`tel:${contact.phone.replace(/\D/g, '')}`}
                    data-edit-key="contact"
                    data-edit-field="phone"
                    className="flex min-h-11 items-center hover:text-[var(--color-foreground)] sm:min-h-0"
                  >
                    {contact.phone}
                  </a>
                </li>
              )}
              {contact.email && (
                <li className="flex min-h-11 items-center gap-2.5 sm:min-h-0">
                  <Mail className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                  <a
                    href={`mailto:${contact.email}`}
                    data-edit-key="contact"
                    data-edit-field="email"
                    className="flex min-h-11 items-center hover:text-[var(--color-foreground)] sm:min-h-0"
                  >
                    {contact.email}
                  </a>
                </li>
              )}
            </ul>

            <div className="mt-8">
              <p className="label-caps mb-3 text-[var(--color-accent)]">Newsletter</p>
              <NewsletterForm />
            </div>
          </div>
        </div>

        <div className="mt-14 flex flex-col gap-4 border-t border-[var(--color-border)] pt-8 text-xs text-[var(--color-muted)] sm:flex-row sm:items-center sm:justify-between">
          {/* The year stays computed — it is not copy and nobody should have
              to remember to change it in January. */}
          <p>
            © {year}{' '}
            <span data-edit-key="page_footer" data-edit-field="legal">
              {copy.legal ?? '559 Flawless. All rights reserved.'}
            </span>
          </p>
          <div className="flex flex-wrap gap-x-6">
            <Link href="/policies" className="flex min-h-11 items-center hover:text-[var(--color-foreground)] sm:min-h-0">
              Policies
            </Link>
            <Link href="/privacy" className="flex min-h-11 items-center hover:text-[var(--color-foreground)] sm:min-h-0">
              Privacy
            </Link>
            <Link href="/terms" className="flex min-h-11 items-center hover:text-[var(--color-foreground)] sm:min-h-0">
              Terms
            </Link>
          </div>
        </div>
      </Container>
    </footer>
  )
}
