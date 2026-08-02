import Link from 'next/link'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { Button } from '@/components/ui/button'
import { CommissionPlanList } from '@/components/shared/CommissionPlanList'
import {
  CommissionAssignments,
  type AssignableLocation,
  type AssignablePlan,
  type AssignableStaff,
  type AssignmentRow,
} from '@/components/shared/CommissionAssignments'
import { addDaysToDateKey, dateKeyInTimeZone, requestNow } from '@/lib/time'
import { formatMoney } from '@/lib/utils'
import { isAdmin } from '@/types/database'
import {
  formatDateKey,
  type CommissionCategoryRate,
  type CommissionPeriodTotals,
  type CommissionPlan,
  type CommissionServiceRate,
  type CommissionTier,
} from '@/types/staff'

export const dynamic = 'force-dynamic'

/** The first of the month after this one, as a date key. */
function nextMonthStart(dateKey: string): string {
  const [y, m] = dateKey.split('-').map(Number)
  return m === 12
    ? `${y + 1}-01-01`
    : `${y}-${String(m + 1).padStart(2, '0')}-01`
}

/**
 * Commission — rate cards and who is on them.
 *
 * Gated on `manage_staff`, which is admin-only to grant. The redirect is the
 * courtesy; RLS and the guard trigger in 034 are the boundary, and they refuse
 * a self-assignment even from someone who holds the permission.
 */
