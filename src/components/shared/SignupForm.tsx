'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'

const MIN_PASSWORD = 8

export function SignupForm() {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [needsConfirmation, setNeedsConfirmation] = useState(false)
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    email: '',
    phone: '',
    password: '',
    marketing: false,
  })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (form.password.length < MIN_PASSWORD) {
      setError(`Please use at least ${MIN_PASSWORD} characters.`)
      return
    }

    setBusy(true)
    const supabase = createClient()

    const { data, error: signUpError } = await supabase.auth.signUp({
      email: form.email.trim().toLowerCase(),
      password: form.password,
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback`,
        // Picked up by the handle_new_user trigger to seed the profile row.
        data: {
          first_name: form.first_name.trim(),
          last_name: form.last_name.trim(),
          phone: form.phone.trim() || null,
        },
      },
    })

    setBusy(false)

    if (signUpError) {
      setError(signUpError.message)
      return
    }

    // No session means the project requires email confirmation.
    if (!data.session) {
      setNeedsConfirmation(true)
      return
    }

    if (form.marketing) {
      await supabase
        .from('profiles')
        .update({ marketing_opt_in: true })
        .eq('id', data.user!.id)
    }

    router.push('/account')
    router.refresh()
  }

  if (needsConfirmation) {
    return (
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-center">
        <p className="display text-2xl">Check your email.</p>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          We sent a confirmation link to {form.email}. Click it and you are in.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="First name" htmlFor="su_first">
          <Input
            id="su_first"
            required
            maxLength={80}
            autoComplete="given-name"
            value={form.first_name}
            onChange={(e) => setForm({ ...form, first_name: e.target.value })}
          />
        </Field>
        <Field label="Last name" htmlFor="su_last">
          <Input
            id="su_last"
            required
            maxLength={80}
            autoComplete="family-name"
            value={form.last_name}
            onChange={(e) => setForm({ ...form, last_name: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Email" htmlFor="su_email">
        <Input
          id="su_email"
          type="email"
          required
          maxLength={254}
          autoComplete="email"
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
        />
      </Field>

      <Field label="Phone" htmlFor="su_phone" hint="For appointment reminders.">
        <Input
          id="su_phone"
          type="tel"
          maxLength={40}
          autoComplete="tel"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
      </Field>

      <Field
        label="Password"
        htmlFor="su_password"
        hint={`At least ${MIN_PASSWORD} characters.`}
      >
        <Input
          id="su_password"
          type="password"
          required
          minLength={MIN_PASSWORD}
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
      </Field>

      <label className="flex cursor-pointer items-start gap-3 text-sm text-[var(--color-muted)]">
        <input
          type="checkbox"
          checked={form.marketing}
          onChange={(e) => setForm({ ...form, marketing: e.target.checked })}
          className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
        />
        <span>Email me occasional offers and skincare tips. No more than monthly.</span>
      </label>

      {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}

      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  )
}
