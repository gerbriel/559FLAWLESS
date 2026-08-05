import type { ReportColumn, ReportContext, ReportModule, ReportResult } from '@/lib/reports/types'
import { ratioToPercent, rangeToInstants } from '@/lib/reports/types'
import { formatDateTimeInTimeZone } from '@/lib/time'

/**
 * Added, Never Bought — which products get put in bags and then left there.
 *
 * The source is `analytics_events`: every `cart_add` the storefront recorded
 * in the period, carrying `{ product_id, quantity }` in `meta`. Purchases come
 * from `orders`/`order_items`. The join between the two is the honest
 * difficulty of this report, and it is stated rather than smoothed over:
 *
 * 1. A CART EVENT BELONGS TO A SESSION, NOT A PERSON. Most shoppers are
 *    anonymous. A session is stitched to an account only when some event on
 *    it carries a `user_id` — the tracker writes one on signed-in pageviews,
 *    and 060's `claim_browsing_session()` backfills the anonymous trail at
 *    sign-in. Sessions that never sign in can never be matched to a sale, so
 *    "bought it later" is a FLOOR and conversion is understated. That bias is
 *    the same for every product, which is why ranking on it is still sound.
 *
 * 2. "LATER" MEANS AFTER THEY ADDED IT. The purchase search runs from the
 *    start of the period to the moment the report is read — not to the end of
 *    the period — because someone who added in the window and bought after it
 *    closed did convert, and calling them lost would flatter the problem this
 *    report exists to find.
 *
 * 3. TRACKING IS CONSENT-GATED. Cart events respect `fl_analytics_consent`;
 *    an opted-out shopper appears in neither column. The report undercounts
 *    activity, never a person's identity.
 */

/** Same list the Retail Sales report counts as "a sale actually happened". */
const PURCHASED_STATUSES = [
  'paid',
  'fulfilling',
  'ready_for_pickup',
  'shipped',
  'completed',
  'refunded',
] as const

/** Rows are the unit of work here; 1000 is PostgREST's default ceiling. */
const PAGE = 1000
/** Postgres will happily take a longer `IN`, but the URL will not. */
const IN_CHUNK = 200

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/** Read every row, not the first page — see retail-sales for the long version. */
async function fetchAll<T>(page: (offset: number, limit: number) => PromiseLike<PageResult<T>>): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await page(offset, PAGE)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    out.push(...rows)
    if (rows.length < PAGE) return out
  }
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

const COLUMNS: ReportColumn[] = [
  { key: 'product', label: 'Product', align: 'left', format: 'text' },
  // Today's shelf price, for reading a row against reason #1 below. No total:
  // a sum of unit prices is not a number that means anything.
  { key: 'price_cents', label: 'Price', align: 'right', format: 'money', total: null },
  { key: 'adds', label: 'Adds', align: 'right', format: 'number', total: 'sum' },
  // Per-product distinct counts overlap across rows — one session can add
  // three products — so a footer sum would be a lie. The summary tiles carry
  // the true distinct totals.
  { key: 'sessions', label: 'Sessions', align: 'right', format: 'number', total: null },
  { key: 'clients', label: 'Signed-in', align: 'right', format: 'number', total: null },
  { key: 'bought_later', label: 'Bought later', align: 'right', format: 'number', total: null },
  { key: 'conversion_pct', label: 'Conversion', align: 'right', format: 'percent', total: null },
  { key: 'flags', label: 'Flags', align: 'left', format: 'text' },
]

