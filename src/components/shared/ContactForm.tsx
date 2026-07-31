'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea, Select } from '@/components/ui/field'

const SUBJECTS = [
  'General question',
  'Booking help',
  'Consultation request',
  'Product question',
  'Something else',
]

/**
 * Opens a message thread. Anonymous visitors can insert a thread and its first
 * message under the public policies; the SECURITY DEFINER triggers then match
 * the thread to an existing client record and notify the front desk.
 */
export function ContactForm({ presetSubject }: { presetSubject?: string }) {
  const [busy, setBusy] = useState(false)
  const [sent, setSent] = useState(false)
  const [form, setForm] = useState({
    name: '',
    email: '',
    phone: '',
    subject: presetSubject ? `Consultation request — ${presetSubject}` : SUBJECTS[0],
    message: '',
  })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)

    const supabase = createClient()

    const { data: thread, error: threadError } = await supabase
      .from('message_threads')
      .insert({
        subject: form.subject,
        guest_name: form.name.trim(),
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
      sender_name: form.name.trim(),
      body: form.message.trim(),
    })

    setBusy(false)

    if (messageError) {
      toast.error('We could not send that. Please try again or call us.')
      return
    }

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
      <div className="grid gap-5 sm:grid-cols-2">
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
        <Field label="Phone" htmlFor="phone" hint="Optional.">
          <Input
            id="phone"
            type="tel"
            maxLength={40}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </Field>
        <Field label="Subject" htmlFor="subject">
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
