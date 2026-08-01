'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/field'
import { useSignedInEmail } from '@/components/shared/SignedInIdentity'

export function NewsletterForm({ source = 'footer' }: { source?: string }) {
  // This form lives in the footer, inside the statically rendered public
  // layout, so the viewer is resolved in the browser rather than by a server
  // parent — see the layout's note on cookies. Anonymous visitors, the common
  // case, see the ordinary field with no wait.
  const { email: signedInEmail } = useSignedInEmail()
  const [email, setEmail] = useState('')
  const [useAnother, setUseAnother] = useState(false)
  const [busy, setBusy] = useState(false)

  const known = signedInEmail && !useAnother ? signedInEmail : null
  const address = known ?? email

  async function subscribe(e: React.FormEvent) {
    e.preventDefault()
    if (!address.trim()) return
    setBusy(true)

    const supabase = createClient()
    const { error } = await supabase
      .from('newsletter_subscribers')
      .insert({ email: address.trim().toLowerCase(), source })

    setBusy(false)

    // 23505 = already subscribed. Say the same thing either way so the form
    // can't be used to test whether an address is on the list.
    if (error && error.code !== '23505') {
      toast.error('Could not subscribe just now. Please try again.')
      return
    }

    setEmail('')
    toast.success("You're on the list.")
  }

  // Signed in: we know the address, so joining is one tap. The escape hatch is
  // a real button — someone may want the list to go somewhere else.
  if (known) {
    return (
      <form onSubmit={subscribe}>
        <div className="flex items-center gap-2">
          <p className="min-w-0 flex-1 text-sm text-[var(--color-muted)]">
            Joining as{' '}
            <span className="break-all text-[var(--color-foreground)]">{known}</span>
          </p>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? '…' : 'Join'}
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
    )
  }

  return (
    <form onSubmit={subscribe} className="flex gap-2">
      <Input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email address"
        aria-label="Email address"
        className="flex-1"
      />
      <Button type="submit" size="sm" disabled={busy}>
        {busy ? '…' : 'Join'}
      </Button>
    </form>
  )
}
