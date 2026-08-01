'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
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
    marketing: true,  // Pre-checked per requirements
    terms: false,     // NOT pre-checked - required explicit consent
  })

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError(null)

    if (!form.terms) {
      setError('Please accept the Terms of Service to continue.')
      return
    }

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

    // Consent is stamped server-side, where the request's own IP is already
    // available. The browser used to fetch it from api.ipify.org, which handed
    // every new client's address to a third party to learn something we
    // already knew — and made signing up depend on their uptime.
    await fetch('/api/account/consent-evidence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ marketing: form.marketing, terms: form.terms }),
    }).catch(() => {
      // The account exists and the checkboxes were ticked; a missing evidence
      // stamp is not worth failing sign-up over.
    })

    // If marketing opt-in, also create newsletter subscription
    if (form.marketing) {
      await supabase.rpc('subscribe_newsletter', {
        p_email: form.email.trim().toLowerCase(),
        p_source: 'signup',
      })
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

      <div className="space-y-3 border-t border-[var(--color-border)] pt-6">
        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={form.marketing}
            onChange={(e) => setForm({ ...form, marketing: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span className="text-[var(--color-muted)]">
            I agree to receive marketing emails and promotional offers. You can unsubscribe
            anytime. See our{' '}
            <Link
              href="/privacy"
              target="_blank"
              className="text-[var(--color-foreground)] underline underline-offset-4"
            >
              Privacy Policy
            </Link>
            .
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            required
            checked={form.terms}
            onChange={(e) => setForm({ ...form, terms: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            I have read and agree to the{' '}
            <Link
              href="/terms"
              target="_blank"
              className="text-[var(--color-foreground)] underline underline-offset-4"
            >
              Terms of Service
            </Link>{' '}
            and{' '}
            <Link
              href="/privacy"
              target="_blank"
              className="text-[var(--color-foreground)] underline underline-offset-4"
            >
              Privacy Policy
            </Link>
            . <span className="text-red-600">*</span>
          </span>
        </label>
      </div>

      {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}

      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy ? 'Creating account…' : 'Create account'}
      </Button>
    </form>
  )
}
