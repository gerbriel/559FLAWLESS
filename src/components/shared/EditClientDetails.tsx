'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'

interface ClientDetails {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  pronouns: string | null
  date_of_birth: string | null
}

/**
 * The contact line, and the pencil that fixes it.
 *
 * Renders exactly what the header used to say; for front desk and above the
 * line grows an edit affordance that swaps to a small form in place. Saving
 * goes through /api/admin/clients/update — never a direct profile write,
 * because the login email has to move together with the profile one.
 */
export function EditClientDetails({
  client,
  canEdit,
}: {
  client: ClientDetails
  canEdit: boolean
}) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    first_name: client.first_name ?? '',
    last_name: client.last_name ?? '',
    email: client.email ?? '',
    phone: client.phone ?? '',
    pronouns: client.pronouns ?? '',
    date_of_birth: client.date_of_birth ?? '',
  })

  if (!editing) {
    return (
      <p className="mt-2 flex flex-wrap items-center gap-x-1.5 text-sm text-[var(--color-muted)]">
        <span>
          {client.email ?? 'no email'}
          {client.phone && ` · ${client.phone}`}
          {client.pronouns && ` · ${client.pronouns}`}
        </span>
        {canEdit && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex min-h-8 items-center gap-1 underline underline-offset-4 hover:text-[var(--color-accent)]"
          >
            <Pencil className="h-3 w-3" strokeWidth={1.5} aria-hidden />
            Edit details
          </button>
        )}
      </p>
    )
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    try {
      const res = await fetch('/api/admin/clients/update', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: client.id,
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim() || null,
          email: form.email.trim(),
          phone: form.phone.trim() || null,
          pronouns: form.pronouns.trim() || null,
          date_of_birth: form.date_of_birth || null,
        }),
      })
      const data = (await res.json().catch(() => null)) as { message?: string } | null
      if (!res.ok) {
        toast.error(data?.message ?? 'Could not save those details.')
        return
      }
      toast.success('Details saved.')
      setEditing(false)
      router.refresh()
    } catch {
      toast.error('Could not reach the server. Nothing was saved.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      onSubmit={save}
      className="mt-4 grid max-w-xl gap-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5 sm:grid-cols-2"
    >
      <Field label="First name" htmlFor="ecd_first">
        <Input
          id="ecd_first"
          required
          value={form.first_name}
          onChange={(e) => setForm({ ...form, first_name: e.target.value })}
        />
      </Field>
      <Field label="Last name" htmlFor="ecd_last">
        <Input
          id="ecd_last"
          value={form.last_name}
          onChange={(e) => setForm({ ...form, last_name: e.target.value })}
        />
      </Field>
      <Field
        label="Email"
        htmlFor="ecd_email"
        hint="Changing it also changes how they sign in."
      >
        <Input
          id="ecd_email"
          type="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </Field>
      <Field label="Phone" htmlFor="ecd_phone">
        <Input
          id="ecd_phone"
          type="tel"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
      </Field>
      <Field label="Pronouns" htmlFor="ecd_pronouns" hint="Optional.">
        <Input
          id="ecd_pronouns"
          value={form.pronouns}
          onChange={(e) => setForm({ ...form, pronouns: e.target.value })}
        />
      </Field>
      <Field label="Date of birth" htmlFor="ecd_dob" hint="Optional.">
        <Input
          id="ecd_dob"
          type="date"
          value={form.date_of_birth}
          onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
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
