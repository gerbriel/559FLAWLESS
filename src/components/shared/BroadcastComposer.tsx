'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Send, Mail, Users, Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Textarea, Select } from '@/components/ui/field'

export interface UnreachableSubscriber {
  email: string
  first_name: string | null
}

type Audience = 'subscribers' | 'clients'

/**
 * Write a newsletter and send it to everyone who can receive one here.
 *
 * "Here" is the point: recipients with an account get it in their in-app inbox,
 * which is already realtime, already tied to their client record, and already
 * the place a reply lands. Nobody has to be handed to an email provider.
 *
 * Subscribers with no account cannot be reached that way, so they are listed
 * plainly for a manual send rather than silently dropped from the count.
 */
export function BroadcastComposer({
  reachableCount,
  unreachable,
}: {
  reachableCount: number
  unreachable: UnreachableSubscriber[]
}) {
  const router = useRouter()
  const [subject, setSubject] = useState('')
  const [body, setBody] = useState('')
  const [audience, setAudience] = useState<Audience>('subscribers')
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState<{ sent: number; unreachable: number } | null>(null)
  const [copied, setCopied] = useState(false)

  async function send(e: React.FormEvent) {
    e.preventDefault()

    if (!subject.trim() || !body.trim()) {
      toast.error('A newsletter needs a subject and a message.')
      return
    }
    if (
      !confirm(
        `Send "${subject.trim()}" to ${reachableCount} ${
          reachableCount === 1 ? 'person' : 'people'
        }? This cannot be unsent.`
      )
    ) {
      return
    }

    setBusy(true)
    const { data, error } = await createClient().rpc('send_broadcast', {
      p_subject: subject.trim(),
      p_body: body.trim(),
      p_audience: audience,
    })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not send that.')
      return
    }

    const result = data as { sent: number; unreachable: number }
    setSent(result)
    setSubject('')
    setBody('')
    toast.success(`Sent to ${result.sent}.`)
    router.refresh()
  }

  async function copyEmails() {
    try {
      await navigator.clipboard.writeText(unreachable.map((u) => u.email).join(', '))
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error('Could not copy. Select the addresses and copy them by hand.')
    }
  }

  if (sent) {
    return (
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
        <div className="flex items-center gap-2.5">
          <Check className="h-5 w-5 text-emerald-600" strokeWidth={2.5} />
          <h2 className="display text-2xl">Sent</h2>
        </div>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          {sent.sent} {sent.sent === 1 ? 'person has' : 'people have'} it in their inbox
          here, and will see a notification next time they visit.
          {sent.unreachable > 0 &&
            ` ${sent.unreachable} more are on the list without an account — they need an email from you.`}
        </p>
        <Button className="mt-6" onClick={() => setSent(null)}>
          Write another
        </Button>
      </div>
    )
  }

  return (
    <div className="grid gap-8 lg:grid-cols-[1fr_20rem]">
      <form onSubmit={send} className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <div className="space-y-4">
          <Field label="Send to" htmlFor="bc_audience">
            <Select
              id="bc_audience"
              value={audience}
              onChange={(e) => setAudience(e.target.value as Audience)}
            >
              <option value="subscribers">Newsletter subscribers with an account</option>
              <option value="clients">Every client with an account</option>
            </Select>
          </Field>

          <Field
            label="Subject"
            htmlFor="bc_subject"
            hint="Shows as the conversation title in their inbox."
          >
            <Input
              id="bc_subject"
              required
              maxLength={160}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="A little something for October"
            />
          </Field>

          <Field
            label="Message"
            htmlFor="bc_body"
            hint="Plain text. They can reply, and it comes back as an ordinary conversation attached to their record."
          >
            <Textarea
              id="bc_body"
              required
              rows={12}
              maxLength={5000}
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </Field>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-4">
          <Button type="submit" disabled={busy || reachableCount === 0}>
            <Send className="h-4 w-4" strokeWidth={1.75} />
            {busy ? 'Sending…' : `Send to ${reachableCount}`}
          </Button>
          <span className="text-xs text-[var(--color-muted)]">
            Each person gets their own conversation — nobody sees anyone else.
          </span>
        </div>
      </form>

      <aside className="space-y-6">
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <p className="label-caps mb-3 flex items-center gap-2 text-[var(--color-accent)]">
            <Users className="h-3.5 w-3.5" strokeWidth={2} />
            Reachable here
          </p>
          <p className="text-3xl tabular-nums">{reachableCount}</p>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            They have an account, so the message lands in their inbox on the site.
          </p>
        </div>

        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <p className="label-caps mb-3 flex items-center gap-2 text-[var(--color-muted)]">
            <Mail className="h-3.5 w-3.5" strokeWidth={2} />
            Need an email
          </p>
          <p className="text-3xl tabular-nums">{unreachable.length}</p>
          <p className="mt-2 text-xs text-[var(--color-muted)]">
            On the newsletter list but no account yet, so there is nowhere in the app to
            deliver to. Email these by hand.
          </p>

          {unreachable.length > 0 && (
            <>
              <Button size="sm" variant="subtle" className="mt-4 w-full" onClick={copyEmails}>
                {copied ? (
                  <>
                    <Check className="h-4 w-4 text-emerald-600" strokeWidth={2.5} />
                    Copied
                  </>
                ) : (
                  'Copy all addresses'
                )}
              </Button>

              <ul className="mt-4 max-h-64 space-y-1.5 overflow-y-auto text-xs">
                {unreachable.map((u) => (
                  <li key={u.email} className="truncate text-[var(--color-muted)]">
                    {u.first_name ? `${u.first_name} · ` : ''}
                    {u.email}
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>

        <p className="text-xs text-[var(--color-muted)]">
          <Badge tone="neutral">Why not email everyone?</Badge>
          <span className="mt-2 block">
            Sending bulk email needs a provider, a verified domain, and unsubscribe
            handling that holds up legally. An in-app message needs none of that and is
            attached to the client&rsquo;s record. When you outgrow it, the subscriber
            list exports as CSV from the Newsletter view.
          </span>
        </p>
      </aside>
    </div>
  )
}
