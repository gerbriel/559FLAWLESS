/**
 * What the inventory list is currently showing, as one object.
 *
 * The screen has five independent controls — the stock pills, the search box,
 * the category and brand pickers and the sortable column headers — and each one
 * is a link or a navigation. Every one of them has to carry the other four, or
 * changing the sort quietly throws away the category someone just picked.
 *
 * Both sides of the render need this: the pickers are Client Components that
 * push a URL, the column headers are plain links on the Server Component. So it
 * lives in a module with no 'use client' and no imports, and there is exactly
 * one place that knows which parameters exist.
 *
 * `focus` is deliberately absent. It is a one-shot instruction from the scanner
 * to jump to a row, not a state of the list, and carrying it would re-trigger
 * the jump on every subsequent click.
 */
export interface InventoryView {
  /** Stock pill: 'all' | 'retail' | 'backbar' | 'low'. */
  filter: string
  /** Free-text search across name, SKU, barcode, brand and category. */
  q: string
  /** Category slug, or '' for every category. */
  category: string
  /** Brand slug, or '' for every brand. */
  brand: string
  sort: SortKey
  dir: SortDir
}

export type SortKey = 'name' | 'price' | 'cost' | 'qty'
export type SortDir = 'asc' | 'desc'

/** The column each sort key orders by, as postgrest names it. */
export const SORT_COLUMN: Record<SortKey, string> = {
  name: 'name',
  price: 'price_cents',
  cost: 'cost_cents',
  qty: 'stock_qty',
}

/**
 * Which way a column sorts the first time it is clicked.
 *
 * Not all ascending: money is most interesting at the top, and stock is most
 * interesting at the bottom — the first thing anyone wants from a quantity sort
 * is what is nearly gone. Clicking the same column again flips it.
 */
export const SORT_DEFAULT_DIR: Record<SortKey, SortDir> = {
  name: 'asc',
  price: 'desc',
  cost: 'desc',
  qty: 'asc',
}

export const DEFAULT_VIEW: InventoryView = {
  filter: 'all',
  q: '',
  category: '',
  brand: '',
  sort: 'name',
  dir: 'asc',
}

const isSortKey = (v: string): v is SortKey => v in SORT_COLUMN

/** Read a view out of the URL, falling back to the default for anything absent
 *  or unrecognised. `allowCost` is false for anyone who cannot see the cost
 *  column, so a hand-typed `?sort=cost` does not order a list by a figure that
 *  is not on screen. */
export function readView(
  params: {
    filter?: string
    q?: string
    category?: string
    brand?: string
    sort?: string
    dir?: string
  },
  allowCost = true
): InventoryView {
  const sortParam = (params.sort ?? '').trim()
  let sort: SortKey = isSortKey(sortParam) ? sortParam : DEFAULT_VIEW.sort
  if (sort === 'cost' && !allowCost) sort = DEFAULT_VIEW.sort

  const dirParam = (params.dir ?? '').trim()
  const dir: SortDir =
    dirParam === 'asc' || dirParam === 'desc' ? dirParam : SORT_DEFAULT_DIR[sort]

  return {
    filter: (params.filter ?? DEFAULT_VIEW.filter).trim() || DEFAULT_VIEW.filter,
    q: (params.q ?? '').trim(),
    category: (params.category ?? '').trim(),
    brand: (params.brand ?? '').trim(),
    sort,
    dir,
  }
}

/**
 * The URL for this view with some of it changed. Anything left at its default
 * is dropped, so the common case stays `/dashboard/inventory` rather than a
 * line of noise that says nothing.
 */
export function inventoryHref(view: InventoryView, patch: Partial<InventoryView> = {}): string {
  const next = { ...view, ...patch }
  const params = new URLSearchParams()
  if (next.filter !== DEFAULT_VIEW.filter) params.set('filter', next.filter)
  if (next.q) params.set('q', next.q)
  if (next.category) params.set('category', next.category)
  if (next.brand) params.set('brand', next.brand)
  if (next.sort !== DEFAULT_VIEW.sort) {
    params.set('sort', next.sort)
    if (next.dir !== SORT_DEFAULT_DIR[next.sort]) params.set('dir', next.dir)
  } else if (next.dir !== DEFAULT_VIEW.dir) {
    params.set('dir', next.dir)
  }
  const qs = params.toString()
  return qs ? `/dashboard/inventory?${qs}` : '/dashboard/inventory'
}

/**
 * The URL for clicking a column header: a new column starts at its own default
 * direction, the column already being sorted by flips.
 */
export function sortHref(view: InventoryView, key: SortKey): string {
  const dir: SortDir =
    view.sort === key ? (view.dir === 'asc' ? 'desc' : 'asc') : SORT_DEFAULT_DIR[key]
  return inventoryHref(view, { sort: key, dir })
}
