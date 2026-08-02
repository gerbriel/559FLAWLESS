/**
 * Permissions and commission plans — the parts of 034 the UI needs.
 *
 * The row shapes are taken from `database.ts` rather than restated here, so
 * there is one description of the schema and not two that can drift. What
 * lives in this file is everything that is *not* schema: the permission-key
 * union, the three-state cell model the matrix works in, and the conversions
 * between what the database stores (integer cents, integer basis points) and
 * what a person types into a box.
 */

import type { Database, UserRole } from '@/types/database'

type Row<T extends keyof Database['public']['Tables']> =
  Database['public']['Tables'][T]['Row']

// ── Permissions ───────────────────────────────────────────────

/**
 * Every permission the studio can grant, as seeded by 034.
 *
 * A union rather than a bare string so a typo in a component is a compile
 * error. The database is still the authority — `has_permission()` answers a
 * name it does not recognise with `false`, which fails closed.
 */
export type PermissionKey =
  | 'view_own_calendar'
  | 'view_calendar_all'
  | 'manage_clients'
  | 'view_client_clinical'
  | 'manage_services'
  | 'view_pricing'
  | 'manage_pricing'
  | 'manage_inventory'
  | 'adjust_stock'
  | 'view_reports'
  | 'view_financial_reports'
  | 'manage_expenses'
  | 'sell_retail'
  | 'manage_staff'
  | 'manage_permissions'
  | 'send_marketing'
  | 'manage_settings'

export type Permission = Row<'permissions'>
export type RolePermission = Row<'role_permissions'>
export type StaffPermission = Row<'staff_permissions'>

/** What `effective_permissions()` returns, one row per catalogue entry. */
export type EffectivePermission = {
  permission: string
  label: string
  category: string
  granted: boolean
  source: 'role' | 'override'
  sort_order: number
}

/**
 * The three states a cell in the permission matrix can be in.
 *
 * `default` is the absence of a row, not a third value in the database —
 * clearing an override is a DELETE, which is why `set_staff_permission` takes
 * null for it.
 */
export type PermissionState = 'default' | 'allow' | 'deny'

export function permissionState(override: boolean | undefined | null): PermissionState {
  if (override === true) return 'allow'
  if (override === false) return 'deny'
  return 'default'
}

/** What `set_staff_permission` wants for a given cell state. */
export function stateToGranted(state: PermissionState): boolean | null {
  if (state === 'allow') return true
  if (state === 'deny') return false
  return null
}

/**
 * The client-side mirror of `has_permission()`.
 *
 * For hiding buttons only. The SQL copy is what actually stops a request —
 * every screen that uses this is still behind RLS, and an admin passes
 * everything here for the same reason `is_admin()` short-circuits every policy.
 */
export function holdsPermission(
  role: UserRole | null | undefined,
  permission: PermissionKey,
  overrides: ReadonlyMap<string, boolean>,
  roleDefaults: ReadonlySet<string>
): boolean {
  if (!role || role === 'client') return false
  if (role === 'admin') return true
  const override = overrides.get(permission)
  if (override !== undefined) return override
  return roleDefaults.has(permission)
}

// ── Commissions ───────────────────────────────────────────────

/**
 * Rates on these rows are basis points, so the whole calculation stays in
 * integers: 4000 is 40.00%. Cents everywhere else, as always.
 */
export type CommissionPlan = Row<'commission_plans'>
export type CommissionCategoryRate = Row<'commission_category_rates'>
export type CommissionServiceRate = Row<'commission_service_rates'>
export type CommissionTier = Row<'commission_tiers'>
export type StaffCommissionPlan = Row<'staff_commission_plans'>

export type CommissionPeriodTotals = {
  service_cents: number
  retail_cents: number
  total_cents: number
}

/** 4000 → "40%". Basis points never become a float on the way. */
export function formatRate(bp: number): string {
  const whole = Math.trunc(bp / 100)
  const frac = bp % 100
  if (frac === 0) return `${whole}%`
  return `${whole}.${String(frac).padStart(2, '0').replace(/0$/, '')}%`
}

/** "40" or "40.5" → 4000 / 4050. Null if it isn't a rate. */
export function rateToBp(percent: string): number | null {
  const trimmed = percent.replace(/[%\s]/g, '')
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(trimmed)) return null
  const bp = Math.round(Number(trimmed) * 100)
  if (!Number.isFinite(bp) || bp < 0 || bp > 10000) return null
  return bp
}

/** "$5" or "5.00" → 500. Null if it isn't money. */
export function dollarsToCents(dollars: string): number | null {
  const trimmed = dollars.replace(/[$,\s]/g, '')
  if (trimmed === '') return 0
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.round(n * 100)
}

/**
 * How an assignment window reads on the page.
 *
 * The dates are already wall-clock strings from Postgres, so they are split on
 * the hyphen rather than parsed into a Date — turning 'YYYY-MM-DD' into an
 * instant is exactly the mistake `src/lib/time.ts` exists to prevent.
 */
export function formatDateKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number)
  const MONTHS = [
    'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
  ]
  if (!y || !m || !d) return dateKey
  return `${MONTHS[m - 1]} ${d}, ${y}`
}
