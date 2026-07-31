import { NextResponse, type NextRequest } from 'next/server'
import { loadAvailability, priceService } from '@/lib/booking'
import { generateSlots } from '@/lib/availability'
import { dateKeyInTimeZone } from '@/lib/time'

export const dynamic = 'force-dynamic'

const MAX_DAYS = 31
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
  const serviceId = Number(params.get('service'))
  const from = params.get('from') ?? ''
  const days = Math.min(Math.max(Number(params.get('days')) || 14, 1), MAX_DAYS)

  const addonIds = (params.get('addons') ?? '')
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)

  if (!UUID_RE.test(providerId)) {
    return NextResponse.json({ error: 'invalid_provider' }, { status: 400 })
  }
  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    return NextResponse.json({ error: 'invalid_service' }, { status: 400 })
  }
  if (from && !DATE_KEY_RE.test(from)) {
    return NextResponse.json({ error: 'invalid_from' }, { status: 400 })
  }

  const outcome = await priceService(providerId, serviceId, addonIds)
  if (!outcome.ok) {
    return NextResponse.json({ error: outcome.error }, { status: 404 })
  }

  const priced = outcome.priced
  const now = new Date()

  // Resolve "today" in the provider's zone before we know it — a first pass
  // with UTC is enough to fetch the provider, then the real key is derived.
  const probe = await loadAvailability({
    providerId,
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
