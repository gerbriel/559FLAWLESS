'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Check } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select } from '@/components/ui/field'
import { formatMoney } from '@/lib/utils'

export interface PaymentRecord {
  id: number
  amount_cents: number
  method: string
  kind: string
  note: string | null
  created_at: string
}

/** "$42.00" → 4200. Null if it isn't a number. */
function toCents(dollars: string): number | null {
  const n = Number(dollars.replace(/[$,\s]/g, ''))
  if (!Number.isFinite(n)) return null
  return Math.round(n * 100)
}

/**
 * The money side of an appointment: what has been taken, and what is left.
 *
 * The deposit usually arrives through Stripe before the visit; the balance is
 * handed over in the room. Both land in the same `payments` table, so the
 * balance here is the arithmetic rather than a flag someone has to remember to
 * flip.
 */
export function TakePayment({
  appointmentId,
  totalCents,
  balanceCents,
  payments,
  settled,
}: {
  appointmentId: string
  totalCents: number
  balanceCents: number
  payments: PaymentRecord[]
  /** Cancelled and no-show appointments are not billed for the treatment. */
  settled: boolean
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [amount, setAmount] = useState((balanceCents / 100).toFixed(2))
  const [method, setMethod] = useState<
    'cash' | 'card' | 'gift_card' | 'apple_pay' | 'zelle' | 'paypal' | 'venmo' | 'cashapp' | 'other'
  >('card')
  const [note, setNote] = useState('')

  const paid = payments.reduce((sum, p) => sum + p.amount_cents, 0)

  async function record(e: React.FormEvent) {
    e.preventDefault()

    const cents = toCents(amount)
    if (cents === null || cents === 0) {
      toast.error('Enter an amount.')
      return
    }
    if (cents < 0) {
      toast.error('To refund, use a refund rather than a negative payment.')
      return
    }

    setBusy(true)
    const { error } = await createClient().rpc('record_payment', {
      p_amount_cents: cents,
      // A payment covering the deposit is recorded as one, so the deposit flag
      // the reminders read moves with it.
      p_kind: balanceCents === totalCents && cents < totalCents ? 'deposit' : 'service',
      p_method: method,
      p_appointment: appointmentId,
      p_note: note.trim() || null,
    })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not record that payment.')
      return
    }

    toast.success(`${formatMoney(cents)} recorded.`)
    setNote('')
    setOpen(false)
    router.refresh()
  }

  return (
    <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-6">
      <h3 className="label-caps mb-5 text-[var(--color-accent)]">Payment</h3>

      <dl className="space-y-2 text-sm">
        <div className="flex justify-between">
          <dt className="text-[var(--color-muted)]">Total</dt>
          <dd className="tabular-nums">{formatMoney(totalCents)}</dd>
        </div>
        <div className="flex justify-between">
          <dt className="text-[var(--color-muted)]">Taken</dt>
          <dd className="tabular-nums">{formatMoney(paid)}</dd>
        </div>
        <div className="flex justify-between border-t border-[var(--color-border)] pt-2 text-base">
          <dt>{settled ? 'Not billed' : 'Balance'}</dt>
          <dd className="tabular-nums">
            {settled ? (
              <span className="text-[var(--color-muted)]">—</span>
            ) : balanceCents === 0 ? (
              <span className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
                <Check className="h-4 w-4" strokeWidth={2.5} />
                Paid
              </span>
            ) : (
              formatMoney(balanceCents)
            )}
          </dd>
        </div>
      </dl>

      {payments.length > 0 && (
        <ul className="mt-5 space-y-2 border-t border-[var(--color-border)] pt-4">
          {payments.map((p) => (
            <li key={p.id} className="flex justify-between gap-3 text-xs">
              <span className="text-[var(--color-muted)]">
                {new Date(p.created_at).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                })}{' '}
                · {p.kind.replace('_', ' ')} · {p.method.replace('_', ' ')}
                {p.note ? ` · ${p.note}` : ''}
              </span>
              <span className="shrink-0 tabular-nums">{formatMoney(p.amount_cents)}</span>
            </li>
          ))}
        </ul>
      )}

      {!settled &&
        (open ? (
          <form onSubmit={record} className="mt-5 space-y-3 border-t border-[var(--color-border)] pt-5">
            <Field label="Amount" htmlFor="pay_amount" hint="In dollars.">
              <Input
                id="pay_amount"
                inputMode="decimal"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </Field>

            <Field label="Paid by" htmlFor="pay_method">
              <Select
                id="pay_method"
                value={method}
                onChange={(e) => setMethod(e.target.value as typeof method)}
              >
                <option value="card">Card</option>
                <option value="cash">Cash</option>
                <option value="apple_pay">Apple Pay</option>
                <option value="zelle">Zelle</option>
                <option value="paypal">PayPal</option>
                <option value="venmo">Venmo</option>
                <option value="cashapp">Cash App</option>
                <option value="gift_card">Gift card</option>
                <option value="other">Other</option>
              </Select>
            </Field>

            <Field label="Note" htmlFor="pay_note">
              <Input
                id="pay_note"
                maxLength={200}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </Field>

            <div className="flex gap-2">
              <Button type="submit" size="sm" disabled={busy}>
                {busy ? 'Recording…' : 'Record'}
              </Button>
              <Button type="button" size="sm" variant="subtle" onClick={() => setOpen(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          balanceCents > 0 && (
            <Button
              size="sm"
              variant="subtle"
              className="mt-5"
              onClick={() => {
                setAmount((balanceCents / 100).toFixed(2))
                setOpen(true)
              }}
            >
              Take {formatMoney(balanceCents)}
            </Button>
          )
        ))}
    </div>
  )
}
