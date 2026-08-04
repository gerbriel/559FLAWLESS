'use client'

import { useEffect } from 'react'
import Link from 'next/link'

/**
 * The staff-side boundary. Unlike the public one this SHOWS the digest
 * prominently — staff are the people who will quote it when reporting, and the
 * digest is the only thread back to the server log once Vercel's short log
 * retention has turned over.
 */
export default function DashboardError({
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
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="max-w-md text-center">
        <p className="label-caps mb-4 text-[var(--color-accent)]">This screen failed</p>
        <h1 className="display text-3xl">The rest of the dashboard is fine</h1>
        <p className="mt-3 text-sm text-[var(--color-muted)]">
          Only this page hit the problem — the diary, the till and everything else are
          still running. Try again first; if it keeps happening, note the reference below.
        </p>
        {error.digest && (
          <p className="mt-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-3 font-mono text-sm">
            {error.digest}
          </p>
        )}
        <div className="mt-8 flex flex-wrap items-center justify-center gap-6">
          <button
            type="button"
            onClick={reset}
            className="label-caps border-b border-[var(--color-foreground)] pb-1"
          >
            Try again
          </button>
          <Link href="/dashboard" className="label-caps pb-1 text-[var(--color-muted)]">
            Today
          </Link>
        </div>
      </div>
    </div>
  )
}
