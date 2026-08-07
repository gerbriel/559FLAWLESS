import type { ReactNode } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  FileBarChart,
  Package,
  ScanLine,
  Store,
  type LucideIcon,
} from 'lucide-react'
import { createClient } from '@/lib/supabase/server'
import { Badge } from '@/components/ui/badge'
import { ButtonLink } from '@/components/ui/button'
import {
  ActionTile,
  EmptyState,
  PageHeader,
  Panel,
  SearchField,
  Thumb,
} from '@/components/ui/dashboard'
import type { PillOption } from '@/components/ui/dashboard-client'
import { ProductEditor } from '@/components/shared/ProductEditor'
import { BarcodeField } from '@/components/shared/BarcodeField'
import { BarcodeInventoryScan } from '@/components/shared/BarcodeInventoryScan'
import { InventoryFilterPills, InventoryScope, StockStepper } from '@/components/shared/InventoryControls'
import {
  inventoryHref,
  readView,
  sortHref,
  SORT_COLUMN,
  type InventoryView,
  type SortKey,
} from '@/lib/inventory-view'
import { cn, formatMoney } from '@/lib/utils'
import { isFrontDesk, isManager, isStaff, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

interface Props {
  /**
   * `focus` is set by the scanner when the code it read is outside the filter.
   * Everything else is the list's own state and is read through `readView` —
   * kept in the URL so a filtered shelf survives a refresh, can be sent to
   * someone, and so the scanner's own navigation can clear it.
   */
  searchParams: Promise<{
    filter?: string
    focus?: string
    q?: string
    category?: string
    brand?: string
    sort?: string
    dir?: string
  }>
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'retail', label: 'Retail' },
  { key: 'backbar', label: 'Back bar' },
  { key: 'low', label: 'Low stock' },
]

/**
 * A column heading that sorts.
 *
 * A link rather than a button: the sort is in the URL like everything else on
 * this screen, so it survives a refresh and can be sent to someone. The arrow
 * only appears on the column actually in force — an arrow on every heading
 * tells you nothing about which one is doing the work.
 */
function SortHeader({
  label,
  column,
  view,
  align = 'left',
}: {
  label: string
  column: SortKey
  view: InventoryView
  align?: 'left' | 'right'
}) {
  const activeHere = view.sort === column
  const Arrow = view.dir === 'asc' ? ArrowUp : ArrowDown

  return (
    <Link
      href={sortHref(view, column)}
      // aria-sort belongs on the cell in a real table; this grid has none, so
      // the state goes in the accessible name instead of being mimed.
      aria-label={
        activeHere
          ? `${label}, sorted ${view.dir === 'asc' ? 'ascending' : 'descending'}. Reverse the order.`
          : `Sort by ${label.toLowerCase()}`
      }
      className={cn(
        'label-caps -my-1 inline-flex items-center gap-1 py-1 transition-colors hover:text-[var(--color-foreground)]',
        align === 'right' && 'flex-row-reverse',
        activeHere ? 'text-[var(--color-foreground)]' : 'text-[var(--color-muted)]'
      )}
    >
      {label}
      {activeHere && <Arrow className="h-3 w-3" strokeWidth={2} aria-hidden />}
    </Link>
  )
}

// One literal, however long — postgrest parses the select string at the type
// level and a concatenation widens it to `string`.
const PRODUCT_COLUMNS =
  'id, sku, barcode, name, unit, stock_qty, low_stock_threshold, price_cents, cost_cents, is_retail, is_professional, is_active, external_url, image_url, gallery, brands(name), product_categories(name)'

