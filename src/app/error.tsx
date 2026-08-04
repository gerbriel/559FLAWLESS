'use client'

import { useEffect } from 'react'
import Link from 'next/link'

/**
 * What a client sees when a page throws.
 *
 * Without this file, production showed Next's unbranded "Application error"
 * document — no chrome, no way home, styled nothing like the studio. This one
 * apologises in the studio's voice and offers the two things a person actually
 * wants at that moment: try again, and a way to reach the studio that does not
 * depend on the thing that just broke.
 *
 * error.message is deliberately NOT rendered. In production Next already
 * strips Server Component messages, but a client-side error's text can carry
 * internals, and a client should never be shown them. It is logged instead —
 * console.error from the browser still reaches nothing server-side, but the
 * digest below ties a report to Vercel's function logs.
 */
export default function Error({
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
    <main className="flex min-h-[60vh] items-center justify-center px-6 py-24">
      <div className="max-w-md text-center">
        <p className="label-caps mb-6 text-[var(--color-accent)]">Something went wrong</p>
        <h1 className="display text-4xl">That didn&rsquo;t work, and it&rsquo;s not you</h1>
        <p className="mt-4 text-[var(--color-muted)]">
          The page hit a problem on our side. Trying again usually clears it — and if it
          doesn&rsquo;t, nothing about your appointment or your account has been lost.
        </p>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-6">
          <button
            type="button"
            onClick={reset}
            className="label-caps border-b border-[var(--color-foreground)] pb-1"
          >
            Try again
          </button>
          <Link href="/" className="label-caps pb-1 text-[var(--color-muted)]">
            Back to the studio
          </Link>
        </div>
        {error.digest && (
          <p className="mt-10 text-xs text-[var(--color-muted)]">
            If you contact us about this, mention <span className="font-mono">{error.digest}</span>
          </p>
        )}
      </div>
    </main>
  )
}
