import type { ReportColumn, ReportContext, ReportModule, ReportResult } from '@/lib/reports/types'
import { percent, ratioToPercent } from '@/lib/reports/types'
// The shared money engine, not a report module. Using its `allocate` and
// `splitRetailPayment` rather than a second copy is what makes the tax figure
// here and the one on the Sales Tax report the same number.
import { allocate, splitRetailPayment, windowBounds } from '@/lib/reports/money'
import { formatDateTimeInTimeZone } from '@/lib/time'
import { formatMoney } from '@/lib/utils'

/**
 * Retail Sales — what sold, what it made, and who sold it.
 *
 * Three things about this report are worth understanding before changing it.
 *
 * 1. REVENUE IS MONEY TAKEN. `orders.total_cents` is what was billed; the
 *    `payments` ledger is what actually arrived. An order can be part-paid and a
 *    refund is a negative payment row, so a figure taken from `orders` would
 *    both overstate takings and silently swallow refunds. Every number here
 *    called "revenue" is derived from succeeded payments and then allocated back
 *    down to the lines that earned it.
 *
 * 2. TAX IS NOT REVENUE. `orders.tax_cents` is the state's money being held.
 *    Shipping is excluded too — the postage it pays for is an expense on the
 *    other side of the books, so counting it as product revenue would flatter
 *    margin on every shipped order. What is left, `subtotal - discount`, is the
 *    merchandise figure this report allocates.
 *
 * 3. MARGIN USES THE COST CAPTURED AT SALE. `order_items.cost_snapshot_cents`
 *    (migration 043) freezes what the studio paid, the same way
 *    `unit_price_cents` freezes what it charged. Rows written before 043 were
 *    backfilled with the cost as it stood on that day, and rows whose product
 *    has since been deleted fall back to `products.cost_cents`. Both cases are
 *    counted and declared in `notes[]` — a margin figure the reader cannot date
 *    is a margin figure they cannot trust.
 */

// The statuses where a sale actually happened. `cart` and `pending_payment` are
// not sales; `cancelled` never was. `refunded` IS included on purpose — the
// goods left the shelf and the money came back, and netting the refund through
// `payments` is the only way it shows up at all. Dropping it would make a
// refunded month look like a good one.
const SALE_STATUSES = [
  'paid',
  'fulfilling',
  'ready_for_pickup',
  'shipped',
  'completed',
  'refunded',
] as const

// Select strings are SINGLE literals. Concatenating widens them to `string`,
// which collapses the whole result type to SelectQueryError.
// Carries every field `splitRetailPayment` needs, so an order row from here can
// be handed to the shared money engine unchanged.
const ORDER_COLS =
  'id, order_number, location_id, status, channel, payment_method, sold_by, guest_name, appointment_id, subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents, paid_at, created_at'
const ORDER_ITEM_COLS =
  'id, order_id, product_id, name_snapshot, sku_snapshot, unit_price_cents, qty, line_total_cents, cost_snapshot_cents'
const PAYMENT_COLS = 'id, order_id, amount_cents, kind, status, created_at'
const PRODUCT_COLS = 'id, sku, name, brand_id, category_id, cost_cents, is_retail, is_professional, external_url'
const APPOINTMENT_COLS = 'id, location_id, provider_id, status, starts_at'

/** Rows are the unit of work here; 1000 is PostgREST's default ceiling. */
const PAGE = 1000
/** Postgres will happily take a longer `IN`, but the URL will not. */
const IN_CHUNK = 200

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/**
 * Read every row, not the first page.
 *
 * PostgREST caps a response at `max-rows`; a year of order lines will exceed it
 * and the failure mode is a report that is quietly, plausibly wrong. Ordering by
 * id keeps the window stable across pages.
 */
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

type Bucket = {
  key: string
  name: string
  sku: string | null
  brandId: number | null
  categoryId: number | null
  units: number
  orders: Set<number>
  billed: number
  revenue: number
  inStoreRevenue: number
  onlineRevenue: number
  cost: number
  flags: Set<string>
}

function emptyBucket(key: string, name: string): Bucket {
  return {
    key,
    name,
    sku: null,
    brandId: null,
    categoryId: null,
    units: 0,
    orders: new Set<number>(),
    billed: 0,
    revenue: 0,
    inStoreRevenue: 0,
    onlineRevenue: 0,
    cost: 0,
    flags: new Set<string>(),
  }
}

