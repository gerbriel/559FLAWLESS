'use client'

import { useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

/** Google's brand mark. Inline so it never depends on a remote asset. */
function GoogleMark() {
  return (
    <svg className="h-[18px] w-[18px]" viewBox="0 0 18 18" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.97 10.72A5.4 5.4 0 0 1 3.68 9c0-.6.1-1.18.29-1.72V4.95H.96A9 9 0 0 0 0 9c0 1.45.35 2.82.96 4.05l3.01-2.33Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58Z"
      />
    </svg>
  )
}

/**
 * Sign in with Google.
 *
 * The redirect carries `next` through, so someone who was part-way through
 * booking lands back on the booking rather than a generic account page —
 * losing your place is the fastest way to lose the booking.
 *
 * `prompt: 'select_account'` is deliberate: on a shared iPad, silently reusing
 * whichever Google account is already signed in would attach a booking to the
 * wrong person.
 */
export function GoogleSignIn({ label = 'Continue with Google' }: { label?: string }) {
  const searchParams = useSearchParams()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const rawNext = searchParams.get('next')
  const next = rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//') ? rawNext : null

  async function signIn() {
    setBusy(true)
    setError(null)

    const callback = new URL('/auth/callback', window.location.origin)
    if (next) callback.searchParams.set('next', next)

    const { error: oauthError } = await createClient().auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: callback.toString(),
        queryParams: { prompt: 'select_account' },
      },
    })

    if (oauthError) {
      setBusy(false)
      setError('Could not reach Google. Please try again, or use your email below.')
    }
    // On success the browser navigates away, so `busy` stays true on purpose.
  }

  return (
    <div>
      <button
        type="button"
        onClick={signIn}
        disabled={busy}
        className="flex min-h-11 w-full items-center justify-center gap-3 border border-[var(--color-border)] bg-[var(--color-surface)] px-5 py-3 text-sm transition-colors hover:border-[var(--color-foreground)] disabled:opacity-60"
      >
        <GoogleMark />
        {busy ? 'Taking you to Google…' : label}
      </button>

      {error && <p className="mt-3 text-sm text-red-700 dark:text-red-400">{error}</p>}

      <div className="my-6 flex items-center gap-4">
        <span className="h-px flex-1 bg-[var(--color-border)]" />
        <span className="label-caps text-[var(--color-muted)]">or</span>
        <span className="h-px flex-1 bg-[var(--color-border)]" />
      </div>
    </div>
  )
}
