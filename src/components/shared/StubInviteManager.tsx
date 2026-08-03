'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Mail, Send } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { Panel } from '@/components/ui/dashboard'
import { DAY_MS, formatDateInTimeZone } from '@/lib/time'

/** One invitation aimed at this stub. Same row as User Management's, narrower. */
export type StubInvitationRow = {
  id: number
  email: string
  note: string | null
  expires_at: string
  accepted_at: string | null
  revoked_at: string | null
  created_at: string
  inviter: { first_name: string | null; last_name: string | null; display_name: string | null } | null
}

type Status = 'pending' | 'accepted' | 'revoked' | 'expired'

function statusOf(row: StubInvitationRow, now: number): Status {
  if (row.accepted_at) return 'accepted'
  if (row.revoked_at) return 'revoked'
  if (new Date(row.expires_at).getTime() <= now) return 'expired'
  return 'pending'
}

const STATUS_TONE = {
  pending: 'info',
  accepted: 'success',
  revoked: 'neutral',
  expired: 'warning',
} as const

/**
 * Invite somebody who is on the studio's list but has no account.
 *
 * A deliberate act, and never an automatic one. The import that created this
 * record sent nothing to anybody; a staff member decides, later, that this is
 * the person to bring in — usually while they are on the phone to them, which
 * is also the moment the studio finally learns their email address. So the
 * address is part of this form rather than a precondition of it, and it is
 * saved onto the record either way: a list of people nobody can reach is how
 * the studio ended up importing a spreadsheet in the first place.
 *
 * The confirmation step is not ceremony. This is the one outward-facing thing
 * on the screen, and a mistyped address turns "your account is ready" into a
 * stranger's link to somebody else's studio record. So the address is read
 * back, in full, with the name it belongs to, before anything is created.
 *
 * Nothing is emailed — there is no transactional email provider in this app,
 * exactly as `InviteManager` says on the staff screen. The link appears once
 * and cannot be shown again; only its SHA-256 is stored (031).
 */
