'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Textarea, Field, Select } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { createClient } from '@/lib/supabase/client'
import { initials } from '@/lib/utils'
import { Send, Users, AlertTriangle } from 'lucide-react'

interface Client {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
}

interface Props {
  allClients: Client[]
  abandonedClients: Client[]
  senderName: string
  senderId: string
}

export function BroadcastMessageForm({ allClients, abandonedClients, senderName, senderId }: Props) {
  const router = useRouter()
  const [recipientType, setRecipientType] = useState<'all' | 'abandoned' | 'custom'>('all')
  const [selectedClients, setSelectedClients] = useState<Set<string>>(new Set())
  const [subject, setSubject] = useState('')
  const [message, setMessage] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const getRecipients = () => {
    switch (recipientType) {
      case 'all':
        return allClients
      case 'abandoned':
        return abandonedClients
      case 'custom':
        return allClients.filter(c => selectedClients.has(c.id))
      default:
        return []
    }
  }

  const recipients = getRecipients()

  const toggleClient = (clientId: string) => {
    const newSet = new Set(selectedClients)
    if (newSet.has(clientId)) {
      newSet.delete(clientId)
    } else {
      newSet.add(clientId)
    }
    setSelectedClients(newSet)
  }

  const handleSelectAll = () => {
    if (selectedClients.size === allClients.length) {
      setSelectedClients(new Set())
    } else {
      setSelectedClients(new Set(allClients.map(c => c.id)))
    }
  }

  const filteredClients = allClients.filter(c => {
    if (!searchTerm.trim()) return true
    const term = searchTerm.toLowerCase()
    return (
      c.first_name?.toLowerCase().includes(term) ||
      c.last_name?.toLowerCase().includes(term) ||
      c.email?.toLowerCase().includes(term)
    )
  })

  const handleSend = async () => {
    if (!subject.trim() || !message.trim()) {
      setError('Subject and message are required')
      return
    }

    if (recipients.length === 0) {
      setError('No recipients selected')
      return
    }

    if (!confirm(`Send this message to ${recipients.length} client${recipients.length > 1 ? 's' : ''}?`)) {
      return
    }

    setLoading(true)
    setError(null)
    setSuccess(false)

    try {
      const supabase = createClient()

      // Create individual thread + message for each recipient
      for (const client of recipients) {
        // Create thread
        const { data: thread, error: threadError } = await supabase
          .from('message_threads')
          .insert({
            subject: subject.trim(),
            client_id: client.id,
            status: 'open',
            client_unread: true,
            staff_unread: false,
          })
          .select('id')
          .single()

        if (threadError) throw threadError

        // Create message
        const { error: messageError } = await supabase
          .from('messages')
          .insert({
            thread_id: thread.id,
            sender_id: senderId,
            sender_name: senderName,
            body: message.trim(),
            is_internal: false,
          })

        if (messageError) throw messageError

        // Create notification for client
        await supabase
          .from('notifications')
          .insert({
            user_id: client.id,
            type: 'message',
            title: `New message: ${subject.trim()}`,
            body: message.trim().slice(0, 100),
            link: `/account/messages/${thread.id}`,
            thread_id: thread.id,
          })
      }

      setSuccess(true)
      setSubject('')
      setMessage('')
      setRecipientType('all')
      setSelectedClients(new Set())

      setTimeout(() => {
        router.push('/dashboard/messages')
      }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send messages')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Recipient Selection */}
      <Card>
        <CardHeader>
          <CardTitle>1. Select Recipients</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Recipient Group" htmlFor="recipient-type">
            <Select
              id="recipient-type"
              value={recipientType}
              onChange={(e) => setRecipientType(e.target.value as any)}
            >
              <option value="all">All Clients ({allClients.length})</option>
              <option value="abandoned">Clients with Abandoned Bookings ({abandonedClients.length})</option>
              <option value="custom">Custom Selection</option>
            </Select>
          </Field>

          {recipientType === 'custom' && (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <Input
                  type="search"
                  placeholder="Search clients..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleSelectAll}
                >
                  {selectedClients.size === allClients.length ? 'Deselect All' : 'Select All'}
                </Button>
              </div>

              <div className="max-h-96 space-y-1 overflow-y-auto border border-[var(--color-border)] p-3">
                {filteredClients.map((client) => (
                  <label
                    key={client.id}
                    className="flex items-center gap-3 rounded px-2 py-2 hover:bg-[var(--color-surface)]"
                  >
                    <input
                      type="checkbox"
                      checked={selectedClients.has(client.id)}
                      onChange={() => toggleClient(client.id)}
                    />
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--color-border)] text-xs">
                      {initials(client.first_name, client.last_name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm">
                        {client.first_name} {client.last_name}
                      </p>
                      <p className="text-xs text-[var(--color-muted)]">{client.email}</p>
                    </div>
                  </label>
                ))}
              </div>

              <p className="text-sm text-[var(--color-muted)]">
                {selectedClients.size} client{selectedClients.size !== 1 ? 's' : ''} selected
              </p>
            </div>
          )}

          {recipients.length > 0 && (
            <div className="flex items-center gap-2 border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm">
              <Users className="h-4 w-4 text-[var(--color-accent)]" />
              <span>
                This message will be sent to <strong>{recipients.length}</strong> client{recipients.length !== 1 ? 's' : ''}
              </span>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Message Composition */}
      <Card>
        <CardHeader>
          <CardTitle>2. Compose Message</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Field label="Subject" htmlFor="subject">
            <Input
              id="subject"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g., Special Offer, Appointment Reminder"
              required
            />
          </Field>

          <Field label="Message" htmlFor="message">
            <Textarea
              id="message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={8}
              placeholder="Your message to clients..."
              required
            />
          </Field>

          <div className="border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
              <div>
                <p className="font-medium">Individual Threads</p>
                <p className="mt-1 text-[var(--color-muted)]">
                  Each client will receive this message in their own private thread.
                  Messages are not sent as a group — each conversation is separate.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Preview & Send */}
      {subject && message && (
        <Card>
          <CardHeader>
            <CardTitle>3. Preview & Send</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
              <p className="label-caps mb-2 text-[var(--color-muted)]">Preview</p>
              <p className="font-medium">{subject}</p>
              <p className="mt-3 whitespace-pre-line text-sm">{message}</p>
            </div>

            <div className="flex items-center gap-2 text-sm text-[var(--color-muted)]">
              <span>From: {senderName}</span>
              <span>·</span>
              <span>To: {recipients.length} recipient{recipients.length !== 1 ? 's' : ''}</span>
            </div>

            {error && (
              <p className="text-sm text-red-600">{error}</p>
            )}

            {success && (
              <div className="flex items-center gap-2 text-sm text-green-600">
                <Badge tone="success">Success</Badge>
                <span>Messages sent! Redirecting...</span>
              </div>
            )}

            <div className="flex gap-3 border-t border-[var(--color-border)] pt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => router.back()}
                disabled={loading}
              >
                Cancel
              </Button>
              <Button onClick={handleSend} disabled={loading || recipients.length === 0}>
                <Send className="h-4 w-4" />
                {loading ? 'Sending...' : `Send to ${recipients.length} Client${recipients.length !== 1 ? 's' : ''}`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
