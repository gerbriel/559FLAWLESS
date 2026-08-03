import { redirect } from 'next/navigation'
import { isProfileComplete } from '@/lib/profile'
import type { Metadata } from 'next'
import { createClient } from '@/lib/supabase/server'
import { CompleteProfileForm, type ProfileGaps } from '@/components/shared/CompleteProfileForm'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Finish your profile · 559 Flawless',
  robots: { index: false, follow: false },
}

interface Props {
  searchParams: Promise<{ next?: string; welcome?: string }>
}

/**
 * The step between "signed in" and "able to book".
 *
 * Anyone who already has everything is sent straight on, so this page never
 * appears for the sake of appearing — someone who signed up with the email form
 * gave us all of this already.
 *
 * `?welcome=1` is the exception, and it comes from one place: an invitation
 * that has just been accepted. That person is new, is already filling a form
 * in, and — if the studio invited them from its own client list — is looking at
 * details it has had on paper for years. Sending them straight to /account
 * would spend the only minute anyone will ever have their whole attention on a
 * page that asks them for nothing. So the welcome pass runs even for a profile
 * that is technically complete, asks the few things worth asking, and offers a
 * way past every one of them.
 */
export default async function CompleteProfilePage({ searchParams }: Props) {
  const { next: rawNext, welcome: rawWelcome } = await searchParams
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : '/account'
  const welcome = rawWelcome === '1'

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    const back = `/account/complete?next=${next}${welcome ? '&welcome=1' : ''}`
    redirect(`/login?next=${encodeURIComponent(back)}`)
  }

  // Two reads, one round trip. `client_records` is the client's own row and 005
  // lets them read it; `referral_source` is all this page wants from it, and
  // all a client may ever write to it — see 053.
  const [{ data: profile }, { data: record }] = await Promise.all([
    supabase
      .from('profiles')
      .select(
        'id, email, role, first_name, last_name, phone, date_of_birth, pronouns, marketing_opt_in, sms_opt_in, terms_accepted_at'
      )
      .eq('id', user.id)
      .maybeSingle(),
    supabase
      .from('client_records')
      .select('referral_source')
      .eq('client_id', user.id)
      .maybeSingle(),
  ])

  if (!profile) redirect('/login')

  // Staff do not book through the client flow, so this never applies to them.
  if (profile.role !== 'client') redirect('/dashboard')

  // Someone arriving from an invitation is why last name is on this list: they
  // came off the studio's old list as a first name and a phone number, and this
  // page is where the rest of it comes from the one person who knows it.
  const complete = isProfileComplete(profile)
  if (complete && !welcome) redirect(next)

  return (
    <div className="mx-auto max-w-lg px-6 py-16 sm:py-24">
      <p className="label-caps text-[var(--color-accent)]">
        {welcome ? 'Your account is ready' : 'Almost there'}
      </p>
      <h1 className="display mt-3 text-4xl">
        {welcome ? 'A little about you.' : 'A couple more details.'}
      </h1>
      <p className="mt-4 text-sm leading-relaxed text-[var(--color-muted)]">
        {welcome
          ? 'Anything already filled in is what the studio had on file — please correct whatever is out of date. We need your name and a phone number so we can reach you if an appointment changes, and a date of birth because some treatments have an age minimum. Everything else is optional.'
          : 'We need your full name, a phone number to reach you if anything about your appointment changes, and a date of birth because some treatments have an age minimum. It takes a moment and we only ask once.'}
      </p>

      {/* Said out loud, because somebody filling in their first form has no way
          of knowing where it stops. The health questions come later, attached
          to the treatment they are actually about. */}
      {welcome && (
        <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
          Nothing here is about your skin or your health — those questions come with
          your first appointment, on a form your provider reviews.
        </p>
      )}

      <div className="mt-10">
        <CompleteProfileForm
          profile={profile as ProfileGaps}
          next={next}
          welcome={welcome}
          referralSource={record?.referral_source ?? null}
          // Only when the account genuinely owes nothing. Somebody still
          // missing a phone number is not offered a way around it.
          skipHref={welcome && complete ? next : null}
        />
      </div>
    </div>
  )
}
