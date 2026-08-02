import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import {
  PermissionMatrix,
  type PermissionOverride,
  type PermissionStaff,
} from '@/components/shared/PermissionMatrix'
import { isAdmin, type UserRole } from '@/types/database'
import type { Permission } from '@/types/staff'

export const dynamic = 'force-dynamic'

/**
 * Permissions — admin only.
 *
 * The redirect is a courtesy, not the boundary: `staff_permissions` is behind
 * RLS and the guard trigger in 034, so a manager who typed this URL would see
 * an empty matrix and be refused on every save. The check here is so she gets
 * sent somewhere useful instead of staring at one.
 */
export default async function PermissionsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || !isAdmin(profile.role)) redirect('/dashboard')

  const [{ data: staff }, { data: permissions }, { data: defaults }, { data: overrides }] =
    await Promise.all([
      supabase
        .from('profiles')
        .select('id, first_name, last_name, display_name, role, suspended_at')
        .neq('role', 'client')
        .order('role')
        .order('first_name'),
      supabase
        .from('permissions')
        .select('key, label, description, category, is_sensitive, sort_order')
        .order('sort_order'),
      supabase.from('role_permissions').select('role, permission'),
      supabase.from('staff_permissions').select('profile_id, permission, granted'),
    ])

  // permission key → the roles that hold it by default, which is what the
  // middle option in every cell of the matrix is describing.
  const roleDefaults: Record<string, UserRole[]> = {}
  for (const row of defaults ?? []) {
    ;(roleDefaults[row.permission] ??= []).push(row.role as UserRole)
  }

  const exceptions = (overrides ?? []).length

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="display text-3xl">Permissions</h1>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            Roles are the starting point, not the ceiling. Everyone gets what
            their role gives them; anything set here is an exception recorded
            against one person, and it holds until you change it or change their
            role.
          </p>
        </div>
        <Link href="/dashboard/settings">
          <Button variant="outline" size="sm">
            Back to settings
          </Button>
        </Link>
      </div>

      {(permissions?.length ?? 0) === 0 ? (
        <p className="mt-10 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
          No permissions catalogue — run migration 034.
        </p>
      ) : (
        <>
          <p className="label-caps mt-10 text-[var(--color-muted)]">
            {exceptions === 0
              ? 'Everyone is on their role default'
              : `${exceptions} exception${exceptions === 1 ? '' : 's'} across the studio`}
          </p>

          <div className="mt-6">
            <PermissionMatrix
              staff={(staff ?? []) as PermissionStaff[]}
              permissions={(permissions ?? []) as Permission[]}
              roleDefaults={roleDefaults}
              overrides={(overrides ?? []) as PermissionOverride[]}
            />
          </div>
        </>
      )}
    </div>
  )
}
