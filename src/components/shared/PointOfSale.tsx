'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { toast } from 'sonner'
import { Search, Plus, Minus, Trash2, ExternalLink, Check, Package, Layers } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Select } from '@/components/ui/field'
import { createClient } from '@/lib/supabase/client'
import { cn, formatMoney } from '@/lib/utils'
import { sellPackage } from '@/app/dashboard/packages/actions'
import { packageErrorMessage } from '@/app/dashboard/packages/errors'
import {
  barcodeVariants,
  matchProductByBarcode,
  resolveScan,
  type ScannableProduct,
  type ScanResolution,
} from '@/types/barcode'
import { BarcodeScanHint, useBarcodeScanner } from './BarcodeScanner'
import { BarcodeCameraScanner } from './BarcodeCameraScanner'

export interface SellableProduct {
  id: number
  name: string
  sku: string | null
  /** The code on the packaging. Optional so an older page keeps compiling. */
  barcode?: string | null
  price_cents: number
  stock_qty: number
  unit: string
  external_url: string | null
  /** The product shot. Optional so an older page keeps compiling. */
  image_url?: string | null
  brand: string | null
}

/**
 * A prepaid course, on the same counter as the bottles.
 *
 * The till is handed the id, the name and enough to read the tile; the price
 * it charges is re-read from `service_packages` by the server action. Same
 * rule as the retail side, where the sale endpoint re-reads `products`.
 */
export interface SellablePackage {
  id: number
  name: string
  description: string | null
  /** What a session buys. Null is an open package — any service on the visit. */
  service_name: string | null
  session_count: number
  price_cents: number
  /** 0 means it never lapses. */
  valid_days: number
}

export interface CustomerOption {
  id: string
  name: string
  email: string | null
}

interface Line {
  product: SellableProduct
  qty: number
}

interface Receipt {
  order_number: string | null
  subtotal_cents: number
  tax_cents: number
  total_cents: number
  customer: string
  /** Set when the sale was a package rather than things off the shelf. */
  prepaid?: { name: string; sessions: number; expiresAt: string | null } | null
}

/**
 * The tile that just changed, and which way.
 *
 * `seq` is what makes a second tap on the same tile replay the animation: it
 * keys the element, so React remounts it rather than leaving a finished
 * animation sitting there.
 */
interface Cue {
  id: number
  dir: 'add' | 'remove'
  seq: number
  said: string
}

/**
 * The counter till.
 *
 * Built around what actually happens in the room: someone is standing there
 * with a bottle, and the sale should take seconds. So products are picked by
 * sight — the photo on the shelf, at the size of the bottle in your hand —
 * with a plus and a minus under it and nothing to read. The cart is always
 * visible, and nothing needs a client account: a walk-in is just a name.
 *
 * Every tap answers on the tile itself, because the eye is on the counter and
 * not on the panel in the corner: a wash of colour, a ±1 rising out of the
 * photo, and then the durable part — the tile keeps an accent frame and a
 * count for as long as it is in the sale. That last bit is the one that
 * survives reduced-motion and a glance three seconds later.
 *
 * Out-of-stock items stay visible rather than disappearing, because the useful
 * answer is not "we don't have it" but "we can ship it to you" — the studio's
 * Rhonda Allison storefront handles that, so the link is right there.
 *
 * Packages sit behind a switch rather than in the same basket, and that is a
 * decision rather than a shortcut. A prepaid course is not a thing off a shelf:
 * no stock moves, no sales tax is due on it (it buys service time, and services
 * are not taxable here), and it cannot be sold to a walk-in because the balance
 * has to belong to an account somebody can spend it from later. Mixing the two
 * into one basket would mean one receipt quietly holding two different sets of
 * rules. Two sales, two receipts, and each is what it says it is.
 */
