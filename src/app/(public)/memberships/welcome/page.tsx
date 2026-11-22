import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { CalendarDays, Check, Clock } from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Container, Section } from '@/components/ui/section'
import { recordBookingIntent } from './actions'

// Signed-in only, and it reads the query string, so it is never cached.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Welcome to your membership',
  robots: { index: false, follow: false },
}

interface Props {
  searchParams: Promise<{ joined?: string }>
}

/**
 * Where Stripe hands a new member back (success_url, ?joined=1).
 *
 * Enrolment happens in the webhook, which races this redirect, so nothing on
 * this page depends on the membership existing yet. It asks one question,
 * book now or when ready, and records the answer (084). `joined` only adds the
 * thank-you line; a refresh without it still renders the choice.
 */
export default async function MembershipWelcomePage({ searchParams }: Props) {
  const { joined } = await searchParams
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login?next=/memberships/welcome')

  const choice =
    'flex h-full w-full flex-col items-start gap-3 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-left transition-colors hover:border-[var(--color-accent)]'

  return (
    <Section>
      <Container>
        <div className="mx-auto max-w-2xl py-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center border border-[var(--color-accent)]">
            <Check className="h-6 w-6 text-[var(--color-accent)]" strokeWidth={1.5} />
          </div>
          <h1 className="display mt-8 text-4xl">Thank you.</h1>
          {joined && (
            <p className="mt-4 text-[var(--color-muted)]">
              Your payment went through. Your membership appears on your membership page
              as soon as it is confirmed, usually within a minute.
            </p>
          )}
          <p className="label-caps mt-10 text-[var(--color-accent)]">What would you like to do?</p>
        </div>

        <div className="mx-auto grid max-w-2xl gap-6 sm:grid-cols-2">
          <form action={recordBookingIntent.bind(null, 'now')}>
            <button type="submit" className={choice}>
              <CalendarDays className="h-6 w-6 text-[var(--color-accent)]" strokeWidth={1.5} />
              <span className="display text-2xl">Pick my dates now</span>
              <span className="text-sm text-[var(--color-muted)]">
                Go straight to booking. A covered visit is counted once the studio confirms it.
              </span>
            </button>
          </form>
          <form action={recordBookingIntent.bind(null, 'later')}>
            <button type="submit" className={choice}>
              <Clock className="h-6 w-6 text-[var(--color-accent)]" strokeWidth={1.5} />
              <span className="display text-2xl">I will book when I am ready</span>
              <span className="text-sm text-[var(--color-muted)]">
                Your visits wait for you. Book from your membership page any time.
              </span>
            </button>
          </form>
        </div>

        <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-[var(--color-muted)]">
          Every visit is requested through booking, and each one is confirmed by the
          studio before it is on the calendar.
        </p>
      </Container>
    </Section>
  )
}
