'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Select, Textarea } from '@/components/ui/field'
import { formatMoney } from '@/lib/utils'
import {
  describeMembershipBenefit,
  membershipPeriodLabel,
  type Membership,
  membershipErrorMessage,
  type MembershipChargeMethod,
} from '@/types/memberships'

/**
 * The write half of the membership panel on a client's record.
 *
 * Every action here is `is_manager()` in RLS or inside a SECURITY DEFINER
 * function, so a front-desk member of staff who reached this markup still gets
 * refused. The gate on the panel above decides whether to render it at all.
 *
 * Nothing in this component knows a price. Enrolling sends a plan id and a
 * note; the trigger in migration 050 reads the price off the plan and freezes
 * it. That is rule 2 of AGENTS.md — the request names WHICH plan, never what it
 * costs — and it is the reason a manager cannot quietly enrol a friend at $0.
 */
export function ClientMembershipControls({
  clientId,
  liveMembershipId,
  plans,
  dueChargeIds,
  cancelAtPeriodEnd,
  stripeSubscriptionId = null,
  periodOver = false,
}: {
  clientId: string
  /** Null when the client has nothing current — the enrol form is shown. */
  liveMembershipId: number | null
  plans: Membership[]
  /** Charges still owed, oldest first. Usually none or one. */
  dueChargeIds: number[]
  cancelAtPeriodEnd: boolean
  /**
   * Set when Stripe bills this membership (083). renew_membership() refuses
   * such a row, so the Renew button is not offered at all.
   */
  stripeSubscriptionId?: string | null
  /**
   * Still 'active' but past current_period_end, not yet swept to expired. It
   * holds 050's one-live index, so it is renewed or ended, not enrolled over.
   */
  periodOver?: boolean
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [planId, setPlanId] = useState<string>('')
  const [note, setNote] = useState('')
  const [method, setMethod] = useState<MembershipChargeMethod>('card')

  const chosen = plans.find((p) => String(p.id) === planId)

  async function enrol(e: React.FormEvent) {
    e.preventDefault()
    if (!chosen) {
      toast.error('Pick a membership first.')
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('client_memberships')
      .insert({
        client_id: clientId,
        membership_id: chosen.id,
        note: note.trim() || null,
      })
    setBusy(false)

    if (error) {
      // 23505 is the partial unique index in 050: one live membership per
      // person, so "which discount applies" has one answer.
      toast.error(
        error.code === '23505'
          ? 'They already hold a membership. End that one before starting another.'
          : error.message || 'Could not enrol them.'
      )
      return
    }

    toast.success(`Enrolled in ${chosen.name}. The first period is showing as due.`)
    setPlanId('')
    setNote('')
    router.refresh()
  }

  async function markPaid(chargeId: number) {
    setBusy(true)
    const { error } = await createClient().rpc('mark_membership_charge_paid', {
      p_charge: chargeId,
      p_method: method,
    })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not record that payment.')
      return
    }
    toast.success('Recorded.')
    router.refresh()
  }

  async function renew() {
    if (!liveMembershipId) return
    setBusy(true)
    const { error } = await createClient().rpc('renew_membership', {
      p_client_membership: liveMembershipId,
    })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not renew that membership.')
      return
    }
    toast.success(
      cancelAtPeriodEnd
        ? 'Ended, as they asked. Nothing further is owed.'
        : 'Rolled into the next period. The charge for it is showing as due.'
    )
    router.refresh()
  }

  async function setCancelAtPeriodEnd(value: boolean) {
    if (!liveMembershipId) return
    setBusy(true)

    // A subscribed membership is stopped in Stripe, or Stripe keeps billing
    // it whatever this row says. The manage route changes both; the webhook
    // confirms. A pay-once membership has nothing in Stripe to tell.
    let failure: string | null = null
    if (stripeSubscriptionId) {
      try {
        const res = await fetch('/api/stripe/membership/manage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: value ? 'stop_renewing' : 'resume_renewing',
            client_membership_id: liveMembershipId,
          }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          failure =
            data.error === 'subscription_ended'
              ? 'That subscription has already ended in Stripe.'
              : 'Stripe did not accept the change. Try again.'
        }
      } catch {
        failure = 'Could not reach Stripe. Try again.'
      }
    } else {
      const { error } = await createClient()
        .from('client_memberships')
        .update({
          cancel_at_period_end: value,
          cancelled_at: value ? new Date().toISOString() : null,
        })
        .eq('id', liveMembershipId)
      if (error) failure = error.message || 'Could not change that.'
    }
    setBusy(false)

    if (failure) {
      toast.error(failure)
      return
    }
    toast.success(
      value
        ? 'It will end when this period runs out. Nothing changes before then.'
        : 'Back on — it will roll into the next period.'
    )
    router.refresh()
  }

  async function endNow() {
    if (!liveMembershipId) return
    if (
      !confirm(
        'End this membership today? The discount stops immediately and nothing is refunded. If they have paid for this period, letting it run out is the fairer option.'
      )
    ) {
      return
    }

    // A subscribed membership is cancelled in Stripe too, or Stripe keeps
    // billing a membership this row calls over. The manage route does both.
    let failure: string | null = null
    setBusy(true)
    if (stripeSubscriptionId) {
      try {
        const res = await fetch('/api/stripe/membership/manage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'end_now', client_membership_id: liveMembershipId }),
        })
        if (!res.ok) {
          const data = await res.json().catch(() => ({}))
          failure = membershipErrorMessage(data.error, 'Could not end that membership.')
        }
      } catch {
        failure = 'Could not reach Stripe. Try again.'
      }
    } else {
      const stamp = new Date().toISOString()
      const { error } = await createClient()
        .from('client_memberships')
        .update({ status: 'cancelled', cancelled_at: stamp, ended_at: stamp })
        .eq('id', liveMembershipId)
      if (error) failure = error.message || 'Could not end that membership.'
    }
    setBusy(false)

    if (failure) {
      toast.error(failure)
      return
    }
    toast.success('Ended.')
    router.refresh()
  }

  if (!liveMembershipId) {
    const sellable = plans.filter((p) => p.is_active)
    if (sellable.length === 0) {
      return (
        <p className="text-sm text-[var(--color-muted)]">
          No membership is open to new members. Set one up under Settings &rarr;
          Memberships.
        </p>
      )
    }

    return (
      <form onSubmit={enrol} className="space-y-4">
        <Field label="Membership" htmlFor="cm_plan">
          <Select id="cm_plan" value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">Choose one…</option>
            {sellable.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {formatMoney(p.price_cents)} /{' '}
                {membershipPeriodLabel(p.period_months)}
              </option>
            ))}
          </Select>
        </Field>

        {chosen && (
          <p className="text-xs text-[var(--color-muted)]">
            {describeMembershipBenefit(chosen)}. The first period starts today and shows
            as due until the money is recorded.
          </p>
        )}

        <Field label="Note" htmlFor="cm_note" hint="Optional. Why, or on whose say-so.">
          <Textarea
            id="cm_note"
            rows={2}
            maxLength={300}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        <Button type="submit" size="sm" disabled={busy || !chosen}>
          {busy ? 'Enrolling…' : 'Enrol'}
        </Button>
      </form>
    )
  }

  return (
    <div className="space-y-4">
      {periodOver && (
        <p className="text-xs text-amber-700 dark:text-amber-400">This period has run out.</p>
      )}

      {dueChargeIds.length > 0 && (
        <div className="space-y-3">
          <Field label="Paid by" htmlFor="cm_method">
            <Select
              id="cm_method"
              value={method}
              onChange={(e) => setMethod(e.target.value as MembershipChargeMethod)}
            >
              <option value="card">Card</option>
              <option value="cash">Cash</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          {dueChargeIds.map((id) => (
            <Button key={id} size="sm" disabled={busy} onClick={() => markPaid(id)}>
              {busy ? 'Recording…' : 'Record that period as paid'}
            </Button>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-2.5">
        {stripeSubscriptionId ? (
          <p className="self-center text-xs text-[var(--color-muted)]">Stripe renews this one.</p>
        ) : (
          <Button variant="subtle" size="sm" disabled={busy} onClick={renew}>
            {cancelAtPeriodEnd ? 'End it now that the period is up' : 'Renew for another period'}
          </Button>
        )}
        {!periodOver && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setCancelAtPeriodEnd(!cancelAtPeriodEnd)}
          >
            {cancelAtPeriodEnd ? 'Keep it going' : 'Stop at the end of this period'}
          </Button>
        )}
      </div>

      <button
        type="button"
        disabled={busy}
        onClick={endNow}
        className="text-xs text-[var(--color-muted)] underline underline-offset-4 transition-colors hover:text-red-700 disabled:opacity-50 dark:hover:text-red-400"
      >
        End it today instead
      </button>
    </div>
  )
}