export function StubInviteManager({
  stub,
  invitations,
  canInvite,
  timeZone,
  now,
}: {
  stub: { id: number; first_name: string; last_name: string | null; email: string | null }
  invitations: StubInvitationRow[]
  /** Front desk and above. A provider sees the history and no buttons. */
  canInvite: boolean
  timeZone: string
  /** Read once on the server via `requestNow()` — see AGENTS.md on the clock. */
  now: number
}) {
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ message: string; clientId?: string | null } | null>(null)
  const [issued, setIssued] = useState<{ email: string; url: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [form, setForm] = useState({
    email: stub.email ?? '',
    expires_in_days: 7,
    note: '',
  })

  const name = `${stub.first_name} ${stub.last_name ?? ''}`.trim()
  const live = invitations.find((i) => statusOf(i, now) === 'pending')

  async function send() {
    setBusy(true)
    setError(null)
    setCopied(false)

    const res = await fetch('/api/invitations/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: form.email.trim(),
        role: 'client',
        first_name: stub.first_name,
        last_name: stub.last_name,
        note: form.note.trim() || null,
        expires_in_days: form.expires_in_days,
        client_stub_id: stub.id,
      }),
    }).catch(() => null)

    const body = (await res?.json().catch(() => null)) as
      | { ok?: true; url?: string; message?: string; clientId?: string | null }
      | null

    setBusy(false)

    if (!res?.ok || !body?.ok || !body.url) {
      setError({
        message: body?.message ?? 'Could not create that invitation.',
        clientId: body?.clientId ?? null,
      })
      setConfirming(false)
      return
    }

    setIssued({ email: form.email.trim().toLowerCase(), url: body.url })
    setOpen(false)
    setConfirming(false)
    router.refresh()
  }

  async function revoke(id: number) {
    setError(null)
    const res = await fetch('/api/invitations/revoke', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    }).catch(() => null)

    const body = (await res?.json().catch(() => null)) as { ok?: true; message?: string } | null
    if (!res?.ok || !body?.ok) {
      setError({ message: body?.message ?? 'Could not withdraw that invitation.' })
      return
    }
    router.refresh()
  }

  async function copy(url: string) {
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
    } catch {
      setCopied(false)
      setError({
        message: 'Your browser blocked the clipboard — select the link and copy it by hand.',
      })
    }
  }

  return (
    <Panel className="p-6">
      <h2 className="display text-2xl">Invite them to set up an account</h2>
      <p className="mt-2 text-sm leading-relaxed text-[var(--color-muted)]">
        They choose their own password and fill in the rest of their details. What
        the studio already has — their name, their phone number — carries across, so
        this record becomes their account rather than a second copy of it.
      </p>

      {/* The one and only time this link can be read. */}
      {issued && (
        <div className="mt-6 border border-[var(--color-accent)] bg-[var(--color-linen)] p-5 dark:bg-[var(--color-background)]">
          <p className="label-caps text-[var(--color-accent)]">Link ready</p>
          <p className="mt-2 text-sm">
            Send this to <span className="font-medium">{issued.email}</span>. It works
            once, and it cannot be shown again — if it goes astray, issue a new one and
            this stops working.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input
              readOnly
              value={issued.url}
              onFocus={(e) => e.currentTarget.select()}
              data-ui="input"
              className="min-h-11 min-w-[16rem] flex-1 border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2.5 font-mono text-xs"
            />
            <Button size="sm" onClick={() => copy(issued.url)}>
              {copied ? 'Copied' : 'Copy link'}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setIssued(null)}>
              Done
            </Button>
          </div>
        </div>
      )}

      {/* What is already outstanding, so nobody sends a second link by accident
          without meaning to — and so "they never got it" has an answer. */}
      {invitations.length > 0 && (
        <ul className="mt-6 divide-y divide-[var(--color-border)] border-y border-[var(--color-border)]">
          {invitations.map((invitation) => {
            const status = statusOf(invitation, now)
            const inviter =
              invitation.inviter?.display_name ||
              `${invitation.inviter?.first_name ?? ''} ${invitation.inviter?.last_name ?? ''}`.trim()

            return (
              <li key={invitation.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                <Mail className="h-4 w-4 shrink-0 text-[var(--color-muted)]" strokeWidth={1.5} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{invitation.email}</span>
                  <span className="block text-xs text-[var(--color-muted)]">
                    Sent {formatDateInTimeZone(new Date(invitation.created_at), timeZone)}
                    {inviter && ` by ${inviter}`}
                    {status === 'pending' &&
                      ` · expires in ${Math.max(
                        1,
                        Math.ceil((new Date(invitation.expires_at).getTime() - now) / DAY_MS)
                      )} days`}
                  </span>
                </span>
                <Badge tone={STATUS_TONE[status]} size="sm">
                  {status}
                </Badge>
                {canInvite && status === 'pending' && (
                  <Button variant="ghost" size="sm" onClick={() => void revoke(invitation.id)}>
                    Withdraw
                  </Button>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {error && (
        <div className="mt-4 border border-red-600/40 bg-red-50 p-4 text-sm text-red-800 dark:bg-transparent dark:text-red-400">
          {error.message}
          {error.clientId && (
            <Link
              href={`/dashboard/clients/${error.clientId}`}
              className="mt-2 block underline underline-offset-4"
            >
              Open their client record
            </Link>
          )}
        </div>
      )}

      {canInvite && !open && (
        <div className="mt-6">
          <Button
            onClick={() => {
              setOpen(true)
              setError(null)
            }}
          >
            <Send className="h-4 w-4" strokeWidth={1.75} />
            {live ? 'Send a new link' : 'Invite them'}
          </Button>
          {live && (
            <p className="mt-2 text-xs text-[var(--color-muted)]">
              A new link withdraws the one already outstanding.
            </p>
          )}
        </div>
      )}

      {canInvite && open && !confirming && (
        <form
          className="mt-6 space-y-5"
          onSubmit={(e) => {
            e.preventDefault()
            setError(null)
            setConfirming(true)
          }}
        >
          <Field
            label="Email"
            htmlFor="stub_invite_email"
            hint={
              stub.email
                ? 'Saved to their record when the invitation is created.'
                : 'The studio has no address for them yet — this one is saved to their record.'
            }
          >
            <Input
              id="stub_invite_email"
              type="email"
              required
              maxLength={254}
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>

          <Field label="Link expires" htmlFor="stub_invite_expiry" hint="Shorter is safer.">
            <Select
              id="stub_invite_expiry"
              value={String(form.expires_in_days)}
              onChange={(e) => setForm({ ...form, expires_in_days: Number(e.target.value) })}
            >
              <option value="1">In 1 day</option>
              <option value="3">In 3 days</option>
              <option value="7">In 7 days</option>
              <option value="14">In 14 days</option>
              <option value="30">In 30 days</option>
            </Select>
          </Field>

          <Field
            label="Note"
            htmlFor="stub_invite_note"
            hint="Shown on the page they land on. Optional — a line about who you are helps."
          >
            <Textarea
              id="stub_invite_note"
              maxLength={500}
              rows={2}
              value={form.note}
              onChange={(e) => setForm({ ...form, note: e.target.value })}
            />
          </Field>

          <div className="flex flex-wrap gap-3">
            <Button type="submit">Review</Button>
            <Button type="button" variant="subtle" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {canInvite && confirming && (
        <div className="mt-6 border border-[var(--color-accent)] bg-[var(--color-linen)] p-5 dark:bg-[var(--color-background)]">
          <p className="label-caps text-[var(--color-accent)]">Check this before sending</p>
          <p className="mt-3 text-sm leading-relaxed">
            This creates an invitation for <span className="font-medium">{name}</span> at{' '}
            <span className="font-medium">{form.email.trim().toLowerCase()}</span>. Whoever
            opens the link claims this record — their visits, their notes, their history.
            Nothing is emailed automatically; you get the link to send yourself.
          </p>
          {live && (
            <p className="mt-2 text-sm text-[var(--color-muted)]">
              The link sent to {live.email} stops working.
            </p>
          )}
          <div className="mt-5 flex flex-wrap gap-3">
            <Button onClick={() => void send()} disabled={busy}>
              {busy ? 'Creating…' : 'Create the invitation'}
            </Button>
            <Button variant="subtle" onClick={() => setConfirming(false)} disabled={busy}>
              Go back
            </Button>
          </div>
        </div>
      )}
    </Panel>
  )
}
