import Link from 'next/link'
import { Mail, Phone, MapPin } from 'lucide-react'
import { Container } from '@/components/ui/section'
import { NewsletterForm } from '@/components/shared/NewsletterForm'

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

export interface FooterContact {
  phone?: string
  email?: string
  address?: string
  city?: string
  state?: string
  instagram?: string
}

export function SiteFooter({
  contact,
  hours,
  categories,
}: {
  contact: FooterContact
  hours: { day_of_week: number; opens_at: string | null; closes_at: string | null; is_closed: boolean }[]
  categories: { name: string; slug: string }[]
}) {
  const year = new Date().getFullYear()

  return (
    <footer className="mt-auto border-t border-[var(--color-border)] bg-[var(--color-linen)] dark:bg-[var(--color-surface)]">
      <Container className="py-16">
        <div className="grid gap-12 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <span className="display block text-3xl leading-none">559</span>
            <span className="label-caps block text-[var(--color-accent)]">Flawless</span>
            <p className="mt-5 max-w-xs text-sm leading-relaxed text-[var(--color-muted)]">
              A private skin studio. Facials, hard-wax hair removal, and corrective
              treatments by a licensed esthetician.
            </p>
            {contact.instagram && (
              <a
                href={`https://instagram.com/${contact.instagram.replace('@', '')}`}
                target="_blank"
                rel="noreferrer noopener"
                className="mt-6 inline-flex items-center gap-2 text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-accent)]"
              >
                <InstagramIcon className="h-4 w-4" />
                {contact.instagram}
              </a>
            )}
          </div>

          <div>
            <p className="label-caps mb-5 text-[var(--color-accent)]">Services</p>
            <ul className="space-y-2.5">
              {categories.map((c) => (
                <li key={c.slug}>
                  <Link
                    href={`/services/${c.slug}`}
                    className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)]"
                  >
                    {c.name}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  href="/shop"
                  className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)]"
                >
                  Shop products
                </Link>
              </li>
              <li>
                <Link
                  href="/gift-cards"
                  className="text-sm text-[var(--color-muted)] transition-colors hover:text-[var(--color-foreground)]"
                >
                  Gift cards
                </Link>
              </li>
            </ul>
          </div>

          <div>
            <p className="label-caps mb-5 text-[var(--color-accent)]">Hours</p>
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
            <p className="label-caps mb-5 text-[var(--color-accent)]">Visit</p>
            <ul className="space-y-3 text-sm text-[var(--color-muted)]">
              {(contact.address || contact.city) && (
                <li className="flex gap-2.5">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.5} />
                  <span>
                    {contact.address}
                    {contact.address && <br />}
                    {contact.city}
                    {contact.city && contact.state ? `, ${contact.state}` : contact.state}
                  </span>
                </li>
              )}
              {contact.phone && (
                <li className="flex gap-2.5">
                  <Phone className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                  <a href={`tel:${contact.phone.replace(/\D/g, '')}`} className="hover:text-[var(--color-foreground)]">
                    {contact.phone}
                  </a>
                </li>
              )}
              {contact.email && (
                <li className="flex gap-2.5">
                  <Mail className="h-4 w-4 shrink-0" strokeWidth={1.5} />
                  <a href={`mailto:${contact.email}`} className="hover:text-[var(--color-foreground)]">
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
          <p>© {year} 559 Flawless. All rights reserved.</p>
          <div className="flex gap-6">
            <Link href="/policies" className="hover:text-[var(--color-foreground)]">
              Policies
            </Link>
            <Link href="/privacy" className="hover:text-[var(--color-foreground)]">
              Privacy
            </Link>
            <Link href="/terms" className="hover:text-[var(--color-foreground)]">
              Terms
            </Link>
          </div>
        </div>
      </Container>
    </footer>
  )
}