const COLUMNS: ReportColumn[] = [
  { key: 'name', label: 'Product', align: 'left', format: 'text' },
  { key: 'sku', label: 'SKU', align: 'left', format: 'text' },
  { key: 'brand', label: 'Brand', align: 'left', format: 'text' },
  { key: 'category', label: 'Category', align: 'left', format: 'text' },
  { key: 'location', label: 'Site', align: 'left', format: 'text' },
  { key: 'units', label: 'Units', align: 'right', format: 'number', total: 'sum' },
  { key: 'orders', label: 'Orders', align: 'right', format: 'number', total: 'sum' },
  { key: 'billed_cents', label: 'Billed', align: 'right', format: 'money', total: 'sum' },
  { key: 'revenue_cents', label: 'Revenue', align: 'right', format: 'money', total: 'sum' },
  { key: 'in_store_revenue_cents', label: 'In studio', align: 'right', format: 'money', total: 'sum' },
  { key: 'online_revenue_cents', label: 'Online', align: 'right', format: 'money', total: 'sum' },
  { key: 'cost_cents', label: 'Cost', align: 'right', format: 'money', total: 'sum' },
  { key: 'margin_cents', label: 'Margin', align: 'right', format: 'money', total: 'sum' },
  // A percentage of a percentage is meaningless, so no footer total: the
  // footer's own margin over its own revenue is the only correct roll-up and
  // the shell can read it off the two money columns beside it.
  { key: 'margin_pct', label: 'Margin %', align: 'right', format: 'percent', total: null },
  { key: 'flags', label: 'Flags', align: 'left', format: 'text' },
]

