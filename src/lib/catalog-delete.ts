import { createClient } from '@/lib/supabase/client'

/**
 * What would go with it.
 *
 * Deleting a service or a product is safe for the *record* and not always safe
 * for the *studio*, and the two are worth separating because the schema already
 * does.
 *
 * HISTORY IS SAFE. `appointment_services` and `order_items` both carry a
 * `name_snapshot` and a frozen price, and both reference their catalogue row
 * with ON DELETE SET NULL. So an old receipt still says "Pumpkin Lactic
 * Cleanse — $46" after the product is gone, and a treatment from two years ago
 * still names what was done. Nothing here is protecting history; 004 and 008
 * already did that.
 *
 * LIVE COMMITMENTS ARE NOT. Several tables reference these rows with ON DELETE
 * CASCADE, and they hold things the studio has promised somebody:
 *
 *   membership_services      what a paying member is entitled to
 *   service_resources        the room or equipment a booking needs
 *   notification_schedules   a reminder somebody is expecting
 *   commission_service_rates what a provider is paid for it
 *   service_consumables      what comes off the back bar when it is performed
 *   product_stock            per-location counts
 *
 * None of those raise an error. They vanish, quietly, and the first sign is a
 * member who cannot book the facial they pay for every month.
 *
 * So this counts them and hands back sentences. It does not decide — the
 * editors do, and they differ: a service that has been booked can still be
 * deleted if the studio insists, because the appointment keeps its snapshot,
 * while a product with stock on the shelf is almost always an archive.
 */

export interface Blocker {
  /** What is in the way, phrased for the person reading it. */
  label: string
  count: number
  /** True when losing this costs the studio something it promised. */
  severe: boolean
}

type Countable = { table: string; column: string; label: string; severe: boolean }

const SERVICE_DEPENDENTS: Countable[] = [
  {
    table: 'membership_services',
    column: 'service_id',
    label: 'membership that includes it',
    severe: true,
  },
  {
    // `waitlist_services`, not `waitlist_entries` — the entry itself names no
    // service, because someone can be waiting for any of several. 037 chose the
    // child table so that "a retired service takes its waitlist interest with
    // it instead of leaving dangling ids", which is right, and is exactly why
    // it is worth saying out loud before the delete rather than after.
    table: 'waitlist_services',
    column: 'service_id',
    label: 'person waiting for it',
    severe: true,
  },
  {
    table: 'notification_schedules',
    column: 'service_id',
    label: 'scheduled reminder',
    severe: true,
  },
  {
    table: 'commission_service_rates',
    column: 'service_id',
    label: 'commission rate',
    severe: true,
  },
  {
    table: 'service_resources',
    column: 'service_id',
    label: 'room or equipment requirement',
    severe: false,
  },
  {
    table: 'service_consumables',
    column: 'service_id',
    label: 'back-bar item it uses',
    severe: false,
  },
]

const PRODUCT_DEPENDENTS: Countable[] = [
  {
    table: 'service_consumables',
    column: 'product_id',
    label: 'service that uses it on the back bar',
    severe: true,
  },
  {
    table: 'product_stock',
    column: 'product_id',
    label: 'per-location count',
    severe: false,
  },
]

async function countAll(list: Countable[], id: number): Promise<Blocker[]> {
  const supabase = createClient()
  const found: Blocker[] = []

  for (const dep of list) {
    // `head: true` — the count is the whole answer, so no rows travel.
    const { count, error } = await supabase
      // The table names are from the list above, never from user input.
      .from(dep.table as 'membership_services')
      .select('*', { count: 'exact', head: true })
      .eq(dep.column, id)

    // A table this account cannot read is not a table this account can be told
    // about. Skipping is right: the delete itself still runs under RLS, and
    // guessing a count from an error would be inventing one.
    if (error || !count) continue
    found.push({ label: dep.label, count, severe: dep.severe })
  }

  return found
}

/** Has this service ever been booked? Snapshotted, so this is advice, not a bar. */
export async function serviceBookingCount(serviceId: number): Promise<number> {
  const { count } = await createClient()
    .from('appointment_services')
    .select('*', { count: 'exact', head: true })
    .eq('service_id', serviceId)
  return count ?? 0
}

/** Has this product ever been sold? Same reasoning — the receipt keeps its own copy. */
export async function productSaleCount(productId: number): Promise<number> {
  const { count } = await createClient()
    .from('order_items')
    .select('*', { count: 'exact', head: true })
    .eq('product_id', productId)
  return count ?? 0
}

export const serviceBlockers = (serviceId: number) => countAll(SERVICE_DEPENDENTS, serviceId)
export const productBlockers = (productId: number) => countAll(PRODUCT_DEPENDENTS, productId)

/** "3 memberships that include it" — plural without a lookup table. */
export function describe(blocker: Blocker): string {
  const plural = blocker.count === 1 ? blocker.label : `${blocker.label}s`
  return `${blocker.count} ${plural}`
}
