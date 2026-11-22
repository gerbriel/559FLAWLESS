'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { formatMoney } from '@/lib/utils'
import {
  addDaysToDateKey,
  addMonthsToDateKey,
  dateKeyInTimeZone,
  formatDateInTimeZone,
  zonedTimeToUtc,
} from '@/lib/time'
import {
  describeIncluded,
  includedAllowances,
  membershipPeriodLabel,
  type Membership,
  membershipErrorMessage,
  type MembershipChargeMethod,
  type MembershipChargeStatus,
} from '@/types/memberships'

/**
 * The database's rule for a start date (089): not after today, and one
 * period from it must still be ahead of today. A start whose first period has
 * already ended would enrol a membership that has run out.
 */
function startIsValid(startKey: string, periodMonths: number, todayKey: string): boolean {
  return startKey <= todayKey && addMonthsToDateKey(startKey, periodMonths) > todayKey
}

/**
 * The earliest day that passes startIsValid, for the picker's min. The
 * subtraction lands on or just before it (month-end clamping), so a few
 * steps forward settle it.
 */
function earliestValidStart(periodMonths: number, todayKey: string): string {
  let day = addMonthsToDateKey(todayKey, -periodMonths)
  for (let i = 0; i < 8 && !startIsValid(day, periodMonths, todayKey); i++) {
    day = addDaysToDateKey(day, 1)
  }
  return day
}

/**
 * A plan offered in the enrol form, with its scope rows (088) so the line
 * under the picker can say "1 Custom Corrective Facial and 1 Full Brazilian"
 * rather than a bare count.
 */
export type EnrolPlan = Membership & {
  membership_services:
    | { service_id: number; sessions_per_period: number | null; services: { name: string } | null }[]
    | null
}

/** What a plan grants, per treatment or from the pool, plus any discount. */
function describeEnrolPlan(plan: EnrolPlan): string {
  const scope = plan.membership_services ?? []
  const allowances = includedAllowances(
    plan,
    scope.map((r) => ({
      service_id: r.service_id,
      sessions_per_period: r.sessions_per_period,
      name: r.services?.name ?? null,
    })),
    [],
    ''
  )
  const included = describeIncluded(
    allowances,
    membershipPeriodLabel(plan.period_months),
    scope.filter((r) => r.sessions_per_period === null).map((r) => r.services?.name ?? '')
  )
  const discount =
    plan.service_discount_pct > 0
      ? included
        ? `${plan.service_discount_pct}% off the rest of the visit`
        : `${plan.service_discount_pct}% off every visit`
      : ''
  return [included, discount].filter(Boolean).join(' · ')
}

/**
 * The write half of the membership panel on a client's record.
 *
 * Every action here is `is_manager()` in RLS or inside a SECURITY DEFINER
 * function, so a front-desk member of staff who reached this markup still gets
 * refused. The gate on the panel above decides whether to render it at all.
 *
 * Nothing in this component knows a price. Enrolling sends a plan id, a start
 * date, a note and how the first period was paid (089's enrol_membership());
 * the trigger in migration 050 reads the price off the plan and freezes it. That is rule 2 of AGENTS.md — the request names WHICH plan, never what it
 * costs — and it is the reason a manager cannot quietly enrol a friend at $0.
 */
