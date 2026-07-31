import type { Metadata } from 'next'
import { Mail, Phone, MapPin } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Container, Section } from '@/components/ui/section'
import { ContactForm } from '@/components/shared/ContactForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Contact',
  description: 'Get in touch with 559 Flawless — questions, consultations, and bookings.',
}

interface Props {
  searchParams: Promise<{ service?: string }>
}

export default async function ContactPage({ searchParams }: Props) {
  const { service } = await searchParams
  const supabase = await createClient()

  const [{ data: contactRow }, { data: serviceRow }] = await Promise.all([
    supabase.from('site_content').select('value').eq('key', 'contact').maybeSingle(),
    service
      ? supabase.from('services').select('name').eq('slug', service).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const contact = (contactRow?.value ?? {}) as {
    phone?: string
    email?: string
    address?: string
    city?: string
    state?: string
  }

  return (
    <Section>
      <Container className="grid gap-16 lg:grid-cols-[1.2fr_1fr]">
        <div>
          <p className="label-caps mb-4 text-[var(--color-accent)]">Contact</p>
          <h1 className="display text-4xl sm:text-5xl">Get in touch.</h1>
          <p className="mt-5 max-w-xl text-[var(--color-muted)]">
            Questions about a treatment, unsure what to book, or want to arrange a
            consultation — send a note and we will get back to you.
          </p>

          <div className="mt-12">
            <ContactForm presetSubject={serviceRow?.name} />
          </div>
        </div>

        <aside className="lg:sticky lg:top-28 lg:self-start">
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
            <p className="label-caps mb-6 text-[var(--color-accent)]">Studio</p>
            <ul className="space-y-5 text-sm">
              {(contact.address || contact.city) && (
                <li className="flex gap-3">
                  <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} />
                  <span className="text-[var(--color-muted)]">
                    {contact.address}
                    {contact.address && <br />}
                    {contact.city}
                    {contact.city && contact.state ? `, ${contact.state}` : contact.state}
                  </span>
                </li>
              )}
              {contact.phone && (
                <li className="flex gap-3">
                  <Phone className="h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} />
                  <a href={`tel:${contact.phone.replace(/\D/g, '')}`}>{contact.phone}</a>
                </li>
              )}
              {contact.email && (
                <li className="flex gap-3">
                  <Mail className="h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} />
                  <a href={`mailto:${contact.email}`} className="break-all">
                    {contact.email}
                  </a>
                </li>
              )}
            </ul>

            <p className="mt-8 border-t border-[var(--color-border)] pt-6 text-xs leading-relaxed text-[var(--color-muted)]">
              Appointments only — the studio is not staffed for walk-ins. If you are
              trying to book, the fastest route is the booking page.
            </p>
          </div>
        </aside>
      </Container>
    </Section>
  )
}
