import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { DashboardNav } from '@/components/layout/DashboardNav'
import { SignOutButton } from '@/components/layout/SignOutButton'
import { NotificationBell } from '@/components/layout/NotificationBell'
import { LocationSwitcher } from '@/components/layout/LocationSwitcher'
import { isStaff, ROLE_LABELS, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) redirect('/login?next=/dashboard')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, first_name, display_name, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  // Middleware bounces clients already; this is the second lock on the door.
  if (!profile || !isStaff(profile.role) || profile.suspended_at) {
    redirect('/account')
  }

  const role = profile.role as UserRole

  const [{ count: unreadNotifications }, { count: unreadThreads }] = await Promise.all([
    supabase
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .eq('user_id', user.id)
      .is('read_at', null),
    supabase
      .from('message_threads')
      .select('id', { count: 'exact', head: true })
      .eq('staff_unread', true)
      .neq('status', 'archived'),
  ])

  return (
    <div className="flex min-h-screen flex-col">
      <header className="sticky top-0 z-30 border-b border-[var(--color-border)] bg-[var(--color-background)]">
        <div className="flex h-16 items-center justify-between gap-6 px-6">
          <div className="flex items-center gap-8">
            <Link href="/dashboard" className="flex items-baseline gap-2">
              <span className="display text-xl leading-none">559</span>
              <span className="label-caps text-[0.5625rem] text-[var(--color-accent)]">
                Studio
              </span>
            </Link>
            <span className="label-caps hidden text-[var(--color-muted)] sm:block">
              {ROLE_LABELS[role]}
            </span>
          </div>

          <div className="flex items-center gap-5">
            {/* Renders nothing at all while there is one studio. */}
            <LocationSwitcher />
            <NotificationBell count={unreadNotifications ?? 0} />
            <Link
              href="/"
              className="label-caps hidden text-[var(--color-muted)] hover:text-[var(--color-accent)] sm:block"
            >
              View site
            </Link>
            <SignOutButton />
          </div>
        </div>
      </header>

      <div className="flex flex-1 flex-col lg:flex-row">
        <DashboardNav role={role} unreadThreads={unreadThreads ?? 0} />
        <main className="min-w-0 flex-1 px-6 py-10 lg:px-10">{children}</main>
      </div>
    </div>
  )
}