export function ClientMembershipControls({
  clientId,
  liveMembershipId,
  plans,
  cancelAtPeriodEnd,
  stripeSubscriptionId = null,
  periodOver = false,
  timeZone,
  todayKey,
}: {
  clientId: string
  /** Null when the client has nothing current — the enrol form is shown. */
  liveMembershipId: number | null
  plans: EnrolPlan[]
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
  /** The studio's zone, for turning a picked day into an instant. */
  timeZone: string
  /** Today, 'YYYY-MM-DD' in the studio's zone, from the server's clock reading. */
  todayKey: string
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [planId, setPlanId] = useState<string>('')
  const [note, setNote] = useState('')
  const [startedOn, setStartedOn] = useState(todayKey)
  const [paidMethod, setPaidMethod] = useState<'' | Exclude<MembershipChargeMethod, 'stripe'>>('')
  const [paidOn, setPaidOn] = useState('')

  const chosen = plans.find((p) => String(p.id) === planId)
  // A convenience for the picker only; submit checks startIsValid itself.
  const earliestStart = chosen
    ? earliestValidStart(chosen.period_months, todayKey)
    : addDaysToDateKey(todayKey, -365)

  async function enrol(e: React.FormEvent) {
    e.preventDefault()
    if (!chosen) {
      toast.error('Pick a membership first.')
      return
    }
    if (!startedOn) {
      toast.error('Pick the day it started.')
      return
    }
    if (!startIsValid(startedOn, chosen.period_months, todayKey)) {
      toast.error(
        startedOn > todayKey
          ? 'The start date cannot be in the future.'
          : `Pick a start within the last ${membershipPeriodLabel(chosen.period_months)}. A start earlier than that would already have run out.`
      )
      return
    }
    const paidKey = paidOn || startedOn
    if (paidMethod && (paidKey < startedOn || paidKey > todayKey)) {
      toast.error('Pick a paid date between the start and today.')
      return
    }

    // A picked day is a wall-clock date in the studio's zone; the instant is
    // its local midnight (src/lib/time.ts, never setHours).
    const startedAt = zonedTimeToUtc(startedOn, '00:00', timeZone).toISOString()
    const paidAt = paidMethod
      ? zonedTimeToUtc(paidKey, '00:00', timeZone).toISOString()
      : null

    setBusy(true)
    const supabase = createClient()
    const { data: newId, error } = await supabase.rpc('enrol_membership', {
      p_client: clientId,
      p_membership: chosen.id,
      p_started_at: startedAt,
      p_note: note.trim() || null,
      p_paid_method: paidMethod || null,
      p_paid_at: paidAt,
    })

    if (error) {
      setBusy(false)
      // 23505 is the partial unique index in 050: one live membership per
      // person, so "which discount applies" has one answer.
      toast.error(
        error.code === '23505'
          ? 'They already hold a membership. End that one before starting another.'
          : error.message || 'Could not enrol them.'
      )
      return
    }

    // Read back what the database wrote: the first period's dates (the 050
    // trigger derives the end from the start) and whether its charge is paid
    // or due. Nothing rolls forward; a past start stays in its first period.
    let summary = `Enrolled in ${chosen.name}.`
    if (typeof newId === 'number') {
      const { data: held } = await supabase
        .from('client_memberships')
        .select('current_period_start, current_period_end')
        .eq('id', newId)
        .maybeSingle()
      if (held) {
        const { data: charge } = await supabase
          .from('membership_charges')
          .select('status')
          .eq('client_membership_id', newId)
          .eq('period_start', held.current_period_start)
          .maybeSingle()
        const status = (charge?.status ?? null) as MembershipChargeStatus | null
        summary +=
          ` They are in the period ${formatDateInTimeZone(new Date(held.current_period_start), timeZone)} to ` +
          `${formatDateInTimeZone(new Date(held.current_period_end), timeZone)}.` +
          (status === 'paid'
            ? ' That period is recorded as paid.'
            : status
              ? ' That period shows as due until the money is recorded.'
              : '') +
          (dateKeyInTimeZone(new Date(held.current_period_end), timeZone) <= todayKey
            ? ' That period has already run out, so renew it to bring them current.'
            : '')
      }
    }
    setBusy(false)

    toast.success(summary)
    setPlanId('')
    setNote('')
    setStartedOn(todayKey)
    setPaidMethod('')
    setPaidOn('')
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
      // RLS refuses by matching nothing, not by erroring, so ask for the row
      // back and require exactly one.
      const { data, error } = await createClient()
        .from('client_memberships')
        .update({
          cancel_at_period_end: value,
          cancelled_at: value ? new Date().toISOString() : null,
        })
        .eq('id', liveMembershipId)
        .select('id')
      if (error || data?.length !== 1) failure = error?.message || 'Could not change that.'
    }
    setBusy(false)

    if (failure) {
      toast.error(failure)
      return
    }
    toast.success(
      value
        ? 'It will end when this period runs out. Nothing changes before then.'
        : 'Back on. It will roll into the next period.'
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
      const { data, error } = await createClient()
        .from('client_memberships')
        .update({ status: 'cancelled', cancelled_at: stamp, ended_at: stamp })
        .eq('id', liveMembershipId)
        .select('id')
      if (error || data?.length !== 1) {
        failure = error?.message || 'Could not end that membership.'
      }
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
                {p.name}: {formatMoney(p.price_cents)} /{' '}
                {membershipPeriodLabel(p.period_months)}
              </option>
            ))}
          </Select>
        </Field>

        {chosen && (
          <p className="text-xs text-[var(--color-muted)]">
            {[
              describeEnrolPlan(chosen),
              paidMethod
                ? 'The first period starts on the day below and is recorded as paid.'
                : 'The first period starts on the day below and shows as due until the money is recorded.',
            ]
              .filter(Boolean)
              .join('. ')}
          </p>
        )}

        <Field
          label="Started on"
          htmlFor="cm_started"
          hint={
            chosen
              ? `Within the last ${membershipPeriodLabel(chosen.period_months)}. A start earlier than that would already have run out.`
              : 'Pick a membership first. The start can go back up to one of its periods.'
          }
        >
          <Input
            id="cm_started"
            type="date"
            required
            min={earliestStart}
            max={todayKey}
            value={startedOn}
            onChange={(e) => setStartedOn(e.target.value)}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Paid" htmlFor="cm_paid">
            <Select
              id="cm_paid"
              value={paidMethod}
              onChange={(e) => {
                const next = e.target.value as typeof paidMethod
                setPaidMethod(next)
                if (next && !paidOn) setPaidOn(startedOn)
              }}
            >
              <option value="">Not yet</option>
              <option value="cash">Cash</option>
              <option value="card">Card</option>
              <option value="other">Other</option>
            </Select>
          </Field>
          {paidMethod && (
            <Field label="Paid on" htmlFor="cm_paid_on">
              <Input
                id="cm_paid_on"
                type="date"
                required
                min={startedOn || undefined}
                max={todayKey}
                value={paidOn}
                onChange={(e) => setPaidOn(e.target.value)}
              />
            </Field>
          )}
        </div>

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
