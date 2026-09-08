'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Pencil } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/field'

interface StubDetails {
  id: number
  first_name: string
  last_name: string | null
  email: string | null
  phone: string | null
  note: string | null
}

/**
 * Fix what the old list got wrong — the misspelled name, the number that
 * changed, the email typo that would send an invitation nowhere.
 *
 * A direct write through the caller's own client: 051's "front desk writes
 * client stubs" policy is the authority, so there is no route to keep in step.
 * One thing this cannot do is recall an invitation already sent — the send box
 * says so, because a corrected email does nothing for a link that already went
 * to the wrong one.
 */
export function StubEditor({ stub }: { stub: StubDetails }) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    first_name: stub.first_name,
    last_name: stub.last_name ?? '',
    email: stub.email ?? '',
    phone: stub.phone ?? '',
    note: stub.note ?? '',
  })

  if (!editing) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
        <Pencil className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.5} aria-hidden />
        Edit their details
      </Button>
    )
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!form.first_name.trim()) {
      toast.error('A first name is the one thing a record has to have.')
      return
    }
    setBusy(true)
    const { error } = await createClient()
      .from('client_stubs')
      .update({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim() || null,
        email: form.email.trim().toLowerCase() || null,
        phone: form.phone.trim() || null,
        note: form.note.trim() || null,
      })
      .eq('id', stub.id)
    setBusy(false)

    if (error) {
      toast.error(
        /unique|duplicate/i.test(error.message)
          ? 'Another record on the list already has that email or phone.'
          : 'Could not save. Nothing was changed.'
      )
      return
    }
    toast.success('Details saved.')
    setEditing(false)
    router.refresh()
  }

  return (
    <form onSubmit={save} className="grid gap-4 sm:grid-cols-2">
      <Field label="First name" htmlFor="stub_first">
        <Input
          id="stub_first"
          required
          value={form.first_name}
          onChange={(e) => setForm({ ...form, first_name: e.target.value })}
        />
      </Field>
      <Field label="Last name" htmlFor="stub_last">
        <Input
          id="stub_last"
          value={form.last_name}
          onChange={(e) => setForm({ ...form, last_name: e.target.value })}
        />
      </Field>
      <Field
        label="Email"
        htmlFor="stub_email"
        hint="Fixing it does not recall an invitation already sent — send a fresh one."
      >
        <Input
          id="stub_email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </Field>
      <Field label="Phone" htmlFor="stub_phone">
        <Input
          id="stub_phone"
          type="tel"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
      </Field>
      <Field
        label="Note"
        htmlFor="stub_note"
        hint="From the old list — contact context only, never health information."
      >
        <Textarea
          id="stub_note"
          rows={3}
          maxLength={2000}
          value={form.note}
          onChange={(e) => setForm({ ...form, note: e.target.value })}
          className="sm:col-span-2"
        />
      </Field>
      <div className="flex gap-3 sm:col-span-2">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save details'}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="subtle"
          disabled={busy}
          onClick={() => setEditing(false)}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