export const addedNotBoughtReport: ReportModule = {
  // Must match the registry key exactly — `loadReport` refuses a module that
  // answers at someone else's URL.
  key: 'added-not-bought',
  title: 'Added, Never Bought',
  description:
    'Cart adds by product, and how few became sales. A product that is chronically added and never bought usually has a fixable reason: the price against the size, the ships-direct hop out to the marketplace, or a photo that promised more than the page delivers.',
  // Reads the whole book's shopping behaviour — manager and above (which is
  // also what 009's RLS on analytics_events grants).
  minRole: 'manager',
  filters: ['dateRange'],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const { supabase, from, to, timeZone, now } = ctx

    const { startIso, endIso } = rangeToInstants(from, to, timeZone)

    // ── Every cart add in the period ──────────────────────────
    const events = await fetchAll((offset, limit) =>
      supabase
        .from('analytics_events')
        .select('id, session_id, user_id, meta, created_at')
        .eq('event', 'cart_add')
        .gte('created_at', startIso)
        .lt('created_at', endIso)
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1),
    )

    type Add = { productId: number; sessionId: string; userId: string | null; atMs: number }
    const adds: Add[] = []
    for (const e of events) {
      // `trackCartEvent` writes { product_id, quantity }; anything else in the
      // column is noise from a future shape and is skipped, not guessed at.
      const meta = (e.meta ?? {}) as { product_id?: unknown }
      if (typeof meta.product_id !== 'number' || !Number.isInteger(meta.product_id)) continue
      adds.push({
        productId: meta.product_id,
        sessionId: e.session_id,
        userId: e.user_id,
        atMs: new Date(e.created_at).getTime(),
      })
    }

    // ── Stitch sessions to accounts where possible ────────────
    // Any event on the same session that carries a user_id names the shopper —
    // signed-in pageviews write one, and 060's claim_browsing_session()
    // backfills the anonymous trail at sign-in. Sessions this finds nothing
    // for stay anonymous, and their purchases are invisible to this report.
    const sessionIds = [...new Set(adds.map((a) => a.sessionId))]
    const identityRows =
      sessionIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(sessionIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('analytics_events')
                    .select('session_id, user_id')
                    .in('session_id', ids)
                    .not('user_id', 'is', null)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()
    const userBySession = new Map<string, string>()
    for (const row of identityRows) {
      if (row.user_id !== null && !userBySession.has(row.session_id)) {
        userBySession.set(row.session_id, row.user_id)
      }
    }
    const shopper = (a: Add): string | null => a.userId ?? userBySession.get(a.sessionId) ?? null

    // ── The catalogue's side of each row ──────────────────────
    const productIds = [...new Set(adds.map((a) => a.productId))]
    const products =
      productIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(productIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('products')
                    .select('id, name, price_cents, image_url, external_url, is_active, archived_at, stock_qty')
                    .in('id', ids)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()
    const productById = new Map(products.map((p) => [p.id, p]))

    // ── What those shoppers went on to buy ────────────────────
    // From the period's start to NOW, not to the period's end — a purchase
    // after the window closed still answers "did the add convert".
    const clientIds = [...new Set(adds.map(shopper).filter((id): id is string => id !== null))]
    const orders =
      clientIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(clientIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('orders')
                    .select('id, client_id, paid_at, created_at')
                    .in('status', [...PURCHASED_STATUSES])
                    .in('client_id', ids)
                    .or(`paid_at.gte.${startIso},and(paid_at.is.null,created_at.gte.${startIso})`)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()
    const orderMeta = new Map(
      orders.map((o) => [o.id, { clientId: o.client_id, atMs: new Date(o.paid_at ?? o.created_at).getTime() }]),
    )

    const orderIds = orders.map((o) => o.id)
    const items =
      orderIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(orderIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('order_items')
                    .select('order_id, product_id')
                    .in('order_id', ids)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()

    // client → product → the moment they bought it (earliest counts).
    const boughtAt = new Map<string, Map<number, number>>()
    for (const item of items) {
      if (item.product_id === null) continue
      const order = orderMeta.get(item.order_id)
      if (!order || order.clientId === null) continue
      let perProduct = boughtAt.get(order.clientId)
      if (!perProduct) {
        perProduct = new Map<number, number>()
        boughtAt.set(order.clientId, perProduct)
      }
      const held = perProduct.get(item.product_id)
      if (held === undefined || order.atMs < held) perProduct.set(item.product_id, order.atMs)
    }

    // ── Aggregate per product ─────────────────────────────────
    type Bucket = {
      productId: number
      adds: number
      sessions: Set<string>
      clients: Set<string>
      /** client → their earliest add of this product, for the "later" check. */
      firstAddByClient: Map<string, number>
    }
    const buckets = new Map<number, Bucket>()
    for (const add of adds) {
      let b = buckets.get(add.productId)
      if (!b) {
        b = {
          productId: add.productId,
          adds: 0,
          sessions: new Set<string>(),
          clients: new Set<string>(),
          firstAddByClient: new Map<string, number>(),
        }
        buckets.set(add.productId, b)
      }
      b.adds += 1
      b.sessions.add(add.sessionId)
      const who = shopper(add)
      if (who !== null) {
        b.clients.add(who)
        const held = b.firstAddByClient.get(who)
        if (held === undefined || add.atMs < held) b.firstAddByClient.set(who, add.atMs)
      }
    }

    type Shaped = Bucket & { buyers: number; conversion: number | null; name: string }
    const shaped: Shaped[] = [...buckets.values()].map((b) => {
      let buyers = 0
      for (const [clientId, firstAddMs] of b.firstAddByClient) {
        const at = boughtAt.get(clientId)?.get(b.productId)
        if (at !== undefined && at >= firstAddMs) buyers += 1
      }
      return {
        ...b,
        buyers,
        conversion: ratioToPercent(buyers, b.sessions.size),
        name: productById.get(b.productId)?.name ?? `Product ${b.productId} (deleted)`,
      }
    })

    // The chronic offenders first: never bought at all, most-added on top.
    // Behind them, worst conversion upward.
    shaped.sort((a, b) => {
      const aNever = a.buyers === 0 ? 0 : 1
      const bNever = b.buyers === 0 ? 0 : 1
      return (
        aNever - bNever ||
        (aNever === 0 ? b.adds - a.adds : (a.conversion ?? 0) - (b.conversion ?? 0)) ||
        a.name.localeCompare(b.name)
      )
    })

    const rows: ReportResult['rows'] = shaped.map((s) => {
      const product = productById.get(s.productId)
      const flags: string[] = []
      if (!product) flags.push('product deleted')
      if (product?.external_url) flags.push('ships direct')
      if (product && !product.image_url) flags.push('no photo')
      if (product && (product.archived_at || !product.is_active)) flags.push('retired')
      else if (product && product.stock_qty <= 0) flags.push('out of stock')
      return {
        product: s.name,
        price_cents: product?.price_cents ?? null,
        adds: s.adds,
        sessions: s.sessions.size,
        clients: s.clients.size,
        bought_later: s.buyers,
        conversion_pct: s.conversion,
        flags: flags.length ? flags.join(', ') : null,
      }
    })

    const allSessions = new Set(adds.map((a) => a.sessionId))
    const neverBought = shaped.filter((s) => s.buyers === 0)
    const chronic = neverBought[0]

    const summary: NonNullable<ReportResult['summary']> = [
      { label: 'Cart adds', value: String(adds.length) },
      { label: 'Products added', value: String(shaped.length) },
      { label: 'Sessions', value: String(allSessions.size) },
      { label: 'Signed-in shoppers', value: String(clientIds.length) },
      {
        label: 'Never bought by anyone',
        value: String(neverBought.length),
        tone: neverBought.length > 0 ? 'warn' : 'good',
      },
    ]
    if (chronic && chronic.adds > 1) {
      summary.push({
        label: 'Most added, never bought',
        value: `${chronic.name} · ${chronic.adds} adds`,
        tone: 'warn',
      })
    }

    const notes: string[] = [
      `Period ${from} to ${to} inclusive, in ${timeZone}. Adds are \`cart_add\` events in \`analytics_events\`, carrying the product id in \`meta\`.`,
      'A cart event belongs to a session, not a person. A session is matched to an account only when some event on it carries a user_id — signed-in pageviews write one, and sign-in stitches the anonymous trail via claim_browsing_session() (060). Sessions that never sign in can never be matched to a sale, so "Bought later" is a floor and conversion is understated. The bias is the same for every product, which is why the ranking still holds.',
      `"Bought later" means an order (${PURCHASED_STATUSES.join(', ')}) containing that product, placed by a matched shopper at or after their first add of it — searched from the period's start to now, not to the period's end, so a purchase after the window closed still counts as converting.`,
      'Per-product session and client counts overlap across rows — one session can add three products — so those columns carry no footer total; the tiles above hold the true distinct counts.',
      'Cart tracking respects the analytics consent key, so an opted-out shopper appears in neither column: activity is undercounted, identity never is.',
      'How to read a chronic row: the price column is today\'s shelf price (is the number the objection?); "ships direct" means the buy button leaves for the marketplace and the bag was as far as our site could take them; "no photo" means the page sold it with words alone. One of those three is usually the answer.',
      `Read at ${formatDateTimeInTimeZone(new Date(now), timeZone)}.`,
    ]

    return { columns: COLUMNS, rows, summary, notes }
  },
}

export default addedNotBoughtReport
