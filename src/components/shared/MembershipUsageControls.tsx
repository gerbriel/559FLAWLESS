'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import type { MembershipChargeMethod, MembershipChargeStatus } from '@/types/memberships'

/**
 * The manager's hands on a live membership's usage and billing (089): record a
 * visit that happened outside the system, record or remove a perk use, and
 * settle, void or refund a charge.
 *
 * None of these decide anything. record_membership_session() and
 * record_membership_perk_use() check cover, period and allowance themselves
 * and say why in error.message, which is shown as it comes. The table writes
 * (void, refund, removing a hand-recorded perk use) are manager-only in RLS;
 * the panel only draws these for managers so nobody is offered a button that
 * will be refused.
 */

/** Dollars typed by a person, as integer cents. Never through a float. */
function dollarsToCents(text: string): number | null {
  const t = text.trim().replace(/^\$/, '')
  if (t === '') return 0
  const m = /^(\d{1,6})(?:\.(\d{0,2}))?$/.exec(t)
  if (!m) return null
  const cents = (m[2] ?? '').padEnd(2, '0')
  return Number(m[1]) * 100 + Number(cents)
}

const LINK =
  'label-caps shrink-0 text-[var(--color-muted)] hover:text-[var(--color-accent)] disabled:opacity-50'

/** A treatment a session may be recorded against. */
export interface CoveredTreatment {
  id: number
  name: string
}

/**
 * "Record a visit used": a session spent at the counter or before the studio
 * used this system. Manager only.
 */
