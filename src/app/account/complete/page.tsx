import { redirect } from 'next/navigation'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { CompleteProfileForm, type ProfileGaps } from '@/components/shared/CompleteProfileForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Finish your profile · 559 Flawless',
  robots: { index: false, follow: false },
}

interface Props {
  searchParams: Promise<{ next?: string }>
}

/**
 * The step between "signed in" and "able to book".
 *
 * Anyone who already has everything is sent straight on, so this page never
 * appears for the sake of appearing — someone who signed up with the email form
 * gave us all of this already.
 */
export default async function CompleteProfilePage({ searchParams }: Props) {
  const { next: rawNext } = await searchParams
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/account'

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    redirect(`/login?next=${encodeURIComponent(`/account/complete?next=${next}`)}`)
  }

  const { data: profile } = await supabase
    .from('profiles')
    .select(
      'id, email, role, first_name, last_name, phone, date_of_birth, pronouns, marketing_opt_in, terms_accepted_at'
    )
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) redirect('/login')

  // Staff do not book through the client flow, so this never applies to them.
  if (profile.role !== 'client') redirect('/dashboard')

  const complete =
    !!profile.first_name?.trim() && !!profile.phone?.trim() && !!profile.date_of_birth
  if (complete) redirect(next)

  return (
    <div className="mx-auto max-w-lg px-6 py-16 sm:py-24">
      <p className="label-caps text-[var(--color-accent)]">Almost there</p>
      <h1 className="display mt-3 text-4xl">A couple more details.</h1>
      <p className="mt-4 text-sm leading-relaxed text-[var(--color-muted)]">
        We need a phone number to reach you if anything about your appointment changes,
        and a date of birth because some treatments have an age minimum. It takes a
        moment and we only ask once.
      </p>

      <div className="mt-10">
        <CompleteProfileForm profile={profile as ProfileGaps} next={next} />
      </div>
    </div>
  )
}