export default async function InventoryPage({ searchParams }: Props) {
  const params = await searchParams
  const focusId = /^\d+$/.test(params.focus ?? '') ? Number(params.focus) : null

  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle()

  const role = (profile?.role ?? 'provider') as UserRole
  // Cost is margin information, so it stays with the managers. Counting stock
  // is not — anyone working the room can do that.
  const canSeeCost = isManager(role)
  // Counting is not a manager decision either: migration 021 retired the
  // approval queue for stock on the grounds that whoever is holding the bottle
  // knows the number, and 032 kept it retired. `adjust_stock` refuses anyone
  // who is not staff, so this only ever hides buttons the RPC would reject.
  const canCount = isStaff(role)
  // Adding a product is not counting one. Migration 021 opened ordinary edits
  // to all staff and deliberately kept `manager creates products` as
  // `for insert with check (public.is_manager())` — catalogue shape is a
  // manager's decision. Showing anyone else the button would be offering an
  // action the database refuses.
  const canCreate = isManager(role)

  // Brands and categories are read before the products, not alongside them,
  // because the products query filters on their ids and the URL only carries
  // slugs. Two tiny reads in sequence rather than one round trip is the price
  // of a URL that says `?category=enzymes-masks` instead of `?category=7`.
  //
  // They used to be fetched only for the "New product" form. Now every member
  // of staff needs them, because they are also the filter pickers.
  const [{ data: brands }, { data: productCategories }] = await Promise.all([
    supabase.from('brands').select('id, name, slug').eq('is_active', true).order('name'),
    supabase
      .from('product_categories')
      .select('id, name, slug')
      .eq('is_active', true)
      .order('sort_order')
      .order('name'),
  ])

  const view = readView(params, canSeeCost)
  const categoryId = (productCategories ?? []).find((c) => c.slug === view.category)?.id ?? null
  const brandId = (brands ?? []).find((b) => b.slug === view.brand)?.id ?? null
  // A slug that matches nothing filters nothing, and the picker should say so
  // rather than sit blank on a value it has no option for.
  if (categoryId === null) view.category = ''
  if (brandId === null) view.brand = ''

  let query = supabase
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('is_active', true)
    .is('archived_at', null)
    .order(SORT_COLUMN[view.sort], { ascending: view.dir === 'asc' })
    // Name breaks every tie. Without it two products at the same price come
    // back in whatever order the planner felt like, and the list reshuffles
    // under someone counting from it.
    .order('name')

  if (view.filter === 'retail') query = query.eq('is_retail', true)
  if (view.filter === 'backbar') query = query.eq('is_professional', true)
  if (categoryId !== null) query = query.eq('category_id', categoryId)
  if (brandId !== null) query = query.eq('brand_id', brandId)

  // Counts come from a second read of the whole active catalogue, because a
  // count of the slice you are already looking at is no use for deciding
  // whether to look somewhere else.
  const [{ data: products }, { data: tally }] = await Promise.all([
    query,
    supabase
      .from('products')
      .select(
        'id, is_retail, is_professional, stock_qty, low_stock_threshold, external_url, category_id, brand_id'
      )
      .eq('is_active', true)
      .is('archived_at', null),
  ])

  type ProductRow = NonNullable<typeof products>[number]

  const nameOf = (embed: unknown) => (embed as { name: string } | null)?.name ?? null

  const term = view.q.toLowerCase()
  const matchesSearch = (p: ProductRow) => {
    if (!term) return true
    const fields = [p.name, p.sku, p.barcode ?? '', nameOf(p.brands) ?? '', nameOf(p.product_categories) ?? '']
    return fields.some((field) => field.toLowerCase().includes(term))
  }

  /**
   * Low, as the database defines it.
   *
   * The `external_url is null` half is not a detail — it is the whole
   * difference between a useful list and forty-odd rows of noise. Migration 007
   * says it twice: `products_low_stock_idx` is a partial index on
   * `is_active and external_url is null and stock_qty <= low_stock_threshold`,
   * and `product_low_stock_alert()` refuses to fire without the same clause,
   * "the marketplace holds that stock, so a zero here means nothing and would
   * alert constantly". That reasoning assumed `products_external_has_no_stock`
   * pinned linked products at zero — migration 024 dropped it, so they can and
   * do hold stock now, and the rule below is narrowed to match.
   *
   * NOTE the database has not caught up: `product_low_stock` and
   * `product_low_stock_alert()` still carry `external_url is null`, so a linked
   * product running low shows here and raises no alert. Aligning them is a
   * migration, and this screen showing the truth beats it staying silent in the
   * meantime. The filter, its count and the row badge all read this one
   * function, so those three cannot disagree with each other.
   */
  const isLow = (p: {
    stock_qty: number
    low_stock_threshold: number
    external_url: string | null
  }) =>
    Number(p.stock_qty) <= Number(p.low_stock_threshold) &&
    // A linked product sitting at zero is the marketplace's stock, not a
    // shortage — that is the noise the original clause existed to silence, and
    // it is still right. But 024 dropped `products_external_has_no_stock`
    // because the studio DOES keep these on the shelf and sells them in person,
    // so a linked product with two left and a threshold of three is genuinely
    // running out, and skipping it meant the one list that exists to warn her
    // never mentioned the products she actually stocks.
    (p.external_url === null || Number(p.stock_qty) > 0)

  const rows = (products ?? [])
    .filter((p) => (view.filter === 'low' ? isLow(p) : true))
    .filter(matchesSearch)

  /**
   * The counts on the controls, each scoped by the OTHER controls.
   *
   * Picking "Enzymes & masks" and still reading "Retail (150)" beside a list of
   * nine is a number that answers a question nobody asked. So the pills count
   * within the chosen category and brand, and each category counts within the
   * chosen pill and brand.
   *
   * The search box is deliberately not part of the scope: the tally read does
   * not carry names or SKUs to match against, and a count that moved on every
   * keystroke would be noise rather than information.
   */
  const everything = tally ?? []
  type TallyRow = (typeof everything)[number]
  const inCategory = (p: TallyRow) => categoryId === null || p.category_id === categoryId
  const inBrand = (p: TallyRow) => brandId === null || p.brand_id === brandId
  const inPill = (p: TallyRow) =>
    view.filter === 'retail'
      ? p.is_retail
      : view.filter === 'backbar'
        ? p.is_professional
        : view.filter === 'low'
          ? isLow(p)
          : true

  const forPills = everything.filter((p) => inCategory(p) && inBrand(p))
  const lowCount = forPills.filter(isLow).length
  const counts: Record<string, number> = {
    all: forPills.length,
    retail: forPills.filter((p) => p.is_retail).length,
    backbar: forPills.filter((p) => p.is_professional).length,
    low: lowCount,
  }

  const categoryOptions = (productCategories ?? []).map((c) => ({
    slug: c.slug,
    name: c.name,
    count: everything.filter((p) => p.category_id === c.id && inPill(p) && inBrand(p)).length,
  }))
  const brandOptions = (brands ?? []).map((b) => ({
    slug: b.slug,
    name: b.name,
    count: everything.filter((p) => p.brand_id === b.id && inPill(p) && inCategory(p)).length,
  }))
  /** Is anything hiding rows? The sort is not — it only reorders them. */
  const narrowed = !!view.q || !!view.category || !!view.brand || view.filter !== 'all'

  // Cost is a manager's column, so it is not offered as a sort to anyone who
  // cannot see it — `readView` refuses the same key from a hand-typed URL.
  const sortOptions: { key: SortKey; label: string }[] = [
    { key: 'name', label: 'Name' },
    { key: 'price', label: 'Price' },
    ...(canSeeCost ? ([{ key: 'cost', label: 'Cost' }] as const) : []),
    { key: 'qty', label: 'Quantity' },
  ]

  const filterOptions: PillOption[] = FILTERS.map((f) => ({
    value: f.key,
    label: f.label,
    count: counts[f.key],
  }))

  // Only what this studio can actually do, and only where the person looking
  // is allowed to go. Nothing here is a promise about a feature that does not
  // exist yet.
  const tiles: {
    icon: LucideIcon
    title: string
    subtitle: string
    href: string
    badge?: ReactNode
  }[] = [
    {
      icon: ScanLine,
      title: 'Count by scanning',
      subtitle:
        'A handheld scanner just types, and the code jumps straight to that bottle’s counter. The camera reads the same barcode.',
      href: '#scan-a-barcode',
      badge: (
        <Badge tone="warning" size="sm">
          Camera on a phone
        </Badge>
      ),
    },
    {
      icon: AlertTriangle,
      title: 'Low stock',
      subtitle:
        lowCount > 0
          ? `${lowCount} at or below the level set for them.`
          : 'Everything is above the level set for it.',
      href: '/dashboard/inventory?filter=low',
    },
  ]

  if (isFrontDesk(role)) {
    tiles.push({
      icon: Store,
      title: 'Selling keeps the count',
      subtitle:
        'A sale at the till and a completed treatment both draw stock down on their own — nobody has to remember.',
      href: '/dashboard/sell',
    })
  }

  if (isManager(role)) {
    tiles.push({
      icon: FileBarChart,
      title: 'What the shelf is worth',
      subtitle: 'Value on hand, weeks of cover, and what has not moved.',
      href: '/dashboard/reports/inventory',
    })
  }

  // Six columns only once there is room for six. Below that the row stacks, so
  // a phone never scrolls sideways to find out how many are left.
  const columns = canSeeCost
    ? 'xl:grid-cols-[minmax(0,1fr)_7rem_7rem_5.5rem_5.5rem_12.5rem]'
    : 'xl:grid-cols-[minmax(0,1fr)_7rem_7rem_5.5rem_12.5rem]'

  return (
    <div>
      <PageHeader
        title="Inventory"
        actions={
          <>
            {/* A GET form, so the search lands in the URL: it survives a
                refresh, it can be sent to someone, and it works before React
                has loaded. */}
            <form method="get" className="w-full sm:w-80">
              {/* Everything else about the view rides along as hidden fields, so
                  searching inside a category stays inside it. */}
              <input type="hidden" name="filter" value={view.filter} />
              <input type="hidden" name="category" value={view.category} />
              <input type="hidden" name="brand" value={view.brand} />
              <input type="hidden" name="sort" value={view.sort} />
              <input type="hidden" name="dir" value={view.dir} />
              <SearchField
                label="Search by product name or brand"
                name="q"
                defaultValue={view.q}
              />
            </form>
            {canCreate && (
              // ProductEditor owns its own trigger; without a product it is the
              // "New product" button. Restyling it from here to read as the
              // primary action beats forking the editor over a colour — the
              // same arrangement the services page uses.
              <span className="[&>button]:border-transparent [&>button]:bg-[var(--color-foreground)] [&>button]:text-[var(--color-background)] [&>button:hover]:border-transparent [&>button:hover]:bg-[var(--color-clay-deep)]">
                <ProductEditor
                  brands={brands ?? []}
                  categories={productCategories ?? []}
                />
              </span>
            )}
          </>
        }
      />

      <div className="mt-8 flex snap-x gap-4 overflow-x-auto pb-2">
        {tiles.map((tile) => (
          <ActionTile key={tile.title} {...tile} className="w-[19rem] shrink-0 snap-start" />
        ))}
      </div>

      <div className="mt-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-4">
        <InventoryFilterPills options={filterOptions} view={view} />
        <InventoryScope
          view={view}
          categories={categoryOptions}
          brands={brandOptions}
          sorts={sortOptions}
        />
      </div>

      {/* The scanner is untouched — same props, same behaviour, same two ways
          in. It predates the dashboard's rounded corners and is not this
          screen's file to edit, so its bar is softened from the outside. */}
      <div
        id="scan-a-barcode"
        className="scroll-mt-24 [&>div:first-child]:rounded-[var(--radius-panel)]"
      >
        <BarcodeInventoryScan
          focusId={focusId}
          rows={rows.map((p) => ({
            id: p.id,
            name: p.name,
            barcode: p.barcode,
            sku: p.sku,
            stock_qty: Number(p.stock_qty),
            unit: p.unit,
          }))}
        />
      </div>

      {rows.length === 0 ? (
        <EmptyState
          className="mt-6"
          icon={Package}
          title={view.q ? `Nothing matches “${view.q}”.` : 'Nothing here yet.'}
          description={
            view.q
              ? 'Names, brands, categories, SKUs and barcodes are all searched.'
              : narrowed
                ? 'Nothing on the shelf answers to all of those at once.'
                : undefined
          }
          action={
            narrowed ? (
              // Clears what is hiding rows and keeps the sort, which is not.
              <ButtonLink
                href={inventoryHref(view, { q: '', category: '', brand: '', filter: 'all' })}
                variant="subtle"
                size="sm"
              >
                {view.q && view.filter === 'all' && !view.category && !view.brand
                  ? 'Clear the search'
                  : 'Clear the filters'}
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <Panel className="mt-6 overflow-hidden">
          <div
            className={`hidden gap-x-4 border-b border-[var(--color-border)] px-5 pb-3 pt-4 xl:grid ${columns}`}
          >
            <SortHeader label="Product" column="name" view={view} />
            {/* Brand and category are filters, not sorts — the picker above
                does the useful version of "group by brand" already. */}
            <span className="label-caps text-[var(--color-muted)]">Brand</span>
            <span className="label-caps text-[var(--color-muted)]">Category</span>
            <span className="text-right">
              <SortHeader label="Price" column="price" view={view} align="right" />
            </span>
            {canSeeCost && (
              <span className="text-right">
                <SortHeader label="Cost" column="cost" view={view} align="right" />
              </span>
            )}
            <span className="text-right">
              <SortHeader label="Quantity" column="qty" view={view} align="right" />
            </span>
          </div>

          <ul>
            {rows.map((p) => {
              const brand = nameOf(p.brands)
              const category = nameOf(p.product_categories)
              const onHand = Number(p.stock_qty)
              const external = p.external_url !== null
              // Same predicate as the filter and its count, so a row that the
              // Low stock list returned always carries the badge that put it
              // there.
              const low = isLow(p)

              return (
                <li
                  key={p.id}
                  data-product-row={p.id}
                  className="border-b border-[var(--color-border)] px-5 py-4 transition-colors last:border-b-0"
                >
                  <div className={`grid gap-x-4 gap-y-3 xl:items-center ${columns}`}>
                    <div className="flex min-w-0 items-center gap-3">
                      <Thumb src={p.image_url} alt="" icon={Package} />
                      <div className="min-w-0">
                        <p className="truncate">{p.name}</p>
                        <p className="truncate text-xs text-[var(--color-muted)]">
                          {/* The brand has a column of its own once the row is
                              wide enough; until then it rides with the SKU. */}
                          <span className="xl:hidden">{brand ? `${brand} · ` : ''}</span>
                          {p.sku}
                        </p>
                        <span className="mt-1.5 flex flex-wrap gap-1.5">
                          {p.is_retail && (
                            <Badge tone="neutral" size="sm">
                              Retail
                            </Badge>
                          )}
                          {p.is_professional && (
                            <Badge tone="accent" size="sm">
                              Back bar
                            </Badge>
                          )}
                        </span>
                      </div>
                    </div>

                    <p className="hidden truncate text-sm text-[var(--color-muted)] xl:block">
                      {brand ?? '—'}
                    </p>
                    <p className="hidden truncate text-sm text-[var(--color-muted)] xl:block">
                      {category ?? '—'}
                    </p>

                    {/* Price, cost and count sit on one line while the row is
                        stacked, and become columns of their own at xl. */}
                    <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3 xl:contents">
                      <p className="text-sm tabular-nums xl:text-right">
                        <span className="label-caps mr-2 text-[var(--color-muted)] xl:hidden">
                          Price
                        </span>
                        {p.price_cents > 0 ? (
                          formatMoney(p.price_cents)
                        ) : (
                          <Badge tone="warning" size="sm">
                            No price
                          </Badge>
                        )}
                      </p>

                      {canSeeCost && (
                        <p className="text-sm tabular-nums text-[var(--color-muted)] xl:text-right">
                          <span className="label-caps mr-2 xl:hidden">Cost</span>
                          {formatMoney(p.cost_cents)}
                        </p>
                      )}

                      <div className="xl:justify-self-end">
                        {external ? (
                          <div className="text-sm xl:text-right">
                            <span className="tabular-nums">
                              {onHand} {p.unit}
                            </span>
                            <span className="block text-xs text-[var(--color-muted)]">
                              Shipped by the brand
                            </span>
                          </div>
                        ) : (
                          <>
                            <StockStepper
                              productId={p.id}
                              productName={p.name}
                              unit={p.unit}
                              quantity={onHand}
                              canCount={canCount}
                            />
                            <p className="mt-1 flex items-center gap-2 text-xs text-[var(--color-muted)] xl:justify-end">
                              <span>{p.unit}</span>
                              {low && (
                                <Badge tone="warning" size="sm">
                                  Low
                                </Badge>
                              )}
                            </p>
                          </>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* The editor keeps its `data-product-edit` wrapper: a scan
                      opens a row by clicking the button inside it, then puts
                      the cursor in the amount box. The barcode field sits under
                      it, one click from the product it describes. */}
                  <div className="mt-3 text-right sm:ml-auto sm:w-72">
                    <div data-product-edit>
                      <ProductEditor
                        product={{
                          id: p.id,
                          name: p.name,
                          unit: p.unit,
                          stock_qty: onHand,
                          low_stock_threshold: Number(p.low_stock_threshold),
                          is_retail: p.is_retail,
                          is_professional: p.is_professional,
                          price_cents: p.price_cents,
                          cost_cents: p.cost_cents,
                          external_url: p.external_url,
                          image_url: p.image_url,
                          gallery: Array.isArray(p.gallery) ? (p.gallery as string[]) : [],
                        }}
                      />
                    </div>
                    <div className="mt-2">
                      <BarcodeField
                        productId={p.id}
                        productName={p.name}
                        initialBarcode={p.barcode}
                      />
                    </div>
                  </div>
                </li>
              )
            })}
          </ul>
        </Panel>
      )}
    </div>
  )
}
