'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/field'
import { Panel } from '@/components/ui/dashboard'
import { createClient } from '@/lib/supabase/client'
import { formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone } from '@/lib/time'
import type { UnmatchedReason } from '@/types/database'

const STUDIO_TZ = 'America/Los_Angeles'

export interface UnmatchedRow {
  id: number
  payment_intent_id: string
  amount_cents: number
  description: string | null
  paid_at: string
  kind: 'payment' | 'overpaid'
  reason: UnmatchedReason
}

export interface AwaitingTicketOption {
  id: number
  amount_cents: number
  who: string
  created_at: string
}

const REASON: Record<UnmatchedReason, string> = {
  no_ticket: 'No sale was waiting for this amount',
  several_tickets: 'More than one sale was waiting for this amount',
  ticket_cancelled: 'Paid for a sale that had been cancelled',
  ticket_expired: 'Paid for a sale that had lapsed',
  ticket_paid: 'Paid for a sale that was already paid. This is a second payment',
  overpaid: 'More than the sale owed. Refund the difference in Stripe',
}

/**
 * Card payments taken in the Stripe app that the webhook could not tie to one
 * till sale (090). Front desk matches one to an awaiting sale of the same
 * amount; a manager can dismiss one once it is dealt with (refunded in
 * Stripe, say). The match route and the dismiss function each re-check
 * everything; this only offers the choice.
 */
export function UnmatchedCardPayments({
  rows,
  tickets,
  canDismiss,
}: {
  rows: UnmatchedRow[]
  tickets: AwaitingTicketOption[]
  canDismiss: boolean
}) {
  const router = useRouter()
  const [picked, setPicked] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState<number | null>(null)

  async function match(row: UnmatchedRow, ticketId: string) {
    setBusy(row.id)
    try {
      const res = await fetch(`/api/pos/ticket/${ticketId}/match`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payment_intent_id: row.payment_intent_id }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.message ?? 'Could not match that payment.')
        return
      }
      toast.success('Matched. The sale is paid.')
      router.refresh()
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setBusy(null)
    }
  }

  async function dismiss(row: UnmatchedRow) {
    const note = window.prompt('What happened to it? (for example, refunded in Stripe)') ?? null
    if (note === null) return
    setBusy(row.id)
    const { data, error } = await createClient().rpc('dismiss_unmatched_payment', { p_id: row.id, p_note: note })
    setBusy(null)
    if (error || !data) {
      toast.error('Could not dismiss that payment.')
      return
    }
    toast.success('Dismissed.')
    router.refresh()
  }

  return (
    <Panel className="mt-8 p-5">
      <h2 className="label-caps">Card payments not matched to a sale</h2>
      <p className="mt-1 max-w-prose text-xs text-[var(--color-muted)]">
        Taken in the Stripe app, but Stripe could not say which till sale they were for. Match each
        one to the sale waiting for the same amount.
      </p>
      <ul className="mt-4 divide-y divide-[var(--color-border)]">
        {rows.map((row) => {
          // The overpaid part of a settled sale is a refund to make, not a
          // payment looking for its sale.
          const options =
            row.kind === 'payment' ? tickets.filter((t) => t.amount_cents === row.amount_cents) : []
          const choice = picked[row.id] ?? (options.length === 1 ? String(options[0].id) : '')
          return (
            <li key={row.id} className="flex flex-wrap items-center gap-x-5 gap-y-2 py-3 text-sm">
              <span className="w-20 tabular-nums">{formatMoney(row.amount_cents)}</span>
              <span className="min-w-0 flex-1">
                {formatDateTimeInTimeZone(new Date(row.paid_at), STUDIO_TZ)}
                {row.description ? ` · ${row.description}` : ''}
                <span className="block text-xs text-[var(--color-muted)]">{REASON[row.reason]}</span>
              </span>
              {options.length > 0 ? (
                <>
                  <Select
                    aria-label="Sale to match"
                    value={choice}
                    onChange={(e) => setPicked((cur) => ({ ...cur, [row.id]: e.target.value }))}
                    className="w-auto"
                  >
                    <option value="">Pick the sale</option>
                    {options.map((t) => (
                      <option key={t.id} value={t.id}>
                        #{t.id} · {t.who} · {formatDateTimeInTimeZone(new Date(t.created_at), STUDIO_TZ)}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="subtle"
                    disabled={!choice || busy !== null}
                    onClick={() => void match(row, choice)}
                  >
                    Match
                  </Button>
                </>
              ) : row.kind === 'payment' ? (
                <span className="text-xs text-[var(--color-muted)]">No sale waiting for this amount</span>
              ) : null}
              {canDismiss && (
                <Button variant="subtle" disabled={busy !== null} onClick={() => void dismiss(row)}>
                  Dismiss
                </Button>
              )}
            </li>
          )
        })}
      </ul>
    </Panel>
  )
}
