import type { ReportColumn, ReportContext, ReportModule, ReportResult } from '@/lib/reports/types'
import { addDaysToDateKey, formatDateTimeInTimeZone, zonedTimeToUtc } from '@/lib/time'
import { formatMoney } from '@/lib/utils'

/**
 * Inventory — what is on the shelf and what it is worth.
 *
 * The one rule this report exists to keep: STOCK COMES FROM `product_stock`.
 *
 * `products.stock_qty` is a trigger-maintained mirror of the PRIMARY site's row
 * and nothing else (migration 032). Reporting it as a business-wide total is the
 * exact failure that design was chosen to avoid — the till at the second site
 * reads "12 on hand", sells twelve, and ten of them are on a shelf in another
 * building. This module never selects that column, so it cannot accidentally
 * read it. "All locations" means summing `product_stock`.
 *
 * The second rule: a product that has never been priced is a PROBLEM, not a
 * zero. The 42 externally-fulfilled Rhonda Allison products were seeded with
 * `price_cents = 0` (and `cost_cents = 0`) until the studio sets its own
 * figures, and quietly valuing them at nothing would hide a shelf of real
 * inventory inside a total that looks complete. They are excluded from the
 * value totals, reported as null rather than 0, counted on their own tile and
 * listed in their own section.
 */

// Select strings are SINGLE literals — concatenation widens them to `string`
// and collapses the result type to SelectQueryError.
// NB: `stock_qty` is deliberately absent. See the header.
const PRODUCT_COLS =
  'id, sku, name, brand_id, category_id, unit, price_cents, cost_cents, low_stock_threshold, is_retail, is_professional, is_active, archived_at, external_url'
const STOCK_COLS = 'product_id, location_id, qty, low_stock_threshold, updated_at'
const LOG_COLS = 'id, product_id, location_id, change_qty, reason, created_at'

const PAGE = 1000

/**
 * More than this many weeks of cover at the period's own rate of sale is money
 * asleep on a shelf. Six months: long enough not to flag ordinary bulk buying
 * of wax and gloves, short enough to catch a case of serum bought on a deal
 * that will not clear before it expires.
 */
const OVERSTOCK_WEEKS = 26

/** Quantities are numeric(12,2). Working in hundredths keeps every sum exact. */
const HUNDREDTHS = 100

type PageResult<T> = { data: T[] | null; error: { message: string } | null }

/** Read every row. PostgREST caps a response at `max-rows`; a year of movements will exceed it. */
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

function toHundredths(qty: number | null | undefined): number {
  return Math.round((qty ?? 0) * HUNDREDTHS)
}

function fromHundredths(h: number): number {
  return h / HUNDREDTHS
}

/**
 * Value of a quantity at a unit price, in whole cents.
 *
 * A quantity of 2.5 bottles at $12.00 is $30.00 exactly, and doing that as
 * `2.5 * 1200` in floating point is the sort of thing that works until it
 * doesn't. Hundredths in, integer cents out, rounded once at the end.
 */
function valueCents(qtyHundredths: number, unitCents: number): number {
  return Math.round((qtyHundredths * unitCents) / HUNDREDTHS)
}

/** Days in [from, to] inclusive, counted as calendar days rather than elapsed hours. */
function inclusiveDayCount(from: string, to: string): number {
  const [fy, fm, fd] = from.split('-').map(Number)
  const [ty, tm, td] = to.split('-').map(Number)
  const ms = Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)
  return Math.floor(ms / 86_400_000) + 1
}

function round(value: number, places: number): number {
  const f = 10 ** places
  return Math.round(value * f) / f
}

type Movement = {
  received: number
  sold: number
  consumed: number
  adjusted: number
  damaged: number
  expired: number
  returned: number
  net: number
}

function emptyMovement(): Movement {
  return { received: 0, sold: 0, consumed: 0, adjusted: 0, damaged: 0, expired: 0, returned: 0, net: 0 }
}

