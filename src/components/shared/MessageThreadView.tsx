'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/field'
import { cn } from '@/lib/utils'

export interface ThreadMessage {
  id: number
  body: string
  sender_id: string | null
  sender_name: string | null
  is_internal?: boolean
  created_at: string
}

export function MessageThreadView({
  threadId,
  currentUserId,
  initialMessages,
  asStaff = false,
  staffName,
}: {
  threadId: string
  currentUserId: string
  initialMessages: ThreadMessage[]
  asStaff?: boolean
  staffName?: string
}) {
  const router = useRouter()
  const [messages, setMessages] = useState(initialMessages)
  const [body, setBody] = useState('')
  const [internal, setInternal] = useState(false)
  const [busy, setBusy] = useState(false)
  const endRef = useRef<HTMLDivElement>(null)

  // Keep the view pinned to the newest message.
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  // Live updates: subscribe to inserts on this thread so a reply from the other
  // side appears without a manual refresh. RLS still applies to the realtime
  // stream, so a client never receives an internal note; we defensively filter
  // internal notes out of the client view here too.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`thread:${threadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `thread_id=eq.${threadId}`,
        },
        (payload) => {
          const m = payload.new as ThreadMessage
          if (!asStaff && m.is_internal) return
          setMessages((prev) =>
            prev.some((x) => x.id === m.id) ? prev : [...prev, m]
          )
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [threadId, asStaff])

  async function send(e: React.FormEvent) {
    e.preventDefault()
    if (!body.trim()) return

    setBusy(true)
    const supabase = createClient()

    const { data, error } = await supabase
      .from('messages')
      .insert({
        thread_id: threadId,
        sender_id: currentUserId,
        sender_name: staffName ?? null,
        body: body.trim(),
        is_internal: asStaff && internal,
      })
      .select('id, body, sender_id, sender_name, is_internal, created_at')
      .single()

    setBusy(false)

    if (error || !data) {
      toast.error('Could not send that. Please try again.')
      return
    }

    setMessages((m) => (m.some((x) => x.id === data.id) ? m : [...m, data]))
    setBody('')
    router.refresh()
  }

  return (
    <div>
      <ul className="space-y-5">
        {messages.map((m) => {
          const mine = m.sender_id === currentUserId
          return (
            <li
              key={m.id}
              className={cn('flex', mine ? 'justify-end' : 'justify-start')}
            >
              <div
                className={cn(
                  'max-w-[85%] border px-5 py-4',
                  mine
                    ? 'border-[var(--color-accent)] bg-[var(--color-clay-soft)] dark:bg-[var(--color-surface)]'
                    : 'border-[var(--color-border)] bg-[var(--color-surface)]'
                )}
              >
                <p className="label-caps mb-2 text-[var(--color-muted)]">
                  {mine ? 'You' : (m.sender_name ?? '559 Flawless')}
                  {' · '}
                  {new Date(m.created_at).toLocaleString('en-US', {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit',
                  })}
                </p>
                <p className="whitespace-pre-line text-sm leading-relaxed">{m.body}</p>
              </div>
            </li>
          )
        })}
      </ul>

      <div ref={endRef} />

      <form onSubmit={send} className="mt-8">
        <Textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={4000}
          rows={4}
          placeholder="Write a reply…"
          aria-label="Your reply"
        />

        {asStaff && (
          <label className="mt-3 flex cursor-pointer items-center gap-2.5 text-sm text-[var(--color-muted)]">
            <input
              type="checkbox"
              checked={internal}
              onChange={(e) => setInternal(e.target.checked)}
              className="h-4 w-4 accent-[var(--color-accent)]"
            />
            Internal note — not visible to the client
          </label>
        )}

        <Button type="submit" className="mt-4" disabled={busy || !body.trim()}>
          {busy ? 'Sending…' : internal ? 'Save note' : 'Send'}
        </Button>
      </form>
    </div>
  )
}
