'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/field'
import { useSignedInEmail } from '@/components/shared/SignedInIdentity'

export function NewsletterSignup() {
  // Resolved in the browser: this can sit anywhere, including inside the
  // statically rendered public layout, and must not force a cookie read on it.
  const { email: signedInEmail } = useSignedInEmail()
  const [email, setEmail] = useState('')
  const [useAnother, setUseAnother] = useState(false)
  const [busy, setBusy] = useState(false)
  const [subscribed, setSubscribed] = useState(false)

  const known = signedInEmail && !useAnother ? signedInEmail : null
  const address = known ?? email

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)

    try {
      const res = await fetch('/api/newsletter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'subscribe',
          email: address.trim().toLowerCase(),
          source: 'footer',
        }),
      })

      const data = await res.json()

      if (data.status === 'pending_confirmation') {
        setSubscribed(true)
        toast.success('Check your email to confirm your subscription.')
      } else if (data.status === 'already_subscribed') {
        toast.info('You are already subscribed!')
      } else {
        toast.error('Could not subscribe. Please try again.')
      }
    } catch {
      toast.error('Something went wrong. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (subscribed) {
    return (
      <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center">
        <p className="display text-xl">Check your email!</p>
        <p className="mt-2 text-sm text-[var(--color-muted)]">
          We sent a confirmation link to {address}. Click it to complete your subscription.
        </p>
      </div>
    )
  }

  return (
    <div>
      <p className="label-caps mb-4 text-[var(--color-accent)]">Stay in touch</p>
      <p className="mb-4 text-sm text-[var(--color-muted)]">
        Get skincare tips and exclusive offers. No more than monthly.
      </p>
      {/* Signed in: we hold the address already, so subscribing is one tap. */}
      {known ? (
        <form onSubmit={handleSubmit}>
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-sm text-[var(--color-muted)]">
              Subscribing{' '}
              <span className="break-all text-[var(--color-foreground)]">{known}</span>
            </p>
            <Button type="submit" disabled={busy}>
              {busy ? 'Subscribing...' : 'Subscribe'}
            </Button>
          </div>
          <button
            type="button"
            onClick={() => setUseAnother(true)}
            className="flex min-h-11 items-center text-xs underline underline-offset-4 hover:text-[var(--color-foreground)] sm:min-h-0 sm:pt-2"
          >
            Use a different address
          </button>
        </form>
      ) : (
        <form onSubmit={handleSubmit} className="flex gap-2">
          <Input
            type="email"
            placeholder="your@email.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="flex-1"
          />
          <Button type="submit" disabled={busy}>
            {busy ? 'Subscribing...' : 'Subscribe'}
          </Button>
        </form>
      )}
      <p className="mt-3 text-xs text-[var(--color-muted)]">
        We respect your privacy. Unsubscribe anytime.
      </p>
    </div>
  )
}
