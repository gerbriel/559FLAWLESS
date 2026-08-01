'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import { UserEditForm } from './UserEditForm'
import { ROLE_LABELS, type Profile } from '@/types/database'

type UserListItem = Pick<
  Profile,
  'id' | 'first_name' | 'last_name' | 'email' | 'phone' | 'role' | 'suspended_at' | 'created_at' | 'updated_at'
>

type TabKey = 'all' | 'staff' | 'clients'

export function UserManagementTable({ users }: { users: UserListItem[] }) {
  const router = useRouter()
  const [activeTab, setActiveTab] = useState<TabKey>('all')
  const [searchTerm, setSearchTerm] = useState('')
  const [roleFilter, setRoleFilter] = useState<string>('all')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [editingUser, setEditingUser] = useState<UserListItem | null>(null)

  // Filter users based on tab, search, role, and status
  const filteredUsers = useMemo(() => {
    return users.filter((user) => {
      // Tab filter
      if (activeTab === 'staff' && user.role === 'client') return false
      if (activeTab === 'clients' && user.role !== 'client') return false

      // Search filter
      if (searchTerm) {
        const term = searchTerm.toLowerCase()
        const fullName = `${user.first_name ?? ''} ${user.last_name ?? ''}`.toLowerCase()
        const email = (user.email ?? '').toLowerCase()
        const phone = (user.phone ?? '').toLowerCase()
        if (
          !fullName.includes(term) &&
          !email.includes(term) &&
          !phone.includes(term)
        ) {
          return false
        }
      }

      // Role filter
      if (roleFilter !== 'all' && user.role !== roleFilter) return false

      // Status filter
      if (statusFilter === 'active' && user.suspended_at) return false
      if (statusFilter === 'suspended' && !user.suspended_at) return false

      return true
    })
  }, [users, activeTab, searchTerm, roleFilter, statusFilter])

  // Stats for tabs
  const stats = useMemo(() => {
    const allActive = users.filter((u) => !u.suspended_at).length
    const staff = users.filter((u) => u.role !== 'client').length
    const clients = users.filter((u) => u.role === 'client').length
    return { all: allActive, staff, clients }
  }, [users])

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  return (
    <div>
      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--color-border)]">
        <TabButton
          active={activeTab === 'all'}
          onClick={() => setActiveTab('all')}
          label="All Users"
          count={stats.all}
        />
        <TabButton
          active={activeTab === 'staff'}
          onClick={() => setActiveTab('staff')}
          label="Staff"
          count={stats.staff}
        />
        <TabButton
          active={activeTab === 'clients'}
          onClick={() => setActiveTab('clients')}
          label="Clients"
          count={stats.clients}
        />
      </div>

      {/* Filters */}
      <div className="mt-6 flex flex-wrap items-end gap-4">
        <Field label="Search" htmlFor="search" className="flex-1 min-w-[200px]">
          <Input
            id="search"
            type="text"
            placeholder="Name, email, or phone..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </Field>

        <Field label="Role" htmlFor="role-filter" className="min-w-[150px]">
          <Select
            id="role-filter"
            value={roleFilter}
            onChange={(e) => setRoleFilter(e.target.value)}
          >
            <option value="all">All roles</option>
            <option value="client">Client</option>
            <option value="provider">Provider</option>
            <option value="front_desk">Front Desk</option>
            <option value="manager">Manager</option>
            <option value="admin">Admin</option>
          </Select>
        </Field>

        <Field label="Status" htmlFor="status-filter" className="min-w-[150px]">
          <Select
            id="status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="suspended">Suspended</option>
          </Select>
        </Field>
      </div>

      {/* Results count */}
      <p className="mt-6 text-sm text-[var(--color-muted)]">
        {filteredUsers.length} {filteredUsers.length === 1 ? 'user' : 'users'}
      </p>

      {/* User table */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left">
              <th className="pb-3 font-medium">Name</th>
              <th className="pb-3 font-medium">Email</th>
              <th className="pb-3 font-medium">Phone</th>
              <th className="pb-3 font-medium">Role</th>
              <th className="pb-3 font-medium">Status</th>
              <th className="pb-3 font-medium">Created</th>
              <th className="pb-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {filteredUsers.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-[var(--color-muted)]">
                  No users found
                </td>
              </tr>
            ) : (
              filteredUsers.map((user) => (
                <tr key={user.id} className="hover:bg-[var(--color-surface)]">
                  <td className="py-3">
                    {user.first_name || user.last_name
                      ? `${user.first_name ?? ''} ${user.last_name ?? ''}`.trim()
                      : '—'}
                  </td>
                  <td className="py-3">{user.email ?? '—'}</td>
                  <td className="py-3">{user.phone ?? '—'}</td>
                  <td className="py-3">
                    <Badge tone="neutral">{ROLE_LABELS[user.role]}</Badge>
                  </td>
                  <td className="py-3">
                    {user.suspended_at ? (
                      <Badge tone="danger">Suspended</Badge>
                    ) : (
                      <Badge tone="success">Active</Badge>
                    )}
                  </td>
                  <td className="py-3 text-[var(--color-muted)]">
                    {formatDate(user.created_at)}
                  </td>
                  <td className="py-3">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setEditingUser(user)}
                    >
                      Edit
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Edit modal */}
      {editingUser && (
        <UserEditForm
          user={editingUser}
          onClose={() => {
            setEditingUser(null)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function TabButton({
  active,
  onClick,
  label,
  count,
}: {
  active: boolean
  onClick: () => void
  label: string
  count: number
}) {
  return (
    <button
      onClick={onClick}
      className={`
        px-4 py-2 text-sm font-medium transition-colors
        ${
          active
            ? 'border-b-2 border-[var(--color-accent)] text-[var(--color-text)]'
            : 'text-[var(--color-muted)] hover:text-[var(--color-text)]'
        }
      `}
    >
      {label} <span className="ml-1.5 text-xs">({count})</span>
    </button>
  )
}
