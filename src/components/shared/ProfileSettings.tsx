'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import type { Profile } from '@/types/database'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'

interface ProfileFields {
  first_name: string
  last_name: string
  email: string
  phone: string
  pronouns: string
  date_of_birth: string
  marketing_opt_in: boolean
  sms_opt_in: boolean
  marketing_consent_at: string | null
  terms_accepted_at: string | null
  terms_version_accepted: number | null
}

export function ProfileSettings({
  userId,
  profile,
  photoReleaseGiven,
}: {
  userId: string
  profile: ProfileFields
  photoReleaseGiven: boolean
}) {
  const router = useRouter()
  const [form, setForm] = useState(profile)
  const [photoRelease, setPhotoRelease] = useState(photoReleaseGiven)
  const [busy, setBusy] = useState(false)
  const [unsubscribing, setUnsubscribing] = useState(false)

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return 'Never'
    return new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    })
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)

    const supabase = createClient()

    // Track if marketing consent changed
    const marketingChanged = form.marketing_opt_in !== profile.marketing_opt_in
    const now = new Date().toISOString()

    // `role` and `suspended_at` are deliberately absent — a database trigger
    // rejects a non-admin changing either, so there is no point offering them.
    const updates: Partial<Profile> = {
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      phone: form.phone.trim() || null,
      pronouns: form.pronouns.trim() || null,
      date_of_birth: form.date_of_birth || null,
      marketing_opt_in: form.marketing_opt_in,
      sms_opt_in: form.sms_opt_in,
    }

    // If enabling marketing, capture consent timestamp
    if (marketingChanged && form.marketing_opt_in) {
      updates.marketing_consent_at = now
    }

    const { error } = await supabase.from('profiles').update(updates).eq('id', userId)

    if (error) {
      setBusy(false)
      toast.error('Could not save. Please try again.')
      return
    }

    // Photo release lives on the clinical record, and withdrawing it has to be
    // recorded as a revocation rather than by clearing the original grant.
    if (photoRelease !== photoReleaseGiven) {
      await supabase.from('client_records').upsert(
        {
          client_id: userId,
          photo_release_at: photoRelease ? new Date().toISOString() : null,
          photo_release_revoked_at: photoRelease ? null : new Date().toISOString(),
        },
        { onConflict: 'client_id' }
      )
    }

    setBusy(false)
    toast.success('Saved.')
    router.refresh()
  }

  async function handleUnsubscribe() {
    if (!confirm('Are you sure you want to unsubscribe from all marketing emails?')) {
      return
    }

    setUnsubscribing(true)
    const supabase = createClient()

    const { error } = await supabase
      .from('profiles')
      .update({
        marketing_opt_in: false,
        marketing_consent_at: null,
      })
      .eq('id', userId)

    if (error) {
      toast.error('Could not unsubscribe. Please try again.')
    } else {
      toast.success('Unsubscribed from marketing emails.')
      setForm({ ...form, marketing_opt_in: false })
      router.refresh()
    }

    setUnsubscribing(false)
  }

  return (
    <form onSubmit={save} className="space-y-6">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="First name" htmlFor="p_first">
          <Input
            id="p_first"
            maxLength={80}
            value={form.first_name}
            onChange={(e) => setForm({ ...form, first_name: e.target.value })}
          />
        </Field>
        <Field label="Last name" htmlFor="p_last">
          <Input
            id="p_last"
            maxLength={80}
            value={form.last_name}
            onChange={(e) => setForm({ ...form, last_name: e.target.value })}
          />
        </Field>
      </div>

      <Field label="Email" htmlFor="p_email" hint="Contact us to change your sign-in email.">
        <Input id="p_email" value={form.email} disabled />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field label="Phone" htmlFor="p_phone">
          <Input
            id="p_phone"
            type="tel"
            maxLength={40}
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
          />
        </Field>
      </div>

      <fieldset className="border-t border-[var(--color-border)] pt-6">
        <legend className="label-caps mb-4 text-[var(--color-accent)]">Preferences</legend>

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={form.marketing_opt_in}
            onChange={(e) => setForm({ ...form, marketing_opt_in: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>Send me marketing emails and promotional offers.</span>
        </label>

        {form.marketing_opt_in && profile.marketing_consent_at && (
          <p className="ml-7 text-xs text-[var(--color-muted)]">
            Subscribed on {formatDate(profile.marketing_consent_at)}
          </p>
        )}

        {!form.marketing_opt_in && profile.marketing_consent_at && (
          <div className="ml-7 space-y-2">
            <p className="text-xs text-[var(--color-muted)]">
              Previously subscribed on {formatDate(profile.marketing_consent_at)}
            </p>
            <button
              type="button"
              onClick={() => setForm({ ...form, marketing_opt_in: true })}
              className="text-xs text-[var(--color-accent)] underline underline-offset-4"
            >
              Re-subscribe
            </button>
          </div>
        )}

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={form.sms_opt_in}
            onChange={(e) => setForm({ ...form, sms_opt_in: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>Text me appointment reminders.</span>
        </label>

        {profile.marketing_opt_in && (
          <div className="mt-4 border-t border-[var(--color-border)] pt-4">
            <button
              type="button"
              onClick={handleUnsubscribe}
              disabled={unsubscribing}
              className="text-sm text-red-600 underline underline-offset-4 hover:text-red-700 disabled:opacity-50 dark:text-red-400"
            >
              {unsubscribing ? 'Unsubscribing…' : 'Unsubscribe from all marketing'}
            </button>
          </div>
        )}
      </fieldset>

      {profile.terms_accepted_at && (
        <div className="border-t border-[var(--color-border)] pt-6">
          <p className="label-caps mb-2 text-[var(--color-accent)]">Legal</p>
          <p className="text-xs text-[var(--color-muted)]">
            You accepted the Terms of Service (v{profile.terms_version_accepted ?? 1}) on{' '}
            {formatDate(profile.terms_accepted_at)}
          </p>
        </div>
      )}

      <div className="grid gap-6 sm:grid-cols-2">
        <Field label="Pronouns" htmlFor="p_pronouns">
          <Input
            id="p_pronouns"
            maxLength={40}
            placeholder="she/her, they/them, he/him"
            value={form.pronouns}
            onChange={(e) => setForm({ ...form, pronouns: e.target.value })}
          />
        </Field>
      </div>

      <Field
        label="Date of birth"
        htmlFor="p_dob"
        hint="Required for services with an age minimum."
      >
        <Input
          id="p_dob"
          type="date"
          value={form.date_of_birth}
          onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
        />
      </Field>

      <fieldset className="space-y-3 border-t border-[var(--color-border)] pt-6">
        <legend className="label-caps mb-2 text-[var(--color-accent)]">Communication</legend>

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={form.marketing_opt_in}
            onChange={(e) => setForm({ ...form, marketing_opt_in: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>Email me offers and skincare tips.</span>
        </label>

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={form.sms_opt_in}
            onChange={(e) => setForm({ ...form, sms_opt_in: e.target.checked })}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>Text me appointment reminders.</span>
        </label>
      </fieldset>

      <fieldset className="space-y-3 border-t border-[var(--color-border)] pt-6">
        <legend className="label-caps mb-2 text-[var(--color-accent)]">Photography</legend>

        <label className="flex cursor-pointer items-start gap-3 text-sm">
          <input
            type="checkbox"
            checked={photoRelease}
            onChange={(e) => setPhotoRelease(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Allow clinical before-and-after photographs in my treatment record. These are
            visible only to me and the staff who treat me, are never used for marketing
            without separate permission, and I can withdraw this at any time.
          </span>
        </label>
      </fieldset>

      <Button type="submit" size="lg" disabled={busy}>
        {busy ? 'Saving…' : 'Save changes'}
      </Button>
    </form>
  )
}