const COLUMNS: ReportColumn[] = [
  { key: 'product', label: 'Product', align: 'left', format: 'text' },
  { key: 'sku', label: 'SKU', align: 'left', format: 'text' },
  { key: 'brand', label: 'Brand', align: 'left', format: 'text' },
  { key: 'category', label: 'Category', align: 'left', format: 'text' },
  { key: 'location', label: 'Site', align: 'left', format: 'text' },
  { key: 'use', label: 'Use', align: 'left', format: 'text' },
  { key: 'unit', label: 'Unit', align: 'left', format: 'text' },
  { key: 'on_hand', label: 'On hand', align: 'right', format: 'number', total: 'sum' },
  { key: 'threshold', label: 'Reorder at', align: 'right', format: 'number', total: null },
  { key: 'status', label: 'Status', align: 'left', format: 'text' },
  { key: 'cost_each_cents', label: 'Cost each', align: 'right', format: 'money', total: null },
  { key: 'value_cost_cents', label: 'Value at cost', align: 'right', format: 'money', total: 'sum' },
  { key: 'value_retail_cents', label: 'Value at retail', align: 'right', format: 'money', total: 'sum' },
  { key: 'received', label: 'Received', align: 'right', format: 'number', total: 'sum' },
  { key: 'sold', label: 'Sold', align: 'right', format: 'number', total: 'sum' },
  { key: 'consumed', label: 'Consumed', align: 'right', format: 'number', total: 'sum' },
  { key: 'adjusted', label: 'Adjusted', align: 'right', format: 'number', total: 'sum' },
  { key: 'damaged', label: 'Damaged', align: 'right', format: 'number', total: 'sum' },
  { key: 'expired', label: 'Expired', align: 'right', format: 'number', total: 'sum' },
  { key: 'returned', label: 'Returned', align: 'right', format: 'number', total: 'sum' },
  { key: 'units_out', label: 'Units out', align: 'right', format: 'number', total: 'sum' },
  { key: 'weeks_cover', label: 'Weeks cover', align: 'right', format: 'number', total: null },
  { key: 'turnover', label: 'Turns', align: 'right', format: 'number', total: null },
  { key: 'flags', label: 'Flags', align: 'left', format: 'text' },
]

