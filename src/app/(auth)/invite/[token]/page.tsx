import Link from 'next/link'
import type { Metadata } from 'next'
import { createPublicClient } from '@/lib/supabase/public'
import { createClient } from '@/lib/supabase/server'
import { InviteAcceptForm } from '@/components/shared/InviteAcceptForm'
import { ROLE_LABELS, type UserRole } from '@/types/database'

// A one-time credential in the URL must never be prerendered or cached.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Your invitation',
  robots: { index: false, follow: false },
}

interface Props {
  params: Promise<{ token: string }>
}

type Preview = {
  email: string
  role: UserRole
  first_name: string | null
  last_name: string | null
  note: string | null
  invited_by_name: string | null
  expires_at: string
  status: 'pending' | 'accepted' | 'revoked' | 'expired'
}

const DEAD_END: Record<string, { heading: string; body: string }> = {
  expired: {
    heading: 'This invitation has expired.',
    body: 'Links are good for a short window. Ask the studio to send you a new one — it takes them a moment.',
  },
  accepted: {
    heading: 'This invitation has already been used.',
    body: 'The account exists. Sign in with the email it was sent to, or use "forgot password" if you need to reset it.',
  },
  revoked: {
    heading: 'This invitation was withdrawn.',
    body: 'It may have been replaced by a newer link. Check for a more recent message from the studio.',
  },
  missing: {
    heading: 'We do not recognise this link.',
    body: 'Copy it again from the message you were sent — links break easily when they wrap across lines.',
  },
}

export default async function InvitePage({ params }: Props) {
  const { token } = await params

  // The `anon` role can read exactly one invitation, and only when it presents
  // that invitation's token. See `invitation_preview` in 031.
  const supabase = createPublicClient()
  const { data } = await supabase.rpc('invitation_preview', { p_token: token })
  const invitation = (data?.[0] ?? null) as Preview | null

  if (!invitation || invitation.status !== 'pending') {
    const copy = DEAD_END[invitation?.status ?? 'missing'] ?? DEAD_END.missing
    return (
      <div>
        <h1 className="display text-3xl">{copy.heading}</h1>
        <p className="mt-3 text-sm text-[var(--color-muted)]">{copy.body}</p>
        <div className="mt-10 flex flex-wrap gap-x-6 gap-y-3 text-sm">
          <Link
            href="/login"
            className="inline-flex min-h-11 items-center text-[var(--color-foreground)] underline underline-offset-4"
          >
            Sign in
          </Link>
          <Link
            href="/"
            className="inline-flex min-h-11 items-center text-[var(--color-muted)] underline underline-offset-4"
          >
            Back to the studio
          </Link>
        </div>
      </div>
    )
  }

  // A link opened in a browser that is already signed in as somebody else.
  // Common enough to be worth answering: a client forwards their link to the
  // studio for help, or the staff member who issued it clicks it to check.
  // Accepting still works — it makes the new account and signs the browser into
  // it — but that is a surprise unless it is said first, and if the invited
  // address is the one already signed in there is nothing here left to do.
  const session = await createClient()
  const {
    data: { user: signedIn },
  } = await session.auth.getUser()
  const signedInAsInvitee =
    !!signedIn?.email && signedIn.email.toLowerCase() === invitation.email.toLowerCase()

  const inviter = invitation.invited_by_name ?? '559 Flawless'
  const roleLabel = ROLE_LABELS[invitation.role].toLowerCase()
  const article = /^[aeiou]/.test(roleLabel) ? 'an' : 'a'

  return (
    <div>
      <p className="label-caps text-[var(--color-accent)]">You have been invited</p>
      <h1 className="display mt-3 text-3xl">
        {invitation.first_name ? `Welcome, ${invitation.first_name}.` : 'Set up your account.'}
      </h1>
      <p className="mt-3 text-sm text-[var(--color-muted)]">
        {inviter} invited{' '}
        <span className="text-[var(--color-foreground)]">{invitation.email}</span> to join 559
        Flawless as{' '}
        <span className="text-[var(--color-foreground)]">
          {article} {roleLabel}
        </span>
        .
      </p>

      {invitation.note && (
        <blockquote className="mt-6 border-l-2 border-[var(--color-accent)] bg-[var(--color-surface)] px-5 py-4 text-sm">
          <p className="italic text-[var(--color-foreground)]">{invitation.note}</p>
          <footer className="mt-2 text-xs text-[var(--color-muted)]">— {inviter}</footer>
        </blockquote>
      )}

      {signedInAsInvitee ? (
        <div className="mt-8 border-l-2 border-[var(--color-accent)] bg-[var(--color-surface)] px-5 py-4 text-sm">
          <p>
            You are already signed in as{' '}
            <span className="text-[var(--color-foreground)]">{signedIn?.email}</span>, so this
            account exists. There is nothing to set up.
          </p>
          <Link
            href="/account"
            className="mt-3 inline-flex min-h-11 items-center text-[var(--color-foreground)] underline underline-offset-4"
          >
            Go to your account
          </Link>
        </div>
      ) : (
        <>
          {signedIn && (
            <div className="mt-8 border-l-2 border-amber-600 bg-[var(--color-surface)] px-5 py-4 text-sm">
              <p>
                This browser is signed in as{' '}
                <span className="text-[var(--color-foreground)]">{signedIn.email}</span>. Setting
                up the account below signs you out of that one — the invitation is for{' '}
                <span className="text-[var(--color-foreground)]">{invitation.email}</span> and
                cannot be redirected to another address.
              </p>
            </div>
          )}

          <div className="mt-10">
            <InviteAcceptForm
              token={token}
              email={invitation.email}
              role={invitation.role}
              firstName={invitation.first_name}
              lastName={invitation.last_name}
              expiresAt={invitation.expires_at}
            />
          </div>
        </>
      )}

      <p className="mt-8 text-sm text-[var(--color-muted)]">
        Not you?{' '}
        <Link
          href="/"
          className="inline-flex min-h-11 items-center text-[var(--color-foreground)] underline underline-offset-4"
        >
          Close this page
        </Link>{' '}
        and let the studio know.
      </p>
    </div>
  )
}
