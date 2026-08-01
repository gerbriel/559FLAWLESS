'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { UserPlus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Field, Input, Textarea } from '@/components/ui/field'

/**
 * Add a client from the dashboard — the walk-in and phone-booking case.
 *
 * The account is created without a password; the client claims it later with a
 * sign-in link. Staff never have to invent a password and read it out.
 */
export function NewClientForm() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; clientId?: string | null } | null>(null)
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    pronouns: '',
    date_of_birth: '',
    notes: '',
    marketing_opt_in: false,
  })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    try {
      const res = await fetch('/api/admin/clients/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          phone: form.phone.trim() || null,
          pronouns: form.pronouns.trim() || null,
          date_of_birth: form.date_of_birth || null,
          notes: form.notes.trim() || null,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        setError({ message: data.message ?? 'Could not add that client.', clientId: data.clientId })
        return
      }

      toast.success(`${form.first_name} ${form.last_name} added.`)
      setOpen(false)
      router.push(`/dashboard/clients/${data.clientId}`)
    } catch {
      setError({ message: 'Could not reach the server. Please try again.' })
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        <UserPlus className="h-4 w-4" strokeWidth={1.75} />
        New client
      </Button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Add a client"
      onClick={() => !busy && setOpen(false)}
    >
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="relative my-8 w-full max-w-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 shadow-2xl sm:my-0 sm:p-8"
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          aria-label="Close"
        >
          <X className="h-5 w-5" strokeWidth={1.5} />
        </button>

        <h2 className="display pr-10 text-2xl">Add a client</h2>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          For walk-ins and phone bookings. They can claim the account later with a
          sign-in link — no password needed now.
        </p>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="First name" htmlFor="nc_first">
            <Input
              id="nc_first"
              required
              maxLength={80}
              autoComplete="off"
              value={form.first_name}
              onChange={(e) => setForm({ ...form, first_name: e.target.value })}
            />
          </Field>
          <Field label="Last name" htmlFor="nc_last">
            <Input
              id="nc_last"
              required
              maxLength={80}
              autoComplete="off"
              value={form.last_name}
              onChange={(e) => setForm({ ...form, last_name: e.target.value })}
            />
          </Field>

          <Field
            label="Email"
            htmlFor="nc_email"
            className="sm:col-span-2"
            hint="Required — confirmations and their sign-in link go here."
          >
            <Input
              id="nc_email"
              type="email"
              required
              maxLength={254}
              autoComplete="off"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>

          <Field label="Phone" htmlFor="nc_phone">
            <Input
              id="nc_phone"
              type="tel"
              maxLength={40}
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <Field label="Pronouns" htmlFor="nc_pronouns" hint="Optional.">
            <Input
              id="nc_pronouns"
              maxLength={40}
              value={form.pronouns}
              onChange={(e) => setForm({ ...form, pronouns: e.target.value })}
            />
          </Field>

          <Field
            label="Date of birth"
            htmlFor="nc_dob"
            className="sm:col-span-2"
            hint="Needed for services with an age minimum."
          >
            <Input
              id="nc_dob"
              type="date"
              value={form.date_of_birth}
              onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
            />
          </Field>

          <Field
            label="First note"
            htmlFor="nc_notes"
            className="sm:col-span-2"
            hint="Optional. Saved as a treatment note — not shown to the client."
          >
            <Textarea
              id="nc_notes"
              rows={3}
              maxLength={2000}
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </Field>
        </div>

        <label className="mt-4 flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={form.marketing_opt_in}
            onChange={(e) => setForm({ ...form, marketing_opt_in: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span className="text-[var(--color-muted)]">
            They agreed to marketing email. Only tick this if they actually said yes —
            it is recorded as consent with a timestamp.
          </span>
        </label>

        {error && (
          <div className="mt-5 border border-red-600/40 bg-red-50 p-4 text-sm text-red-800 dark:bg-transparent dark:text-red-400">
            {error.message}
            {error.clientId && (
              <Link
                href={`/dashboard/clients/${error.clientId}`}
                className="mt-2 block underline underline-offset-4"
              >
                Open their record
              </Link>
            )}
          </div>
        )}

        <div className="mt-7 flex flex-wrap gap-3">
          <Button type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add client'}
          </Button>
          <Button type="button" variant="subtle" onClick={() => setOpen(false)} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}
