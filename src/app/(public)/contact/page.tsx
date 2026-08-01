import type { Metadata } from 'next'
import { Mail, Phone } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Container, Section } from '@/components/ui/section'
import { ContactForm, type ContactIdentity } from '@/components/shared/ContactForm'
import { DirectionsLink, type StudioLocation } from '@/components/shared/DirectionsLink'
import { StudioMap } from '@/components/shared/StudioMap'

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

  // This page is already force-dynamic and already reads cookies, so the
  // session costs nothing extra here. It is what lets a signed-in client write
  // in without retyping the name and email we hold for them.
  const {
    data: { user },
  } = await supabase.auth.getUser()

  const [{ data: contactRow }, { data: serviceRow }, profileRes] = await Promise.all([
    supabase.from('site_content').select('value').eq('key', 'contact').maybeSingle(),
    service
      ? supabase.from('services').select('name').eq('slug', service).maybeSingle()
      : Promise.resolve({ data: null }),
    user
      ? supabase
          .from('profiles')
          .select('first_name, last_name, email, phone')
          .eq('id', user.id)
          .maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  const contact = (contactRow?.value ?? {}) as StudioLocation & {
    phone?: string
    email?: string
    note?: string
  }

  const profile = profileRes?.data as
    | {
        first_name: string | null
        last_name: string | null
        email: string | null
        phone: string | null
      }
    | null

  // An address is what makes the rest usable — without one we cannot reply, so
  // there is nothing to prefill and the form asks as it always did.
  const knownEmail = profile?.email ?? user?.email ?? null
  const identity: ContactIdentity | null =
    user && knownEmail
      ? {
          userId: user.id,
          firstName: profile?.first_name ?? null,
          lastName: profile?.last_name ?? null,
          email: knownEmail,
          phone: profile?.phone ?? null,
        }
      : null

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
            <ContactForm presetSubject={serviceRow?.name} identity={identity} />
          </div>
        </div>

        <aside className="lg:sticky lg:top-28 lg:self-start">
          <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
            <p className="label-caps mb-6 text-[var(--color-accent)]">Studio</p>
            <ul className="space-y-5 text-sm">
              {(contact.address || contact.city) && (
                <li className="text-[var(--color-muted)]">
                  <DirectionsLink location={contact} />
                </li>
              )}
              {contact.phone && (
                <li className="flex min-h-11 items-center gap-3">
                  <Phone className="h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} />
                  <a href={`tel:${contact.phone.replace(/\D/g, '')}`}>{contact.phone}</a>
                </li>
              )}
              {contact.email && (
                <li className="flex min-h-11 items-center gap-3">
                  <Mail className="h-4 w-4 shrink-0 text-[var(--color-accent)]" strokeWidth={1.5} />
                  <a href={`mailto:${contact.email}`} className="break-all">
                    {contact.email}
                  </a>
                </li>
              )}
            </ul>

            <p className="mt-8 border-t border-[var(--color-border)] pt-6 text-xs leading-relaxed text-[var(--color-muted)]">
              {contact.note ??
                'Appointments only — the studio is not staffed for walk-ins. If you are trying to book, the fastest route is the booking page.'}
            </p>
          </div>

          <StudioMap location={contact} className="mt-6" />
        </aside>
      </Container>
    </Section>
  )
}