export const inventoryReport: ReportModule = {
  key: 'inventory',
  title: 'Inventory',
  description: 'Stock on hand per site, what it is worth, how it moved, and what is not moving.',
  // Shows wholesale cost and stock valuation, so manager and above.
  minRole: 'manager',
  // No provider filter: a shelf does not belong to an esthetician.
  filters: ['dateRange', 'location'],

  async run(ctx: ReportContext): Promise<ReportResult> {
    const { supabase, from, to, locationId, timeZone } = ctx

    // Studio-local days, half-open at the top so the last day is whole whatever
    // DST does to it.
    const fromAt = zonedTimeToUtc(from, '00:00', timeZone).toISOString()
    const toAt = zonedTimeToUtc(addDaysToDateKey(to, 1), '00:00', timeZone).toISOString()

    const locations = await fetchAll((offset, limit) =>
      supabase
        .from('locations')
        .select('id, name, is_active, sort_order')
        .order('sort_order', { ascending: true })
        .range(offset, offset + limit - 1),
    )
    const locationName = new Map(locations.map((l) => [l.id, l.name]))
    // null means every site — and "every site" is the sum of `product_stock`,
    // never the primary-site mirror on `products`.
    const scopedLocationIds = new Set(locationId === null ? locations.map((l) => l.id) : [locationId])

    const products = await fetchAll((offset, limit) =>
      supabase.from('products').select(PRODUCT_COLS).order('id', { ascending: true }).range(offset, offset + limit - 1),
    )
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

    // ── Stock: the authoritative per-site count ───────────────
    const stock = await fetchAll((offset, limit) => {
      let q = supabase.from('product_stock').select(STOCK_COLS)
      if (locationId !== null) q = q.eq('location_id', locationId)
      return q
        .order('product_id', { ascending: true })
        .order('location_id', { ascending: true })
        .range(offset, offset + limit - 1)
    })

    // ── Movement in the period ────────────────────────────────
    const logs = await fetchAll((offset, limit) => {
      let q = supabase.from('inventory_log').select(LOG_COLS).gte('created_at', fromAt).lt('created_at', toAt)
      if (locationId !== null) q = q.eq('location_id', locationId)
      return q.order('id', { ascending: true }).range(offset, offset + limit - 1)
    })

    // ── Movement since the period ended ───────────────────────
    // `product_stock` is today's count. To say what was on the shelf at the end
    // of a period that has since passed, roll today's number back through
    // everything that has happened since. Empty whenever `to` is today or later.
    const logsAfter = await fetchAll((offset, limit) => {
      let q = supabase.from('inventory_log').select('id, product_id, location_id, change_qty').gte('created_at', toAt)
      if (locationId !== null) q = q.eq('location_id', locationId)
      return q.order('id', { ascending: true }).range(offset, offset + limit - 1)
    })

    // ── Fold it together, per product ─────────────────────────
    type Shelf = { locationId: number; qtyH: number; thresholdH: number }
    const shelvesByProduct = new Map<number, Shelf[]>()
    for (const row of stock) {
      const product = productById.get(row.product_id)
      // A per-site floor wins over the product's own — a busier site may want a
      // deeper one on the same bottle.
      const thresholdH = toHundredths(row.low_stock_threshold ?? product?.low_stock_threshold ?? 0)
      const list = shelvesByProduct.get(row.product_id)
      const shelf: Shelf = { locationId: row.location_id, qtyH: toHundredths(row.qty), thresholdH }
      if (list) list.push(shelf)
      else shelvesByProduct.set(row.product_id, [shelf])
    }

    const movementByProduct = new Map<number, Movement>()
    const netAfterByProduct = new Map<number, number>()

    for (const log of logs) {
      let m = movementByProduct.get(log.product_id)
      if (!m) {
        m = emptyMovement()
        movementByProduct.set(log.product_id, m)
      }
      const h = toHundredths(log.change_qty)
      m.net += h
      switch (log.reason) {
        case 'received':
          m.received += h
          break
        // Outward reasons are stored as negative changes and reported as
        // positive units out — "sold 6" reads better than "sold -6".
        case 'sold':
          m.sold -= h
          break
        case 'consumed':
          m.consumed -= h
          break
        case 'damaged':
          m.damaged -= h
          break
        case 'expired':
          m.expired -= h
          break
        case 'returned':
          m.returned += h
          break
        // A count correction is not a movement of goods — it is the discovery
        // that the number was wrong. Folded in with adjustments because both
        // are "somebody changed this by hand", and called out in notes[].
        case 'adjustment':
        case 'count_correction':
          m.adjusted += h
          break
      }
    }

    for (const log of logsAfter) {
      netAfterByProduct.set(log.product_id, (netAfterByProduct.get(log.product_id) ?? 0) + toHundredths(log.change_qty))
    }

    const days = inclusiveDayCount(from, to)
    const weeks = days / 7

    const siteLabel = locationId === null ? 'All sites' : (locationName.get(locationId) ?? `Location ${locationId}`)
    const multiSite = locationId === null && locations.length > 1

    type Computed = {
      row: Record<string, string | number | null>
      onHandH: number
      unitsOutH: number
      soldH: number
      consumedH: number
      valueCost: number | null
      valueRetail: number | null
      isLow: boolean
      isOut: boolean
      isOverstocked: boolean
      isDead: boolean
      unpriced: boolean
      noCost: boolean
      stocked: boolean
      moved: boolean
      /** Live, retail, not archived — something the shop is meant to be able to sell. */
      sellableInPrinciple: boolean
      sortName: string
    }

    function buildComputed(product: (typeof products)[number]): Computed {
      const shelves = (shelvesByProduct.get(product.id) ?? []).filter((s) => scopedLocationIds.has(s.locationId))
      const onHandH = shelves.reduce((sum, s) => sum + s.qtyH, 0)
      const movement = movementByProduct.get(product.id) ?? emptyMovement()
      const unitsOutH = movement.sold + movement.consumed

      const stocked = onHandH !== 0
      const moved =
        movement.received !== 0 ||
        movement.sold !== 0 ||
        movement.consumed !== 0 ||
        movement.adjusted !== 0 ||
        movement.damaged !== 0 ||
        movement.expired !== 0 ||
        movement.returned !== 0

      // Only a RETAIL product can be unpriced in the sense that matters. Wax and
      // gloves have no counter price by design, and flagging them as a gap would
      // bury the 42 products that genuinely are one.
      const unpriced = product.is_retail && product.price_cents === 0
      const noCost = product.cost_cents === 0

      // Value is only reported where there is a real figure behind it. A zero
      // price or a zero cost means "nobody has recorded one yet", and folding
      // that into a total as $0 makes the total look complete when it is not.
      // Back-bar-only stock has no retail value at all — that is a fact about
      // the product, not a missing figure, so it is blank rather than counted.
      const valueCost = noCost ? null : valueCents(onHandH, product.cost_cents)
      const valueRetail = !product.is_retail || unpriced ? null : valueCents(onHandH, product.price_cents)

      // Low stock is asked of a SHELF, not of the business. Summing counts
      // across sites and comparing to one threshold would hide an empty shelf
      // behind a full one in another building, and it is the empty shelf a
      // person has to walk over to and refill.
      const lowShelves = shelves.filter((s) => s.qtyH > 0 && s.qtyH <= s.thresholdH)
      const emptyShelves = shelves.filter((s) => s.qtyH <= 0)
      const isOut = onHandH <= 0
      const isLow = !isOut && lowShelves.length > 0

      // Weeks of cover: how long what is on the shelf lasts at the rate it went
      // out during the period. Undefined, not infinite, when nothing went out.
      const weeklyOutH = weeks > 0 ? unitsOutH / weeks : 0
      const weeksCover = weeklyOutH > 0 ? onHandH / weeklyOutH : null

      // Turnover over average stock held. Closing is today's count rolled back
      // through movements since the period ended; opening is closing rolled back
      // through the period's own movements.
      const closingH = onHandH - (netAfterByProduct.get(product.id) ?? 0)
      const openingH = closingH - movement.net
      const averageH = (openingH + closingH) / 2
      const turnover = averageH > 0 ? unitsOutH / averageH : null

      const isOverstocked = weeksCover !== null && weeksCover > OVERSTOCK_WEEKS && onHandH > 0
      const isDead = onHandH > 0 && unitsOutH === 0

      const flags: string[] = []
      if (unpriced) flags.push('unpriced')
      if (noCost) flags.push('no cost on file')
      if (isOverstocked) flags.push(`overstocked (${round(weeksCover ?? 0, 1)}w cover)`)
      if (isDead) flags.push('no movement')
      if (multiSite && emptyShelves.length > 0 && !isOut) {
        flags.push(`empty at ${emptyShelves.length} of ${shelves.length} sites`)
      }
      if (product.external_url !== null) flags.push('links out when empty')
      if (product.archived_at !== null) flags.push('archived')
      else if (!product.is_active) flags.push('inactive')

      const use =
        product.is_retail && product.is_professional
          ? 'Retail + back bar'
          : product.is_retail
            ? 'Retail'
            : product.is_professional
              ? 'Back bar'
              : '—'

      // One threshold to show. Per site when scoped to one; otherwise the
      // product's own default, because per-site floors do not add up.
      const shownThreshold =
        locationId !== null && shelves.length === 1 ? fromHundredths(shelves[0].thresholdH) : product.low_stock_threshold

      return {
        row: {
          product: product.name,
          sku: product.sku,
          brand: product.brand_id != null ? (brandName.get(product.brand_id) ?? null) : null,
          category: product.category_id != null ? (categoryName.get(product.category_id) ?? null) : null,
          location: siteLabel,
          use,
          unit: product.unit,
          on_hand: fromHundredths(onHandH),
          threshold: shownThreshold,
          status: isOut ? 'Out' : isLow ? 'Low' : 'OK',
          cost_each_cents: noCost ? null : product.cost_cents,
          value_cost_cents: valueCost,
          value_retail_cents: valueRetail,
          received: fromHundredths(movement.received),
          sold: fromHundredths(movement.sold),
          consumed: fromHundredths(movement.consumed),
          adjusted: fromHundredths(movement.adjusted),
          damaged: fromHundredths(movement.damaged),
          expired: fromHundredths(movement.expired),
          returned: fromHundredths(movement.returned),
          units_out: fromHundredths(unitsOutH),
          weeks_cover: weeksCover === null ? null : round(weeksCover, 1),
          turnover: turnover === null ? null : round(turnover, 2),
          flags: flags.length ? flags.join(', ') : null,
        },
        onHandH,
        unitsOutH,
        soldH: movement.sold,
        consumedH: movement.consumed,
        valueCost,
        valueRetail,
        isLow,
        isOut,
        isOverstocked,
        isDead,
        unpriced,
        noCost,
        stocked,
        moved,
        sellableInPrinciple: product.is_active && product.is_retail && product.archived_at === null,
        sortName: product.name,
      }
    }

    // A product with nothing on the shelf and no movement in the period has
    // nothing to say about the shelf — except that being unpriced makes it
    // unsellable, which is worth saying whether or not there is stock behind it.
    const computed: Computed[] = products
      .map(buildComputed)
      .filter(
        (c) =>
          c.stocked ||
          c.moved ||
          (c.unpriced && c.sellableInPrinciple),
      )

    // ── Totals ────────────────────────────────────────────────
    const stockedRows = computed.filter((c) => c.stocked)

    const totalValueCost = stockedRows.reduce((sum, c) => sum + (c.valueCost ?? 0), 0)
    const totalValueRetail = stockedRows.reduce((sum, c) => sum + (c.valueRetail ?? 0), 0)
    const totalUnitsH = stockedRows.reduce((sum, c) => sum + c.onHandH, 0)
    const soldUnitsH = computed.reduce((sum, c) => sum + c.soldH, 0)
    const consumedUnitsH = computed.reduce((sum, c) => sum + c.consumedH, 0)

    // Stock that is sitting there with no cost or no price recorded — the part
    // of the shelf the totals above cannot see.
    const unvaluedAtCost = stockedRows.filter((c) => c.noCost)
    const unvaluedAtRetail = stockedRows.filter((c) => c.unpriced)
    const unvaluedUnitsH = unvaluedAtCost.reduce((sum, c) => sum + c.onHandH, 0)

    const lowRows = computed.filter((c) => c.isLow)
    // "Out" means a shelf that ought to have something on it and does not.
    // Every product has a `product_stock` row at every site, so without the
    // movement test this would list the entire catalogue the studio has never
    // stocked — which tells nobody anything.
    const outRows = computed.filter((c) => c.isOut && c.moved)
    const overRows = computed.filter((c) => c.isOverstocked)
    const deadRows = computed.filter((c) => c.isDead)
    const unpricedRows = computed.filter((c) => c.unpriced)
    // Only worth listing where there is stock or trade behind it — a cost the
    // studio has never needed is not a gap.
    const noCostRows = computed.filter((c) => c.noCost && (c.stocked || c.moved))
    const backBarRows = computed.filter((c) => c.consumedH > 0)
    const retailMoved = computed.filter((c) => c.soldH > 0)

    const byValueDesc = (a: Computed, b: Computed) =>
      (b.valueCost ?? 0) - (a.valueCost ?? 0) || b.onHandH - a.onHandH || a.sortName.localeCompare(b.sortName)

    const rows = [...stockedRows].sort(byValueDesc).map((c) => c.row)

    const summary: NonNullable<ReportResult['summary']> = [
      { label: 'Stock value at cost', value: formatMoney(totalValueCost) },
      // Retail products only, and only the priced ones. Back bar has no counter
      // price by design; unpriced retail is a gap, and is on its own tile.
      { label: 'Stock value at retail', value: formatMoney(totalValueRetail) },
      { label: 'Units on hand', value: String(round(fromHundredths(totalUnitsH), 2)) },
      { label: 'Products with stock', value: String(stockedRows.length) },
      {
        label: 'Low stock',
        value: String(lowRows.length),
        tone: lowRows.length > 0 ? 'warn' : 'good',
      },
      {
        label: 'Out of stock',
        value: String(outRows.length),
        tone: outRows.length > 0 ? 'warn' : 'good',
      },
      { label: 'Overstocked', value: String(overRows.length), tone: overRows.length > 0 ? 'warn' : 'good' },
      { label: 'No movement', value: String(deadRows.length) },
      { label: 'Sold (retail units)', value: String(round(fromHundredths(soldUnitsH), 2)) },
      { label: 'Consumed (back bar units)', value: String(round(fromHundredths(consumedUnitsH), 2)) },
    ]

    if (unpricedRows.length > 0) {
      summary.push({
        label: 'Unpriced products',
        value: `${unpricedRows.length}${unvaluedAtRetail.length > 0 ? ` · ${unvaluedAtRetail.length} holding stock` : ''}`,
        tone: 'warn',
      })
    }
    if (unvaluedAtCost.length > 0) {
      summary.push({
        label: 'Stock with no cost on file',
        value: `${unvaluedAtCost.length} products · ${round(fromHundredths(unvaluedUnitsH), 2)} units`,
        tone: 'warn',
      })
    }
    if (noCostRows.length > unvaluedAtCost.length) {
      summary.push({
        label: 'Products with no cost recorded',
        value: String(noCostRows.length),
        tone: 'warn',
      })
    }

    const sections: NonNullable<ReportResult['sections']> = []
    if (lowRows.length) sections.push({ title: 'Low stock — at or below the reorder point', rows: lowRows.sort(byValueDesc).map((c) => c.row) })
    if (outRows.length) sections.push({ title: 'Out of stock', rows: outRows.sort(byValueDesc).map((c) => c.row) })
    if (overRows.length)
      sections.push({
        title: `Overstocked — more than ${OVERSTOCK_WEEKS} weeks of cover`,
        rows: overRows.sort(byValueDesc).map((c) => c.row),
      })
    if (deadRows.length)
      sections.push({ title: 'No movement in the period', rows: deadRows.sort(byValueDesc).map((c) => c.row) })
    if (backBarRows.length)
      sections.push({
        title: 'Back bar — consumed in treatment',
        rows: backBarRows.sort((a, b) => b.consumedH - a.consumedH).map((c) => c.row),
      })
    if (retailMoved.length)
      sections.push({
        title: 'Retail — sold to clients',
        rows: retailMoved.sort((a, b) => b.soldH - a.soldH).map((c) => c.row),
      })
    if (unpricedRows.length)
      sections.push({
        title: 'Unpriced — the till cannot sell these and they are worth nothing on paper',
        rows: unpricedRows.sort(byValueDesc).map((c) => c.row),
      })
    if (noCostRows.length)
      sections.push({
        title: 'No wholesale cost on file — stock value understated by whatever these are worth',
        rows: noCostRows.sort(byValueDesc).map((c) => c.row),
      })

    // Per-site breakdown, so "all locations" is never mistaken for one shelf.
    if (multiSite) {
      const perSite: Record<string, string | number | null>[] = []
      for (const product of products) {
        for (const shelf of shelvesByProduct.get(product.id) ?? []) {
          if (shelf.qtyH === 0) continue
          perSite.push({
            product: product.name,
            sku: product.sku,
            brand: product.brand_id != null ? (brandName.get(product.brand_id) ?? null) : null,
            category: product.category_id != null ? (categoryName.get(product.category_id) ?? null) : null,
            location: locationName.get(shelf.locationId) ?? `Location ${shelf.locationId}`,
            use: null,
            unit: product.unit,
            on_hand: fromHundredths(shelf.qtyH),
            threshold: fromHundredths(shelf.thresholdH),
            status: shelf.qtyH <= 0 ? 'Out' : shelf.qtyH <= shelf.thresholdH ? 'Low' : 'OK',
            cost_each_cents: product.cost_cents === 0 ? null : product.cost_cents,
            value_cost_cents: product.cost_cents === 0 ? null : valueCents(shelf.qtyH, product.cost_cents),
            value_retail_cents:
              !product.is_retail || product.price_cents === 0 ? null : valueCents(shelf.qtyH, product.price_cents),
            received: null,
            sold: null,
            consumed: null,
            adjusted: null,
            damaged: null,
            expired: null,
            returned: null,
            units_out: null,
            weeks_cover: null,
            turnover: null,
            flags: null,
          })
        }
      }
      if (perSite.length) sections.push({ title: 'Stock by site', rows: perSite })
    }

    const notes: string[] = [
      `Stock is as it stands right now (${formatDateTimeInTimeZone(new Date(ctx.now), timeZone)}), not as it stood at the end of the period. Movement columns cover ${from} to ${to} inclusive, ${days} day(s), in ${timeZone}.`,
      `Site: ${siteLabel}. Stock comes from \`product_stock\`, the per-site count. ${locationId === null ? 'Across all sites it is the SUM of those rows — `products.stock_qty` is a trigger-maintained mirror of the primary site only, and reporting it as a business-wide total is exactly the silent overselling migration 032 chose that design to avoid. This report never reads it.' : 'Scoped to this location’s row only.'}`,
      'Low stock is asked of a shelf, not of the business: a product is Low when any site in scope is at or below its reorder point (`product_stock.low_stock_threshold`, falling back to `products.low_stock_threshold`). Summing counts across sites and comparing them to one threshold would hide an empty shelf behind a full one in another building.',
      'Out of stock means nothing in scope — across all sites, that is nothing anywhere. A site with an empty shelf while another still has stock is flagged on the row instead, and listed under "Stock by site".',
      `Weeks of cover = units on hand ÷ (units out per week), where units out = sold + consumed over the period and the week count is ${round(weeks, 2)} (${days} days ÷ 7). It is left blank, not set to infinity, when nothing went out — those products are listed under "No movement" instead.`,
      `Overstocked = more than ${OVERSTOCK_WEEKS} weeks (six months) of cover at the period's own rate. Six months is long enough not to flag ordinary bulk buying of wax and gloves, short enough to catch a case bought on a deal that will not clear before it expires. A short reporting period makes this jumpy — a fortnight of unusually quiet sales will read as years of cover.`,
      'Turnover = units out ÷ average units on hand for the period, where average = (opening + closing) ÷ 2. Closing is today’s `product_stock` count rolled back through every movement since the period ended; opening is closing rolled back through the period’s own movements. It is blank where average stock was zero or negative.',
      'Back bar and retail are separated by MOVEMENT REASON, not by the product flags: `consumed` is what was used in treatment, `sold` is what a client bought. A serum that is both retail and back bar appears in both sections with its own share in each, because conflating them makes both numbers wrong. Its stock value is not split — there is one physical bottle on one shelf.',
      '`adjustment` and `count_correction` are reported together under "Adjusted". They are different things — one moves goods, the other corrects a number that was wrong — but both mean "somebody changed this by hand", which is what the column is for.',
      'Movement is signed in `inventory_log`; outward reasons (sold, consumed, damaged, expired) are shown as positive units out. "Adjusted" and "Returned" keep their sign, so a negative Adjusted is stock written off.',
      'Value at cost uses `products.cost_cents` — today’s wholesale price, applied to what is on the shelf now. That is the right basis for a stock valuation (it is what replacing it would cost) and is not the same figure as the margin in the Retail Sales report, which uses the cost captured at the moment of each sale.',
      '"Stock value at retail" covers retail products with a price only. Back-bar-only stock is blank rather than zero — a bottle of wax has no counter price by design, and giving it one would inflate the figure with money nobody is ever going to take.',
      unpricedRows.length > 0
        ? `${unpricedRows.length} retail product(s) have no price set (\`price_cents = 0\`). They are NOT valued at zero: their "Value at retail" is blank, they are excluded from the retail total above, and they are listed under "Unpriced". The 42 externally-fulfilled Rhonda Allison products were seeded this way on purpose — the studio sets its own counter price, and a guessed one on a real receipt would be worse than an empty field. Until it is filled in, the till refuses to sell them.`
        : 'Every stocked product has a price set.',
      noCostRows.length > 0
        ? `${noCostRows.length} product(s) have no wholesale cost on file (\`cost_cents = 0\`). Their stock value at cost is blank rather than zero, so the "Stock value at cost" tile above is understated by whatever those ${round(fromHundredths(unvaluedUnitsH), 2)} unit(s) are actually worth. Same reasoning as the price: a total that silently counts unknown stock as free looks complete when it is not.`
        : 'Every stocked product has a wholesale cost on file.',
      'Products with nothing on the shelf and no movement in the period are left out of the main table — there is nothing to report about them. Unpriced ones are still surfaced in their own section, because being unsellable is a problem whether or not there is stock behind it.',
      'Quantities are `numeric(12,2)`, not integers — a back bar counts in half-litres. All quantity arithmetic here is done in hundredths and money is integer cents throughout; nothing is rounded until the value is produced.',
      'Sub-tables reuse the main column set, so "Stock by site" leaves the movement columns blank.',
    ]

    return { columns: COLUMNS, rows, summary, sections, notes }
  },
}

export default inventoryReport
