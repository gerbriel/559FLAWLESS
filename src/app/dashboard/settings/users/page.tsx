import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { UserManagementTable } from '@/components/shared/UserManagementTable'
import { InviteManager, type InvitationRow } from '@/components/shared/InviteManager'
import { requestNow } from '@/lib/time'
import { isAdmin } from '@/types/database'

export const dynamic = 'force-dynamic'

export default async function UsersPage() {
  const supabase = await createClient()

  // Check authentication and authorization
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  // Only admins can access user management
  if (!profile || !isAdmin(profile.role)) {
    redirect('/dashboard')
  }

  // Fetch all users with aggregated data
  // We use the standard client here - RLS policies allow admins to read profiles
  const { data: users } = await supabase
    .from('profiles')
    .select('id, first_name, last_name, email, phone, role, suspended_at, created_at, updated_at')
    .order('created_at', { ascending: false })

  // `invitations` has three FKs to profiles (invited_by, accepted_by,
  // revoked_by), so the embed must name the constraint or PostgREST cannot tell
  // which one is meant. One literal, per the note in AGENTS.md.
  const { data: invitations } = await supabase
    .from('invitations')
    .select(
      'id, email, first_name, last_name, note, role, invited_by, expires_at, accepted_at, revoked_at, created_at, inviter:profiles!invitations_invited_by_fkey(first_name, last_name, display_name)'
    )
    .order('created_at', { ascending: false })
    .limit(200)

  return (
    <div>
      <div className="flex items-center justify-between">
        <div>
          <h1 className="display text-3xl">User Management</h1>
          <p className="mt-2 text-sm text-[var(--color-muted)]">
            Manage all users, roles, and permissions
          </p>
        </div>
      </div>

      <div className="mt-10 border-b border-[var(--color-border)] pb-10">
        <InviteManager
          invitations={(invitations ?? []) as unknown as InvitationRow[]}
          canInviteStaff
          now={requestNow()}
        />
      </div>

      <div className="mt-10">
        <h2 className="display text-2xl">Everyone</h2>
        <div className="mt-6">
          <UserManagementTable users={users ?? []} />
        </div>
      </div>
    </div>
  )
}