export const retailSalesReport: ReportModule = {
  // Must match the registry key exactly — `loadReport` refuses a module that
  // answers at someone else's URL.
  key: 'retail_sales',
  title: 'Retail Sales',
  description: 'Units, revenue and margin by product, brand, category and seller — plus the attach rate.',
  // Shows cost and margin, so manager and above.
  minRole: 'manager',
  filters: ['dateRange', 'location', 'provider'],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const { supabase, from, to, locationId, providerId, timeZone } = ctx

    // Studio-local days turned into the instants the rows are stored in.
    // Half-open at the top so the last day is whole however many hours it has —
    // a DST Sunday is 23 or 25, never 24.
    const { startIso: fromAt, endIso: toAt } = windowBounds(from, to, timeZone)

    // ── Orders in the period ─────────────────────────────────
    // Anchored on when the sale happened, not when the cart was created: a cart
    // opened in March and paid in April is April's sale. `paid_at` is null for
    // rows the till wrote directly, so `created_at` stands in.
    const saleWindow = `and(paid_at.gte.${fromAt},paid_at.lt.${toAt}),and(paid_at.is.null,created_at.gte.${fromAt},created_at.lt.${toAt})`

    const orders = await fetchAll((offset, limit) => {
      let q = supabase
        .from('orders')
        .select(ORDER_COLS)
        .in('status', [...SALE_STATUSES])
        .or(saleWindow)
      if (locationId !== null) q = q.eq('location_id', locationId)
      // The provider filter reads as "this person's retail": what they rang up.
      if (providerId !== null) q = q.eq('sold_by', providerId)
      return q.order('id', { ascending: true }).range(offset, offset + limit - 1)
    })

    // ── Appointments in the period, for the attach rate ───────
    const appointments = await fetchAll((offset, limit) => {
      let q = supabase
        .from('appointments')
        .select(APPOINTMENT_COLS)
        .eq('status', 'completed')
        .gte('starts_at', fromAt)
        .lt('starts_at', toAt)
      if (locationId !== null) q = q.eq('location_id', locationId)
      if (providerId !== null) q = q.eq('provider_id', providerId)
      return q.order('id', { ascending: true }).range(offset, offset + limit - 1)
    })

    const appointmentIds = appointments.map((a) => a.id)

    // Sales attached to those visits, WITHOUT the date filter. A bottle rung up
    // the morning after the facial still belongs to that facial, and the whole
    // point of the attach rate is to catch retail that did or did not get sold
    // in the room.
    const attachedOrders =
      appointmentIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(appointmentIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('orders')
                    .select(ORDER_COLS)
                    .in('status', [...SALE_STATUSES])
                    .in('appointment_id', ids)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()

    // One row per order id across both sets — the attached list overlaps the
    // period list whenever the sale happened on the day of the visit.
    const orderById = new Map<number, (typeof orders)[number]>()
    for (const o of orders) orderById.set(o.id, o)
    for (const o of attachedOrders) if (!orderById.has(o.id)) orderById.set(o.id, o)

    const allOrderIds = [...orderById.keys()]

    // ── The money that actually arrived ───────────────────────
    // Every succeeded payment against these orders, refunds included (they are
    // negative rows, so they net out of the sum on their own).
    const payments =
      allOrderIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(allOrderIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('payments')
                    .select(PAYMENT_COLS)
                    .eq('status', 'succeeded')
                    .in('order_id', ids)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()

    const collectedByOrder = new Map<number, number>()
    for (const p of payments) {
      if (p.order_id === null) continue
      collectedByOrder.set(p.order_id, (collectedByOrder.get(p.order_id) ?? 0) + p.amount_cents)
    }

    // ── The lines, for the period's orders only ───────────────
    const periodOrderIds = orders.map((o) => o.id)
    const items =
      periodOrderIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(periodOrderIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('order_items')
                    .select(ORDER_ITEM_COLS)
                    .in('order_id', ids)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()

    // ── Reference data ────────────────────────────────────────
    const productIds = [...new Set(items.map((i) => i.product_id).filter((id): id is number => id !== null))]
    const products =
      productIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(productIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('products')
                    .select(PRODUCT_COLS)
                    .in('id', ids)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()
    const productById = new Map(products.map((p) => [p.id, p]))

    const brands = await fetchAll((offset, limit) =>
      supabase.from('brands').select('id, name').order('id', { ascending: true }).range(offset, offset + limit - 1),
    )
    const brandName = new Map(brands.map((b) => [b.id, b.name]))

    const categories = await fetchAll((offset, limit) =>
      supabase
        .from('product_categories')
        .select('id, name')
        .order('id', { ascending: true })
        .range(offset, offset + limit - 1),
    )
    const categoryName = new Map(categories.map((c) => [c.id, c.name]))

    const locations = await fetchAll((offset, limit) =>
      supabase.from('locations').select('id, name').order('id', { ascending: true }).range(offset, offset + limit - 1),
    )
    const locationName = new Map(locations.map((l) => [l.id, l.name]))

    const sellerIds = [...new Set(orders.map((o) => o.sold_by).filter((id): id is string => id !== null))]
    const sellers =
      sellerIds.length === 0
        ? []
        : (
            await Promise.all(
              chunk(sellerIds, IN_CHUNK).map((ids) =>
                fetchAll((offset, limit) =>
                  supabase
                    .from('profiles')
                    .select('id, first_name, last_name, display_name, email')
                    .in('id', ids)
                    .order('id', { ascending: true })
                    .range(offset, offset + limit - 1),
                ),
              ),
            )
          ).flat()
    // Same precedence the shared money engine uses, so a seller is called the
    // same thing on this report as on the Sales one.
    const sellerName = new Map(
      sellers.map((s) => [
        s.id,
        s.display_name || [s.first_name, s.last_name].filter(Boolean).join(' ').trim() || s.email || 'Unnamed staff',
      ]),
    )

    // ── Allocate each order's takings down to its lines ───────
    const itemsByOrder = new Map<number, typeof items>()
    for (const item of items) {
      const list = itemsByOrder.get(item.order_id)
      if (list) list.push(item)
      else itemsByOrder.set(item.order_id, [item])
    }

    const byProduct = new Map<string, Bucket>()
    const byBrand = new Map<string, Bucket>()
    const byCategory = new Map<string, Bucket>()
    const bySeller = new Map<string, Bucket>()

    let totalBilled = 0
    let totalRevenue = 0
    let totalCost = 0
    let totalUnits = 0
    let taxCollected = 0
    let shippingCollected = 0
    let outstanding = 0
    let refundedOrders = 0
    let snapshotLines = 0
    let fallbackLines = 0
    let zeroCostLines = 0
    let orphanLines = 0

    const touch = (map: Map<string, Bucket>, key: string, name: string): Bucket => {
      let b = map.get(key)
      if (!b) {
        b = emptyBucket(key, name)
        map.set(key, b)
      }
      return b
    }

    for (const order of orders) {
      const lines = itemsByOrder.get(order.id) ?? []
      const merchandise = order.subtotal_cents - order.discount_cents
      const collected = collectedByOrder.get(order.id) ?? 0

      if (order.status === 'refunded') refundedOrders += 1

      // How much of what arrived was for goods, as opposed to tax and postage.
      // A fully paid order returns the order's own figures unchanged; a
      // part-paid or part-refunded one is apportioned, which is the honest
      // answer to "what did this product earn" when only half the money is in.
      const split = splitRetailPayment(collected, order)

      taxCollected += split.taxCents
      shippingCollected += split.shippingCents
      outstanding += Math.max(order.total_cents - collected, 0)

      const weights = lines.map((l) => l.line_total_cents)
      const billedShares = allocate(merchandise, weights)
      const revenueShares = allocate(split.baseCents, weights)

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]
        const product = line.product_id === null ? undefined : productById.get(line.product_id)

        // `order_items.product_id` is ON DELETE SET NULL, so a product removed
        // from the catalogue leaves its sales behind with only a name snapshot.
        // Those lines are real sales and must not be dropped.
        const key = line.product_id === null ? `gone:${line.name_snapshot}` : `p:${line.product_id}`
        const name = product?.name ?? line.name_snapshot

        const bucket = touch(byProduct, key, name)
        bucket.sku = product?.sku ?? line.sku_snapshot
        bucket.brandId = product?.brand_id ?? null
        bucket.categoryId = product?.category_id ?? null

        // Cost as it was at the moment of sale (043). The fallback is only
        // reachable for pre-043 rows the backfill could not match and for
        // products deleted since — both are counted and declared.
        let unitCost = line.cost_snapshot_cents
        if (unitCost === null) {
          unitCost = product?.cost_cents ?? null
          fallbackLines += 1
        } else {
          snapshotLines += 1
        }
        if (line.product_id === null) orphanLines += 1
        if (unitCost === null || unitCost === 0) zeroCostLines += 1

        const lineCost = (unitCost ?? 0) * line.qty
        const billed = billedShares[i]
        const revenue = revenueShares[i]

        if (unitCost === null || unitCost === 0) bucket.flags.add('no cost')
        if (line.product_id === null) bucket.flags.add('product deleted')

        const apply = (b: Bucket) => {
          b.units += line.qty
          b.orders.add(order.id)
          b.billed += billed
          b.revenue += revenue
          b.cost += lineCost
          if (order.channel === 'in_store') b.inStoreRevenue += revenue
          else b.onlineRevenue += revenue
        }

        apply(bucket)

        const brandKey = product?.brand_id === null || product === undefined ? 'b:none' : `b:${product.brand_id}`
        const brandLabel =
          product?.brand_id != null ? (brandName.get(product.brand_id) ?? `Brand ${product.brand_id}`) : 'No brand'
        apply(touch(byBrand, brandKey, brandLabel))

        const catKey = product?.category_id === null || product === undefined ? 'c:none' : `c:${product.category_id}`
        const catLabel =
          product?.category_id != null
            ? (categoryName.get(product.category_id) ?? `Category ${product.category_id}`)
            : 'Uncategorised'
        apply(touch(byCategory, catKey, catLabel))

        const sellerKey = order.sold_by === null ? 's:none' : `s:${order.sold_by}`
        const sellerLabel =
          order.sold_by === null
            ? order.channel === 'in_store'
              ? 'In studio — seller not recorded'
              : 'Online (no seller)'
            : (sellerName.get(order.sold_by) ?? 'Unnamed staff')
        apply(touch(bySeller, sellerKey, sellerLabel))

        totalUnits += line.qty
        totalBilled += billed
        totalRevenue += revenue
        totalCost += lineCost
      }
    }

    // ── Attach rate ───────────────────────────────────────────
    // Of the visits that happened, how many left with a product.
    const ordersByAppointment = new Map<string, number[]>()
    for (const o of orderById.values()) {
      if (o.appointment_id === null) continue
      const list = ordersByAppointment.get(o.appointment_id)
      if (list) list.push(o.id)
      else ordersByAppointment.set(o.appointment_id, [o.id])
    }

    let visitsWithRetail = 0
    let attachedRevenue = 0
    for (const appointment of appointments) {
      const ids = ordersByAppointment.get(appointment.id)
      if (!ids || ids.length === 0) continue
      visitsWithRetail += 1
      for (const id of ids) {
        const o = orderById.get(id)
        if (!o) continue
        attachedRevenue += splitRetailPayment(collectedByOrder.get(o.id) ?? 0, o).baseCents
      }
    }
    const attachRate = ratioToPercent(visitsWithRetail, appointments.length)

    // ── Shape the output ──────────────────────────────────────
    const siteLabel =
      locationId === null ? 'All sites' : (locationName.get(locationId) ?? `Location ${locationId}`)

    const toRow = (b: Bucket): Record<string, string | number | null> => ({
      name: b.name,
      sku: b.sku,
      brand: b.brandId != null ? (brandName.get(b.brandId) ?? null) : null,
      category: b.categoryId != null ? (categoryName.get(b.categoryId) ?? null) : null,
      location: siteLabel,
      units: b.units,
      orders: b.orders.size,
      billed_cents: b.billed,
      revenue_cents: b.revenue,
      in_store_revenue_cents: b.inStoreRevenue,
      online_revenue_cents: b.onlineRevenue,
      cost_cents: b.cost,
      margin_cents: b.revenue - b.cost,
      // Percent values travel as 0–100, per the shell's `formatCell`.
      margin_pct: ratioToPercent(b.revenue - b.cost, b.revenue),
      flags: b.flags.size ? [...b.flags].join(', ') : null,
    })

    const byRevenueDesc = (a: Bucket, b: Bucket) => b.revenue - a.revenue || b.units - a.units || a.name.localeCompare(b.name)

    const productBuckets = [...byProduct.values()].sort(byRevenueDesc)
    const rows = productBuckets.map(toRow)

    const inStoreRevenue = productBuckets.reduce((sum, b) => sum + b.inStoreRevenue, 0)
    const onlineRevenue = productBuckets.reduce((sum, b) => sum + b.onlineRevenue, 0)
    const totalMargin = totalRevenue - totalCost

    const best = productBuckets[0]
    const worst = productBuckets.length > 1 ? productBuckets[productBuckets.length - 1] : undefined

    const summary: NonNullable<ReportResult['summary']> = [
      { label: 'Revenue (money taken)', value: formatMoney(totalRevenue) },
      { label: 'Billed', value: formatMoney(totalBilled) },
      { label: 'Cost of goods', value: formatMoney(totalCost) },
      {
        label: 'Margin',
        value: `${formatMoney(totalMargin)}${totalRevenue > 0 ? ` · ${percent(ratioToPercent(totalMargin, totalRevenue))}` : ''}`,
        tone: totalMargin < 0 ? 'warn' : 'good',
      },
      { label: 'Units sold', value: String(totalUnits) },
      { label: 'Orders', value: String(orders.length) },
      { label: 'In studio', value: formatMoney(inStoreRevenue) },
      { label: 'Online', value: formatMoney(onlineRevenue) },
      {
        label: 'Attach rate',
        value:
          attachRate === null
            ? 'No completed visits'
            : `${percent(attachRate)} · ${visitsWithRetail} of ${appointments.length} visits`,
        tone: attachRate !== null && attachRate < 15 ? 'warn' : 'good',
      },
      {
        label: 'Retail per visit',
        value: appointments.length === 0 ? '—' : formatMoney(Math.trunc(attachedRevenue / appointments.length)),
      },
      { label: 'Sales tax collected', value: formatMoney(taxCollected) },
    ]

    // Postage is money taken but it is not product revenue — it pays for a
    // service the studio buys straight back from the carrier. Shown so the
    // difference between the till total and this report's Revenue is fully
    // accounted for, rather than looking like a discrepancy.
    if (shippingCollected !== 0) {
      summary.push({ label: 'Shipping collected', value: formatMoney(shippingCollected) })
    }

    if (outstanding > 0) {
      summary.push({
        label: 'Still owed on period orders',
        value: formatMoney(outstanding),
        tone: 'warn',
      })
    }
    if (refundedOrders > 0) {
      summary.push({ label: 'Refunded orders', value: String(refundedOrders), tone: 'warn' })
    }
    if (zeroCostLines > 0) {
      summary.push({
        label: 'Lines with no cost on file',
        value: `${zeroCostLines} — margin overstated`,
        tone: 'warn',
      })
    }
    if (best) summary.push({ label: 'Best seller', value: `${best.name} · ${formatMoney(best.revenue)}` })
    if (worst) summary.push({ label: 'Weakest seller', value: `${worst.name} · ${formatMoney(worst.revenue)}` })

    const sections: NonNullable<ReportResult['sections']> = [
      { title: 'By brand', rows: [...byBrand.values()].sort(byRevenueDesc).map(toRow) },
      { title: 'By category', rows: [...byCategory.values()].sort(byRevenueDesc).map(toRow) },
      { title: 'Who rang it up', rows: [...bySeller.values()].sort(byRevenueDesc).map(toRow) },
    ]
    if (productBuckets.length > 5) {
      sections.push({
        title: 'Slowest five',
        rows: productBuckets.slice(-5).reverse().map(toRow),
      })
    }

    const notes: string[] = [
      `Period ${from} to ${to} inclusive, in ${timeZone}. An order belongs to the day it was paid (\`paid_at\`), falling back to \`created_at\` for till sales that never had a Stripe session — so a sale at 11pm on the last day is in.`,
      `Site: ${siteLabel}. ${locationId === null ? 'Aggregated across every location; the date boundary uses the zone above, which matters only if a second site is ever opened in another zone.' : 'Filtered to this location via `orders.location_id`.'}`,
      'Revenue is money TAKEN: succeeded rows in `payments`, refunds included as the negative amounts they are. It is not `orders.total_cents`, which is what was billed — the two differ whenever an order is part-paid or refunded, and the "Billed" tile beside it is there so the gap is visible rather than hidden.',
      'An order can be part-paid. Each order\'s takings are split into merchandise, tax and shipping in proportion to the amounts billed, and only the merchandise share is called revenue — tax is money held for the state and shipping pays for postage that is an expense on the other side of the books. The merchandise share is then spread across that order\'s lines in proportion to their line totals, by largest remainder, so the product rows sum to the headline exactly.',
      `Margin is revenue minus cost, where cost is \`order_items.cost_snapshot_cents\` — what the studio paid, captured at the moment of sale by migration 043. ${snapshotLines} of ${snapshotLines + fallbackLines} lines used that snapshot.`,
      'Rows written before migration 043 were backfilled with the wholesale cost as it stood on the day 043 ran, not the cost on the day of the sale. A margin figure from before that date is therefore approximate in exactly the way this column exists to stop: if the wholesale price moved in between, the historical margin was restated once, then frozen.',
      fallbackLines > 0
        ? `${fallbackLines} line(s) had no captured cost and fell back to \`products.cost_cents\` as it stands today. Those are restated every time a wholesale price changes.`
        : 'Every line in this period carried a captured cost; nothing fell back to today\'s `products.cost_cents`.',
      zeroCostLines > 0
        ? `${zeroCostLines} line(s) have no wholesale cost on file at all (cost of 0). Their margin is reported as the full sale price, which is wrong — it is shown rather than hidden so the gap gets filled. Products flagged "no cost" in the table are the ones to fix.`
        : 'Every line sold has a wholesale cost on file.',
      orphanLines > 0
        ? `${orphanLines} line(s) point at a product that has since been deleted (\`order_items.product_id\` is ON DELETE SET NULL). They are grouped by their name snapshot and flagged "product deleted"; brand and category are unknown for them.`
        : 'Every line still resolves to a product in the catalogue.',
      `Attach rate = completed appointments in the period that have at least one linked retail order, over all completed appointments in the period. Denominator: ${appointments.length} completed visit(s)${locationId === null ? '' : ' at this site'}${providerId === null ? '' : ' for the selected provider'}. Cancellations and no-shows are excluded — nobody was in the room to sell to. The link is \`orders.appointment_id\`, and attached orders are counted whatever day they were rung up, so a bottle sold the morning after still counts against that visit.`,
      '"Retail per visit" divides attached merchandise takings by every completed visit, not only the visits that bought — it is the number that moves when retail starts getting sold in the room.',
      'Orders counted are those in status paid, fulfilling, ready_for_pickup, shipped, completed or refunded. Carts and pending payments are not sales. Refunded orders are kept in: the units did leave the shelf, and the refund nets their revenue back out through `payments` instead of the whole order silently vanishing from the month.',
      'A refund taken in this period against an order sold in an earlier one does not appear here, because the report is anchored on the sale. Reconcile against the payments ledger directly if you need cash-in by day.',
      providerId === null
        ? null
        : 'The provider filter is applied to `orders.sold_by` — whose till rang it up — and to `appointments.provider_id` for the attach rate.',
      'The footer deliberately has no margin-percent total: averaging percentages is meaningless, so read the footer\'s own Margin over its own Revenue.',
      'The Sales and Sales Tax reports anchor on the day the money moved; this one anchors on the day of the sale. For a fully paid order those are the same day and the two agree; for a part-paid order or a refund landing in a later month they will not, and this report is the one that answers "what sold".',
      'Sub-tables reuse the main column set, so in "By brand" the Product column holds the brand name.',
      `Stock is not part of this report — see the Inventory report for what is left on the shelf. Read at ${formatDateTimeInTimeZone(new Date(ctx.now), timeZone)}.`,
    ].filter((n): n is string => n !== null)

    return { columns: COLUMNS, rows, summary, sections, notes }
  },
}

export default retailSalesReport
