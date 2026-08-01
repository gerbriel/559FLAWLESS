'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { ROLE_LABELS, isStaff, type UserRole } from '@/types/database'

export type InvitationRow = {
  id: number
  email: string
  first_name: string | null
  last_name: string | null
  note: string | null
  role: UserRole
  invited_by: string
  expires_at: string
  accepted_at: string | null
  revoked_at: string | null
  created_at: string
  inviter: { first_name: string | null; last_name: string | null; display_name: string | null } | null
}

type Status = 'pending' | 'accepted' | 'revoked' | 'expired'

function statusOf(row: InvitationRow, now: number): Status {
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

function shortDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

function expiryLabel(iso: string, now: number) {
  const days = Math.ceil((new Date(iso).getTime() - now) / 86_400_000)
  if (days < 0) return `Expired ${shortDate(iso)}`
  if (days === 0) return 'Expires today'
  if (days === 1) return 'Expires tomorrow'
  return `Expires in ${days} days`
}

/**
 * Send, track and withdraw invitations.
 *
 * There is no transactional email provider in this app, so nothing is sent
 * anywhere: the studio gets a link and passes it on themselves, by text, by
 * email, or by reading it out. That is stated plainly rather than hidden,
 * because a staff member who thinks an email went out will wait for a reply
 * that is never coming.
 *
 * The link is shown once, at creation, and cannot be recovered — the database
 * stores only its SHA-256. "Send a new link" issues a fresh invitation, which
 * supersedes (and so revokes) the previous one for that address.
 */
export function InviteManager({
  invitations,
  canInviteStaff,
  now,
}: {
  invitations: InvitationRow[]
  canInviteStaff: boolean
  /** Read once on the server via `requestNow()` — see AGENTS.md on the clock. */
  now: number
}) {
  const router = useRouter()

  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [issued, setIssued] = useState<{ email: string; role: UserRole; url: string } | null>(null)
  const [copied, setCopied] = useState(false)
  const [form, setForm] = useState({
    email: '',
    first_name: '',
    last_name: '',
    role: 'client' as UserRole,
    expires_in_days: 7,
    note: '',
  })

  const [showAll, setShowAll] = useState(false)

  const rows = useMemo(() => {
    const withStatus = invitations.map((i) => ({ row: i, status: statusOf(i, now) }))
    return showAll ? withStatus : withStatus.filter((i) => i.status === 'pending')
  }, [invitations, now, showAll])

  const pendingCount = useMemo(
    () => invitations.filter((i) => statusOf(i, now) === 'pending').length,
    [invitations, now]
  )

  async function send(payload: {
    email: string
    role: UserRole
    first_name?: string | null
    last_name?: string | null
    note?: string | null
    expires_in_days: number
  }) {
    setBusy(true)
    setError(null)
    setCopied(false)

    const res = await fetch('/api/invitations/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).catch(() => null)

    const body = (await res?.json().catch(() => null)) as
      | { ok?: true; url?: string; message?: string }
      | null

    setBusy(false)

    if (!res?.ok || !body?.ok || !body.url) {
      setError(body?.message ?? 'Could not create that invitation.')
      return
    }

    setIssued({ email: payload.email.trim().toLowerCase(), role: payload.role, url: body.url })
    setOpen(false)
    setForm({ email: '', first_name: '', last_name: '', role: 'client', expires_in_days: 7, note: '' })
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
      setError(body?.message ?? 'Could not withdraw that invitation.')
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
      setError('Your browser blocked the clipboard — select the link and copy it by hand.')
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="display text-2xl">Invitations</h2>
          <p className="mt-2 max-w-2xl text-sm text-[var(--color-muted)]">
            Invite someone to set up their own account and password. Nothing is emailed — you
            get a link to send them yourself.
            {pendingCount > 0 && ` ${pendingCount} outstanding.`}
          </p>
        </div>
        <Button variant={open ? 'subtle' : 'primary'} onClick={() => setOpen(!open)}>
          {open ? 'Cancel' : 'Invite someone'}
        </Button>
      </div>

      {/* The one and only time this link can be read. */}
      {issued && (
        <div className="mt-6 border border-[var(--color-accent)] bg-[var(--color-surface)] p-6">
          <p className="label-caps text-[var(--color-accent)]">Link ready</p>
          <p className="mt-2 text-sm">
            Send this to <span className="font-medium">{issued.email}</span>. It sets them up as{' '}
            {ROLE_LABELS[issued.role].toLowerCase()}, works once, and cannot be shown again.
          </p>
          <div className="mt-4 flex flex-wrap items-center gap-3">
            <input
              readOnly
              value={issued.url}
              onFocus={(e) => e.currentTarget.select()}
              className="min-h-11 flex-1 min-w-[16rem] border border-[var(--color-border)] bg-[var(--color-background)] px-3 py-2.5 font-mono text-xs"
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

      {open && (
        <form
          className="mt-6 space-y-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-6"
          onSubmit={(e) => {
            e.preventDefault()
            void send({
              email: form.email,
              role: form.role,
              first_name: form.first_name || null,
              last_name: form.last_name || null,
              note: form.note || null,
              expires_in_days: form.expires_in_days,
            })
          }}
        >
          <div className="grid gap-5 sm:grid-cols-2">
            <Field label="Email" htmlFor="inv_new_email" className="sm:col-span-2">
              <Input
                id="inv_new_email"
                type="email"
                required
                maxLength={254}
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
              />
            </Field>

            <Field label="First name" htmlFor="inv_new_first" hint="Optional — prefills their form.">
              <Input
                id="inv_new_first"
                maxLength={80}
                value={form.first_name}
                onChange={(e) => setForm({ ...form, first_name: e.target.value })}
              />
            </Field>
            <Field label="Last name" htmlFor="inv_new_last">
              <Input
                id="inv_new_last"
                maxLength={80}
                value={form.last_name}
                onChange={(e) => setForm({ ...form, last_name: e.target.value })}
              />
            </Field>

            <Field
              label="Role"
              htmlFor="inv_new_role"
              hint={canInviteStaff ? undefined : 'Only an admin can invite a staff member.'}
            >
              <Select
                id="inv_new_role"
                value={form.role}
                onChange={(e) => setForm({ ...form, role: e.target.value as UserRole })}
              >
                <option value="client">Client</option>
                {canInviteStaff && (
                  <>
                    <option value="provider">Provider</option>
                    <option value="front_desk">Front Desk</option>
                    <option value="manager">Manager</option>
                    <option value="admin">Admin</option>
                  </>
                )}
              </Select>
            </Field>

            <Field label="Link expires" htmlFor="inv_new_expiry" hint="Shorter is safer.">
              <Select
                id="inv_new_expiry"
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
              htmlFor="inv_new_note"
              hint="Shown on the page they land on. Optional."
              className="sm:col-span-2"
            >
              <Textarea
                id="inv_new_note"
                maxLength={500}
                rows={2}
                value={form.note}
                onChange={(e) => setForm({ ...form, note: e.target.value })}
              />
            </Field>
          </div>

          {form.role !== 'client' && (
            <p className="text-sm text-[var(--color-muted)]">
              Whoever opens this link becomes {ROLE_LABELS[form.role].toLowerCase()}. Send it to
              one person, over a channel you trust.
            </p>
          )}

          <Button type="submit" disabled={busy}>
            {busy ? 'Creating…' : 'Create invitation'}
          </Button>
        </form>
      )}

      {error && <p className="mt-4 text-sm text-red-700 dark:text-red-400">{error}</p>}

      <div className="mt-6 flex items-center justify-between">
        <p className="text-sm text-[var(--color-muted)]">
          {rows.length} {showAll ? 'total' : 'outstanding'}
        </p>
        <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Show outstanding only' : 'Show all'}
        </Button>
      </div>

      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[var(--color-border)] text-left">
              <th className="pb-3 font-medium">Email</th>
              <th className="pb-3 font-medium">Role</th>
              <th className="pb-3 font-medium">Invited by</th>
              <th className="pb-3 font-medium">Sent</th>
              <th className="pb-3 font-medium">Expiry</th>
              <th className="pb-3 font-medium">Status</th>
              <th className="pb-3 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--color-border)]">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-[var(--color-muted)]">
                  No invitations {showAll ? 'yet' : 'outstanding'}
                </td>
              </tr>
            ) : (
              rows.map(({ row, status }) => {
                const inviter =
                  row.inviter?.display_name ||
                  `${row.inviter?.first_name ?? ''} ${row.inviter?.last_name ?? ''}`.trim() ||
                  '—'
                const live = status === 'pending'
                const mayTouch = canInviteStaff || !isStaff(row.role)

                return (
                  <tr key={row.id} className="hover:bg-[var(--color-surface)]">
                    <td className="py-3">
                      <span className="block">{row.email}</span>
                      {(row.first_name || row.last_name) && (
                        <span className="block text-xs text-[var(--color-muted)]">
                          {`${row.first_name ?? ''} ${row.last_name ?? ''}`.trim()}
                        </span>
                      )}
                    </td>
                    <td className="py-3">
                      <Badge tone={isStaff(row.role) ? 'accent' : 'neutral'}>
                        {ROLE_LABELS[row.role]}
                      </Badge>
                    </td>
                    <td className="py-3 text-[var(--color-muted)]">{inviter}</td>
                    <td className="py-3 text-[var(--color-muted)]">{shortDate(row.created_at)}</td>
                    <td className="py-3 text-[var(--color-muted)]">
                      {status === 'accepted'
                        ? `Accepted ${shortDate(row.accepted_at!)}`
                        : status === 'revoked'
                          ? `Withdrawn ${shortDate(row.revoked_at!)}`
                          : expiryLabel(row.expires_at, now)}
                    </td>
                    <td className="py-3">
                      <Badge tone={STATUS_TONE[status]}>{status}</Badge>
                    </td>
                    <td className="py-3">
                      {status !== 'accepted' && mayTouch && (
                        <div className="flex flex-wrap gap-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy}
                            onClick={() =>
                              void send({
                                email: row.email,
                                role: row.role,
                                first_name: row.first_name,
                                last_name: row.last_name,
                                note: row.note,
                                expires_in_days: 7,
                              })
                            }
                          >
                            New link
                          </Button>
                          {live && (
                            <Button variant="ghost" size="sm" onClick={() => void revoke(row.id)}>
                              Withdraw
                            </Button>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  )
}
