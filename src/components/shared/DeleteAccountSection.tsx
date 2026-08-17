'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/field'

/**
 * Deleting an account.
 *
 * The studio keeps real records — a signed consent, a treatment note, a sales
 * receipt — and this is where a client is told so, in full, before they
 * decide. The copy below is not hedging: it is the actual list, in the same
 * order as the scrub in migration 030, and if that migration's policy switches
 * are ever changed this copy has to change with it.
 */

const REMOVED = [
  'Your name, email address, phone number, date of birth and pronouns.',
  'Your profile photo.',
  'The name and street address on anything you had shipped.',
  'Your email and text subscriptions, and the record of what you browsed here.',
  'The messages you wrote to us. Our replies stay, so the studio still has a record of any advice it gave.',
  'Your before-and-after treatment photographs — the image files themselves, not just the link to them.',
  'Any review you left on the site.',
  'Any labels staff had added to your file.',
]

const KEPT = [
  {
    what: 'Your appointments, and the services on each one.',
    why: 'A record of treatment performed, and part of the studio’s tax return.',
  },
  {
    what: 'Your orders and payments, including the city and ZIP code an order shipped to.',
    why: 'California assesses sales tax by district, and the CDTFA can ask for four years of it. Your name and street address are removed; the ZIP is not enough to identify you.',
  },
  {
    what: 'Consent forms you signed, including the name you signed them under and your signature.',
    why: 'A consent form is only evidence of what you agreed to if it still shows who agreed. Removing the name would leave a document that proves nothing.',
  },
  {
    what: 'Your health intake, patch tests, and your cosmetologist’s treatment notes.',
    why: 'These are clinical records. They are held for the same period as any other treatment record, and a note written at the time cannot honestly be rewritten later.',
  },
  {
    what: 'Prepaid packages and gift-card balances.',
    why: 'That is money. If there is a balance, it is still owed.',
  },
]

export function DeleteAccountSection() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [busy, setBusy] = useState(false)

  const armed = typed.trim().toUpperCase() === 'DELETE'

  async function destroy() {
    if (!armed) return
    setBusy(true)

    let res: Response
    try {
      res = await fetch('/api/account/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: 'DELETE' }),
      })
    } catch {
      setBusy(false)
      toast.error('Could not reach the studio. Please try again.')
      return
    }

    if (!res.ok) {
      setBusy(false)
      const body = await res.json().catch(() => null)
      toast.error(body?.message ?? 'Could not delete your account. Please call the studio.')
      return
    }

    // The route already revoked every session server-side. This clears what the
    // browser is still holding; it can fail precisely because the token it
    // would use has just been revoked, which is not a problem worth reporting.
    try {
      await createClient().auth.signOut()
    } catch {
      // already gone
    }

    toast.success('Your account has been deleted and your personal details removed.')
    router.push('/')
    router.refresh()
  }

  return (
    <section className="mt-16 border-t border-[var(--color-border)] pt-10">
      <p className="label-caps text-[var(--color-accent)]">Deleting your account</p>

      {!open ? (
        <>
          <p className="mt-4 max-w-prose text-sm text-[var(--color-muted)]">
            You can remove your personal information from our system at any time. Some records
            — what you bought, what you signed, and your treatment history — stay, because the
            studio is required to keep them. Nothing that stays is connected to your name,
            email, phone number or address afterwards.
          </p>
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="label-caps mt-5 text-red-700 underline underline-offset-4 hover:text-red-800 dark:text-red-400 dark:hover:text-red-300"
          >
            Delete my account
          </button>
        </>
      ) : (
        <div className="mt-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-6 sm:p-8">
          <p className="display text-2xl">Delete your account</p>
          <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
            This cannot be undone. Read both lists before you decide — we would rather you knew
            exactly what happens than found out later.
          </p>

          <div className="mt-8 grid gap-8 sm:grid-cols-2">
            <div>
              <p className="label-caps text-red-700 dark:text-red-400">What is removed</p>
              <ul className="mt-4 space-y-3">
                {REMOVED.map((line) => (
                  <li key={line} className="flex gap-3 text-sm">
                    <span aria-hidden className="mt-2 h-px w-3 shrink-0 bg-red-700 dark:bg-red-400" />
                    <span>{line}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <p className="label-caps text-[var(--color-accent)]">What the studio keeps, and why</p>
              <ul className="mt-4 space-y-4">
                {KEPT.map((item) => (
                  <li key={item.what} className="flex gap-3 text-sm">
                    <span
                      aria-hidden
                      className="mt-2 h-px w-3 shrink-0 bg-[var(--color-accent)]"
                    />
                    <span>
                      {item.what}
                      <span className="mt-1 block text-[var(--color-muted)]">{item.why}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </div>

          <p className="mt-8 max-w-prose text-sm text-[var(--color-muted)]">
            You will be signed out everywhere. Your email address is released, so if you ever
            want to come back you can sign up again from scratch — it will be a new account,
            with none of this attached to it.
          </p>

          <div className="mt-8 max-w-xs border-t border-[var(--color-border)] pt-6">
            <label htmlFor="confirm_delete" className="label-caps block">
              Type <span className="text-red-700 dark:text-red-400">DELETE</span> to confirm
            </label>
            <Input
              id="confirm_delete"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              maxLength={10}
              className="mt-3"
              aria-describedby="confirm_delete_hint"
            />
            <p id="confirm_delete_hint" className="sr-only">
              Type the word DELETE in capital letters to enable the delete button.
            </p>
          </div>

          <div className="mt-8 flex flex-wrap gap-3">
            <Button variant="danger" onClick={destroy} disabled={!armed || busy}>
              {busy ? 'Deleting…' : 'Delete my account'}
            </Button>
            <Button
              variant="subtle"
              onClick={() => {
                setOpen(false)
                setTyped('')
              }}
              disabled={busy}
            >
              Keep my account
            </Button>
          </div>

          <p className="mt-6 text-xs text-[var(--color-muted)]">
            If you would rather talk to someone first, call the studio — we can do this for you,
            and we can answer what happens to anything you are unsure about.
          </p>
        </div>
      )}
    </section>
  )
}
