'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { X, Plus, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Field, Input, Select, Textarea } from '@/components/ui/field'
import { ImageField, ImageGalleryField } from '@/components/shared/ImageField'
import { describe, productBlockers, productSaleCount } from '@/lib/catalog-delete'
import { BarcodeField } from './BarcodeField'
import { normalizeBarcode, isValidGtin } from '@/types/barcode'
import { slugify } from '@/lib/utils'
import type { StockReason } from '@/types/database'

const REASONS: { value: StockReason; label: string }[] = [
  { value: 'received', label: 'Received a delivery' },
  { value: 'count_correction', label: 'Correcting the count' },
  { value: 'damaged', label: 'Damaged' },
  { value: 'expired', label: 'Expired' },
  { value: 'returned', label: 'Returned by a client' },
  { value: 'adjustment', label: 'Other adjustment' },
]

export interface EditableProduct {
  id: number
  name: string
  unit: string
  stock_qty: number
  low_stock_threshold: number
  is_retail: boolean
  is_professional: boolean
  price_cents: number
  cost_cents: number
  /** Where clients are sent when there is none left, if anywhere. */
  external_url: string | null
  /** The shop's main shot, and the extra angles beside it. */
  image_url?: string | null
  gallery?: string[]
}

/** A brand or a category to file a new product under. Both are optional. */
export interface ProductRefOption {
  id: number
  name: string
}

/**
 * "$12.10" → 1210, without ever multiplying a float.
 *
 * The obvious `Math.round(Number(x) * 100)` is what every other editor in this
 * codebase does and it is wrong in principle: `Number('12.10') * 100` is
 * 1209.9999999999998, and the rounding only hides that for as long as the
 * error stays under half a cent. Dollars and cents are two integers here, and
 * they are combined with integer arithmetic, so no float is ever in the path.
 *
 * Null when it is not money — a negative, a stray letter, or more precision
 * than a till can charge. Blank is zero, which is how a price is cleared.
 */
function toCents(input: string): number | null {
  const cleaned = input.replace(/[$,\s]/g, '')
  if (cleaned === '') return 0
  // Requires at least one digit, so "." and "$" alone are refused rather than
  // silently read as nothing.
  const parts = /^(?=.*[0-9])([0-9]*)(?:\.([0-9]{0,2}))?$/.exec(cleaned)
  if (!parts) return null
  const dollars = parts[1] === '' ? 0 : Number(parts[1])
  if (!Number.isSafeInteger(dollars)) return null
  const cents = Number((parts[2] ?? '').padEnd(2, '0'))
  return dollars * 100 + cents
}

const money = (cents: number) => (cents / 100).toFixed(2)

/**
 * The studio's own code for a product, when the box has none of its own.
 *
 * Same shape as the seeded catalogue: uppercase, hyphenated, derived from the
 * name. Unique is the database's job — a clash comes back as 23505 and is named
 * for the person, not swallowed.
 */
function skuFromName(name: string): string {
  return slugify(name).toUpperCase().slice(0, 40)
}

interface WriteError {
  code?: string
  message?: string
  details?: string | null
}

/**
 * Which unique column a 23505 was about.
 *
 * PostgREST forwards both halves of the Postgres error: `details` carries
 * `Key (sku)=(RA-FOO) already exists.` and `message` names the constraint. Read
 * the column out of either so the person is told which field to change instead
 * of being shown a constraint name.
 */
function collidedField(error: WriteError): 'sku' | 'slug' | 'barcode' | null {
  const text = `${error.details ?? ''} ${error.message ?? ''}`
  if (/Key \(sku\)|products_sku_key/.test(text)) return 'sku'
  if (/Key \(slug\)|products_slug_key/.test(text)) return 'slug'
  if (/Key \(barcode\)|products_barcode_key/.test(text)) return 'barcode'
  return null
}

/**
 * Stock and shelf settings for one product, or a form for a product that does
 * not exist yet.
 *
 * The prop is optional and that is the whole switch: absent means "New
 * product", present means "Edit" — the same shape as ServiceEditor and
 * ConsentFormEditor. The two modes are separate components underneath because
 * they are genuinely different forms (creating cannot adjust stock through the
 * RPC, and cannot show a barcode field bound to an id that does not exist yet),
 * and hooks cannot be declared conditionally.
 */
