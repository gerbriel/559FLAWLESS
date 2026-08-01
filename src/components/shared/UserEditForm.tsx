'use client'

import { useState, useEffect } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { ROLE_LABELS, type UserRole, type Profile } from '@/types/database'

type UserListItem = Pick<
  Profile,
  'id' | 'first_name' | 'last_name' | 'email' | 'phone' | 'role' | 'suspended_at' | 'created_at'
>

const ROLE_PERMISSIONS: Record<UserRole, string[]> = {
  client: [
    'Book appointments',
    'Purchase products',
    'View own records',
    'Sign consent forms',
    'Send messages',
  ],
  provider: [
    'All client permissions',
    'Manage own calendar and availability',
    'Treat clients',
    'Write clinical notes',
    'Propose inventory changes',
    'View own appointments',
  ],
  front_desk: [
    'All client permissions',
    'Book appointments for others',
    'View all clients',
    'Handle messages',
    'View full calendar',
    'Process orders',
  ],
  manager: [
    'All front desk permissions',
    'Approve inventory changes',
    'View analytics',
    'Manage marketing content',
    'Moderate reviews',
    'Manage FAQs and content',
  ],
  admin: [
    'All manager permissions',
    'Manage users and roles',
    'Change pricing',
    'Edit booking policies',
    'Manage services',
    'Edit site settings',
    'View activity logs',
  ],
}

export function UserEditForm({
  user,
  onClose,
}: {
  user: UserListItem
  onClose: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    first_name: user.first_name ?? '',
    last_name: user.last_name ?? '',
    email: user.email ?? '',
    phone: user.phone ?? '',
    role: user.role,
  })
  const [isSuspended, setIsSuspended] = useState(!!user.suspended_at)
  const [showActivity, setShowActivity] = useState(false)
  const [activityLog, setActivityLog] = useState<any[]>([])

  // Defined inside the effect so it cannot go stale and needs no dep on a
  // function hoisted below it.
  useEffect(() => {
    if (!showActivity) return
    void loadActivityLog()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showActivity, user.id])

  async function loadActivityLog() {
    const supabase = createClient()
    const { data } = await supabase
      .from('user_activity_log')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .limit(20)

    setActivityLog(data ?? [])
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)

    // We need to use a server action to update user profiles with admin privileges
    try {
      const response = await fetch('/api/admin/users/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: user.id,
          updates: {
            first_name: form.first_name.trim() || null,
            last_name: form.last_name.trim() || null,
            email: form.email.trim() || null,
            phone: form.phone.trim() || null,
            role: form.role,
            suspended_at: isSuspended ? new Date().toISOString() : null,
          },
        }),
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to update user')
      }

      toast.success('User updated')
      onClose()
    } catch (error: any) {
      toast.error(error.message || 'Failed to update user')
    } finally {
      setBusy(false)
    }
  }

  async function sendPasswordReset() {
    if (!user.email) {
      toast.error('No email address on file')
      return
    }

    setBusy(true)
    try {
      const response = await fetch('/api/admin/users/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: user.email }),
      })

      if (!response.ok) throw new Error('Failed to send reset email')

      toast.success('Password reset email sent')
    } catch (error) {
      toast.error('Failed to send reset email')
    } finally {
      setBusy(false)
    }
  }

  const formatDate = (date: string) => {
    return new Date(date).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[90vh] w-full max-w-2xl overflow-y-auto bg-[var(--color-background)] p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="display text-2xl">Edit User</h2>
            <p className="mt-1 text-sm text-[var(--color-muted)]">
              User ID: <code className="text-xs">{user.id}</code>
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>

        <form onSubmit={save} className="mt-6 space-y-6">
          {/* Basic info */}
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="First name" htmlFor="first_name">
                <Input
                  id="first_name"
                  value={form.first_name}
                  onChange={(e) => setForm({ ...form, first_name: e.target.value })}
                />
              </Field>

              <Field label="Last name" htmlFor="last_name">
                <Input
                  id="last_name"
                  value={form.last_name}
                  onChange={(e) => setForm({ ...form, last_name: e.target.value })}
                />
              </Field>
            </div>

            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>

            <Field label="Phone" htmlFor="phone">
              <Input
                id="phone"
                type="tel"
                value={form.phone}
                onChange={(e) => setForm({ ...form, phone: e.target.value })}
              />
            </Field>
          </div>

          {/* Role and status */}
          <div className="space-y-4 border-t border-[var(--color-border)] pt-6">
            <Field
              label="Role"
              htmlFor="role"
              hint="Changing a role takes effect immediately"
            >
              <Select
                id="role"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
              >
                <option value="client">Client</option>
                <option value="provider">Provider</option>
                <option value="front_desk">Front Desk</option>
                <option value="manager">Manager</option>
                <option value="admin">Admin</option>
              </Select>
            </Field>

            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="suspended"
                checked={isSuspended}
                onChange={(e) => setIsSuspended(e.target.checked)}
                className="h-4 w-4"
              />
              <label htmlFor="suspended" className="text-sm">
                Suspend account (blocks login)
              </label>
            </div>
          </div>

          {/* Permissions display */}
          <div className="border-t border-[var(--color-border)] pt-6">
            <h3 className="text-sm font-medium">Permissions for {ROLE_LABELS[form.role]}</h3>
            <ul className="mt-3 space-y-2 text-sm">
              {ROLE_PERMISSIONS[form.role].map((perm, i) => (
                <li key={i} className="flex items-start gap-2">
                  <span className="text-green-600">✓</span>
                  <span>{perm}</span>
                </li>
              ))}
            </ul>
          </div>

          {/* Actions */}
          <div className="flex flex-wrap items-center gap-3 border-t border-[var(--color-border)] pt-6">
            <Button type="submit" disabled={busy}>
              {busy ? 'Saving...' : 'Save changes'}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={sendPasswordReset}
              disabled={busy || !user.email}
            >
              Send password reset
            </Button>
          </div>
        </form>

        {/* Activity log toggle */}
        <div className="mt-6 border-t border-[var(--color-border)] pt-6">
          <button
            onClick={() => setShowActivity(!showActivity)}
            className="text-sm font-medium text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            {showActivity ? '▼' : '▶'} Activity log
          </button>

          {showActivity && (
            <div className="mt-4 max-h-60 overflow-y-auto border border-[var(--color-border)] p-4">
              {activityLog.length === 0 ? (
                <p className="text-sm text-[var(--color-muted)]">No activity recorded</p>
              ) : (
                <ul className="space-y-2 text-xs">
                  {activityLog.map((log) => (
                    <li key={log.id} className="border-b border-[var(--color-border)] pb-2">
                      <div className="flex items-center justify-between">
                        <Badge tone="neutral" className="text-xs">
                          {log.action}
                        </Badge>
                        <span className="text-[var(--color-muted)]">
                          {formatDate(log.created_at)}
                        </span>
                      </div>
                      {Object.keys(log.details).length > 0 && (
                        <pre className="mt-1 text-[var(--color-muted)]">
                          {JSON.stringify(log.details, null, 2)}
                        </pre>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
