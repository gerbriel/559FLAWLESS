import { NextResponse, type NextRequest } from 'next/server'
import { loadAvailability, priceService } from '@/lib/booking'
import { generateSlots } from '@/lib/availability'
import { dateKeyInTimeZone } from '@/lib/time'
import { refreshBusyIfStale } from '@/lib/calendar-push'

export const dynamic = 'force-dynamic'

const MAX_DAYS = 31
/** More than this in one visit is a mis-click, not a plan. */
const MAX_SERVICES = 6
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * Open slots for a provider + service, as absolute ISO instants.
 *
 * Reads through the same loadAvailability/generateSlots path the booking
 * handler uses, so what a client is offered here is exactly what the server
 * will accept there. Duration comes from the database, never the query string.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams

  const providerId = params.get('provider') ?? ''
  // `service` accepts one id or a comma-separated list — a client can book a
  // facial and a wax in one visit, and the slot has to be long enough for both.
  const serviceIds = (params.get('service') ?? '')
    .split(',')
    .map((v) => Number(v.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  const from = params.get('from') ?? ''
  const days = Math.min(Math.max(Number(params.get('days')) || 14, 1), MAX_DAYS)

  const addonIds = (params.get('addons') ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)

  if (!UUID_RE.test(providerId)) {
    return NextResponse.json({ error: 'invalid_provider' }, { status: 400 })
  }
  if (serviceIds.length === 0 || serviceIds.length > MAX_SERVICES) {
    return NextResponse.json({ error: 'invalid_service' }, { status: 400 })
  }
  if (from && !DATE_KEY_RE.test(from)) {
    return NextResponse.json({ error: 'invalid_from' }, { status: 400 })
  }

  // Nudge a calendar refresh if the cache has gone stale. Deliberately not
  // awaited — the scheduled sweep is only daily on this plan, and a client
  // should never wait on Google to see what times are open.
  void refreshBusyIfStale(providerId)

  const outcome = await priceService(providerId, serviceIds, addonIds)
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 404 })
  }

  const priced = outcome.priced
  const now = new Date()

  // Resolve "today" in the provider's zone before we know it — a first pass
  // with UTC is enough to fetch the provider, then the real key is derived.
  const probe = await loadAvailability({
    providerId,
    serviceIds,
    durationMinutes: priced.durationMinutes,
    bufferMinutes: priced.bufferMinutes,
    fromDateKey: from || dateKeyInTimeZone(now, 'UTC'),
    days,
    now,
  })

  if (!probe) {
    return NextResponse.json({ error: 'provider_not_bookable' }, { status: 409 })
  }

  const fromDateKey = from || dateKeyInTimeZone(now, probe.timeZone)

  const input =
    from || fromDateKey === (from || dateKeyInTimeZone(now, 'UTC'))
      ? probe
      : ((await loadAvailability({
          providerId,
          serviceIds,
          durationMinutes: priced.durationMinutes,
          bufferMinutes: priced.bufferMinutes,
          fromDateKey,
          days,
          now,
        })) ?? probe)

  const slots = generateSlots(input, fromDateKey, days)

  return NextResponse.json(
    {
      timezone: input.timeZone,
      duration_minutes: priced.durationMinutes,
      total_cents: priced.totalCents,
      days: slots.map((d) => ({
        date: d.dateKey,
        slots: d.slots.map((s) => s.toISOString()),
      })),
    },
    { headers: { 'Cache-Control': 'no-store' } }
  )
}
