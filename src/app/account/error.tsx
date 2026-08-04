'use client'

import { useEffect } from 'react'
import Link from 'next/link'

/** The client-account boundary: the public page's manner, the account's exits. */
export default function AccountError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div className="flex min-h-[50vh] items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="label-caps mb-4 text-[var(--color-accent)]">Something went wrong</p>
        <h1 className="display text-3xl">This page hit a problem</h1>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          Your appointments and your account are unaffected — only this screen failed to
          load. Trying again usually clears it.
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-6">
          <button
            type="button"
            onClick={reset}
            className="label-caps border-b border-[var(--color-foreground)] pb-1"
          >
            Try again
          </button>
          <Link href="/account/appointments" className="label-caps pb-1 text-[var(--color-muted)]">
            My appointments
          </Link>
        </div>
        {error.digest && (
          <p className="mt-8 text-xs text-[var(--color-muted)]">
            Reference if you contact us: <span className="font-mono">{error.digest}</span>
          </p>
        )}
      </div>
    </div>
  )
}
