'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'

const MIN_PASSWORD = 8

/**
 * Set — or change — the account password, from an existing session.
 *
 * This is the missing half of two flows that end with a signed-in client and
 * no password at all: the account the desk created for a walk-in (claimed by
 * a staff-issued sign-in link) and a Google account whose owner wants a
 * password besides. `auth.updateUser` needs only the session, not an email —
 * which matters here, because password-reset EMAIL is exactly the thing an
 * account like this cannot receive yet.
 *
 * No "current password" field on purpose: Supabase does not require one for
 * a session-holder, and demanding one would lock out the passwordless
 * accounts this exists for.
 */
export function PasswordSection() {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)

  async function save(e: React.FormEvent) {
    e.preventDefault()
    if (password.length < MIN_PASSWORD) {
      toast.error(`Please use at least ${MIN_PASSWORD} characters.`)
      return
    }
    if (password !== confirm) {
      toast.error('The two passwords do not match.')
      return
    }

    setBusy(true)
    const { error } = await createClient().auth.updateUser({ password })
    setBusy(false)

    if (error) {
      toast.error(
        /same password|different from the old/i.test(error.message)
          ? 'That is already your password.'
          : error.message || 'Could not set the password.'
      )
      return
    }

    toast.success('Password set. You can sign in with it from now on.')
    setPassword('')
    setConfirm('')
  }

  return (
    <section className="mt-14 border-t border-[var(--color-border)] pt-10">
      <h2 className="label-caps mb-2 text-[var(--color-accent)]">Password</h2>
      <p className="mb-6 text-sm text-[var(--color-muted)]">
        Set or change the password you sign in with. If the studio set your account up
        for you, this is where you choose one.
      </p>

      <form onSubmit={save} className="space-y-5">
        <Field
          label="New password"
          htmlFor="pw_new"
          hint={`At least ${MIN_PASSWORD} characters.`}
        >
          <Input
            id="pw_new"
            type="password"
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <Field label="Repeat it" htmlFor="pw_confirm">
          <Input
            id="pw_confirm"
            type="password"
            required
            minLength={MIN_PASSWORD}
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </Field>
        <Button type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save password'}
        </Button>
      </form>
    </section>
  )
}
