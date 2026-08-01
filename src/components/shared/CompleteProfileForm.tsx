'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'

export interface ProfileGaps {
  id: string
  email: string | null
  first_name: string | null
  last_name: string | null
  phone: string | null
  date_of_birth: string | null
  pronouns: string | null
  marketing_opt_in: boolean
  terms_accepted_at: string | null
}

/** Whole years between a date of birth and today. */
function ageFrom(dob: string): number {
  const birth = new Date(`${dob}T00:00:00`)
  const now = new Date()
  let age = now.getFullYear() - birth.getFullYear()
  const monthDiff = now.getMonth() - birth.getMonth()
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < birth.getDate())) age -= 1
  return age
}

/**
 * The details signing in cannot supply.
 *
 * Google hands over a name, an email and a picture. It does not hand over a
 * phone number — needed to reach someone when a slot moves — or a date of
 * birth, which several services require because they have an age minimum.
 *
 * Only the genuinely missing fields are shown: asking someone to retype a name
 * that is already on screen is the kind of friction that loses a booking.
 */
export function CompleteProfileForm({
  profile,
  next,
}: {
  profile: ProfileGaps
  next: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState({
    first_name: profile.first_name ?? '',
    last_name: profile.last_name ?? '',
    phone: profile.phone ?? '',
    date_of_birth: profile.date_of_birth ?? '',
    pronouns: profile.pronouns ?? '',
    marketing: profile.marketing_opt_in,
    terms: !!profile.terms_accepted_at,
  })

  const needsTerms = !profile.terms_accepted_at

  async function submit(e: React.FormEvent) {
    e.preventDefault()

    if (needsTerms && !form.terms) {
      toast.error('Please accept the Terms of Service to continue.')
      return
    }
    if (!form.date_of_birth) {
      toast.error('We need your date of birth.')
      return
    }

    const age = ageFrom(form.date_of_birth)
    if (age < 0 || age > 120) {
      toast.error('Please check that date of birth.')
      return
    }
    if (age < 16) {
      toast.error('Accounts are for clients aged 16 and over. Please call the studio.')
      return
    }

    setBusy(true)
    const supabase = createClient()
    const now = new Date().toISOString()

    const { error } = await supabase
      .from('profiles')
      .update({
        first_name: form.first_name.trim(),
        last_name: form.last_name.trim() || null,
        phone: form.phone.trim(),
        date_of_birth: form.date_of_birth,
        pronouns: form.pronouns.trim() || null,
        marketing_opt_in: form.marketing,
        // Only stamp consent the first time it is actually given.
        ...(form.marketing && !profile.marketing_opt_in ? { marketing_consent_at: now } : {}),
        ...(needsTerms && form.terms
          ? { terms_accepted_at: now, terms_version_accepted: 1, privacy_accepted_at: now }
          : {}),
        profile_completed_at: now,
      })
      .eq('id', profile.id)

    setBusy(false)

    if (error) {
      toast.error('Could not save those details. Please try again.')
      return
    }

    // Opting in here should put them on the list too, not just flip a flag.
    if (form.marketing && !profile.marketing_opt_in && profile.email) {
      await supabase.rpc('subscribe_newsletter', {
        p_email: profile.email,
        p_source: 'profile',
      })
    }

    toast.success('Thank you — you are all set.')
    router.push(next)
    router.refresh()
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="First name" htmlFor="cp_first">
          <Input
            id="cp_first"
            required
            maxLength={80}
            autoComplete="given-name"
            value={form.first_name}
            onChange={(e) => setForm({ ...form, first_name: e.target.value })}
          />
        </Field>
        <Field label="Last name" htmlFor="cp_last">
          <Input
            id="cp_last"
            maxLength={80}
            autoComplete="family-name"
            value={form.last_name}
            onChange={(e) => setForm({ ...form, last_name: e.target.value })}
          />
        </Field>
      </div>

      <Field
        label="Phone"
        htmlFor="cp_phone"
        hint="So we can reach you if anything about your appointment changes."
      >
        <Input
          id="cp_phone"
          type="tel"
          required
          maxLength={40}
          autoComplete="tel"
          value={form.phone}
          onChange={(e) => setForm({ ...form, phone: e.target.value })}
        />
      </Field>

      <Field
        label="Date of birth"
        htmlFor="cp_dob"
        hint="Some treatments have an age minimum, so we have to ask."
      >
        <Input
          id="cp_dob"
          type="date"
          required
          value={form.date_of_birth}
          onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
        />
      </Field>

      <Field label="Pronouns" htmlFor="cp_pronouns" hint="Optional.">
        <Input
          id="cp_pronouns"
          maxLength={40}
          value={form.pronouns}
          onChange={(e) => setForm({ ...form, pronouns: e.target.value })}
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
            Email me offers and studio news. You can unsubscribe at any time.
          </span>
        </label>

        {needsTerms && (
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
              .
            </span>
          </label>
        )}
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy ? 'Saving…' : 'Save and continue'}
      </Button>
    </form>
  )
}
