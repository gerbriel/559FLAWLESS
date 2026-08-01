'use client'

import { Suspense, useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Loader2, CheckCircle, XCircle } from 'lucide-react'

function UnsubscribeInner() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')
  const [status, setStatus] = useState<'loading' | 'success' | 'error' | 'invalid'>('loading')
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setStatus('invalid')
      return
    }

    async function unsubscribe() {
      try {
        const res = await fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'unsubscribe', token }),
        })

        const data = await res.json()

        if (data.status === 'unsubscribed') {
          setStatus('success')
          setEmail(data.email)
        } else if (data.status === 'already_unsubscribed') {
          setStatus('success')
          setEmail(data.email)
        } else {
          setStatus('error')
        }
      } catch {
        setStatus('error')
      }
    }

    void unsubscribe()
  }, [token])

  return (
    <div className="mx-auto max-w-2xl px-6 py-20">
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-12 text-center">
        {status === 'loading' && (
          <>
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-[var(--color-muted)]" strokeWidth={1.5} />
            <p className="mt-6 text-[var(--color-muted)]">Unsubscribing…</p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle className="mx-auto h-12 w-12 text-green-600 dark:text-green-400" strokeWidth={1.5} />
            <h1 className="display mt-6 text-3xl">You&apos;ve been unsubscribed.</h1>
            {email && (
              <p className="mt-3 text-[var(--color-muted)]">
                {email} will no longer receive marketing emails from us.
              </p>
            )}
            <p className="mt-6 text-sm text-[var(--color-muted)]">
              You&apos;ll still receive transactional emails like appointment confirmations.
            </p>
            <p className="mt-3 text-sm text-[var(--color-muted)]">
              Changed your mind?{' '}
              <Link href="/account/settings" className="text-[var(--color-foreground)] underline underline-offset-4">
                Sign in to resubscribe
              </Link>
            </p>
          </>
        )}

        {status === 'error' && (
          <>
            <XCircle className="mx-auto h-12 w-12 text-red-600 dark:text-red-400" strokeWidth={1.5} />
            <h1 className="display mt-6 text-3xl">Something went wrong.</h1>
            <p className="mt-3 text-[var(--color-muted)]">
              We couldn&apos;t process your unsubscribe request. Please try again or contact us directly.
            </p>
          </>
        )}

        {status === 'invalid' && (
          <>
            <XCircle className="mx-auto h-12 w-12 text-red-600 dark:text-red-400" strokeWidth={1.5} />
            <h1 className="display mt-6 text-3xl">Invalid link.</h1>
            <p className="mt-3 text-[var(--color-muted)]">
              This unsubscribe link is not valid. Please use the link from one of our emails.
            </p>
          </>
        )}

        <Link href="/" className="label-caps mt-8 inline-block border-b border-[var(--color-foreground)] pb-1">
          Return home
        </Link>
      </div>
    </div>
  )
}

/**
 * `useSearchParams` forces a client-side bailout, which fails prerendering
 * unless the component reading it sits behind a Suspense boundary.
 */
export default function UnsubscribePage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-[60vh] items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-[var(--color-muted)]" strokeWidth={1.5} />
          <span className="sr-only">Unsubscribing…</span>
        </div>
      }
    >
      <UnsubscribeInner />
    </Suspense>
  )
}
