'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Search, ArrowLeftRight, AlertTriangle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input } from '@/components/ui/field'
import { formatMoney, initials } from '@/lib/utils'

interface ClientSummary {
  id: string
  first_name: string | null
  last_name: string | null
  email: string | null
  phone: string | null
  created_at: string | null
  visit_count: number
  lifetime_value_cents: number
}

const fullName = (c: { first_name: string | null; last_name: string | null }) =>
  `${c.first_name ?? ''} ${c.last_name ?? ''}`.trim() || 'Unnamed'

/**
 * Fold a duplicate account into this one — admin only, and deliberately slow.
 *
 * The dangerous part is not the merge, it is merging the wrong way round or
 * the wrong two people. So: both records side by side with the numbers that
 * tell them apart, an explicit swap for direction, and the folded account's
 * name typed back before the button arms. The server (074) refuses anything
 * but two client accounts and writes the audit trail either way.
 */
export function MergeClients({ current }: { current: ClientSummary }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [searchTerm, setSearchTerm] = useState('')
  const [results, setResults] = useState<
    Array<{ id: string; first_name: string | null; last_name: string | null; email: string | null; phone: string | null }>
  >([])
  const [other, setOther] = useState<ClientSummary | null>(null)
  // true: the page's client survives (the common case). false: the other does.
  const [keepCurrent, setKeepCurrent] = useState(true)
  const [reason, setReason] = useState('')
  const [confirmName, setConfirmName] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const trimmed = searchTerm.trim()
    const timer = setTimeout(async () => {
      if (!trimmed || other) {
        setResults([])
        return
      }
      const term = `%${trimmed}%`
      const { data } = await createClient()
        .from('profiles')
        .select('id, first_name, last_name, email, phone')
        .eq('role', 'client')
        .neq('id', current.id)
        .or(`first_name.ilike.${term},last_name.ilike.${term},email.ilike.${term},phone.ilike.${term}`)
        .limit(8)
      setResults(data ?? [])
    }, 300)
    return () => clearTimeout(timer)
  }, [searchTerm, other, current.id])

  async function pick(candidate: {
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
    phone: string | null
  }) {
    setSearchTerm('')
    setResults([])
    const supabase = createClient()
    const [{ data: profile }, { data: record }] = await Promise.all([
      supabase
        .from('profiles')
        .select('created_at')
        .eq('id', candidate.id)
        .maybeSingle(),
      supabase
        .from('client_records')
        .select('visit_count, lifetime_value_cents')
        .eq('client_id', candidate.id)
        .maybeSingle(),
    ])
    setOther({
      ...candidate,
      created_at: profile?.created_at ?? null,
      visit_count: record?.visit_count ?? 0,
      lifetime_value_cents: record?.lifetime_value_cents ?? 0,
    })
  }

  const survivor = keepCurrent ? current : other
  const loser = keepCurrent ? other : current
  const armed =
    !!loser && confirmName.trim().toLowerCase() === fullName(loser).toLowerCase()

  async function merge() {
    if (!survivor || !loser || !armed) return
    setBusy(true)
    try {
      const res = await fetch('/api/admin/clients/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          survivorId: survivor.id,
          loserId: loser.id,
          reason: reason.trim() || null,
        }),
      })
      const data = (await res.json().catch(() => null)) as {
        ok?: boolean
        message?: string
        result?: { moved?: Record<string, number> }
      } | null

      if (!res.ok || !data?.ok) {
        toast.error(data?.message ?? 'The merge did not go through. Nothing was changed.')
        return
      }

      const moved = data.result?.moved ?? {}
      const highlights = ['appointments', 'orders', 'payments']
        .filter((k) => (moved[k] ?? 0) > 0)
        .map((k) => `${moved[k]} ${k}`)
        .join(', ')
      toast.success(
        `Merged. ${highlights ? `Moved ${highlights}.` : 'Records combined.'} Their old sign-in is closed.`
      )

      if (keepCurrent) {
        router.refresh()
        setOpen(false)
        setOther(null)
        setConfirmName('')
        setReason('')
      } else {
        // This page is now the tombstone — go to the record that survived.
        router.push(`/dashboard/clients/${survivor.id}`)
      }
    } catch {
      toast.error('Could not reach the server. Nothing was changed.')
    } finally {
      setBusy(false)
    }
  }

  if (!open) {
    return (
      <section className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
        <h3 className="label-caps mb-3 text-[var(--color-muted)]">Duplicate account?</h3>
        <p className="text-sm text-[var(--color-muted)]">
          If this person also exists under another email, an admin can fold the
          two records into one — appointments, money, forms and clinical history
          included.
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="mt-4"
          onClick={() => setOpen(true)}
        >
          Merge a duplicate into this record
        </Button>
      </section>
    )
  }

  return (
    <section className="border border-[var(--color-accent)] bg-[var(--color-surface)] p-6">
      <div className="flex items-start justify-between gap-4">
        <h3 className="label-caps text-[var(--color-accent)]">Merge accounts</h3>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false)
            setOther(null)
            setConfirmName('')
          }}
        >
          Cancel
        </Button>
      </div>

      {!other ? (
        <div className="mt-4">
          <p className="mb-3 text-sm text-[var(--color-muted)]">
            Find the duplicate account — the other record this same person
            exists under.
          </p>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]" />
            <Input
              type="search"
              placeholder="Search by name, email, or phone..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="pl-10"
            />
          </div>
          {results.length > 0 && (
            <ul className="mt-2 divide-y divide-[var(--color-border)] border border-[var(--color-border)]">
              {results.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => void pick(c)}
                    className="flex w-full items-center gap-3 p-3 text-left transition-colors hover:bg-[var(--color-background)]"
                  >
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center border border-[var(--color-border)] text-xs">
                      {initials(c.first_name, c.last_name)}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-sm">{fullName(c)}</span>
                      <span className="block truncate text-xs text-[var(--color-muted)]">
                        {c.email ?? c.phone ?? 'no contact details'}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="mt-4 space-y-5">
          <div className="grid gap-3 sm:grid-cols-2">
            {[
              { c: survivor!, label: 'Keeps everything', keep: true },
              { c: loser!, label: 'Folded in & closed', keep: false },
            ].map(({ c, label, keep }) => (
              <div
                key={c.id}
                className={`border p-4 ${
                  keep
                    ? 'border-[var(--color-accent)]'
                    : 'border-[var(--color-border)]'
                }`}
              >
                <p className="label-caps text-xs text-[var(--color-muted)]">{label}</p>
                <p className="mt-2 text-sm font-medium">{fullName(c)}</p>
                <dl className="mt-2 space-y-1 text-xs text-[var(--color-muted)]">
                  <div>{c.email ?? 'no email'}</div>
                  <div>{c.phone ?? 'no phone'}</div>
                  <div>
                    Joined{' '}
                    {c.created_at
                      ? new Date(c.created_at).toLocaleDateString('en-US', {
                          month: 'short',
                          day: 'numeric',
                          year: 'numeric',
                        })
                      : '—'}
                  </div>
                  <div className="tabular-nums">
                    {c.visit_count} visits · {formatMoney(c.lifetime_value_cents)} lifetime
                  </div>
                </dl>
              </div>
            ))}
          </div>

          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => {
                setKeepCurrent(!keepCurrent)
                setConfirmName('')
              }}
            >
              <ArrowLeftRight className="mr-1.5 h-3.5 w-3.5" strokeWidth={1.5} />
              Keep the other one instead
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setOther(null)
                setConfirmName('')
              }}
            >
              Pick a different account
            </Button>
          </div>

          <div className="flex items-start gap-2 border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-sm">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <p>
              Everything on <strong>{fullName(loser!)}</strong> — appointments,
              orders, payments, forms, clinical history — moves to{' '}
              <strong>{fullName(survivor!)}</strong>, and their old sign-in
              stops working. This is not undoable from a button.
            </p>
          </div>

          <Field label="Reason" htmlFor="merge_reason" hint="Optional; kept on the record.">
            <Input
              id="merge_reason"
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. signed up twice under a second email"
            />
          </Field>

          <Field
            label={`Type "${fullName(loser!)}" to confirm`}
            htmlFor="merge_confirm"
            hint="The name of the account being folded in."
          >
            <Input
              id="merge_confirm"
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              autoComplete="off"
            />
          </Field>

          <Button
            type="button"
            variant="danger"
            size="sm"
            disabled={!armed || busy}
            onClick={() => void merge()}
          >
            {busy ? 'Merging…' : 'Merge these accounts'}
          </Button>
        </div>
      )}
    </section>
  )
}
