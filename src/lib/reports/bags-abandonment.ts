import type { ReportColumn, ReportContext, ReportModule, ReportResult } from '@/lib/reports/types'
import { MINUTE_MS, formatDateInTimeZone, formatDateTimeInTimeZone } from '@/lib/time'
import { formatMoney } from '@/lib/utils'
import type { Json } from '@/types/database'

/**
 * Abandoned Bags — who walked away from a full shopping bag, and what is in it.
 *
 * The source is `cart_snapshots` (060): one row per browsing session, the
 * CURRENT bag overwritten in place, swept at 30 days. Three consequences run
 * through this report:
 *
 * 1. IT IS A PHOTOGRAPH, NOT A PERIOD. There is no history to window over —
 *    yesterday's version of a bag no longer exists — so this report takes no
 *    date filter and always answers "as of right now". Nothing here can ever
 *    show a bag more than 30 days old, because the table's own retention has
 *    already removed it.
 *
 * 2. THE BAG HOLDS IDS, NEVER PRICES (rule 2). Every dollar figure is the
 *    quantity times TODAY'S `products.price_cents` — what the bag would ring
 *    up at if they came back this afternoon, which is the number the studio
 *    can actually act on. A price change since the bag was packed changes this
 *    report, and that is correct.
 *
 * 3. VISITORS ARE A COUNT, NOT ROWS. Most bags belong to people the studio
 *    cannot name. Listing them session by session would be a browsing-history
 *    panel wearing a different hat — exactly the line 060 drew — so anonymous
 *    bags are aggregated into one row and a headline number. The named rows
 *    are clients, because a client record is where the studio can act: the
 *    reminder button lives there, and it re-reads marketing consent at the
 *    moment of sending (038's principle), not here.
 */

/**
 * A bag is "abandoned" once nothing has touched it for this long.
 *
 * 24 hours: long enough that "still deciding over lunch" and "finishing on the
 * laptop tonight" have both passed, short enough that the products are still
 * on their mind and a reminder reads as helpful rather than as surveillance.
 * The description quotes this number because the owner reads descriptions, not
 * source files.
 */
const STALE_HOURS = 24

/**
 * A purchase "since the bag was last touched" counts in any of these statuses.
 * Same list the Retail Sales report uses, for the same reason: `cart` and
 * `pending_payment` are not purchases, and a `refunded` order still WAS one —
 * the client came back and bought, which is the question this column answers.
 */
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

/**
 * `cart_snapshots.lines` is jsonb written by `upsert_cart_snapshot()` (060) —
 * [{ productId, qty }], the cart store's own shape. The function caps size and
 * shape but does not inspect elements, so each is checked before it is summed.
 */
function parseBagLines(lines: Json | null | undefined): { productId: number; qty: number }[] {
  if (!Array.isArray(lines)) return []
  const out: { productId: number; qty: number }[] = []
  for (const raw of lines) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
    const line = raw as { productId?: Json; qty?: Json }
    if (typeof line.productId !== 'number' || !Number.isInteger(line.productId)) continue
    const qty = typeof line.qty === 'number' && Number.isFinite(line.qty) ? Math.trunc(line.qty) : 0
    if (qty <= 0) continue
    out.push({ productId: line.productId, qty: Math.min(qty, 99) })
  }
  return out
}

const COLUMNS: ReportColumn[] = [
  { key: 'who', label: 'Who', align: 'left', format: 'text' },
  { key: 'items', label: 'In the bag', align: 'left', format: 'text' },
  { key: 'item_count', label: 'Items', align: 'right', format: 'number', total: 'sum' },
  { key: 'value_cents', label: 'Bag value', align: 'right', format: 'money', total: 'sum' },
  { key: 'last_activity', label: 'Last activity', align: 'right', format: 'text' },
  { key: 'purchased_later', label: 'Bought since?', align: 'left', format: 'text' },
]

