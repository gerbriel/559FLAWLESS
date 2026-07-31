'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/field'

export function NewsletterForm({ source = 'footer' }: { source?: string }) {
  const [email, setEmail] = useState('')
  const [busy, setBusy] = useState(false)

  async function subscribe(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setBusy(true)

    const supabase = createClient()
    const { error } = await supabase
      .from('newsletter_subscribers')
      .insert({ email: email.trim().toLowerCase(), source })

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
