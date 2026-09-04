'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { MessageSquare, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { pingEmailDispatch } from '@/lib/email-ping'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/field'

/**
 * Compose to a client from their record, without leaving it.
 *
 * The Message button used to link to the inbox filtered by this client —
 * which, for a client nobody had written to yet, was an empty list with no
 * way to start. This writes into their existing conversation when one is
 * open, and opens one when there is none, then lands the sender in the
 * thread. The client hears about it the way they hear about any reply: the
 * message trigger (006) marks the thread unread for them and rings their
 * bell.
 *
 * Front-desk gated by the caller, and by RLS either way: `staff posts
 * messages` is what actually admits the write.
 */
export function MessageClient({
  clientId,
  clientName,
  staffName,
}: {
  clientId: string
  clientName: string
  staffName: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)

  async function send() {
    if (!body.trim()) return
    setBusy(true)

    try {
      const supabase = createClient()
      const {
        data: { user },
      } = await supabase.auth.getUser()
      if (!user) {
        toast.error('You are signed out. Sign in and try again.')
        return
      }

      // Their live conversation, if one exists — a second thread for the same
      // person is how half a conversation goes unanswered.
      const { data: existing } = await supabase
        .from('message_threads')
        .select('id')
        .eq('client_id', clientId)
        .in('status', ['open', 'pending'])
        .order('last_message_at', { ascending: false })
        .limit(1)

      let threadId = existing?.[0]?.id ?? null

      if (!threadId) {
        const { data: thread, error: threadError } = await supabase
          .from('message_threads')
          .insert({
            subject: `Message from the studio`,
            client_id: clientId,
            status: 'open',
            assigned_to: user.id,
          })
          .select('id')
          .single()

        if (threadError || !thread) {
          toast.error('Could not start the conversation. Please try again.')
          return
        }
        threadId = thread.id
      }

      const { error: messageError } = await supabase.from('messages').insert({
        thread_id: threadId,
        sender_id: user.id,
        sender_name: staffName,
        body: body.trim(),
        is_internal: false,
      })

      if (messageError) {
        toast.error('Could not send that. Please try again.')
        return
      }

      pingEmailDispatch()
      toast.success(`Sent to ${clientName}.`)
      setBody('')
      setOpen(false)
      router.push(`/dashboard/messages/${threadId}`)
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <MessageSquare className="h-4 w-4" />
        Message
      </Button>
    )
  }

  return (
    <div
      data-ui="tile"
      className="w-full max-w-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="label-caps text-[var(--color-accent)]">Message {clientName}</p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          aria-label="Close"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
      <Textarea
        className="mt-3"
        rows={3}
        maxLength={4000}
        autoFocus
        placeholder="They see it in their account, with a notification."
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="mt-3 flex gap-2">
        <Button size="sm" disabled={busy || !body.trim()} onClick={send}>
          {busy ? 'Sending…' : 'Send'}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
