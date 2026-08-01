'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { isStaff, type UserRole } from '@/types/database'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'

const MIN_PASSWORD = 8

/**
 * The invitee's side of an invitation.
 *
 * Deliberately close to `SignupForm` — same password floor, same terms
 * checkbox, same copy — but it cannot reuse it, because signup asks for an
 * email and this must not. The address is fixed by the invitation and is shown
 * read-only; changing it is exactly what the token is there to prevent.
 *
 * Nothing here names a role. The role comes from the invitation row, decided
 * server-side by `redeem_invitation`.
 */
export function InviteAcceptForm({
  token,
  email,
  role,
  firstName,
  lastName,
  expiresAt,
}: {
  token: string
  email: string
  role: UserRole
  firstName: string | null
  lastName: string | null
  expiresAt: string
}) {
  const router = useRouter()
  const staff = isStaff(role)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [form, setForm] = useState({
    first_name: firstName ?? '',
    last_name: lastName ?? '',
    phone: '',
    date_of_birth: '',
    password: '',
    marketing: !staff,
    terms: false,
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

    const res = await fetch('/api/invitations/accept', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token,
        password: form.password,
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim(),
        phone: form.phone.trim() || null,
        date_of_birth: form.date_of_birth || null,
        marketing_opt_in: staff ? false : form.marketing,
        accepted_terms: true,
      }),
    }).catch(() => null)

    const payload = (await res?.json().catch(() => null)) as
      | { ok?: true; role?: UserRole; message?: string }
      | null

    if (!res?.ok || !payload?.ok) {
      setBusy(false)
      setError(payload?.message ?? 'Something went wrong. Please try again.')
      return
    }

    // The account exists and already has its role; sign in with the password
    // they just set so they land inside rather than on a login screen.
    const supabase = createClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: form.password,
    })

    if (signInError) {
      setBusy(false)
      setError('Your account is ready — please sign in.')
      router.push('/login')
      return
    }

    // Staff go straight to the dashboard. The client profile-completion step in
    // /auth/callback is for clients only, and this form already collected what
    // it asks for.
    router.push(isStaff(payload.role) ? '/dashboard' : '/account')
    router.refresh()
  }

  const expires = new Date(expiresAt).toLocaleDateString('en-US', {
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  })

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Email" htmlFor="inv_email" hint="Set by the invitation and cannot be changed.">
        <Input id="inv_email" type="email" value={email} readOnly disabled autoComplete="username" />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="First name" htmlFor="inv_first">
          <Input
            id="inv_first"
            required
            maxLength={80}
            autoComplete="given-name"
            value={form.first_name}
            onChange={(e) => setForm({ ...form, first_name: e.target.value })}
          />
        </Field>
        <Field label="Last name" htmlFor="inv_last">
          <Input
            id="inv_last"
            required
            maxLength={80}
            autoComplete="family-name"
            value={form.last_name}
            onChange={(e) => setForm({ ...form, last_name: e.target.value })}
          />
        </Field>
      </div>

      <Field
        label="Phone"
        htmlFor="inv_phone"
        hint={staff ? 'So the studio can reach you.' : 'For appointment reminders.'}
      >
        <Input
          id="inv_phone"
          type="tel"
          maxLength={40}
          autoComplete="tel"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
      </Field>

      {/* Clients only. Several services have an age minimum, so a date of birth
          is asked for once, here, instead of at the point of booking. */}
      {!staff && (
        <Field
          label="Date of birth"
          htmlFor="inv_dob"
          hint="Some treatments have an age minimum."
        >
          <Input
            id="inv_dob"
            type="date"
            value={form.date_of_birth}
            onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
          />
        </Field>
      )}

      <Field
        label="Password"
        htmlFor="inv_password"
        hint={`At least ${MIN_PASSWORD} characters.`}
      >
        <Input
          id="inv_password"
          type="password"
          required
          minLength={MIN_PASSWORD}
          autoComplete="new-password"
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
      </Field>

      <div className="space-y-3 border-t border-[var(--color-border)] pt-6">
        {!staff && (
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
        )}

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
        {busy ? 'Setting up…' : 'Accept invitation'}
      </Button>

      <p className="text-xs text-[var(--color-muted)]">
        This link works once and stops working on {expires}.
      </p>
    </form>
  )
}
