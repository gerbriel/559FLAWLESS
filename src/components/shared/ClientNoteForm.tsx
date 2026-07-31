'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/field'

export function ClientNoteForm({
  clientId,
  appointmentId,
}: {
  clientId: string
  appointmentId?: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({ body: '', products: '', next: '' })

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (!form.body.trim()) return

    setBusy(true)
    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      setBusy(false)
      toast.error('Please sign in again.')
      return
    }

    // author_id must equal auth.uid() — the insert policy enforces it, so a
    // note can never be attributed to someone else.
    const { error } = await supabase.from('client_notes').insert({
      client_id: clientId,
      appointment_id: appointmentId ?? null,
      author_id: user.id,
      body: form.body.trim(),
      products_used: form.products.trim() || null,
      next_visit_plan: form.next.trim() || null,
    })

    setBusy(false)

    if (error) {
      toast.error('Could not save the note.')
      return
    }

    setForm({ body: '', products: '', next: '' })
    setOpen(false)
    toast.success('Note saved.')
    router.refresh()
  }

  if (!open) {
    return (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        Add a note
      </Button>
    )
  }

  return (
    <form
      onSubmit={save}
      className="space-y-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5"
    >
      <Field label="What happened" htmlFor="note_body">
        <Textarea
          id="note_body"
          required
          rows={4}
          maxLength={4000}
          value={form.body}
          onChange={(e) => setForm({ ...form, body: e.target.value })}
          placeholder="Skin condition on arrival, what you did, settings used, how they reacted."
        />
      </Field>

      <Field label="Products used" htmlFor="note_products">
        <Input
          id="note_products"
          maxLength={500}
          value={form.products}
          onChange={(e) => setForm({ ...form, products: e.target.value })}
        />
      </Field>

      <Field label="Plan for next visit" htmlFor="note_next">
        <Input
          id="note_next"
          maxLength={500}
          value={form.next}
          onChange={(e) => setForm({ ...form, next: e.target.value })}
        />
      </Field>

      <p className="text-xs text-[var(--color-muted)]">
        Clinical record — never shown to the client.
      </p>

      <div className="flex gap-3">
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Save note'}
        </Button>
        <Button type="button" size="sm" variant="subtle" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}
