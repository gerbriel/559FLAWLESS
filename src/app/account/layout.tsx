import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Container } from '@/components/ui/section'
import { SignOutButton } from '@/components/layout/SignOutButton'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { AccountNav } from '@/components/layout/AccountNav'
import { isStaff } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function AccountLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  // The proxy already gates /account, but a layout that assumes a user without
  // checking is one refactor away from leaking someone else's page.
  if (!user) redirect('/login?next=/account')

  /*
    Two different counts, because they were one and it was the wrong one.

    The `notifications` count used to be handed to AccountNav and painted on the
    MESSAGES link — and /account/messages lists `message_threads`, not
    notifications. So every notification a client received bumped a badge that
    led to a page where the message was not, and the client area rendered no
    notification anywhere at all: NotificationBell was mounted only in the
    dashboard layout.

    That is not cosmetic while booking approval is on. "Your time is held" and
    "Your appointment is confirmed" (049) are written straight into
    `notifications`, and the seeded templates for booking_confirmation,
    appointment_reminder, intake_outstanding and patch_test_due all carry
    `opens_thread = false` (038), so they become bare notification rows too.
    Every one of those was unreadable by the person it was addressed to, which
    made "you will be notified as soon as it is confirmed" a promise the app
    could not keep — the one message the studio owner actually asked for.

    So the bell goes in the header, where the notifications are, and the nav
    badge counts the thing the page it sits on actually shows.
  */
  const [{ data: profile }, { count: unreadNotifications }, { count: unreadThreads }] =
    await Promise.all([
      supabase
        .from('profiles')
        .select('first_name, last_name, role')
        .eq('id', user.id)
        .maybeSingle(),
      supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('user_id', user.id)
        .is('read_at', null),
      supabase
        .from('message_threads')
        .select('id', { count: 'exact', head: true })
        .eq('client_id', user.id)
        .eq('client_unread', true),
    ])

  // The site header points its account icon here unconditionally, which is what
  // lets the public pages stay static. Staff get forwarded on from here.
  if (isStaff(profile?.role)) redirect('/dashboard')

  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-[var(--color-border)]">
        <Container>
          <div className="flex h-20 items-center justify-between">
            <Link href="/">
              <span className="display block text-2xl leading-none">559</span>
              <span className="label-caps block text-[0.625rem] text-[var(--color-accent)]">
                Flawless
              </span>
            </Link>
            <div className="flex items-center gap-6">
              <span className="hidden text-sm text-[var(--color-muted)] sm:block">
                {profile?.first_name} {profile?.last_name}
              </span>
              {/* Reads `notifications` under RLS ("read own notifications",
                  006), and every client-bound link written by 047/049 points
                  into /account/*, so the same component works on this side of
                  the login without a second implementation. */}
              <NotificationBell count={unreadNotifications ?? 0} />
              <SignOutButton />
            </div>
          </div>
        </Container>
      </header>

      <Container className="flex-1 py-12">
        <div className="grid gap-12 lg:grid-cols-[13rem_1fr]">
          <AccountNav unreadCount={unreadThreads ?? 0} />
          <div className="min-w-0">{children}</div>
        </div>
      </Container>
    </div>
  )
}
