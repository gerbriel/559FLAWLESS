'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea, Select } from '@/components/ui/field'
import { SignedInAs, backfillProfile } from '@/components/shared/SignedInIdentity'
import { cn } from '@/lib/utils'

const SUBJECTS = [
  'General question',
  'Booking help',
  'Consultation request',
  'Product question',
  'Something else',
]

/**
 * Who we already know the sender to be. Built by the server parent, and only
 * when there is an email to go with it — a signed-in account we cannot reach is
 * no better than an anonymous one, so that case falls back to asking.
 */
export interface ContactIdentity {
  userId: string
  firstName: string | null
  lastName: string | null
  email: string
  phone: string | null
}

/**
 * Opens a message thread. Anonymous visitors can insert a thread and its first
 * message under the public policies; the SECURITY DEFINER triggers then match
 * the thread to an existing client record and notify the front desk.
 *
 * This is also the client's own "new message" composer — /account/messages
 * links here — so a signed-in client is not asked for a name and an email the
 * studio already holds. The subject and the message stay: they are new every
 * time, which is the whole point of writing in.
 */
export function ContactForm({
  presetSubject,
  identity,
}: {
  presetSubject?: string
  identity?: ContactIdentity | null
}) {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [form, setForm] = useState({
    name: identity ? [identity.firstName, identity.lastName].filter(Boolean).join(' ').trim() : '',
    email: identity?.email ?? '',
    phone: identity?.phone ?? '',
    subject: presetSubject ? `Consultation request — ${presetSubject}` : SUBJECTS[0],
    message: '',
  })

  // A number is how the studio calls someone back, so it is still collected —
  // but only from people whose number we do not already have.
  const askPhone = !identity?.phone

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)

    const supabase = createClient()

    // A signed-in client must own the thread and sign their message, or RLS
    // rejects the insert: the anonymous "guest posts first message" policy only
    // applies to the `anon` role, and the client policy requires
    // sender_id = auth.uid(). Anonymous visitors leave both null and are matched
    // to a client record by the SECURITY DEFINER trigger instead.
    //
    // Read from the session rather than the `identity` prop: the prop is what we
    // rendered with, the session is what the insert will actually be judged by.
    const {
      data: { user },
    } = await supabase.auth.getUser()

    const { data: thread, error: threadError } = await supabase
      .from('message_threads')
      .insert({
        subject: form.subject,
        client_id: user?.id ?? null,
        // Still denormalized onto the thread even when we know the client:
        // it is what the inbox and the staff notification read. Null rather
        // than empty when an account has no name on it yet — the trigger
        // coalesces null to something readable, but not ''.
        guest_name: form.name.trim() || null,
        guest_email: form.email.trim().toLowerCase(),
        guest_phone: form.phone.trim() || null,
      })
      .select('id')
      .single()

    if (threadError || !thread) {
      setBusy(false)
      toast.error('We could not send that. Please try again or call us.')
      return
    }

    const { error: messageError } = await supabase.from('messages').insert({
      thread_id: thread.id,
      sender_id: user?.id ?? null,
      sender_name: form.name.trim() || null,
      body: form.message.trim(),
    })

    if (messageError) {
      setBusy(false)
      toast.error('We could not send that. Please try again or call us.')
      return
    }

    // They gave us a number we did not hold — keep it, so the next form does
    // not ask for it again.
    if (identity && askPhone) {
      await backfillProfile(identity.userId, { phone: form.phone })
    }

    setBusy(false)
    setSent(true)
  }

  if (sent) {
    return (
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-10 text-center">
        <div className="mx-auto flex h-12 w-12 items-center justify-center border border-[var(--color-accent)]">
          <Check className="h-5 w-5 text-[var(--color-accent)]" strokeWidth={1.5} />
        </div>
        <p className="display mt-6 text-2xl">Message sent.</p>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          We usually reply within one business day. If it is urgent, please call.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      {identity && (
        <SignedInAs
          label="Sending as"
          name={form.name}
          email={identity.email}
          href="/account/settings"
        />
      )}

      <div className="grid gap-5 sm:grid-cols-2">
        {!identity && (
          <>
            <Field label="Name" htmlFor="name">
              <Input
                id="name"
                required
                maxLength={120}
                value={form.name}
                onChange={(e) => setForm({ ...form, name: e.target.value })}
              />
            </Field>
            <Field label="Email" htmlFor="email">
              <Input
                id="email"
                type="email"
                required
                maxLength={254}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>
          </>
        )}

        {askPhone && (
          <Field
            label="Phone"
            htmlFor="phone"
            hint={
              identity
                ? 'Optional. We will keep it on your account so you are not asked again.'
                : 'Optional.'
            }
          >
            <Input
              id="phone"
              type="tel"
              maxLength={40}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
        )}

        <Field
          label="Subject"
          htmlFor="subject"
          className={cn(identity && !askPhone && 'sm:col-span-2')}
        >
          <Select
            id="subject"
            value={form.subject}
            onChange={(e) => setForm({ ...form, subject: e.target.value })}
          >
            {presetSubject && <option>{form.subject}</option>}
            {SUBJECTS.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        </Field>
      </div>

      <Field label="Message" htmlFor="message">
        <Textarea
          id="message"
          required
          maxLength={4000}
          rows={6}
          value={form.message}
          onChange={(e) => setForm({ ...form, message: e.target.value })}
          placeholder="Tell us what is going on with your skin, or what you would like to book."
        />
      </Field>

      <p className="text-xs leading-relaxed text-[var(--color-muted)]">
        Please do not include detailed medical information here. You will complete a
        secure health form before your appointment.
      </p>

      <Button type="submit" size="lg" disabled={busy}>
        {busy ? 'Sending…' : 'Send message'}
      </Button>
    </form>
  )
}
