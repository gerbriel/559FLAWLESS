'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { isStaff } from '@/types/database'

export function LoginForm({ next }: { next?: string }) {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)

    const supabase = createClient()
    const { data, error: signInError } = await supabase.auth.signInWithPassword({
      email: email.trim().toLowerCase(),
      password,
    })

    if (signInError) {
      setBusy(false)
      // Deliberately one message for both wrong-password and no-such-account,
      // so the form can't be used to discover who has an account here.
      setError('That email and password did not match.')
      return
    }

    // Staff land in the dashboard, clients in their account area.
    const { data: profile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', data.user.id)
      .maybeSingle()

    const destination = next ?? (isStaff(profile?.role) ? '/dashboard' : '/account')
    router.push(destination)
    router.refresh()
  }

  async function sendMagicLink() {
    if (!email.trim()) {
      toast.error('Enter your email first.')
      return
    }
    const supabase = createClient()
    const { error: linkError } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: {
        emailRedirectTo: `${window.location.origin}/auth/callback${
          next ? `?next=${encodeURIComponent(next)}` : ''
        }`,
      },
    })
    // Same message either way — no account enumeration.
    if (linkError) console.error(linkError)
    toast.success('If that address has an account, a sign-in link is on its way.')
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <Field label="Email" htmlFor="email">
        <Input
          id="email"
          type="email"
          required
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </Field>

      <Field label="Password" htmlFor="password">
        <Input
          id="password"
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </Field>

      {error && <p className="text-sm text-red-700 dark:text-red-400">{error}</p>}

      <Button type="submit" size="lg" className="w-full" disabled={busy}>
        {busy ? 'Signing in…' : 'Sign in'}
      </Button>

      <button
        type="button"
        onClick={sendMagicLink}
        className="label-caps min-h-11 w-full text-center text-[var(--color-muted)] hover:text-[var(--color-accent)]"
      >
        Email me a sign-in link instead
      </button>
    </form>
  )
}