export default async function CommissionsPage() {
  const supabase = await createClient()

  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [{ data: profile }, { data: canManage }] = await Promise.all([
    supabase.from('profiles').select('role').eq('id', user.id).maybeSingle(),
    supabase.rpc('has_permission', { p_permission: 'manage_staff' }),
  ])

  if (!profile || (!isAdmin(profile.role) && canManage !== true)) redirect('/dashboard')

  const [
    { data: locations },
    { data: plans },
    { data: categoryRates },
    { data: serviceRates },
    { data: tiers },
    { data: assignments },
    { data: staff },
    { data: categories },
    { data: services },
  ] = await Promise.all([
    supabase.from('locations').select('id, name, timezone').order('sort_order'),
    supabase
      .from('commission_plans')
      .select(
        'id, name, description, service_rate_bp, retail_rate_bp, service_flat_cents, is_active, created_by, created_at, updated_at'
      )
      .order('name'),
    supabase
      .from('commission_category_rates')
      .select('plan_id, category_id, rate_bp, flat_cents'),
    supabase.from('commission_service_rates').select('plan_id, service_id, rate_bp, flat_cents'),
    supabase.from('commission_tiers').select('id, plan_id, applies_to, min_period_cents, rate_bp'),
    supabase
      .from('staff_commission_plans')
      .select(
        'id, profile_id, plan_id, location_id, effective_from, effective_to, note, created_by, created_at, updated_at'
      )
      .order('effective_from', { ascending: false }),
    supabase
      .from('profiles')
      .select('id, first_name, last_name, display_name, role')
      .neq('role', 'client')
      .order('first_name'),
    supabase.from('service_categories').select('id, name').order('sort_order'),
    supabase.from('services').select('id, name').eq('is_active', true).order('name'),
  ])

  // The studio's own wall clock, not the viewer's. `locations.timezone` is
  // authoritative for the site; the primary one sets the month boundaries this
  // page reports on.
  const timezone = locations?.[0]?.timezone ?? 'America/Los_Angeles'
  const today = dateKeyInTimeZone(new Date(requestNow()), timezone)
  const monthStart = `${today.slice(0, 7)}-01`
  const monthEnd = addDaysToDateKey(nextMonthStart(today), -1)

  const inForcePlanIds = Array.from(
    new Set(
      (assignments ?? [])
        .filter((a) => a.effective_from <= today)
        .map((a) => a.plan_id)
    )
  )

  // Month to date, per person. Priced appointment by appointment from the
  // ledger, each one against the card that covered its own date.
  const earners = (staff ?? []).filter((s) =>
    (assignments ?? []).some((a) => a.profile_id === s.id)
  )

  const monthToDate = await Promise.all(
    earners.map(async (s) => {
      const { data } = await supabase.rpc('commission_for_period', {
        p_profile: s.id,
        p_from: monthStart,
        p_to: monthEnd,
      })
      const totals = (data as CommissionPeriodTotals[] | null)?.[0]
      return { staff: s, totals }
    })
  )

  const studioTotal = monthToDate.reduce((sum, r) => sum + Number(r.totals?.total_cents ?? 0), 0)

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <div>
          <h1 className="display text-3xl">Commission</h1>
          <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
            Rates are paid on money that arrived, not money that was billed — a
            visit nobody paid for earns nothing, and a refund takes its
            commission back with it.
          </p>
        </div>
        <Link href="/dashboard/settings">
          <Button variant="outline" size="sm">
            Back to settings
          </Button>
        </Link>
      </div>

      <section className="mt-14">
        <h2 className="display text-2xl">
          {formatDateKey(monthStart).slice(0, -6)} to date
        </h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          Every appointment and counter sale in the month, priced against the
          card that covered its own date.
        </p>

        {monthToDate.length === 0 ? (
          <p className="mt-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
            Nobody is on a rate card yet.
          </p>
        ) : (
          <div className="mt-6 overflow-x-auto">
            <table className="w-full min-w-xl text-sm">
              <thead>
                <tr className="border-y border-[var(--color-border)]">
                  <th className="label-caps px-3 py-3 text-left text-[var(--color-muted)]">
                    Who
                  </th>
                  <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                    Services
                  </th>
                  <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                    Retail
                  </th>
                  <th className="label-caps px-3 py-3 text-right text-[var(--color-muted)]">
                    Owed
                  </th>
                </tr>
              </thead>
              <tbody>
                {monthToDate.map(({ staff: s, totals }) => (
                  <tr key={s.id} className="border-b border-[var(--color-border)]">
                    <td className="px-3 py-3">
                      {s.display_name?.trim() ||
                        `${s.first_name ?? ''} ${s.last_name ?? ''}`.trim() ||
                        'Unnamed'}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {formatMoney(Number(totals?.service_cents ?? 0))}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {formatMoney(Number(totals?.retail_cents ?? 0))}
                    </td>
                    <td className="px-3 py-3 text-right tabular-nums">
                      {formatMoney(Number(totals?.total_cents ?? 0))}
                    </td>
                  </tr>
                ))}
                <tr>
                  <td className="px-3 py-3 label-caps text-[var(--color-muted)]">Studio</td>
                  <td />
                  <td />
                  <td className="px-3 py-3 text-right tabular-nums">
                    {formatMoney(studioTotal)}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="mt-16">
        <h2 className="display text-2xl">Rate cards</h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          A percentage of services and of retail, optionally different by
          category or for one service, optionally improving once the month
          clears a number.
        </p>
        <div className="mt-6">
          <CommissionPlanList
            plans={(plans ?? []) as CommissionPlan[]}
            categoryRates={(categoryRates ?? []) as CommissionCategoryRate[]}
            serviceRates={(serviceRates ?? []) as CommissionServiceRate[]}
            tiers={(tiers ?? []) as CommissionTier[]}
            categories={categories ?? []}
            services={services ?? []}
            inForcePlanIds={inForcePlanIds}
          />
        </div>
      </section>

      <section className="mt-16">
        <h2 className="display text-2xl">Who is on what</h2>
        <p className="mt-2 max-w-prose text-sm text-[var(--color-muted)]">
          Assignments are dated, so a change of rate is a new one starting the
          day it takes effect. Nothing rewrites a month that has already been
          paid.
        </p>
        <div className="mt-6">
          <CommissionAssignments
            staff={(staff ?? []) as AssignableStaff[]}
            plans={(plans ?? []) as AssignablePlan[]}
            locations={(locations ?? []) as AssignableLocation[]}
            assignments={(assignments ?? []) as AssignmentRow[]}
            today={today}
          />
        </div>
      </section>
    </div>
  )
}
