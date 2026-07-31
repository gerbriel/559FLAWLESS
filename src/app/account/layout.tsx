import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Container } from '@/components/ui/section'
import { SignOutButton } from '@/components/layout/SignOutButton'
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

  const [{ data: profile }, { count: unread }] = await Promise.all([
    supabase.from('profiles').select('first_name, last_name, role').eq('id', user.id).maybeSingle(),
    supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('read_at', null),
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
              <SignOutButton />
            </div>
          </div>
        </Container>
      </header>

      <Container className="flex-1 py-12">
        <div className="grid gap-12 lg:grid-cols-[13rem_1fr]">
          <AccountNav unreadCount={unread ?? 0} />
          <div className="min-w-0">{children}</div>
        </div>
      </Container>
    </div>
  )
}
