import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { requestNow } from '@/lib/time'
import { readLocationScope } from '@/components/layout/LocationScope'
import type { UserRole } from '@/types/database'
import {
  parsePreset,
  resolveDateRange,
  roleAtLeast,
  type DateRangePreset,
  type ReportContext,
  type ReportFilter,
  type ReportModule,
  type ResolvedRange,
} from '@/lib/reports/types'

/**
 * Everything the report shell needs to run a module, resolved once.
 *
 * The index page, the report page and the CSV export route all go through here,
 * so they cannot disagree about who the caller is, which window they asked for,
 * or which zone the dates were read in. The export route in particular must
 * re-derive all of it server-side — the UI hiding a card is not a permission.
 */

/** Search params the filter bar reads and writes. Also the CSV export's inputs. */
export interface ReportSearchParams {
  preset?: string
  from?: string
  to?: string
  location?: string
  provider?: string
}

export interface ReportViewer {
  id: string
  role: UserRole
}

export interface LocationOption {
  id: number
  name: string
  timezone: string
}

export interface ProviderOption {
  id: string
  name: string
}

export interface ReportShell {
  viewer: ReportViewer
  ctx: ReportContext
  range: ResolvedRange
  /** Active sites. Length < 2 means the location filter renders nothing at all. */
  locations: LocationOption[]
  providers: ProviderOption[]
  /** The params as resolved, for building links that keep the current filters. */
  params: Required<Pick<ReportSearchParams, 'preset'>> & ReportSearchParams
}

const DEFAULT_ZONE = 'America/Los_Angeles'

function providerName(p: {
  display_name: string | null
  first_name: string | null
  last_name: string | null
}): string {
  return (
    p.display_name?.trim() ||
    [p.first_name, p.last_name].filter(Boolean).join(' ').trim() ||
    'Unnamed'
  )
}

/**
 * Resolve the caller, the window and the filters.
 *
 * Returns null when there is no signed-in staff member — the caller decides
 * whether that is a redirect or a 401, because a page and a route handler owe
 * different answers to the same failure.
 */
export async function resolveReportShell(
  search: ReportSearchParams
): Promise<ReportShell | null> {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) return null

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, suspended_at')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile || profile.suspended_at || !roleAtLeast(profile.role, 'provider')) return null
  const role = profile.role as UserRole

  const [{ data: locationRows }, { data: providerRows }, cookieScope] = await Promise.all([
    supabase
      .from('locations')
      .select('id, name, timezone')
      .eq('is_active', true)
      .order('sort_order')
      .order('id'),
    supabase
      .from('profiles')
      .select('id, first_name, last_name, display_name')
      .in('role', ['provider', 'front_desk', 'manager', 'admin'])
      .is('suspended_at', null)
      .order('display_name'),
    readLocationScope(),
  ])

  const locations: LocationOption[] = (locationRows ?? []).map((l) => ({
    id: l.id,
    name: l.name,
    timezone: l.timezone,
  }))

  // A location filter in the URL wins, so a report link carries its own scope.
  // Absent one, inherit whatever site the dashboard's own switcher is on — a
  // manager standing in the second studio should not have to re-pick it here.
  const requested =
    search.location && /^\d+$/.test(search.location) ? Number(search.location) : null
  const candidate = requested ?? cookieScope
  // Honour the id only while it names a site that still exists and is open.
  const locationId = locations.some((l) => l.id === candidate) ? candidate : null

  // The chosen site's zone; with no site chosen, the primary one's. Falls back
  // to booking_settings only if `locations` is somehow empty, which is a
  // misconfiguration rather than a state to design around.
  let timeZone =
    locations.find((l) => l.id === locationId)?.timezone ?? locations[0]?.timezone ?? ''
  if (!timeZone) {
    const { data: settings } = await supabase
      .from('booking_settings')
      .select('timezone')
      .eq('id', 1)
      .maybeSingle()
    timeZone = settings?.timezone ?? DEFAULT_ZONE
  }

  const providers: ProviderOption[] = (providerRows ?? []).map((p) => ({
    id: p.id,
    name: providerName(p),
  }))

  const providerId =
    search.provider && providers.some((p) => p.id === search.provider) ? search.provider : null

  const now = requestNow()
  const preset: DateRangePreset = parsePreset(search.preset)
  const range = resolveDateRange(preset, timeZone, now, { from: search.from, to: search.to })

  return {
    viewer: { id: user.id, role },
    ctx: {
      supabase,
      from: range.from,
      to: range.to,
      locationId,
      providerId,
      timeZone,
      now,
    },
    range,
    locations,
    providers,
    params: {
      preset: range.preset,
      from: range.preset === 'custom' ? range.from : undefined,
      to: range.preset === 'custom' ? range.to : undefined,
      location: locationId === null ? undefined : String(locationId),
      provider: providerId ?? undefined,
    },
  }
}

/**
 * The filter params a module actually declared, as a query string.
 *
 * A report that does not take a provider filter must not carry one in its links
 * — a stale `?provider=` in a bookmarked URL would otherwise look like it was
 * doing something.
 */
export function filterQuery(
  shell: ReportShell,
  filters: readonly ReportFilter[],
  override: ReportSearchParams = {}
): string {
  const q = new URLSearchParams()
  const wants = new Set(filters)
  const merged = { ...shell.params, ...override }

  if (wants.has('dateRange')) {
    if (merged.preset) q.set('preset', merged.preset)
    if (merged.preset === 'custom') {
      if (merged.from) q.set('from', merged.from)
      if (merged.to) q.set('to', merged.to)
    }
  }
  if (wants.has('location') && merged.location) q.set('location', merged.location)
  if (wants.has('provider') && merged.provider) q.set('provider', merged.provider)

  return q.toString()
}

/** Can this viewer run this report? Mirrors the check the export route repeats. */
export function canRun(shell: ReportShell, module: ReportModule): boolean {
  return roleAtLeast(shell.viewer.role, module.minRole)
}
