import type { ReactNode } from 'react'
import { redirect } from 'next/navigation'
import { AlertTriangle, FileBarChart, Package, ScanLine, Store, type LucideIcon } from 'lucide-react'
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
import { InventoryFilterPills, StockStepper } from '@/components/shared/InventoryControls'
import { formatMoney } from '@/lib/utils'
import { isFrontDesk, isManager, isStaff, type UserRole } from '@/types/database'

export const dynamic = 'force-dynamic'

interface Props {
  /**
   * `focus` is set by the scanner when the code it read is outside the filter.
   * `q` is the search box, kept in the URL so a filtered shelf survives a
   * refresh and so the scanner's own navigation can clear it.
   */
  searchParams: Promise<{ filter?: string; focus?: string; q?: string }>
}

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'retail', label: 'Retail' },
  { key: 'backbar', label: 'Back bar' },
  { key: 'low', label: 'Low stock' },
]

// One literal, however long — postgrest parses the select string at the type
// level and a concatenation widens it to `string`.
const PRODUCT_COLUMNS =
  'id, sku, barcode, name, unit, stock_qty, low_stock_threshold, price_cents, cost_cents, is_retail, is_professional, is_active, external_url, image_url, brands(name), product_categories(name)'

export default async function InventoryPage({ searchParams }: Props) {
  const { filter, focus, q } = await searchParams
  const active = filter ?? 'all'
  const focusId = /^\d+$/.test(focus ?? '') ? Number(focus) : null
  const search = (q ?? '').trim()
  const term = search.toLowerCase()

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

  let query = supabase
    .from('products')
    .select(PRODUCT_COLUMNS)
    .eq('is_active', true)
    .is('archived_at', null)
    .order('name')

  if (active === 'retail') query = query.eq('is_retail', true)
  if (active === 'backbar') query = query.eq('is_professional', true)

  // The pills carry counts, and a count of the slice you are already looking at
  // is no use for deciding whether to look somewhere else. This second read is
  // the same set of products with none of the filters applied.
  const [{ data: products }, { data: tally }] = await Promise.all([
    query,
    supabase
      .from('products')
      .select('id, is_retail, is_professional, stock_qty, low_stock_threshold, external_url')
      .eq('is_active', true)
      .is('archived_at', null),
  ])

  type ProductRow = NonNullable<typeof products>[number]

  const nameOf = (embed: unknown) => (embed as { name: string } | null)?.name ?? null

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
   * alert constantly". Externally fulfilled products are pinned at zero by the
   * `products_external_has_no_stock` CHECK, so without this they are *all*
   * permanently low. Keep the two halves together — the filter, its count and
   * the row badge all read this one function so they cannot disagree.
   */
  const isLow = (p: {
    stock_qty: number
    low_stock_threshold: number
    external_url: string | null
  }) => p.external_url === null && Number(p.stock_qty) <= Number(p.low_stock_threshold)

  const rows = (products ?? [])
    .filter((p) => (active === 'low' ? isLow(p) : true))
    .filter(matchesSearch)

  const everything = tally ?? []
  const lowCount = everything.filter(isLow).length
  const counts: Record<string, number> = {
    all: everything.length,
    retail: everything.filter((p) => p.is_retail).length,
    backbar: everything.filter((p) => p.is_professional).length,
    low: lowCount,
  }
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
          // A GET form, so the search lands in the URL: it survives a refresh,
          // it can be sent to someone, and it works before React has loaded.
          <form method="get" className="w-full sm:w-80">
            <input type="hidden" name="filter" value={active} />
            <SearchField
              label="Search by product name or brand"
              name="q"
              defaultValue={search}
            />
          </form>
        }
      />

      <div className="mt-8 flex snap-x gap-4 overflow-x-auto pb-2">
        {tiles.map((tile) => (
          <ActionTile key={tile.title} {...tile} className="w-[19rem] shrink-0 snap-start" />
        ))}
      </div>

      <InventoryFilterPills
        options={filterOptions}
        value={active}
        search={search}
        className="mt-8"
      />

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
          title={search ? `Nothing matches “${search}”.` : 'Nothing here yet.'}
          description={
            search ? 'Names, brands, categories, SKUs and barcodes are all searched.' : undefined
          }
          action={
            search ? (
              <ButtonLink href={`/dashboard/inventory?filter=${active}`} variant="subtle" size="sm">
                Clear the search
              </ButtonLink>
            ) : undefined
          }
        />
      ) : (
        <Panel className="mt-6 overflow-hidden">
          <div
            className={`hidden gap-x-4 border-b border-[var(--color-border)] px-5 pb-3 pt-4 xl:grid ${columns}`}
          >
            <span className="label-caps text-[var(--color-muted)]">Product</span>
            <span className="label-caps text-[var(--color-muted)]">Brand</span>
            <span className="label-caps text-[var(--color-muted)]">Category</span>
            <span className="label-caps text-right text-[var(--color-muted)]">Price</span>
            {canSeeCost && (
              <span className="label-caps text-right text-[var(--color-muted)]">Cost</span>
            )}
            <span className="label-caps text-right text-[var(--color-muted)]">Quantity</span>
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
