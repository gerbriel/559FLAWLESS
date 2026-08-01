'use client'

import { useEffect, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { Loader2, CheckCircle, XCircle } from 'lucide-react'

export default function ConfirmNewsletterPage() {
  const searchParams = useSearchParams()
  const token = searchParams.get('token')
  const [status, setStatus] = useState<'loading' | 'success' | 'already' | 'error' | 'invalid'>('loading')
  const [email, setEmail] = useState<string | null>(null)

  useEffect(() => {
    if (!token) {
      setStatus('invalid')
      return
    }

    async function confirm() {
      try {
        const res = await fetch('/api/newsletter', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'confirm', token }),
        })

        const data = await res.json()

        if (data.status === 'confirmed') {
          setStatus('success')
          setEmail(data.email)
        } else if (data.status === 'already_confirmed') {
          setStatus('already')
          setEmail(data.email)
        } else {
          setStatus('error')
        }
      } catch {
        setStatus('error')
      }
    }

    void confirm()
  }, [token])

  return (
    <div className="mx-auto max-w-2xl px-6 py-20">
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-12 text-center">
        {status === 'loading' && (
          <>
            <Loader2 className="mx-auto h-12 w-12 animate-spin text-[var(--color-muted)]" strokeWidth={1.5} />
            <p className="mt-6 text-[var(--color-muted)]">Confirming your subscription…</p>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle className="mx-auto h-12 w-12 text-green-600 dark:text-green-400" strokeWidth={1.5} />
            <h1 className="display mt-6 text-3xl">You're subscribed!</h1>
            {email && (
              <p className="mt-3 text-[var(--color-muted)]">
                {email} is confirmed. You'll receive our newsletter and exclusive offers.
              </p>
            )}
            <Link href="/" className="label-caps mt-8 inline-block border-b border-[var(--color-foreground)] pb-1">
              Continue to site
            </Link>
          </>
        )}

        {status === 'already' && (
          <>
            <CheckCircle className="mx-auto h-12 w-12 text-green-600 dark:text-green-400" strokeWidth={1.5} />
            <h1 className="display mt-6 text-3xl">Already confirmed.</h1>
            <p className="mt-3 text-[var(--color-muted)]">
              This email is already subscribed to our newsletter.
            </p>
            <Link href="/" className="label-caps mt-8 inline-block border-b border-[var(--color-foreground)] pb-1">
              Continue to site
            </Link>
          </>
        )}

        {status === 'error' && (
          <>
            <XCircle className="mx-auto h-12 w-12 text-red-600 dark:text-red-400" strokeWidth={1.5} />
            <h1 className="display mt-6 text-3xl">Something went wrong.</h1>
            <p className="mt-3 text-[var(--color-muted)]">
              We couldn't confirm your subscription. The link may have expired. Please try subscribing again.
            </p>
          </>
        )}

        {status === 'invalid' && (
          <>
            <XCircle className="mx-auto h-12 w-12 text-red-600 dark:text-red-400" strokeWidth={1.5} />
            <h1 className="display mt-6 text-3xl">Invalid link.</h1>
            <p className="mt-3 text-[var(--color-muted)]">
              This confirmation link is not valid. Please use the link from your confirmation email.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
