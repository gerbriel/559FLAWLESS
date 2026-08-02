'use client'

import { Fragment, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Select } from '@/components/ui/field'
import { ROLE_LABELS, type UserRole } from '@/types/database'
import {
  permissionState,
  stateToGranted,
  type Permission,
  type PermissionState,
} from '@/types/staff'

export type PermissionStaff = {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
  role: UserRole
  suspended_at: string | null
}

export type PermissionOverride = {
  profile_id: string
  permission: string
  granted: boolean
}

const STATE_LABELS: Record<PermissionState, string> = {
  default: 'Role default',
  allow: 'Allowed',
  deny: 'Denied',
}

function staffName(s: PermissionStaff): string {
  const name = s.display_name?.trim() || `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim()
  return name || 'Unnamed'
}

const cellKey = (profileId: string, permission: string) => `${profileId}:${permission}`

/**
 * Who may do what, one row per permission and one column per person.
 *
 * The role stays the baseline — the middle option in every cell is "whatever
 * this role gives" — and a grant or a denial is an exception recorded against
 * one person. Saving goes through `set_staff_permission`, which is the only
 * write path: the guard trigger behind it refuses a self-grant, refuses to
 * hand on manage_permissions or manage_staff to anyone but an admin, and
 * refuses anything the person making the change does not already hold. What is
 * hidden here is a convenience; what is refused there is the rule.
 */
export function PermissionMatrix({
  staff,
  permissions,
  roleDefaults,
  overrides,
}: {
  staff: PermissionStaff[]
  permissions: Permission[]
  /** permission key → the roles that hold it without anyone deciding anything. */
  roleDefaults: Record<string, UserRole[]>
  overrides: PermissionOverride[]
}) {
  const [cells, setCells] = useState<Record<string, PermissionState>>(() => {
    const initial: Record<string, PermissionState> = {}
    for (const o of overrides) {
      initial[cellKey(o.profile_id, o.permission)] = permissionState(o.granted)
    }
    return initial
  })
  const [busy, setBusy] = useState<string | null>(null)

  const editable = useMemo(() => staff.filter((s) => s.role !== 'admin'), [staff])
  const admins = useMemo(() => staff.filter((s) => s.role === 'admin'), [staff])

  const categories = useMemo(() => {
    const order: string[] = []
    const grouped = new Map<string, Permission[]>()
    for (const p of permissions) {
      if (!grouped.has(p.category)) {
        grouped.set(p.category, [])
        order.push(p.category)
      }
      grouped.get(p.category)!.push(p)
    }
    return order.map((name) => ({ name, items: grouped.get(name)! }))
  }, [permissions])

  const exceptionCount = (profileId: string) =>
    Object.entries(cells).filter(
      ([key, state]) => key.startsWith(`${profileId}:`) && state !== 'default'
    ).length

  async function change(person: PermissionStaff, permission: Permission, next: PermissionState) {
    const key = cellKey(person.id, permission.key)
    const previous = cells[key] ?? 'default'
    if (previous === next) return

    setCells((c) => ({ ...c, [key]: next }))
    setBusy(key)

    const { error } = await createClient().rpc('set_staff_permission', {
      p_profile: person.id,
      p_permission: permission.key,
      p_granted: stateToGranted(next),
    })

    setBusy(null)

    if (error) {
      setCells((c) => ({ ...c, [key]: previous }))
      toast.error(error.message || 'That change was refused.')
      return
    }

    toast.success(
      next === 'default'
        ? `${staffName(person)} is back to the ${ROLE_LABELS[person.role].toLowerCase()} default for ${permission.label.toLowerCase()}.`
        : `${permission.label} — ${STATE_LABELS[next].toLowerCase()} for ${staffName(person)}.`
    )
  }

  if (editable.length === 0) {
    return (
      <p className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
        Everyone on staff is an admin, and an admin already passes every check.
        There is nothing to tune until there is a provider, a front desk, or a
        manager to tune it for.
      </p>
    )
  }

  return (
    <div>
      {admins.length > 0 && (
        <p className="mb-8 border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-4 text-sm text-[var(--color-muted)] dark:bg-[var(--color-background)]">
          {admins.map(staffName).join(', ')}{' '}
          {admins.length === 1 ? 'is an admin and holds' : 'are admins and hold'}{' '}
          everything. That is not a setting — an admin passes every check in the
          database, so a box unticked here would hide a button without stopping
          anything. Change the role instead.
        </p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full min-w-3xl border-collapse text-sm">
          <thead>
            <tr className="border-y border-[var(--color-border)]">
              <th className="label-caps w-72 px-3 py-4 text-left align-bottom text-[var(--color-muted)]">
                Permission
              </th>
              {editable.map((s) => (
                <th key={s.id} className="w-44 px-3 py-4 text-left align-bottom">
                  <span className="block text-sm font-normal">{staffName(s)}</span>
                  <span className="label-caps mt-1 block text-[var(--color-muted)]">
                    {ROLE_LABELS[s.role]}
                  </span>
                  <span className="mt-2 flex flex-wrap gap-1.5">
                    {s.suspended_at && <Badge tone="danger" size="sm">Suspended</Badge>}
                    {exceptionCount(s.id) > 0 && (
                      <Badge tone="accent" size="sm">
                        {exceptionCount(s.id)} exception
                        {exceptionCount(s.id) === 1 ? '' : 's'}
                      </Badge>
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>

          <tbody>
            {categories.map((group) => (
              <Fragment key={group.name}>
                <tr>
                  <th
                    colSpan={editable.length + 1}
                    className="label-caps border-b border-[var(--color-border)] px-3 pb-2 pt-9 text-left text-[var(--color-accent)]"
                  >
                    {group.name}
                  </th>
                </tr>

                {group.items.map((p) => (
                  <tr key={p.key} className="border-b border-[var(--color-border)] align-top">
                    <th scope="row" className="px-3 py-4 text-left font-normal">
                      <span className="flex flex-wrap items-center gap-2">
                        {p.label}
                        {p.is_sensitive && <Badge tone="warning" size="sm">Admin only</Badge>}
                      </span>
                      <span className="mt-1 block max-w-xs text-xs text-[var(--color-muted)]">
                        {p.description}
                      </span>
                    </th>

                    {editable.map((s) => {
                      const key = cellKey(s.id, p.key)
                      const state = cells[key] ?? 'default'
                      const byRole = (roleDefaults[p.key] ?? []).includes(s.role)
                      const effective = state === 'default' ? byRole : state === 'allow'

                      return (
                        <td key={s.id} className="px-3 py-4">
                          <label className="sr-only" htmlFor={key}>
                            {p.label} for {staffName(s)}
                          </label>
                          <Select
                            id={key}
                            value={state}
                            disabled={busy === key}
                            onChange={(e) => change(s, p, e.target.value as PermissionState)}
                            className="min-h-9 py-1.5 text-xs sm:text-xs"
                          >
                            <option value="default">
                              Role default — {byRole ? 'yes' : 'no'}
                            </option>
                            <option value="allow">Allow</option>
                            <option value="deny">Deny</option>
                          </Select>
                          <span
                            className={`mt-1.5 block text-xs ${
                              effective
                                ? 'text-[var(--color-muted)]'
                                : 'text-[var(--color-muted)] line-through'
                            }`}
                          >
                            {effective ? 'Can' : 'Cannot'}
                          </span>
                        </td>
                      )
                    })}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-8 max-w-prose text-xs text-[var(--color-muted)]">
        Changing somebody&rsquo;s role clears their exceptions. A role is a
        statement about what a person does, and exceptions that outlive the job
        they were made for are how &ldquo;why can she see that?&rdquo; happens
        six months later.
      </p>
    </div>
  )
}