export function PointOfSale({
  products,
  customers,
  taxRate,
  packages,
}: {
  products: SellableProduct[]
  customers: CustomerOption[]
  taxRate: number
  /**
   * Optional so a page that has never heard of packages still compiles and
   * still renders exactly the till it rendered before — with none passed, the
   * switch is not drawn at all.
   */
  packages?: SellablePackage[]
}) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [customerId, setCustomerId] = useState('')
  const [walkIn, setWalkIn] = useState('')
  const [method, setMethod] = useState<'cash' | 'card' | 'other'>('card')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [lastScan, setLastScan] = useState<string | null>(null)
  const [camera, setCamera] = useState(false)
  const [cue, setCue] = useState<Cue | null>(null)
  const cueSeq = useRef(0)

  /**
   * The package list, handed down or fetched.
   *
   * A page that knows about packages passes them and this never runs. A page
   * that does not — the till predates the feature — gets them anyway, because
   * `service_packages` is readable by any authenticated session when it is
   * active (008), and a switch that cannot be made to appear is worse than one
   * extra request on a screen that is open all day. Passing the prop from the
   * server is the better version of this, not a different one.
   */
  const [fetchedPackages, setFetchedPackages] = useState<SellablePackage[] | null>(null)

  useEffect(() => {
    if (packages !== undefined) return
    let alive = true

    void (async () => {
      const { data } = await createClient()
        .from('service_packages')
        .select('id, name, description, session_count, price_cents, valid_days, services(name)')
        .eq('is_active', true)
        .order('sort_order')
        .order('name')

      if (!alive) return
      setFetchedPackages(
        (data ?? []).map((p) => ({
          id: p.id,
          name: p.name,
          description: p.description,
          service_name: (p.services as { name: string } | null)?.name ?? null,
          session_count: p.session_count,
          price_cents: p.price_cents,
          valid_days: p.valid_days,
        }))
      )
    })()

    return () => {
      alive = false
    }
  }, [packages])

  const packageList = packages ?? fetchedPackages ?? []
  const [mode, setMode] = useState<'retail' | 'prepaid'>('retail')
  const [packageId, setPackageId] = useState<number | null>(null)
  // A package sale is one package. Two courses for the same person are two
  // balances, and two balances are two sales — there is no quantity here.
  const chosenPackage = packageList.find((p) => p.id === packageId) ?? null
  const sellingPackage = packageList.length > 0 && mode === 'prepaid'

  // One cue at a time, cleared a beat after the animation ends. Guarded by seq
  // so a later tap's timer is the only one that can retire it.
  useEffect(() => {
    if (!cue) return
    const seq = cue.seq
    const timer = setTimeout(() => setCue((c) => (c?.seq === seq ? null : c)), 850)
    return () => clearTimeout(timer)
  }, [cue])

  function flash(id: number, dir: 'add' | 'remove', said: string) {
    cueSeq.current += 1
    setCue({ id, dir, seq: cueSeq.current, said })
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return products
    return products.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.sku?.toLowerCase().includes(q) ||
        p.barcode?.includes(q) ||
        p.brand?.toLowerCase().includes(q)
    )
  }, [products, search])

  const retailSubtotal = lines.reduce((s, l) => s + l.product.price_cents * l.qty, 0)
  // Integer cents in, integer cents out — the rate is the only fraction in the
  // building and it never survives past this line.
  const retailTax = Math.round(retailSubtotal * taxRate)

  // No tax on a package: it buys service time, and services are not taxable in
  // California. Writing 8.35% of it into the order would invent a liability
  // nobody will ever be asked for.
  const subtotal = sellingPackage ? (chosenPackage?.price_cents ?? 0) : retailSubtotal
  const tax = sellingPackage ? 0 : retailTax
  const total = subtotal + tax

  /**
   * Add one of something, and say so on its tile.
   *
   * The shelf ceiling is refused out here rather than inside the updater: a
   * toast raised from a state updater is a side effect React is entitled to
   * run twice. The updater still clamps, so the count stays honest — it just
   * does it quietly.
   */
  function add(product: SellableProduct) {
    const inCart = lines.find((l) => l.product.id === product.id)?.qty ?? 0
    if (inCart >= product.stock_qty) {
      toast.error(`Only ${product.stock_qty} ${product.unit} of ${product.name} on the shelf.`)
      return
    }

    setLines((cur) => {
      const existing = cur.find((l) => l.product.id === product.id)
      if (!existing) return [...cur, { product, qty: 1 }]
      return cur.map((l) =>
        l.product.id === product.id ? { ...l, qty: Math.min(l.qty + 1, product.stock_qty) } : l
      )
    })
    flash(product.id, 'add', `Added ${product.name}. ${inCart + 1} in this sale.`)
  }

  /** Take one back off. The minus under the photo, and the one in the cart. */
  function subtract(product: SellableProduct) {
    const inCart = lines.find((l) => l.product.id === product.id)?.qty ?? 0
    if (inCart <= 0) return
    setQty(product.id, inCart - 1)
    flash(
      product.id,
      'remove',
      inCart === 1
        ? `Removed ${product.name} from this sale.`
        : `${product.name}, ${inCart - 1} in this sale.`
    )
  }

  /**
   * What a scan does at the till.
   *
   * Every refusal here is one the sale endpoint would give anyway — no price,
   * no stock, not sold to clients — said at the moment the bottle is scanned
   * rather than after the customer has been told a total. The endpoint still
   * re-checks all of it; this is the courtesy, not the guard.
   */
  const applyScan = useCallback((result: ScanResolution) => {
    switch (result.kind) {
      case 'unknown':
        toast.error(`Nothing on file for ${result.code}.`, {
          description: 'Save that barcode against the product under Inventory first.',
        })
        return
      case 'not_for_sale':
        toast.error(`${result.product.name} is back-bar stock, not something clients buy.`)
        return
      case 'unpriced':
        toast.error(`${result.product.name} has no price yet.`, {
          description: 'Set one under Inventory before selling it.',
        })
        return
      case 'out_of_stock':
        toast.error(`No ${result.product.name} left on the shelf.`, {
          description: result.product.external_url
            ? 'It can be shipped from the Rhonda Allison store instead.'
            : undefined,
        })
        return
      case 'match': {
        const p = result.product
        // Checked here as well as in `add`, so that scanning a fourth of three
        // shows the refusal on its own rather than beside a cheerful
        // confirmation.
        const inCart = lines.find((l) => l.product.id === p.id)?.qty ?? 0
        if (inCart >= p.stock_qty) {
          toast.error(
            `Only ${p.stock_qty} ${p.unit} of ${p.name} on the shelf, and it is all in this sale.`
          )
          return
        }
        // The photo and brand live on the till's own copy of the row; a scan
        // that came back off the network has neither.
        const known = products.find((row) => row.id === p.id)
        add({
          id: p.id,
          name: p.name,
          sku: p.sku,
          barcode: p.barcode,
          price_cents: p.price_cents,
          stock_qty: p.stock_qty,
          unit: p.unit,
          external_url: p.external_url,
          image_url: known?.image_url ?? null,
          brand: known?.brand ?? null,
        })
        toast.success(`${p.name} — ${formatMoney(p.price_cents)}`)
      }
    }
  }, [products, lines])

  const handleScan = useCallback(
    async (code: string) => {
      setLastScan(code)

      // The till already holds every active retail product, so the common case
      // never touches the network — and keeps working if it is down.
      const local = matchProductByBarcode(code, products)
      if (local) {
        applyScan(
          resolveScan(code, [
            { ...local, barcode: local.barcode ?? null, is_active: true, is_retail: true },
          ])
        )
        return
      }

      // Not in the retail list. It may still be on file, and "that one is back
      // bar" is a far more useful answer than "unknown barcode".
      const { data, error } = await createClient()
        .from('products')
        .select('id, name, sku, barcode, price_cents, stock_qty, unit, external_url, is_active, is_retail, archived_at')
        .in('barcode', barcodeVariants(code))
        .limit(1)

      if (error) {
        toast.error('Could not look that barcode up.')
        return
      }

      const row = (data ?? [])[0] as
        | (ScannableProduct & { archived_at: string | null })
        | undefined

      if (!row || row.archived_at) {
        applyScan({ kind: 'unknown', code })
        return
      }

      applyScan(resolveScan(code, [{ ...row, stock_qty: Number(row.stock_qty) }]))
    },
    [products, applyScan]
  )

  useBarcodeScanner({
    // The receipt screen is a full stop; a scan there should not quietly begin
    // a new sale behind it. Neither should one while a package is on the
    // counter — a package has nothing to scan, and a stray keystroke burst
    // should not silently switch what is being sold.
    enabled: !receipt && !camera && !sellingPackage,
    onScan: (scan) => {
      void handleScan(scan.code)
    },
  })

  function setQty(productId: number, qty: number) {
    setLines((cur) =>
      qty <= 0
        ? cur.filter((l) => l.product.id !== productId)
        : cur.map((l) => (l.product.id === productId ? { ...l, qty } : l))
    )
  }

  /**
   * Ring up a package.
   *
   * The browser sends WHICH package and to whom; `sellPackage` reads the price
   * out of `service_packages`, writes the order, the balance and the ledger
   * row, and hands back what it actually charged. Nothing about the money on
   * this screen is believed by the server.
   */
  async function ringUpPackage() {
    if (!chosenPackage) {
      toast.error('Pick a package first.')
      return
    }
    if (!customerId) {
      toast.error('A package needs a client account.', {
        description:
          'The sessions belong to a person and get spent at a later visit, so a walk-in name is not enough to hang them on.',
      })
      return
    }

    setBusy(true)
    try {
      const result = await sellPackage({
        packageId: chosenPackage.id,
        clientId: customerId,
        paymentMethod: method,
        note: notes.trim() || null,
      })

      if (!result.ok) {
        toast.error(packageErrorMessage(result.error))
        return
      }

      setReceipt({
        order_number: result.data.orderNumber,
        subtotal_cents: result.data.totalCents,
        tax_cents: 0,
        total_cents: result.data.totalCents,
        customer: customers.find((c) => c.id === customerId)?.name ?? 'Client',
        prepaid: {
          name: result.data.name,
          sessions: result.data.sessions,
          expiresAt: result.data.expiresAt,
        },
      })
      setPackageId(null)
      setCustomerId('')
      setNotes('')
      router.refresh()
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  async function ringUp() {
    if (sellingPackage) {
      await ringUpPackage()
      return
    }
    if (lines.length === 0) {
      toast.error('Add something to the sale first.')
      return
    }
    if (!customerId && !walkIn.trim()) {
      toast.error('Pick a client or type a name for the walk-in.')
      return
    }

    setBusy(true)
    try {
      const res = await fetch('/api/pos/sale', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: customerId || null,
          guestName: customerId ? null : walkIn.trim(),
          items: lines.map((l) => ({ productId: l.product.id, qty: l.qty })),
          paymentMethod: method,
          notes: notes.trim() || null,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        toast.error(data.message ?? 'Could not complete that sale.')
        return
      }

      setReceipt({
        ...data.order,
        customer: customerId
          ? (customers.find((c) => c.id === customerId)?.name ?? 'Client')
          : walkIn.trim(),
      })
      setLines([])
      setCustomerId('')
      setWalkIn('')
      setNotes('')
      router.refresh()
    } catch {
      toast.error('Could not reach the server.')
    } finally {
      setBusy(false)
    }
  }

  if (receipt) {
    return (
      <div className="mt-10 max-w-md border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
        <div className="flex items-center gap-2.5">
          <Check className="h-5 w-5 text-emerald-600" strokeWidth={2.5} />
          <h2 className="display text-2xl">Sale complete</h2>
        </div>

        <dl className="mt-6 space-y-2 text-sm">
          <div className="flex justify-between">
            <dt className="text-[var(--color-muted)]">Customer</dt>
            <dd>{receipt.customer}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--color-muted)]">Order</dt>
            <dd className="tabular-nums">{receipt.order_number ?? '—'}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-[var(--color-muted)]">Subtotal</dt>
            <dd className="tabular-nums">{formatMoney(receipt.subtotal_cents)}</dd>
          </div>
          {/* A package carries no sales tax, so the line would read $0 and say
              nothing. The retail sale always has one, even when it is zero. */}
          {!receipt.prepaid && (
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">Tax</dt>
              <dd className="tabular-nums">{formatMoney(receipt.tax_cents)}</dd>
            </div>
          )}
          {receipt.prepaid && (
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">Sessions</dt>
              <dd className="tabular-nums">{receipt.prepaid.sessions}</dd>
            </div>
          )}
          <div className="flex justify-between border-t border-[var(--color-border)] pt-2 text-base">
            <dt>Total</dt>
            <dd className="tabular-nums">{formatMoney(receipt.total_cents)}</dd>
          </div>
        </dl>

        <p className="mt-5 text-sm text-[var(--color-muted)]">
          {receipt.prepaid ? (
            <>
              {receipt.prepaid.sessions} sessions of {receipt.prepaid.name} are on{' '}
              {receipt.customer}&rsquo;s account
              {receipt.prepaid.expiresAt
                ? `, good until ${new Date(receipt.prepaid.expiresAt).toLocaleDateString('en-US')}`
                : ', with no expiry'}
              . Spend one at checkout and it comes off what that visit owes.
            </>
          ) : (
            <>Stock has been updated and this is on the customer&rsquo;s history.</>
          )}
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => setReceipt(null)}>New sale</Button>
          {receipt.prepaid ? (
            <Link href="/dashboard/packages/balances">
              <Button variant="subtle">Balances</Button>
            </Link>
          ) : (
            <Link href="/dashboard/orders">
              <Button variant="subtle">All orders</Button>
            </Link>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-[1fr_22rem]">
      <div>
        {/* Drawn only when there is something behind it. A studio that has
            never priced a package sees the till exactly as it was. */}
        {packageList.length > 0 && (
          <div
            data-ui="tile"
            role="group"
            aria-label="What is being sold"
            className="mb-6 inline-flex border border-[var(--color-border)] p-1"
          >
            {(
              [
                { value: 'retail', label: 'Products', icon: Package },
                { value: 'prepaid', label: 'Packages', icon: Layers },
              ] as const
            ).map((tab) => {
              const on = mode === tab.value
              const Icon = tab.icon
              return (
                <button
                  key={tab.value}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setMode(tab.value)}
                  data-ui="button"
                  className={cn(
                    'label-caps flex min-h-10 items-center gap-2 px-5',
                    on
                      ? 'bg-[var(--color-foreground)] text-[var(--color-background)]'
                      : 'text-[var(--color-muted)] hover:text-[var(--color-foreground)]'
                  )}
                >
                  <Icon className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                  {tab.label}
                </button>
              )
            })}
          </div>
        )}

        {sellingPackage ? (
          <>
            <p className="max-w-prose text-sm text-[var(--color-muted)]">
              A course paid for once and drawn down a session at a time. It goes on the
              client&rsquo;s account, so it needs a client — and no sales tax is charged,
              because what they are buying is treatment time.
            </p>

            <ul className="mt-5 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 xl:grid-cols-3">
              {packageList.map((p) => {
                const on = packageId === p.id
                const sessions = Math.max(p.session_count, 1)
                // Display only, never charged — the server re-reads
                // `price_cents` and that is the figure that moves.
                const perSessionCents = Math.round(p.price_cents / sessions)

                return (
                  <li key={p.id} className="bg-[var(--color-surface)]">
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => setPackageId(on ? null : p.id)}
                      className={cn(
                        'flex h-full w-full flex-col items-start p-5 text-left transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-background)]',
                        on && 'shadow-[inset_0_0_0_2px_var(--color-accent)]'
                      )}
                    >
                      <span className="flex w-full items-start justify-between gap-3">
                        <span className="text-base leading-snug">{p.name}</span>
                        {on && (
                          <Check
                            className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-accent)]"
                            strokeWidth={2.5}
                            aria-hidden
                          />
                        )}
                      </span>

                      <span className="mt-1 block text-xs text-[var(--color-muted)]">
                        {p.session_count} × {p.service_name ?? 'any service'}
                        {' · '}
                        {p.valid_days > 0 ? `${p.valid_days} days` : 'no expiry'}
                      </span>

                      {p.description && (
                        <span className="mt-3 line-clamp-3 text-sm leading-relaxed text-[var(--color-muted)]">
                          {p.description}
                        </span>
                      )}

                      <span className="mt-auto pt-4">
                        <span className="display block text-xl tabular-nums">
                          {formatMoney(p.price_cents)}
                        </span>
                        <span className="mt-0.5 block text-xs tabular-nums text-[var(--color-muted)]">
                          {formatMoney(perSessionCents)} a session
                        </span>
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </>
        ) : (
          <>
        <BarcodeScanHint
          className="mb-5"
          label="Scan a bottle to add it to the sale."
          lastCode={lastScan}
          onOpenCamera={() => setCamera(true)}
        />

        {camera && (
          <BarcodeCameraScanner
            title="Scan to add"
            onClose={() => setCamera(false)}
            onDetect={(code) => {
              // Stay open: at a counter you are usually ringing up more than one.
              void handleScan(code)
              return false
            }}
          />
        )}

        <label className="relative block">
          <span className="sr-only">Search products</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--color-muted)]"
            strokeWidth={1.5}
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by name, brand, SKU or barcode"
            className="w-full border border-[var(--color-border)] bg-[var(--color-surface)] py-3 pl-10 pr-3 text-sm outline-none focus:border-[var(--color-accent)]"
          />
        </label>

        {filtered.length === 0 ? (
          <p className="mt-6 border border-[var(--color-border)] bg-[var(--color-surface)] p-8 text-sm text-[var(--color-muted)]">
            Nothing matches &ldquo;{search}&rdquo;.
          </p>
        ) : (
          <ul className="mt-5 grid grid-cols-2 gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-3 xl:grid-cols-4">
            {filtered.map((p) => {
              const inCart = lines.find((l) => l.product.id === p.id)?.qty ?? 0
              const remaining = p.stock_qty - inCart
              const soldOut = p.stock_qty <= 0
              const here = cue?.id === p.id ? cue : null

              return (
                <li
                  key={p.id}
                  className={cn(
                    'flex flex-col bg-[var(--color-surface)] p-3',
                    // The part of the answer that outlives the animation.
                    inCart > 0 && 'shadow-[inset_0_0_0_2px_var(--color-accent)]'
                  )}
                >
                  <div className="relative aspect-square w-full overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-background)]">
                    {p.image_url ? (
                      <Image
                        src={p.image_url}
                        alt=""
                        fill
                        sizes="(max-width: 640px) 45vw, (max-width: 1280px) 28vw, 15rem"
                        // Transparent PNGs of a bottle — contained with padding,
                        // never cropped.
                        className="object-contain p-3"
                      />
                    ) : (
                      <div className="flex h-full items-center justify-center">
                        <Package
                          className="h-8 w-8 text-[var(--color-muted)]"
                          strokeWidth={1}
                          aria-hidden
                        />
                      </div>
                    )}

                    {inCart > 0 && (
                      <span className="absolute left-0 top-0 flex h-7 min-w-7 items-center justify-center bg-[var(--color-accent)] px-1.5 text-sm font-medium tabular-nums text-[var(--color-accent-fg)]">
                        {inCart}
                      </span>
                    )}

                    {/* Only for something the studio actually keeps and has run
                        out of. Most of the catalogue ships from the store and
                        has never been on the shelf — the button below says so,
                        and a badge on all forty of them says nothing. */}
                    {soldOut && !p.external_url && (
                      <span className="absolute right-1.5 top-1.5">
                        <Badge tone="neutral" size="sm">
                          Out
                        </Badge>
                      </span>
                    )}

                    {here && (
                      // Keyed by seq: a second tap remounts this, which is what
                      // replays the animation instead of leaving a finished one.
                      <span key={here.seq} className="pointer-events-none absolute inset-0" aria-hidden>
                        <span
                          className={cn(
                            'pos-flash absolute inset-0 border-2',
                            here.dir === 'add'
                              ? 'border-[var(--color-accent)] bg-[var(--color-accent)]/25'
                              : 'border-[var(--color-stone)] bg-[var(--color-stone)]/30'
                          )}
                        />
                        <span
                          className={cn(
                            'pos-cue display absolute inset-0 flex items-center justify-center text-4xl',
                            here.dir === 'add'
                              ? 'text-[var(--color-clay-deep)] dark:text-[var(--color-accent)]'
                              : 'text-[var(--color-stone)]'
                          )}
                        >
                          {here.dir === 'add' ? '+1' : '−1'}
                        </span>
                      </span>
                    )}
                  </div>

                  <div className="mt-3 flex-1">
                    <span className="line-clamp-2 text-sm leading-snug">{p.name}</span>
                    <span className="mt-1 block text-xs text-[var(--color-muted)]">
                      {/* Externally fulfilled stock carries no price here on
                          purpose — the marketplace owns it, and $0.00 is worse
                          than silence. */}
                      {p.price_cents > 0 && (
                        <>
                          <span className="tabular-nums">{formatMoney(p.price_cents)}</span>
                          {' · '}
                        </>
                      )}
                      {soldOut ? (
                        p.external_url ? (
                          'Sold from the store'
                        ) : (
                          <span className="text-amber-700 dark:text-amber-400">Out of stock</span>
                        )
                      ) : (
                        `${remaining} ${p.unit} left`
                      )}
                    </span>
                  </div>

                  {soldOut ? (
                    p.external_url ? (
                      <a
                        href={p.external_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="label-caps mt-3 flex min-h-11 items-center justify-center gap-1.5 border border-[var(--color-border)] text-[var(--color-accent)] hover:border-[var(--color-accent)]"
                      >
                        Ship it
                        <ExternalLink className="h-3 w-3" strokeWidth={2} />
                      </a>
                    ) : (
                      <p className="label-caps mt-3 flex min-h-11 items-center justify-center border border-dashed border-[var(--color-border)] text-[var(--color-muted)]">
                        None left
                      </p>
                    )
                  ) : (
                    <div className="mt-3 flex items-stretch border border-[var(--color-border)]">
                      <button
                        type="button"
                        onClick={() => subtract(p)}
                        disabled={inCart <= 0}
                        className="flex min-h-11 flex-1 items-center justify-center hover:bg-[var(--color-linen)] disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-[var(--color-background)]"
                      >
                        <Minus className="h-4 w-4" strokeWidth={2} aria-hidden />
                        <span className="sr-only">One fewer {p.name}</span>
                      </button>
                      <span className="flex w-10 shrink-0 items-center justify-center border-x border-[var(--color-border)] text-sm tabular-nums">
                        {inCart}
                      </span>
                      <button
                        type="button"
                        onClick={() => add(p)}
                        disabled={remaining <= 0}
                        className="flex min-h-11 flex-1 items-center justify-center hover:bg-[var(--color-linen)] disabled:opacity-30 disabled:hover:bg-transparent dark:hover:bg-[var(--color-background)]"
                      >
                        <Plus className="h-4 w-4" strokeWidth={2} aria-hidden />
                        <span className="sr-only">One more {p.name}</span>
                      </button>
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}

        {/* The same answer the tile gives, for anyone not watching it. */}
        <p className="sr-only" role="status" aria-live="polite">
          {cue?.said ?? ''}
        </p>
          </>
        )}
      </div>

      <aside className="lg:sticky lg:top-24 lg:self-start">
        <div className="border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <h2 className="label-caps text-[var(--color-muted)]">This sale</h2>

          {sellingPackage ? (
            chosenPackage === null ? (
              <p className="mt-4 text-sm text-[var(--color-muted)]">No package picked yet.</p>
            ) : (
              <div className="mt-4 flex items-start gap-2.5 text-sm">
                <span
                  data-ui="tile"
                  className="flex h-10 w-10 shrink-0 items-center justify-center bg-[var(--color-linen)] dark:bg-[var(--color-background)]"
                >
                  <Layers className="h-4 w-4 text-[var(--color-muted)]" strokeWidth={1.25} aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block">{chosenPackage.name}</span>
                  <span className="text-xs text-[var(--color-muted)]">
                    {chosenPackage.session_count} sessions ·{' '}
                    {chosenPackage.service_name ?? 'any service'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setPackageId(null)}
                  className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--color-muted)] hover:text-red-700"
                  aria-label={`Remove ${chosenPackage.name}`}
                >
                  <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                </button>
              </div>
            )
          ) : lines.length === 0 ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">Nothing added yet.</p>
          ) : (
            <ul className="mt-4 space-y-3">
              {lines.map((l) => (
                <li key={l.product.id} className="flex items-start gap-2.5 text-sm">
                  <div className="relative h-10 w-10 shrink-0 overflow-hidden bg-[var(--color-linen)] dark:bg-[var(--color-background)]">
                    {l.product.image_url ? (
                      <Image
                        src={l.product.image_url}
                        alt=""
                        fill
                        sizes="40px"
                        className="object-contain p-1"
                      />
                    ) : (
                      <Package
                        className="absolute left-1/2 top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 text-[var(--color-muted)]"
                        strokeWidth={1}
                        aria-hidden
                      />
                    )}
                  </div>

                  <div className="min-w-0 flex-1">
                    <span className="block truncate">{l.product.name}</span>
                    <span className="text-xs tabular-nums text-[var(--color-muted)]">
                      {formatMoney(l.product.price_cents)} each
                    </span>
                  </div>

                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => subtract(l.product)}
                      className="flex h-8 w-8 items-center justify-center border border-[var(--color-border)]"
                      aria-label={`One fewer ${l.product.name}`}
                    >
                      <Minus className="h-3 w-3" strokeWidth={2} />
                    </button>
                    <span className="w-7 text-center tabular-nums">{l.qty}</span>
                    <button
                      type="button"
                      onClick={() => add(l.product)}
                      className="flex h-8 w-8 items-center justify-center border border-[var(--color-border)]"
                      aria-label={`One more ${l.product.name}`}
                    >
                      <Plus className="h-3 w-3" strokeWidth={2} />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setQty(l.product.id, 0)
                        flash(l.product.id, 'remove', `Removed ${l.product.name} from this sale.`)
                      }}
                      className="ml-1 flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-red-700"
                      aria-label={`Remove ${l.product.name}`}
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}

          <dl className="mt-5 space-y-1.5 border-t border-[var(--color-border)] pt-4 text-sm">
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">Subtotal</dt>
              <dd className="tabular-nums">{formatMoney(subtotal)}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">
                {sellingPackage
                  ? 'Tax'
                  : `Tax ${(taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%`}
              </dt>
              <dd className="tabular-nums">
                {sellingPackage ? (
                  <span className="text-[var(--color-muted)]">Not taxable</span>
                ) : (
                  formatMoney(tax)
                )}
              </dd>
            </div>
            <div className="flex justify-between pt-1 text-base">
              <dt>Total</dt>
              <dd className="tabular-nums">{formatMoney(total)}</dd>
            </div>
          </dl>
        </div>

        <div className="mt-5 space-y-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <Field
            label="Client"
            htmlFor="pos_client"
            hint={
              sellingPackage
                ? 'Required — the sessions live on their account.'
                : 'Leave blank for a walk-in.'
            }
          >
            <Select
              id="pos_client"
              value={customerId}
              onChange={(e) => setCustomerId(e.target.value)}
            >
              <option value="">{sellingPackage ? 'Pick a client' : 'Walk-in'}</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.email ? ` — ${c.email}` : ''}
                </option>
              ))}
            </Select>
          </Field>

          {!customerId && !sellingPackage && (
            <Field label="Walk-in name" htmlFor="pos_walkin">
              <Input
                id="pos_walkin"
                maxLength={120}
                value={walkIn}
                onChange={(e) => setWalkIn(e.target.value)}
                placeholder="Walk-in"
              />
            </Field>
          )}

          <Field label="Paid by" htmlFor="pos_method">
            <Select
              id="pos_method"
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
            >
              <option value="card">Card</option>
              <option value="cash">Cash</option>
              <option value="other">Other</option>
            </Select>
          </Field>

          <Field label="Note" htmlFor="pos_note">
            <Input
              id="pos_note"
              maxLength={200}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>

          <Button
            onClick={ringUp}
            disabled={busy || (sellingPackage ? chosenPackage === null : lines.length === 0)}
            className="w-full"
          >
            {busy ? 'Ringing up…' : `Take ${formatMoney(total)}`}
          </Button>

          {sellingPackage && (
            <p className="text-xs leading-relaxed text-[var(--color-muted)]">
              Taking this opens the balance straight away. The sessions can be spent from
              the client&rsquo;s record or at the end of any visit it covers.
            </p>
          )}
        </div>
      </aside>
    </div>
  )
}
