'use client'

import { useState, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import type { SubscriberStatus } from '@/types/database'

type Subscriber = {
  id: number
  email: string
  first_name: string | null
  status: SubscriberStatus
  source: string | null
  client_id: string | null
  subscribed_at: string
  unsubscribed_at: string | null
  profiles: {
    first_name: string | null
    last_name: string | null
  } | null
}

export function NewsletterTable({ subscribers }: { subscribers: Subscriber[] }) {
  const router = useRouter()
  const [searchTerm, setSearchTerm] = useState('')
  const [statusFilter, setStatusFilter] = useState<string>('all')
  const [typeFilter, setTypeFilter] = useState<string>('all')
  const [busy, setBusy] = useState<number | null>(null)
  const [showAddForm, setShowAddForm] = useState(false)

  // Filter subscribers
  const filteredSubscribers = useMemo(() => {
    return subscribers.filter((sub) => {
      // Search filter
      if (searchTerm) {
        const term = searchTerm.toLowerCase()
        const email = sub.email.toLowerCase()
        const firstName = (sub.first_name ?? '').toLowerCase()
        const clientName = sub.profiles
          ? `${sub.profiles.first_name ?? ''} ${sub.profiles.last_name ?? ''}`.toLowerCase()
          : ''

        if (!email.includes(term) && !firstName.includes(term) && !clientName.includes(term)) {
          return false
        }
      }

      // Status filter
      if (statusFilter !== 'all' && sub.status !== statusFilter) return false

      // Type filter
      if (typeFilter === 'clients' && !sub.client_id) return false
      if (typeFilter === 'non-clients' && sub.client_id) return false

      return true
    })
  }, [subscribers, searchTerm, statusFilter, typeFilter])

  async function unsubscribe(subscriberId: number) {
    setBusy(subscriberId)
    try {
      const { error } = await createClient()
        .from('newsletter_subscribers')
        .update({ status: 'unsubscribed', unsubscribed_at: new Date().toISOString() })
        .eq('id', subscriberId)

      if (error) throw error

      toast.success('Subscriber unsubscribed')
      router.refresh()
    } catch (error) {
      toast.error('Failed to unsubscribe')
    } finally {
      setBusy(null)
    }
  }

  function exportToCSV() {
    const headers = ['Email', 'First Name', 'Status', 'Source', 'Client', 'Subscribed Date']
    const rows = filteredSubscribers.map((sub) => [
      sub.email,
      sub.first_name ?? '',
      sub.status,
      sub.source ?? '',
      sub.profiles
        ? `${sub.profiles.first_name ?? ''} ${sub.profiles.last_name ?? ''}`.trim()
        : '',
      new Date(sub.subscribed_at).toLocaleDateString(),
    ])

    const csv = [headers, ...rows].map((row) => row.map((cell) => `"${cell}"`).join(',')).join('\n')

    const blob = new Blob([csv], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `newsletter-subscribers-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  const formatDate = (date: string) => {
    return new Date(date).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    })
  }

  return (
    <div>
      {/* Filters */}
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Search" htmlFor="search" className="flex-1 min-w-[200px]">
          <Input
            id="search"
            type="text"
            placeholder="Email or name..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </Field>

        <Field label="Status" htmlFor="status-filter" className="min-w-[150px]">
          <Select
            id="status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="unsubscribed">Unsubscribed</option>
            <option value="bounced">Bounced</option>
          </Select>
        </Field>

        <Field label="Type" htmlFor="type-filter" className="min-w-[150px]">
          <Select
            id="type-filter"
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
          >
            <option value="all">All</option>
            <option value="clients">Clients</option>
            <option value="non-clients">Non-clients</option>
          </Select>
        </Field>

        <Button variant="outline" onClick={exportToCSV}>
          Export CSV
        </Button>

        <Button onClick={() => setShowAddForm(true)}>Add subscriber</Button>
      </div>

      {/* Results count */}
      <p className="mt-6 text-sm text-[var(--color-muted)]">
        {filteredSubscribers.length}{' '}
        {filteredSubscribers.length === 1 ? 'subscriber' : 'subscribers'}
      </p>

      {/* Subscriber table */}
      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left">
              <th className="pb-3 font-medium">Email</th>
              <th className="pb-3 font-medium">Name</th>
              <th className="pb-3 font-medium">Status</th>
              <th className="pb-3 font-medium">Source</th>
              <th className="pb-3 font-medium">Subscribed</th>
              <th className="pb-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {filteredSubscribers.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-8 text-center text-[var(--color-muted)]">
                  No subscribers found
                </td>
              </tr>
            ) : (
              filteredSubscribers.map((sub) => (
                <tr key={sub.id} className="hover:bg-[var(--color-surface)]">
                  <td className="py-3">{sub.email}</td>
                  <td className="py-3">
                    {sub.profiles ? (
                      <>
                        {sub.profiles.first_name} {sub.profiles.last_name}{' '}
                        <Badge tone="neutral" className="ml-2 text-xs">
                          Client
                        </Badge>
                      </>
                    ) : sub.first_name ? (
                      sub.first_name
                    ) : (
                      <span className="text-[var(--color-muted)]">—</span>
                    )}
                  </td>
                  <td className="py-3">
                    {sub.status === 'active' && <Badge tone="success">Active</Badge>}
                    {sub.status === 'unsubscribed' && (
                      <Badge tone="neutral">Unsubscribed</Badge>
                    )}
                    {sub.status === 'bounced' && <Badge tone="danger">Bounced</Badge>}
                  </td>
                  <td className="py-3 text-[var(--color-muted)]">{sub.source ?? '—'}</td>
                  <td className="py-3 text-[var(--color-muted)]">
                    {formatDate(sub.subscribed_at)}
                  </td>
                  <td className="py-3">
                    {sub.status === 'active' && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => unsubscribe(sub.id)}
                        disabled={busy === sub.id}
                      >
                        {busy === sub.id ? 'Removing...' : 'Unsubscribe'}
                      </Button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Add subscriber form */}
      {showAddForm && (
        <AddSubscriberForm
          onClose={() => {
            setShowAddForm(false)
            router.refresh()
          }}
        />
      )}
    </div>
  )
}

function AddSubscriberForm({ onClose }: { onClose: () => void }) {
  const [busy, setBusy] = useState(false)
  const [email, setEmail] = useState('')
  const [firstName, setFirstName] = useState('')

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)

    try {
      const { error } = await createClient().from('newsletter_subscribers').insert({
        email: email.trim(),
        first_name: firstName.trim() || null,
        source: 'manual',
        status: 'active',
      })

      if (error) throw error

      toast.success('Subscriber added')
      onClose()
    } catch (error: any) {
      if (error.code === '23505') {
        toast.error('This email is already subscribed')
      } else {
        toast.error('Failed to add subscriber')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto bg-[var(--color-background)] p-6 shadow-xl">
        <div className="flex items-start justify-between">
          <h2 className="display text-xl">Add subscriber</h2>
          <button
            onClick={onClose}
            className="text-[var(--color-muted)] hover:text-[var(--color-text)]"
          >
            ✕
          </button>
        </div>

        <form onSubmit={add} className="mt-6 space-y-4">
          <Field label="Email" htmlFor="email">
            <Input
              id="email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </Field>

          <Field label="First name (optional)" htmlFor="firstName">
            <Input
              id="firstName"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
            />
          </Field>

          <div className="flex gap-3 pt-4">
            <Button type="submit" disabled={busy}>
              {busy ? 'Adding...' : 'Add subscriber'}
            </Button>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
          </div>
        </form>
      </div>
    </div>
  )
}
