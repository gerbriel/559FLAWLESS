'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { toast } from 'sonner'
import { Check, RotateCcw, Ticket } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone } from '@/lib/time'
import { redeemSession, undoRedemption } from '@/app/dashboard/packages/actions'
import { packageErrorMessage } from '@/app/dashboard/packages/errors'

/**
 * Spending a prepaid session, in the two places it comes up.
 *
 * `PackageRedeemButton` is the whole act: one balance, one visit, one session.
 * It calls the server action and says what happened — including the case that
 * matters, which is the second person pressing it. The unique constraint on
 * `(appointment_id, client_package_id)` is what refuses them, and
 * `already_redeemed` is that refusal in a sentence.
 *
 * `PackageRedeem` wraps it in a picker for the screens that start from the
 * balance rather than the visit: it asks which appointment, and answers with
 * what each one still owes so nobody spends a session on a visit that is
 * already settled.
 */

/* ── The act itself ───────────────────────────────────────── */

export function PackageRedeemButton({
  clientPackageId,
  appointmentId,
  /** What it will cover, in cents. Shown on the button so the desk can see it. */
  coversCents,
  disabled,
  /** Already spent on this visit — the button becomes the way back. */
  redeemed,
  size = 'sm',
}: {
  clientPackageId: number
  appointmentId: string
  coversCents?: number | null
  disabled?: boolean
  redeemed?: boolean
  size?: 'sm' | 'md'
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function spend() {
    startTransition(async () => {
      const result = await redeemSession({ clientPackageId, appointmentId })
      if (!result.ok) {
        toast.error(packageErrorMessage(result.error))
        // `already_redeemed` and `balance_moved` both mean the screen is
        // showing something that is no longer true. Refetch rather than leave
        // a button that will keep failing.
        if (result.error === 'already_redeemed' || result.error === 'balance_moved') {
          router.refresh()
        }
        return
      }
      toast.success(`Session used — ${formatMoney(result.data.coveredCents)} off this visit.`, {
        description:
          result.data.sessionsRemaining === 0
            ? 'That was the last one on the package.'
            : `${result.data.sessionsRemaining} left.`,
      })
      router.refresh()
    })
  }

  function undo() {
    startTransition(async () => {
      const result = await undoRedemption({ clientPackageId, appointmentId })
      if (!result.ok) {
        toast.error(packageErrorMessage(result.error))
        return
      }
      toast.success('Session put back.', {
        description:
          result.data.reversedCents === null
            ? `${result.data.sessionsRemaining} on the package. No credit was found to reverse — check what this visit owes.`
            : `${result.data.sessionsRemaining} on the package, and ${formatMoney(result.data.reversedCents)} back onto what this visit owes.`,
      })
      router.refresh()
    })
  }

  if (redeemed) {
    return (
      <Button variant="ghost" size={size} disabled={pending} onClick={undo}>
        <RotateCcw className="h-4 w-4" strokeWidth={1.75} />
        {pending ? 'Putting it back…' : 'Put the session back'}
      </Button>
    )
  }

  return (
    <Button variant="subtle" size={size} disabled={disabled || pending} onClick={spend}>
      <Ticket className="h-4 w-4" strokeWidth={1.75} />
      {pending
        ? 'Using a session…'
        : coversCents && coversCents > 0
          ? `Use a session — ${formatMoney(coversCents)}`
          : 'Use a session'}
    </Button>
  )
}

/* ── The picker ───────────────────────────────────────────── */

interface Candidate {
  id: string
  startsAt: string
  status: string
  coveredName: string | null
  coveredCents: number
  outstandingCents: number
  redeemed: boolean
}

/**
 * Which visit is this session for?
 *
 * The eligibility rules here are the same ones `redeemSession` enforces, said
 * ahead of the click rather than after it — the server is still the authority
 * and re-derives all of it, this is only so nobody presses a button that was
 * always going to refuse.
 */
export function PackageRedeem({
  clientPackageId,
  clientId,
  packageName,
  packageServiceId,
  sessionsRemaining,
  timeZone,
}: {
  clientPackageId: number
  clientId: string
  packageName: string
  /** Null is an open package — any service on the visit will do. */
  packageServiceId: number | null
  sessionsRemaining: number
  timeZone: string
}) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [candidates, setCandidates] = useState<Candidate[] | null>(null)

  async function load() {
    setLoading(true)
    const supabase = createClient()

    // One select string, one literal. Split across a `+` and postgrest-js
    // widens it to `string` and the whole result collapses to SelectQueryError.
    const { data: appointments, error } = await supabase
      .from('appointments')
      .select(
        'id, starts_at, status, total_cents, appointment_services(service_id, name_snapshot, price_cents), package_redemptions(client_package_id)'
      )
      .eq('client_id', clientId)
      .in('status', ['confirmed', 'checked_in', 'completed'])
      .order('starts_at', { ascending: false })
      .limit(25)

    if (error || !appointments) {
      setLoading(false)
      toast.error('Could not read this client’s visits.')
      return
    }

    const ids = appointments.map((a) => a.id)
    const { data: payments } = ids.length
      ? await supabase
          .from('payments')
          .select('appointment_id, amount_cents')
          .in('appointment_id', ids)
          .eq('status', 'succeeded')
      : { data: [] }

    const takenByAppointment = new Map<string, number>()
    for (const p of payments ?? []) {
      if (!p.appointment_id) continue
      takenByAppointment.set(
        p.appointment_id,
        (takenByAppointment.get(p.appointment_id) ?? 0) + p.amount_cents
      )
    }

    const rows: Candidate[] = []
    for (const a of appointments) {
      const lines = (a.appointment_services ?? []) as {
        service_id: number | null
        name_snapshot: string
        price_cents: number
      }[]

      // An open package covers a service, never an add-on: an add-on row on
      // `appointment_services` carries `addon_id` and a null `service_id`.
      const eligible =
        packageServiceId === null
          ? lines.filter((l) => l.service_id !== null)
          : lines.filter((l) => l.service_id === packageServiceId)
      if (eligible.length === 0) continue

      // The dearest covered line — the same reading the server takes.
      const best = eligible.reduce((top, l) => (l.price_cents > top.price_cents ? l : top))
      const outstanding = Math.max(a.total_cents - (takenByAppointment.get(a.id) ?? 0), 0)
      const spent = ((a.package_redemptions ?? []) as { client_package_id: number }[]).some(
        (r) => r.client_package_id === clientPackageId
      )

      rows.push({
        id: a.id,
        startsAt: a.starts_at,
        status: a.status,
        coveredName: best.name_snapshot,
        coveredCents: Math.min(best.price_cents, outstanding),
        outstandingCents: outstanding,
        redeemed: spent,
      })
    }

    setCandidates(rows)
    setLoading(false)
  }

  if (!open) {
    return (
      <Button
        variant="subtle"
        size="sm"
        onClick={() => {
          setOpen(true)
          void load()
        }}
      >
        <Ticket className="h-4 w-4" strokeWidth={1.75} />
        Use a session
      </Button>
    )
  }

  return (
    <div
      data-ui="tile"
      className="mt-3 border border-[var(--color-border)] bg-[var(--color-linen)] p-4 dark:bg-[var(--color-background)]"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="label-caps text-[var(--color-muted)]">
          {packageName} · {sessionsRemaining} left
        </p>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="label-caps text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
        >
          Close
        </button>
      </div>

      {loading && <p className="mt-3 text-sm text-[var(--color-muted)]">Reading their visits…</p>}

      {!loading && candidates !== null && candidates.length === 0 && (
        <p className="mt-3 max-w-prose text-sm text-[var(--color-muted)]">
          No visit on file includes a service this package pays for. Book the treatment
          first, then spend the session against it.
        </p>
      )}

      {!loading && candidates !== null && candidates.length > 0 && (
        <ul className="mt-3 divide-y divide-[var(--color-border)]">
          {candidates.map((c) => {
            const settled = !c.redeemed && c.outstandingCents === 0
            return (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="min-w-0">
                  <Link
                    href={`/dashboard/appointments/${c.id}`}
                    className="text-sm underline-offset-4 hover:underline"
                  >
                    {formatDateTimeInTimeZone(new Date(c.startsAt), timeZone)}
                  </Link>
                  <p className="mt-0.5 text-xs text-[var(--color-muted)]">
                    {c.coveredName}
                    {c.redeemed ? (
                      ' · covered by this package'
                    ) : settled ? (
                      ' · already paid in full'
                    ) : (
                      <> · {formatMoney(c.outstandingCents)} outstanding</>
                    )}
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  {c.redeemed && (
                    <Badge tone="success" size="sm">
                      <Check className="h-3 w-3" strokeWidth={2.5} />
                      Used
                    </Badge>
                  )}
                  <PackageRedeemButton
                    clientPackageId={clientPackageId}
                    appointmentId={c.id}
                    coversCents={c.coveredCents}
                    redeemed={c.redeemed}
                    disabled={settled || (sessionsRemaining <= 0 && !c.redeemed)}
                  />
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
