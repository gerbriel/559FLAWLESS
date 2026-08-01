'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check, ChevronDown } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { Badge } from '@/components/ui/badge'
import { trackFormEvent } from '@/components/shared/ClientAnalytics'

/**
 * A signature stores a verbatim copy of the body that was on screen, plus the
 * version number. Editing the template later can never change what someone
 * actually agreed to — that is the whole point of `body_snapshot`.
 */
export function ConsentSigner({
  formId,
  version,
  title,
  body,
  revalidateAfterDays,
  alreadySigned,
  signedAt,
  expiresAt,
}: {
  formId: number
  version: number
  title: string
  body: string
  revalidateAfterDays: number
  alreadySigned: boolean
  signedAt?: string | null
  expiresAt?: string | null
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [agreed, setAgreed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [hasTrackedOpen, setHasTrackedOpen] = useState(false)

  useEffect(() => {
    if (open && !hasTrackedOpen) {
      void trackFormEvent('consent', 'started', { form_id: formId })
      setHasTrackedOpen(true)
    }
  }, [open, hasTrackedOpen, formId])

  const isExpiringSoon =
    expiresAt && new Date(expiresAt) < new Date(Date.now() + 30 * 86_400_000)

  async function sign(e: React.FormEvent) {
    e.preventDefault()
    if (!agreed || !name.trim()) return

    setBusy(true)
    const supabase = createClient()
    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      setBusy(false)
      toast.error('Please sign in again.')
      return
    }

    const expiresAt =
      revalidateAfterDays > 0
        ? new Date(Date.now() + revalidateAfterDays * 86_400_000).toISOString()
        : null

    const { error } = await supabase.from('consent_signatures').insert({
      consent_form_id: formId,
      client_id: user.id,
      signed_name: name.trim(),
      body_snapshot: body,
      form_version: version,
      expires_at: expiresAt,
    })

    if (error) {
      setBusy(false)
      toast.error('Could not save. Please try again.')
      void trackFormEvent('consent', 'abandoned', { form_id: formId, error: error.message })
      return
    }

    void trackFormEvent('consent', 'completed', { form_id: formId })

    toast.success('Signed. Thank you.')
    setOpen(false)
    router.refresh()
  }

  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)]">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-4 px-6 py-4 text-left"
        aria-expanded={open}
      >
        <span className="flex flex-col gap-2">
          <span className="flex flex-wrap items-center gap-3">
            {title}
            {alreadySigned && (
              <Badge tone="success">
                <Check className="h-3 w-3" strokeWidth={2.5} />
                Signed
              </Badge>
            )}
            {isExpiringSoon && (
              <Badge tone="warning">Expires soon</Badge>
            )}
          </span>
          {signedAt && (
            <span className="text-xs text-[var(--color-muted)]">
              Last signed {new Date(signedAt).toLocaleDateString()}
              {expiresAt && ` • Expires ${new Date(expiresAt).toLocaleDateString()}`}
            </span>
          )}
        </span>
        <ChevronDown
          className={`h-4 w-4 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`}
          strokeWidth={1.5}
        />
      </button>

      {open && (
        <div className="border-t border-[var(--color-border)] px-6 py-6">
          <div className="max-h-72 overflow-y-auto whitespace-pre-line border border-[var(--color-border)] bg-[var(--color-background)] p-5 text-sm leading-relaxed text-[var(--color-muted)]">
            {body}
          </div>

          {alreadySigned ? (
            <p className="mt-5 text-sm text-[var(--color-muted)]">
              You have already signed this. To withdraw consent, message us or tell your
              provider — no explanation needed.
            </p>
          ) : (
            <form onSubmit={sign} className="mt-6 space-y-5">
              <label className="flex cursor-pointer items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)]"
                />
                <span>
                  I have read the above and I agree to it. I understand I may withdraw
                  this consent at any time.
                </span>
              </label>

              <Field
                label="Type your full name to sign"
                htmlFor={`sign_${formId}`}
                hint="This is your electronic signature."
              >
                <Input
                  id={`sign_${formId}`}
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  autoComplete="name"
                />
              </Field>

              <Button type="submit" disabled={busy || !agreed || !name.trim()}>
                {busy ? 'Recording…' : 'Sign'}
              </Button>
            </form>
          )}
        </div>
      )}
    </div>
  )
}