export const bagsAbandonmentReport: ReportModule = {
  // Must match the registry key exactly — `loadReport` refuses a module that
  // answers at someone else's URL.
  key: 'bags-abandonment',
  title: 'Abandoned Bags',
  description:
    'Shopping bags untouched for 24 hours with no purchase since — who to gently remind, and what is waiting in each. Visitors without an account are counted, not listed.',
  // Names clients against unfinished purchases — manager and above.
  minRole: 'manager',
  // A snapshot table has no period to filter: the report is always "right now".
  filters: [],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const { supabase, timeZone, now } = ctx

    const cutoffIso = new Date(now - STALE_HOURS * 60 * MINUTE_MS).toISOString()

    // ── Every bag nobody has touched since the cutoff ─────────
    // Ordered by primary key so the pages are stable; the table is bounded at
    // 30 days by its own sweep, so this is never a large read.
    const snapshots = await fetchAll((offset, limit) =>
      supabase
        .from('cart_snapshots')
        .select('session_id, client_id, lines, updated_at')
        .lt('updated_at', cutoffIso)
        .order('session_id', { ascending: true })
        .range(offset, offset + limit - 1),
    )

    const bags = snapshots
      .map((s) => ({ ...s, parsed: parseBagLines(s.lines) }))
      .filter((s) => s.parsed.length > 0)

    const named = bags.filter((b) => b.client_id !== null)
    const anonymous = bags.filter((b) => b.client_id === null)

    // ── Names and today's prices ──────────────────────────────
    const productIds = [...new Set(bags.flatMap((b) => b.parsed.map((l) => l.productId)))]
    const products =
      productIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(productIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('products')
                    .select('id, name, price_cents')
                    .in('id', ids)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()
    const productById = new Map(products.map((p) => [p.id, p]))

    const clientIds = [...new Set(named.map((b) => b.client_id as string))]
    const clients =
      clientIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(clientIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('profiles')
                    .select('id, first_name, last_name, email')
                    .in('id', ids)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()
    const clientById = new Map(clients.map((c) => [c.id, c]))

    // ── Did they buy anyway? ──────────────────────────────────
    // Any qualifying order whose effective moment — `paid_at`, falling back to
    // `created_at` for till sales — lands after the bag was last touched. The
    // `or` window is anchored on the OLDEST snapshot so one query covers every
    // client; the per-client comparison below is what actually decides.
    // Instants are compared as epoch milliseconds throughout: Postgres writes
    // timestamps with however many fractional digits it has, so two ISO
    // strings for nearby moments do not reliably sort as text.
    const oldestMs = named.reduce(
      (min, b) => Math.min(min, new Date(b.updated_at).getTime()),
      now - STALE_HOURS * 60 * MINUTE_MS,
    )
    const oldestIso = new Date(oldestMs).toISOString()
    const orders =
      clientIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(clientIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('orders')
                    .select('id, client_id, status, paid_at, created_at')
                    .in('status', [...PURCHASED_STATUSES])
                    .in('client_id', ids)
                    .or(`paid_at.gte.${oldestIso},and(paid_at.is.null,created_at.gte.${oldestIso})`)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()

    const latestPurchaseByClient = new Map<string, number>()
    for (const o of orders) {
      if (o.client_id === null) continue
      const at = new Date(o.paid_at ?? o.created_at).getTime()
      const held = latestPurchaseByClient.get(o.client_id)
      if (held === undefined || at > held) latestPurchaseByClient.set(o.client_id, at)
    }

    // ── Shape the rows ────────────────────────────────────────
    let droppedLines = 0
    const priceBag = (parsed: { productId: number; qty: number }[]) => {
      let cents = 0
      let count = 0
      const names: string[] = []
      for (const line of parsed) {
        const product = productById.get(line.productId)
        // A line pointing at a product the catalogue no longer knows prices
        // nothing and names nothing — dropped, and counted in the notes.
        if (!product) {
          droppedLines += 1
          continue
        }
        cents += product.price_cents * line.qty
        count += line.qty
        names.push(line.qty > 1 ? `${product.name} ×${line.qty}` : product.name)
      }
      return { cents, count, names }
    }

    type NamedRow = {
      who: string
      items: string
      itemCount: number
      valueCents: number
      updatedAt: string
      /** Epoch ms of the latest purchase after the bag went quiet, else null. */
      purchasedAt: number | null
    }

    const namedRows: NamedRow[] = []
    for (const bag of named) {
      const { cents, count, names } = priceBag(bag.parsed)
      if (count === 0) continue
      const person = clientById.get(bag.client_id as string)
      const who =
        [person?.first_name, person?.last_name].filter(Boolean).join(' ').trim() ||
        person?.email ||
        'Unnamed client'
      const purchasedAt = latestPurchaseByClient.get(bag.client_id as string)
      const bagAt = new Date(bag.updated_at).getTime()
      namedRows.push({
        who,
        items: names.join(', '),
        itemCount: count,
        valueCents: cents,
        updatedAt: bag.updated_at,
        purchasedAt: purchasedAt !== undefined && purchasedAt >= bagAt ? purchasedAt : null,
      })
    }

    // The ones still waiting first — they are the reason anyone opens this —
    // dearest bag on top; the already-recovered trail behind them.
    namedRows.sort((a, b) => {
      const aWaiting = a.purchasedAt === null ? 0 : 1
      const bWaiting = b.purchasedAt === null ? 0 : 1
      return aWaiting - bWaiting || b.valueCents - a.valueCents || a.who.localeCompare(b.who)
    })

    const rows: ReportResult['rows'] = namedRows.map((r) => ({
      who: r.who,
      items: r.items,
      item_count: r.itemCount,
      value_cents: r.valueCents,
      last_activity: formatDateTimeInTimeZone(new Date(r.updatedAt), timeZone),
      purchased_later:
        r.purchasedAt === null
          ? 'No'
          : `Yes — ${formatDateInTimeZone(new Date(r.purchasedAt), timeZone)}`,
    }))

    // ── Visitors, as one line ─────────────────────────────────
    let anonCount = 0
    let anonItems = 0
    let anonCents = 0
    let anonLatestMs: number | null = null
    for (const bag of anonymous) {
      const { cents, count } = priceBag(bag.parsed)
      if (count === 0) continue
      anonCount += 1
      anonItems += count
      anonCents += cents
      const at = new Date(bag.updated_at).getTime()
      if (anonLatestMs === null || at > anonLatestMs) anonLatestMs = at
    }
    if (anonCount > 0) {
      rows.push({
        who: anonCount === 1 ? '1 visitor — not signed in' : `${anonCount} visitors — not signed in`,
        items: null,
        item_count: anonItems,
        value_cents: anonCents,
        last_activity:
          anonLatestMs === null
            ? null
            : `newest ${formatDateTimeInTimeZone(new Date(anonLatestMs), timeZone)}`,
        purchased_later: '—',
      })
    }

    const waiting = namedRows.filter((r) => r.purchasedAt === null)
    const recovered = namedRows.length - waiting.length
    const waitingCents = waiting.reduce((sum, r) => sum + r.valueCents, 0)
    const totalCents = namedRows.reduce((sum, r) => sum + r.valueCents, 0) + anonCents

    const summary: NonNullable<ReportResult['summary']> = [
      { label: 'Bags waiting', value: String(namedRows.length + anonCount) },
      { label: 'Worth at today’s prices', value: formatMoney(totalCents) },
      {
        label: 'Signed-in, no purchase since',
        value: `${waiting.length} · ${formatMoney(waitingCents)}`,
        tone: waiting.length > 0 ? 'warn' : 'good',
      },
      { label: 'Bought anyway', value: String(recovered), tone: 'good' },
      { label: 'Anonymous visitors', value: String(anonCount) },
    ]

    const notes: string[] = [
      `A bag counts as abandoned after ${STALE_HOURS} hours untouched. The clock runs from the snapshot's own \`updated_at\`; touching the bag again — adding, removing, changing a quantity — resets it.`,
      'This is a photograph, not a period: `cart_snapshots` (060) holds each session\'s CURRENT bag, overwritten in place and swept at 30 days, so there is no date filter and nothing here can be more than a month old.',
      'The bag stores product ids and quantities only, never prices (rule 2). Every dollar figure is the quantity times today\'s shelf price — what the bag would ring up at if they walked in this afternoon.',
      `"Bought since?" means a qualifying order (${PURCHASED_STATUSES.join(', ')}) whose payment moment — \`paid_at\`, falling back to \`created_at\` for till sales — lands after the bag was last touched. It does not check whether they bought the SAME products; "they came back and spent" is the question a reminder answers. Refunded orders count: the purchase happened.`,
      'Visitors without an account are one aggregated line, deliberately. Listing anonymous sessions one by one would be a browsing trail with a different name — the line 060 drew — and there is nobody to act on anyway: no account means no notification to send.',
      'The reminder lives on the client record ("Send a gentle reminder"), not here — and it re-reads marketing consent at the moment of sending, per 038\'s principle, so a name on this list is not yet permission to contact it.',
      droppedLines > 0
        ? `${droppedLines} bag line(s) pointed at a product the catalogue no longer sells; they are priced at nothing and left out of the item lists.`
        : 'Every bag line still resolves to a product in the catalogue.',
      `Read at ${formatDateTimeInTimeZone(new Date(now), timeZone)}.`,
    ]

    return { columns: COLUMNS, rows, summary, notes }
  },
}

export default bagsAbandonmentReport