export function ProductEditor({
  product,
  brands,
  categories,
}: {
  product?: EditableProduct
  brands?: ProductRefOption[]
  categories?: ProductRefOption[]
}) {
  return product ? (
    <EditProduct product={product} />
  ) : (
    <NewProduct brands={brands ?? []} categories={categories ?? []} />
  )
}

/**
 * Add a product to the catalogue.
 *
 * Manager-only: migration 021 kept `manager creates products` as
 * `for insert with check (public.is_manager())` when it opened ordinary edits
 * to all staff, on the grounds that catalogue shape is a different decision
 * from counting what is on the shelf. The button is hidden for everyone else;
 * the policy is what actually refuses.
 */
function NewProduct({
  brands,
  categories,
}: {
  brands: ProductRefOption[]
  categories: ProductRefOption[]
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [name, setName] = useState('')
  const [sku, setSku] = useState('')
  const [barcode, setBarcode] = useState('')
  const [brandId, setBrandId] = useState('')
  const [categoryId, setCategoryId] = useState('')

  const [retail, setRetail] = useState(true)
  const [backBar, setBackBar] = useState(false)

  const [price, setPrice] = useState('')
  const [cost, setCost] = useState('')
  const [unit, setUnit] = useState('each')
  const [count, setCount] = useState('0')
  const [threshold, setThreshold] = useState('3')

  const [description, setDescription] = useState('')
  const [imageUrl, setImageUrl] = useState('')
  const [gallery, setGallery] = useState<string[]>([])
  const [externalUrl, setExternalUrl] = useState('')

  const trimmedName = name.trim()
  const derivedSku = skuFromName(trimmedName)
  const derivedSlug = slugify(trimmedName)
  const code = normalizeBarcode(barcode)
  const opening = Number(count)
  const external = externalUrl.trim() !== ''
  const priceCents = toCents(price)
  // Retail with a price of zero is the state the till refuses outright — worth
  // saying while the form is still open rather than after the row exists.
  const listedOnly = retail && external && priceCents === 0 && !(opening > 0)

  function reset() {
    setName('')
    setSku('')
    setBarcode('')
    setBrandId('')
    setCategoryId('')
    setRetail(true)
    setBackBar(false)
    setPrice('')
    setCost('')
    setUnit('each')
    setCount('0')
    setThreshold('3')
    setDescription('')
    setImageUrl('')
    setGallery([])
    setExternalUrl('')
  }

  async function save(e: React.FormEvent) {
    e.preventDefault()

    if (!trimmedName) {
      toast.error('Give it a name.')
      return
    }
    if (!derivedSlug) {
      toast.error('That name has no letters or numbers in it, so there is no web address to give it.')
      return
    }
    if (!retail && !backBar) {
      toast.error('Mark it retail, back bar, or both — otherwise it has nowhere to live.')
      return
    }

    // Mirrors the products_barcode_format CHECK added in 040: digits only,
    // 8 to 14 of them. Caught here so a mistyped code is a sentence rather
    // than a 23514.
    if (barcode.trim() !== '' && (code === null || !/^[0-9]{8,14}$/.test(code))) {
      toast.error('A barcode is 8 to 14 digits — check you scanned the whole thing.')
      return
    }

    const costCents = toCents(cost)
    if (priceCents === null) {
      toast.error('That price is not a number.')
      return
    }
    if (costCents === null) {
      toast.error('That cost is not a number.')
      return
    }

    // The till refuses `price_cents <= 0` (api/pos/sale/route.ts), so a retail
    // product it can actually reach needs a price. The one coherent exception
    // is a product that is only listed so clients can be sent to the brand for
    // it — no shelf, no counter sale — and that one is confirmed out loud below
    // rather than created quietly. The 42 seeded products are exactly that
    // shape and the studio has spent since 024 pricing them.
    if (retail && priceCents === 0 && !external) {
      toast.error('A retail product needs a price, or the till cannot ring it up.')
      return
    }
    if (retail && priceCents === 0 && opening > 0) {
      toast.error(
        `You are putting ${opening} ${unit} on the shelf. The till needs a price to sell them.`
      )
      return
    }

    if (!Number.isFinite(opening) || opening < 0) {
      toast.error('The opening count cannot be negative.')
      return
    }
    const low = Number(threshold)
    if (!Number.isFinite(low) || low < 0) {
      toast.error('The low-stock level must be zero or more.')
      return
    }

    if (listedOnly) {
      const ok = confirm(
        `${trimmedName} will be listed for clients to find, but with no price and nothing on the shelf the till cannot sell it — they will be sent to the brand's store instead. Add it that way?`
      )
      if (!ok) return
    }

    setBusy(true)
    const supabase = createClient()

    // stock_qty is deliberately left at its default of 0 and moved afterwards.
    // Every change to a count belongs in inventory_log, and adjust_stock is the
    // one statement that moves the balance and writes the log row together.
    const { data, error } = await supabase
      .from('products')
      .insert({
        sku: sku.trim() || derivedSku,
        name: trimmedName,
        slug: derivedSlug,
        barcode: code,
        brand_id: brandId ? Number(brandId) : null,
        category_id: categoryId ? Number(categoryId) : null,
        // Only meaningful on something a client can see.
        description: retail ? description.trim() || null : null,
        image_url: imageUrl.trim() || null,
        // A jsonb array since 007, with nothing ever able to fill it until now.
        gallery: gallery,
        external_url: retail && external ? externalUrl.trim() : null,
        price_cents: retail ? priceCents : 0,
        cost_cents: costCents,
        is_retail: retail,
        is_professional: backBar,
        unit: unit.trim() || 'each',
        low_stock_threshold: low,
        is_active: true,
      })
      .select('id')
      .single()

    if (error) {
      setBusy(false)
      const failure = error as WriteError
      if (failure.code === '42501') {
        toast.error('Only a manager can add a product.')
        return
      }
      if (failure.code === '23505') {
        const field = collidedField(failure)
        toast.error(
          field === 'sku'
            ? `The SKU “${sku.trim() || derivedSku}” is already on another product. Change it, or clear the box and one will be made from the name.`
            : field === 'slug'
              ? `Another product already uses the web address “${derivedSlug}”. Give this one a slightly different name.`
              : field === 'barcode'
                ? 'Another product already carries that barcode.'
                : 'Something about this product is already used by another one.'
        )
        return
      }
      toast.error(failure.message || 'Could not add that product.')
      return
    }

    // The row exists from here on. A failed count is reported as exactly that —
    // the product is not rolled back, because it is real and correct.
    if (opening > 0) {
      const { error: stockError } = await supabase.rpc('adjust_stock', {
        p_product_id: data.id,
        p_change: opening,
        // A brand-new row with a count on it is a delivery being put away.
        p_reason: 'received',
        p_note: 'Opening count, set when the product was added.',
      })
      setBusy(false)
      if (stockError) {
        toast.error(
          `${trimmedName} was added, but the opening count did not save. Set it from its row.`
        )
        setOpen(false)
        reset()
        router.refresh()
        return
      }
    } else {
      setBusy(false)
    }

    toast.success(`${trimmedName} added.`)
    setOpen(false)
    reset()
    router.refresh()
  }

  if (!open) {
    return (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        <Plus className="h-4 w-4" strokeWidth={1.75} />
        New product
      </Button>
    )
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/50 p-4 sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label="Add a product"
      onClick={() => !busy && setOpen(false)}
    >
      <form
        onSubmit={save}
        onClick={(e) => e.stopPropagation()}
        className="relative my-8 w-full max-w-2xl border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-left shadow-2xl sm:my-0 sm:p-8"
      >
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="absolute right-3 top-3 flex h-11 w-11 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
          aria-label="Close"
        >
          <X className="h-5 w-5" strokeWidth={1.5} />
        </button>

        <h2 className="display pr-10 text-2xl">Add a product</h2>

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="np_name" className="sm:col-span-2">
            <Input
              id="np_name"
              required
              maxLength={160}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Pumpkin Lactic Cleanse"
            />
          </Field>

          <Field
            label="SKU"
            htmlFor="np_sku"
            hint={
              trimmedName
                ? `The code on the box. Leave it blank and it becomes ${derivedSku}.`
                : 'The code on the box. Leave it blank and one is made from the name.'
            }
          >
            <Input
              id="np_sku"
              maxLength={64}
              autoComplete="off"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              placeholder={derivedSku || 'RA-PUMPKIN-LACTIC'}
            />
          </Field>

          <Field
            label="Barcode"
            htmlFor="np_barcode"
            hint="Optional. Scan it with the field focused, or type the digits under the bars."
          >
            <Input
              id="np_barcode"
              inputMode="numeric"
              autoComplete="off"
              maxLength={20}
              value={barcode}
              onChange={(e) => setBarcode(e.target.value)}
              placeholder="0123456789012"
            />
          </Field>

          {code !== null && code.length >= 8 && code.length <= 14 && !isValidGtin(code) && (
            <p className="text-xs text-[var(--color-muted)] sm:col-span-2">
              The check digit does not match a standard UPC/EAN. That is fine for an in-house
              label — worth a second scan if it came off a bottle.
            </p>
          )}

          <Field label="Brand" htmlFor="np_brand">
            <Select id="np_brand" value={brandId} onChange={(e) => setBrandId(e.target.value)}>
              <option value="">No brand</option>
              {brands.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>

          <Field label="Category" htmlFor="np_cat">
            <Select id="np_cat" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
              <option value="">Uncategorised</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </Select>
          </Field>
        </div>

        <div className="mt-6 space-y-3 border-t border-[var(--color-border)] pt-5">
          <p className="label-caps text-[var(--color-muted)]">Where it lives</p>

          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={retail}
              onChange={(e) => setRetail(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Retail
              <span className="block text-xs text-[var(--color-muted)]">
                Clients can see and buy it. Needs a price.
              </span>
            </span>
          </label>

          <label className="flex cursor-pointer items-start gap-2.5 text-sm">
            <input
              type="checkbox"
              checked={backBar}
              onChange={(e) => setBackBar(e.target.checked)}
              className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
            />
            <span>
              Back bar
              <span className="block text-xs text-[var(--color-muted)]">
                Used during treatments. Never shown to clients on its own.
              </span>
            </span>
          </label>

          {retail && backBar && (
            <p className="text-xs text-[var(--color-muted)]">
              Both, which is normal for a serum she sells and also uses in the room. One count
              covers both — the till and a completed treatment draw down the same number.
            </p>
          )}
        </div>

        <div className="mt-5 grid gap-4 border-t border-[var(--color-border)] pt-5 sm:grid-cols-2">
          <p className="label-caps text-[var(--color-muted)] sm:col-span-2">Money and count</p>

          {retail ? (
            <Field
              label="You charge"
              htmlFor="np_price"
              hint="In dollars, e.g. 42 or 42.00. This is the counter price, not the brand's."
            >
              <Input
                id="np_price"
                inputMode="decimal"
                value={price}
                onChange={(e) => setPrice(e.target.value)}
                placeholder="42.00"
              />
            </Field>
          ) : (
            <p className="self-center text-xs text-[var(--color-muted)]">
              Back-bar stock is never rung up, so it has no price — only what it costs you.
            </p>
          )}

          <Field
            label="It costs you"
            htmlFor="np_cost"
            hint="Optional. Used for margin in Analytics and for what the shelf is worth."
          >
            <Input
              id="np_cost"
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
              placeholder="18.50"
            />
          </Field>

          <Field
            label="Counted in"
            htmlFor="np_unit"
            hint="bottle, case, lb — whatever you say out loud when you count it."
          >
            <Input
              id="np_unit"
              maxLength={24}
              value={unit}
              onChange={(e) => setUnit(e.target.value)}
              placeholder="each"
            />
          </Field>

          <Field
            label="On the shelf now"
            htmlFor="np_count"
            hint="Goes into the stock log as an opening count. Zero is fine."
          >
            <Input
              id="np_count"
              type="number"
              step="any"
              min={0}
              value={count}
              onChange={(e) => setCount(e.target.value)}
            />
          </Field>

          <Field
            label="Tell me when it drops to"
            htmlFor="np_thresh"
            hint="At or below this it moves to Low stock."
          >
            <Input
              id="np_thresh"
              type="number"
              step="any"
              min={0}
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </Field>
        </div>

        {retail && (
          <div className="mt-5 space-y-4 border-t border-[var(--color-border)] pt-5">
            <p className="label-caps text-[var(--color-muted)]">In the shop</p>

            <Field
              label="Description"
              htmlFor="np_desc"
              hint="What it does and who it is for. Shown to clients on the shop page."
            >
              <Textarea
                id="np_desc"
                rows={3}
                maxLength={2000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </Field>

            <ImageField
              label="Photograph"
              value={imageUrl || null}
              onChange={(url) => setImageUrl(url ?? '')}
              bucket="products"
              folder="products"
              hint="Upload one, or link to the brand's own shot. Optional — without one the shop and the till show a placeholder."
            />

            <ImageGalleryField
              value={gallery}
              onChange={setGallery}
              bucket="products"
              folder="products"
              hint="Extra angles for the shop page, in the order they appear."
            />

            <Field
              label="Where to buy it when you run out"
              htmlFor="np_ext"
              hint="The brand's own store page. Optional."
            >
              <Input
                id="np_ext"
                type="url"
                inputMode="url"
                value={externalUrl}
                onChange={(e) => setExternalUrl(e.target.value)}
                placeholder="https://ramarketplace.com/store/559flawless/product/…"
              />
            </Field>

            {external && (
              // 007 said an externally fulfilled product "must not pretend to
              // hold stock" and enforced it with a CHECK. 024 dropped that
              // constraint, because it is not how the studio works: she keeps
              // these on a shelf and sells them in person, and the link is what
              // happens when she runs out. So stock and price above are real
              // for this product, not decoration.
              <p className="border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-3 text-xs text-[var(--color-muted)] dark:bg-[var(--color-background)]">
                The link is the fallback, not a replacement. Whatever you put on the shelf still
                sells at the counter at your price; clients are only sent to the brand once it
                runs out.
                {opening > 0 && (
                  <span className="mt-2 block">
                    One thing to know: the Low stock list skips anything with a link, so this
                    one will not appear there when it runs down.
                  </span>
                )}
              </p>
            )}

            {listedOnly && (
              <p className="border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-3 text-xs text-[var(--color-muted)] dark:bg-[var(--color-background)]">
                No price and nothing on the shelf, so this will be listed for clients to find and
                sent to the brand to buy — the till will not sell it. That is how the 42 imported
                products arrived. Give it a price whenever you start stocking it.
              </p>
            )}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center gap-2.5 border-t border-[var(--color-border)] pt-5">
          <Button type="submit" disabled={busy}>
            {busy ? 'Adding…' : 'Add product'}
          </Button>
          <Button
            type="button"
            variant="subtle"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            Cancel
          </Button>
        </div>
      </form>
    </div>
  )
}

/**
 * Stock and shelf settings for one product.
 *
 * Stock goes through the `adjust_stock` RPC, which moves the balance and writes
 * the log row in one statement so the two can never drift. There is no approval
 * step: whoever is holding the bottle is the person who knows the count, and the
 * RPC notifies the managers afterwards.
 */
function EditProduct({ product }: { product: EditableProduct }) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  const [change, setChange] = useState('')
  const [reason, setReason] = useState<StockReason>('received')
  const [note, setNote] = useState('')

  const [retail, setRetail] = useState(product.is_retail)
  const [backBar, setBackBar] = useState(product.is_professional)
  const [threshold, setThreshold] = useState(String(product.low_stock_threshold))
  const [price, setPrice] = useState(money(product.price_cents))
  const [cost, setCost] = useState(money(product.cost_cents))
  const [imageUrl, setImageUrl] = useState(product.image_url ?? null)
  const [gallery, setGallery] = useState<string[]>(product.gallery ?? [])

  async function applyStock(e: React.FormEvent) {
    e.preventDefault()
    const delta = Number(change)
    if (!Number.isFinite(delta) || delta === 0) {
      toast.error('Enter a non-zero amount.')
      return
    }
    if (product.stock_qty + delta < 0) {
      toast.error(`That would take ${product.name} below zero.`)
      return
    }

    setBusy(true)
    const { error } = await createClient().rpc('adjust_stock', {
      p_product_id: product.id,
      p_change: delta,
      p_reason: reason,
      p_note: note.trim() || null,
    })
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not adjust stock.')
      return
    }

    toast.success(`${product.name} is now ${product.stock_qty + delta} ${product.unit}.`)
    setChange('')
    setNote('')
    router.refresh()
  }

  async function saveSettings() {
    const t = Number(threshold)
    if (!Number.isFinite(t) || t < 0) {
      toast.error('The low-stock level must be zero or more.')
      return
    }
    if (!retail && !backBar) {
      toast.error('Mark it retail, back bar, or both — otherwise it has nowhere to live.')
      return
    }

    const priceCents = toCents(price)
    const costCents = toCents(cost)
    if (priceCents === null) {
      toast.error('That price is not a number.')
      return
    }
    if (costCents === null) {
      toast.error('That cost is not a number.')
      return
    }
    if (retail && priceCents === 0) {
      toast.error('A retail product needs a price before it can be sold.')
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('products')
      .update({
        is_retail: retail,
        is_professional: backBar,
        low_stock_threshold: t,
        price_cents: priceCents,
        cost_cents: costCents,
        image_url: imageUrl,
        gallery,
      })
      .eq('id', product.id)
    setBusy(false)

    if (error) {
      toast.error('Could not save those settings.')
      return
    }

    toast.success('Saved.')
    router.refresh()
  }

  /**
   * Take it off the shelf without taking it out of the books.
   *
   * `archived_at` has been on `products` since 007 and every screen already
   * filters on it — the inventory list, the till, the shop — so this column has
   * always been the intended way to retire something. Nothing could set it.
   * That is why a studio that stopped carrying a line had no move except
   * unticking retail and back bar, which leaves the row in the list forever.
   */
  async function archive() {
    if (!confirm(`Archive "${product.name}"? It leaves the list, the shop and the till, and every past sale keeps it.`)) {
      return
    }

    setBusy(true)
    const { error } = await createClient()
      .from('products')
      .update({ archived_at: new Date().toISOString(), is_active: false })
      .eq('id', product.id)
    setBusy(false)

    if (error) {
      toast.error(error.message || 'Could not archive that product.')
      return
    }
    toast.success(`${product.name} archived.`)
    setOpen(false)
    router.refresh()
  }

  /**
   * And the actual delete, for the row that should never have existed.
   *
   * A duplicate, a typo, something added to the wrong studio. Anything that has
   * been sold is an archive instead and this says so — not because the receipt
   * would break (`order_items` snapshots the name and the price, so it would
   * not) but because a product with a sales history is a thing the studio had,
   * and pretending otherwise makes the inventory reports lie about what was on
   * the shelf that year.
   */
  async function remove() {
    setBusy(true)
    const [sold, blockers] = await Promise.all([
      productSaleCount(product.id),
      productBlockers(product.id),
    ])
    setBusy(false)

    if (sold > 0) {
      toast.error(
        `${product.name} has been sold ${sold} ${sold === 1 ? 'time' : 'times'} — archive it instead.`,
        { description: 'Past receipts keep their own copy of the name and price, but the product itself is part of what the studio stocked.' }
      )
      return
    }

    const severe = blockers.filter((b) => b.severe)
    const warning =
      severe.length > 0
        ? `\n\nThis also removes ${severe.map(describe).join(', ')}, which go without a warning of their own.`
        : ''

    if (!confirm(`Delete "${product.name}" for good? It has never been sold.${warning}`)) return

    setBusy(true)
    const { error } = await createClient().from('products').delete().eq('id', product.id)
    setBusy(false)

    if (error) {
      toast.error(
        error.code === '23503'
          ? 'Something still refers to this product, so the database refused to delete it. Archive it instead.'
          : error.message || 'Could not delete that product.'
      )
      return
    }
    toast.success(`${product.name} deleted.`)
    setOpen(false)
    router.refresh()
  }

  if (!open) {
    return (
      <Button variant="subtle" size="sm" onClick={() => setOpen(true)}>
        Edit
      </Button>
    )
  }

  return (
    <div className="relative space-y-5 border border-[var(--color-border)] bg-[var(--color-surface)] p-4 text-left">
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-[var(--color-foreground)]"
        aria-label="Close"
      >
        <X className="h-4 w-4" strokeWidth={1.5} />
      </button>

      <form onSubmit={applyStock} className="space-y-3">
        <p className="label-caps text-[var(--color-muted)]">Adjust stock</p>

        <Field
          label="Change"
          htmlFor={`change_${product.id}`}
          hint={`Negative to remove. Now: ${product.stock_qty} ${product.unit}.`}
        >
          <Input
            id={`change_${product.id}`}
            type="number"
            step="any"
            required
            value={change}
            onChange={(e) => setChange(e.target.value)}
            placeholder="+6"
          />
        </Field>

        <Field label="Reason" htmlFor={`reason_${product.id}`}>
          <Select
            id={`reason_${product.id}`}
            value={reason}
            onChange={(e) => setReason(e.target.value as StockReason)}
          >
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </Select>
        </Field>

        <Field label="Note" htmlFor={`note_${product.id}`}>
          <Input
            id={`note_${product.id}`}
            maxLength={200}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
        </Field>

        <Button type="submit" size="sm" disabled={busy}>
          {busy ? 'Saving…' : 'Apply'}
        </Button>
      </form>

      <div className="space-y-3 border-t border-[var(--color-border)] pt-5">
        <p className="label-caps text-[var(--color-muted)]">Price</p>

        {product.price_cents === 0 && (
          <p className="border-l-2 border-[var(--color-accent)] bg-[var(--color-clay-soft)] p-3 text-sm text-[var(--color-muted)] dark:bg-[var(--color-background)]">
            No price set yet, so this cannot be sold at the counter. The catalogue was
            imported without prices — these are yours to set.
          </p>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            label="You charge"
            htmlFor={`price_${product.id}`}
            hint="In dollars, e.g. 42 or 42.00"
          >
            <Input
              id={`price_${product.id}`}
              inputMode="decimal"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
            />
          </Field>

          <Field
            label="It costs you"
            htmlFor={`cost_${product.id}`}
            hint="Optional. Used for margin in Analytics."
          >
            <Input
              id={`cost_${product.id}`}
              inputMode="decimal"
              value={cost}
              onChange={(e) => setCost(e.target.value)}
            />
          </Field>
        </div>

        {product.external_url && (
          <p className="text-xs text-[var(--color-muted)]">
            When this runs out, clients are sent to the Rhonda Allison store to have it
            shipped. That price is theirs and is not shown here.
          </p>
        )}
      </div>

      <div className="space-y-3 border-t border-[var(--color-border)] pt-5">
        <BarcodeField productId={product.id} productName={product.name} />
      </div>

      <div className="space-y-3 border-t border-[var(--color-border)] pt-5">
        <p className="label-caps text-[var(--color-muted)]">Where it lives</p>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={retail}
            onChange={(e) => setRetail(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Retail
            <span className="block text-xs text-[var(--color-muted)]">
              Clients can see and buy it.
            </span>
          </span>
        </label>

        <label className="flex cursor-pointer items-start gap-2.5 text-sm">
          <input
            type="checkbox"
            checked={backBar}
            onChange={(e) => setBackBar(e.target.checked)}
            className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]"
          />
          <span>
            Back bar
            <span className="block text-xs text-[var(--color-muted)]">
              Used during treatments. Never shown to clients on its own.
            </span>
          </span>
        </label>

        <Field
          label="Tell me when it drops to"
          htmlFor={`thresh_${product.id}`}
          hint={`In ${product.unit}. At or below this it moves to Low stock.`}
        >
          <Input
            id={`thresh_${product.id}`}
            type="number"
            step="any"
            min={0}
            value={threshold}
            onChange={(e) => setThreshold(e.target.value)}
          />
        </Field>

        {/* Retail only. A back-bar item is never on a page anybody outside the
            studio sees, so a photograph of it is storage nobody looks at. */}
        {retail && (
          <>
            <ImageField
              label="Photograph"
              value={imageUrl}
              onChange={setImageUrl}
              bucket="products"
              folder="products"
              hint="Shown in the shop and at the till. Saves with the settings below."
            />

            <ImageGalleryField
              value={gallery}
              onChange={setGallery}
              bucket="products"
              folder="products"
              hint="Extra angles for the shop page."
            />
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" variant="subtle" onClick={saveSettings} disabled={busy}>
            Save settings
          </Button>

          {/* Archive first and delete second, in that order and with that
              weight: retiring a line is the ordinary thing and deleting is for
              the row that should not have existed. */}
          <Button type="button" size="sm" variant="ghost" onClick={archive} disabled={busy}>
            Archive
          </Button>

          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={remove}
            disabled={busy}
            className="text-[var(--color-muted)] hover:text-red-700"
          >
            <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            Delete
          </Button>
        </div>
      </div>
    </div>
  )
}