export function RecordSessionForm({
  clientMembershipId,
  treatments,
  todayKey,
  periodStartKey,
}: {
  clientMembershipId: number
  treatments: CoveredTreatment[]
  /** 'YYYY-MM-DD' in the studio's zone, from the server's one clock reading. */
  todayKey: string
  /** The current period's first day, 'YYYY-MM-DD' in the studio's zone. */
  periodStartKey: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [serviceId, setServiceId] = useState(treatments.length === 1 ? String(treatments[0].id) : '')
  const [usedOn, setUsedOn] = useState(todayKey)
  const [note, setNote] = useState('')

  if (treatments.length === 0) return null

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!serviceId) {
      toast.error('Pick the treatment they had.')
      return
    }
    setBusy(true)
    const { error } = await createClient().rpc('record_membership_session', {
      p_client_membership: clientMembershipId,
      p_service: Number(serviceId),
      p_used_on: usedOn,
      p_note: note.trim() || null,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message || 'Could not record that visit.')
      return
    }
    toast.success('Visit recorded against this period.')
    setOpen(false)
    setNote('')
    setUsedOn(todayKey)
    router.refresh()
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={LINK}>
        Record a visit used
      </button>
    )
  }

  return (
    <form
      onSubmit={submit}
      className="space-y-3 border-t border-[var(--color-border)] pt-3"
      aria-label="Record a visit used"
    >
      <Field label="Treatment" htmlFor={`rs_svc_${clientMembershipId}`}>
        <Select
          id={`rs_svc_${clientMembershipId}`}
          value={serviceId}
          onChange={(e) => setServiceId(e.target.value)}
        >
          <option value="">Choose one…</option>
          {treatments.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </Select>
      </Field>
      <Field label="Used on" htmlFor={`rs_on_${clientMembershipId}`}>
        <Input
          id={`rs_on_${clientMembershipId}`}
          type="date"
          required
          min={periodStartKey}
          max={todayKey}
          value={usedOn}
          onChange={(e) => setUsedOn(e.target.value)}
        />
      </Field>
      <Field label="Note" htmlFor={`rs_note_${clientMembershipId}`} hint="Optional.">
        <Textarea
          id={`rs_note_${clientMembershipId}`}
          rows={2}
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2.5">
        <Button type="submit" size="sm" disabled={busy || !serviceId || !usedOn}>
          {busy ? 'Recording…' : 'Record visit'}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/** "Record a use" of one product perk, for a sale outside the shop. Manager only. */
export function RecordPerkUseForm({
  perkId,
  clientMembershipId,
  todayKey,
  minKey,
}: {
  perkId: number
  clientMembershipId: number
  todayKey: string
  /** The earliest day inside the perk's window, 'YYYY-MM-DD'. */
  minKey: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [usedOn, setUsedOn] = useState(todayKey)
  const [discount, setDiscount] = useState('')
  const [note, setNote] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    const cents = dollarsToCents(discount)
    if (cents === null) {
      toast.error('Enter the discount in dollars, like 12.50, or leave it blank.')
      return
    }
    setBusy(true)
    const { error } = await createClient().rpc('record_membership_perk_use', {
      p_perk: perkId,
      p_client_membership: clientMembershipId,
      p_used_on: usedOn,
      p_discount_cents: cents,
      p_note: note.trim() || null,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message || 'Could not record that use.')
      return
    }
    toast.success('Perk use recorded.')
    setOpen(false)
    setDiscount('')
    setNote('')
    setUsedOn(todayKey)
    router.refresh()
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className={LINK}>
        Record a use
      </button>
    )
  }

  return (
    <form onSubmit={submit} className="space-y-3 pt-2" aria-label="Record a perk use">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Used on" htmlFor={`pu_on_${perkId}`}>
          <Input
            id={`pu_on_${perkId}`}
            type="date"
            required
            min={minKey}
            max={todayKey}
            value={usedOn}
            onChange={(e) => setUsedOn(e.target.value)}
          />
        </Field>
        <Field label="Discount" htmlFor={`pu_amt_${perkId}`} hint="Optional, in dollars.">
          <Input
            id={`pu_amt_${perkId}`}
            inputMode="decimal"
            placeholder="0.00"
            value={discount}
            onChange={(e) => setDiscount(e.target.value)}
          />
        </Field>
      </div>
      <Field label="Note" htmlFor={`pu_note_${perkId}`} hint="Optional.">
        <Input
          id={`pu_note_${perkId}`}
          maxLength={300}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </Field>
      <div className="flex flex-wrap gap-2.5">
        <Button type="submit" size="sm" disabled={busy || !usedOn}>
          {busy ? 'Recording…' : 'Record use'}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

/**
 * Remove a hand-recorded perk use. RLS allows the delete only where order_id
 * is null, so a use an order won cannot be removed from here even by hand.
 */
export function RemovePerkUse({ redemptionId }: { redemptionId: number }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  async function remove() {
    if (!confirm('Remove this recorded use? They get the use back.')) return
    setBusy(true)
    const { data, error } = await createClient()
      .from('membership_perk_redemptions')
      .delete()
      .eq('id', redemptionId)
      .select('id')
    setBusy(false)
    if (error || data?.length !== 1) {
      toast.error(error?.message || 'Could not remove that use.')
      return
    }
    toast.success('Use removed.')
    router.refresh()
  }

  return (
    <button type="button" onClick={remove} disabled={busy} className={LINK}>
      {busy ? 'Removing…' : 'Remove'}
    </button>
  )
}

/**
 * The manager's controls on one membership charge: mark paid (due or
 * failed), void (due or failed), mark refunded (paid by hand). A charge
 * Stripe took is refunded in Stripe, so that row says so instead.
 */
export function ChargeActions({
  chargeId,
  status,
  method,
}: {
  chargeId: number
  status: MembershipChargeStatus
  method: MembershipChargeMethod
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [payMethod, setPayMethod] = useState<MembershipChargeMethod>('card')
  const [closing, setClosing] = useState<'void' | 'refunded' | null>(null)
  const [note, setNote] = useState('')

  async function markPaid() {
    setBusy(true)
    const { error } = await createClient().rpc('mark_membership_charge_paid', {
      p_charge: chargeId,
      p_method: payMethod,
    })
    setBusy(false)
    if (error) {
      toast.error(error.message || 'Could not record that payment.')
      return
    }
    toast.success('Recorded as paid.')
    router.refresh()
  }

  async function close(e: React.FormEvent) {
    e.preventDefault()
    if (!closing) return
    if (
      !confirm(
        closing === 'void'
          ? 'Void this charge? It will no longer show as owed.'
          : 'Mark this charge refunded? Record it only once the money has gone back to them.'
      )
    ) {
      return
    }
    setBusy(true)
    const trimmed = note.trim()
    const { data, error } = await createClient()
      .from('membership_charges')
      .update(trimmed ? { status: closing, note: trimmed } : { status: closing })
      .eq('id', chargeId)
      .select('id')
    setBusy(false)
    if (error || data?.length !== 1) {
      toast.error(error?.message || 'Could not change that charge.')
      return
    }
    toast.success(closing === 'void' ? 'Charge voided.' : 'Marked refunded.')
    setClosing(null)
    setNote('')
    router.refresh()
  }

  const open = status === 'due' || status === 'failed'
  const refundable = status === 'paid' && method !== 'stripe'

  if (!open && !refundable) {
    return status === 'paid' && method === 'stripe' ? (
      <p className="text-[var(--color-muted)]">Refund this one in Stripe.</p>
    ) : null
  }

  if (closing) {
    return (
      <form onSubmit={close} className="flex flex-wrap items-end gap-2.5">
        <Field
          label={closing === 'void' ? 'Why void it' : 'Refund note'}
          htmlFor={`ch_note_${chargeId}`}
          hint="Optional."
          className="min-w-40 flex-1"
        >
          <Input
            id={`ch_note_${chargeId}`}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>
        <Button type="submit" size="sm" variant="subtle" disabled={busy}>
          {busy ? 'Saving…' : closing === 'void' ? 'Void charge' : 'Mark refunded'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => setClosing(null)}>
          Cancel
        </Button>
      </form>
    )
  }

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      {open && (
        <>
          <Select
            aria-label="Paid by"
            value={payMethod}
            onChange={(e) => setPayMethod(e.target.value as MembershipChargeMethod)}
            className="w-auto"
          >
            <option value="card">Card</option>
            <option value="cash">Cash</option>
            <option value="other">Other</option>
          </Select>
          <Button size="sm" disabled={busy} onClick={markPaid}>
            {busy ? 'Recording…' : 'Mark paid'}
          </Button>
          <button type="button" disabled={busy} onClick={() => setClosing('void')} className={LINK}>
            Void
          </button>
        </>
      )}
      {refundable && (
        <button type="button" disabled={busy} onClick={() => setClosing('refunded')} className={LINK}>
          Mark refunded
        </button>
      )}
    </div>
  )
}
