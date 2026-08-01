import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { UserManagementTable } from '@/components/shared/UserManagementTable'
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

      <div className="mt-8">
        <UserManagementTable users={users ?? []} />
      </div>
    </div>
  )
}
