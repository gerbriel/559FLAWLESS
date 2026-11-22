'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Image from 'next/image'
import Link from 'next/link'
import { toast } from 'sonner'
import {
  Search,
  Plus,
  Minus,
  Trash2,
  ExternalLink,
  Check,
  Package,
  Layers,
  Scissors,
  PenLine,
  Delete,
  Smartphone,
  Mail,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Field, Input, Select } from '@/components/ui/field'
import { createClient } from '@/lib/supabase/client'
import { cn, formatMoney } from '@/lib/utils'
import { formatDateTimeInTimeZone } from '@/lib/time'
import {
  allowancesLeftLabel,
  includedAllowances,
  membershipDiscountCents,
  type MembershipProductPerk,
} from '@/types/memberships'
import { bestProductPerk, type PerkAvailability, type PerkUnit } from '@/lib/member-product-perks'
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
import QRCode from 'qrcode'

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
  /** For a member's product perk scoped to a category (086). Optional so an older page keeps compiling. */
  category_id?: number | null
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

export interface SellableService {
  id: number
  name: string
  price_cents: number
  duration_minutes: number
  category: string
}

export interface CustomerOption {
  id: string
  name: string
  email: string | null
}

/** A visit of the picked client's with money still owed on it. */
interface OpenBalance {
  id: string
  starts_at: string
  services: string
  owed_cents: number
}

const STUDIO_TZ = 'America/Los_Angeles'

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
  /** Set when the sale was a typed-in amount, to be itemised later. */
  custom?: boolean
  /** How much of a custom amount went on the client's visit balances. */
  applied_cents?: number
  /** What a membership took off: the visit's benefit plus any product perk. */
  membership_cents?: number
  membership_name?: string | null
  /** The visit's lines, when services were in the sale. */
  services?: { name: string; price_cents: number }[]
  /** What went on the order: products off the shelf and the custom extra. */
  products?: { name: string; qty: number; line_cents: number }[]
  /** Deals and the manager's discount, apart from the membership. */
  discount_cents?: number
  /** Whether anything came off the shelf, so the receipt can say stock moved. */
  shelf?: boolean
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
  services,
  canDiscount = false,
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
  /** Treatments sellable at the counter. Same contract: absent = no tab. */
  services?: SellableService[]
  /** Manager and up: the hand-typed discount. Verified again server-side. */
  canDiscount?: boolean
}) {
  const router = useRouter()
  const [search, setSearch] = useState('')
  const [lines, setLines] = useState<Line[]>([])
  const [customerId, setCustomerId] = useState('')
  const [walkIn, setWalkIn] = useState('')
  const [method, setMethod] = useState<
    | 'phone_link'
    | 'stripe_app'
    | 'cash'
    | 'card'
    | 'apple_pay'
    | 'zelle'
    | 'paypal'
    | 'venmo'
    | 'cashapp'
    | 'other'
  >('card')
  // A sale rung up to be paid through Stripe (090), waiting for the webhook.
  // The receipt it will become is built now, from the sale's response, and
  // shown once the ticket reads paid.
  const [awaiting, setAwaiting] = useState<{ ticket: TicketView; receipt: Receipt; canEmail: boolean } | null>(
    null
  )
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
  // Custom amount first and by default: at this studio the counter usually
  // starts from "that's $X today", not from a bottle being scanned.
  const [mode, setMode] = useState<'retail' | 'services' | 'prepaid' | 'custom'>('custom')
  // Custom mode: a figure typed in at the counter, itemised later if at all.
  const [customDesc, setCustomDesc] = useState('')
  // The keypad's digits, read as cents: "1250" is $12.50 — the card-terminal
  // way, so nobody ever types a decimal point.
  const [customAmount, setCustomAmount] = useState('')
  const [customTaxable, setCustomTaxable] = useState(false)
  // What the picked client still owes, and which of it this payment settles.
  const [balances, setBalances] = useState<OpenBalance[]>([])
  // The picked client's live membership, for the Services preview. The sale
  // route applies it for real; this only shows staff the figure first.
  const [membership, setMembership] = useState<{
    name: string
    /** What is left of each allowance this period, keyed by service id, or null for the shared pool (088). */
    remaining: Map<number | null, number>
    /** Every treatment in the plan's scope. Empty means any treatment, from the pool. */
    scope: number[]
    /** Treatments with an allowance of their own. They never draw from the pool. */
    own: number[]
    /** "1 of 1 Custom Corrective Facial and 0 of 1 Full Brazilian left", or '' when nothing is included. */
    leftLabel: string
    pct: number
    prices: Map<number, number>
    /** Retail perks (086), for the retail preview. */
    perks: MembershipProductPerk[]
    /** Uses so far of each limited perk, this window. */
    availability: PerkAvailability[]
    /** Limited perks whose use count failed to load: left out of the preview. */
    unchecked: number[]
  } | null>(null)
  const [applyTo, setApplyTo] = useState<string[]>([])
  // Bumped when a sale changes what the picked client owes without the client
  // changing (a visit recorded but not paid), so the balances are read again.
  const [balancesSeq, setBalancesSeq] = useState(0)

  useEffect(() => {
    let alive = true
    void (async () => {
      if (!customerId) {
        if (alive) {
          setBalances([])
          setApplyTo([])
          setMembership(null)
        }
        return
      }
      const supabase = createClient()

      const { data: held } = await supabase
        .from('client_memberships')
        .select(
          'id, membership_id, current_period_start, memberships!client_memberships_membership_id_fkey(name, included_sessions_per_period, service_discount_pct, membership_services(service_id, sessions_per_period, services(name)), membership_member_prices(service_id, price_cents), membership_product_perks(id, membership_id, kind, percent_off, buy_qty, product_id, category_id, label, sort_order, max_uses, uses_window, max_units_per_use)), membership_redemptions(service_id, sessions, redeemed_for_period_start)'
        )
        .eq('client_id', customerId)
        .eq('status', 'active')
        .gt('current_period_end', new Date().toISOString())
        .maybeSingle()
      const heldPerks =
        ((held?.memberships as unknown as {
          membership_product_perks: MembershipProductPerk[] | null
        } | null)?.membership_product_perks ?? [])
      // Staff may count any member's uses. A failed count is not read as
      // zero (the sale route treats a failure as no discount, so the preview
      // would promise one the receipt does not give): the perk is left out of
      // the preview, and if it would have won, the line says the sale decides.
      const counted = held
        ? await Promise.all(
            heldPerks
              .filter((perk) => perk.max_uses !== null)
              .map(async (perk) => {
                const { data: uses, error } = await supabase.rpc('perk_uses_so_far', {
                  p_client_membership: held.id,
                  p_perk: perk.id,
                  p_window: perk.uses_window,
                  p_period_start: held.current_period_start,
                })
                return {
                  perkId: perk.id,
                  usesSoFar: !error && typeof uses === 'number' ? uses : null,
                }
              })
          )
        : []
      const availability: PerkAvailability[] = counted.flatMap((c) =>
        c.usesSoFar === null ? [] : [{ perkId: c.perkId, usesSoFar: c.usesSoFar }]
      )
      const unchecked = counted.filter((c) => c.usesSoFar === null).map((c) => c.perkId)
      if (alive) {
        const plan = held?.memberships as unknown as {
          name: string
          included_sessions_per_period: number
          service_discount_pct: number
          membership_services: {
            service_id: number
            sessions_per_period: number | null
            services: { name: string } | null
          }[]
          membership_member_prices: { service_id: number; price_cents: number }[]
          membership_product_perks: MembershipProductPerk[] | null
        } | null
        if (held && plan) {
          const allowances = includedAllowances(
            plan,
            plan.membership_services.map((r) => ({
              service_id: r.service_id,
              sessions_per_period: r.sessions_per_period,
              name: r.services?.name ?? null,
            })),
            (held.membership_redemptions ?? []) as {
              service_id: number | null
              sessions: number
              redeemed_for_period_start: string
            }[],
            held.current_period_start
          )
          setMembership({
            name: plan.name,
            remaining: new Map(allowances.map((a) => [a.serviceId, Math.max(a.total - a.used, 0)])),
            scope: plan.membership_services.map((r) => r.service_id),
            own: plan.membership_services
              .filter((r) => r.sessions_per_period != null)
              .map((r) => r.service_id),
            leftLabel: allowancesLeftLabel(allowances),
            pct: plan.service_discount_pct,
            prices: new Map(plan.membership_member_prices.map((r) => [r.service_id, r.price_cents])),
            perks: plan.membership_product_perks ?? [],
            availability,
            unchecked,
          })
        } else {
          setMembership(null)
        }
      }
      const { data: visits } = await supabase
        .from('appointments')
        .select('id, starts_at, total_cents, appointment_services(name_snapshot, sort_order)')
        .eq('client_id', customerId)
        .not('status', 'in', '(cancelled,no_show)')
        .order('starts_at', { ascending: true })
        .limit(50)
      const ids = (visits ?? []).map((v) => v.id)
      const [{ data: paid }, { data: waiting }] =
        ids.length === 0
          ? [{ data: [] }, { data: [] }]
          : await Promise.all([
              supabase
                .from('payments')
                .select('appointment_id, amount_cents')
                .in('appointment_id', ids)
                .eq('status', 'succeeded'),
              // A visit a till sale is waiting on a card payment for (090)
              // is not offered again here; Orders shows it as awaiting.
              supabase
                .from('till_tickets')
                .select('appointment_id')
                .in('appointment_id', ids)
                .eq('status', 'awaiting'),
            ])
      if (!alive) return
      const awaitingCard = new Set((waiting ?? []).map((t) => t.appointment_id))

      const open = (visits ?? [])
        .map((v) => {
          const taken = (paid ?? [])
            .filter((p) => p.appointment_id === v.id)
            .reduce((sum, p) => sum + p.amount_cents, 0)
          return {
            id: v.id,
            starts_at: v.starts_at,
            services: ((v.appointment_services ?? []) as { name_snapshot: string; sort_order: number }[])
              .sort((a, b) => a.sort_order - b.sort_order)
              .map((x) => x.name_snapshot)
              .join(' + '),
            owed_cents: Math.max(v.total_cents - taken, 0),
          }
        })
        .filter((v) => v.owed_cents > 0 && !awaitingCard.has(v.id))

      setBalances(open)
      // Today's visit and anything already past are what the desk is usually
      // settling; a booking next month is left for them to tick.
      const endOfToday = Date.now() + 12 * 60 * 60 * 1000
      setApplyTo(open.filter((v) => new Date(v.starts_at).getTime() <= endOfToday).map((v) => v.id))
    })()
    return () => {
      alive = false
    }
  }, [customerId, balancesSeq])

  const owedTotal = balances.reduce((sum, b) => sum + b.owed_cents, 0)
  // Services picked: one line per treatment. The same one twice is refused at
  // the picker, because priceService prices a service id once.
  const [serviceLines, setServiceLines] = useState<SellableService[]>([])
  // The manager's discount, in dollars as typed. Parsed at use, capped server-side.
  const [discount, setDiscount] = useState('')
  const [packageId, setPackageId] = useState<number | null>(null)

  // The keypad answers the physical keyboard too — but never while someone is
  // typing in a field, where those keys belong to the field.
  useEffect(() => {
    if (mode !== 'custom' || receipt || awaiting || packageId !== null) return
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) {
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault()
        setCustomAmount((cur) => pressKey(cur, e.key))
      } else if (e.key === 'Backspace') {
        e.preventDefault()
        setCustomAmount((cur) => pressKey(cur, 'back'))
      } else if (e.key === 'Escape') {
        setCustomAmount('')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, receipt, awaiting, packageId])
  // A package sale is one package. Two courses for the same person are two
  // balances, and two balances are two sales — there is no quantity here.
  const chosenPackage = packageList.find((p) => p.id === packageId) ?? null
  const serviceList = services ?? []
  const customCents = Number(customAmount || '0')
  // The tabs are pickers, not modes: products, services and a typed amount all
  // ride in ONE running sale, rung up together with one payment. A package is
  // the exception and stays its own sale (see the header): it is what is being
  // sold once one is picked, or while its tab is open on an empty counter.
  const hasLines = lines.length > 0 || serviceLines.length > 0 || customCents > 0
  const sellingPackage =
    packageList.length > 0 && (chosenPackage !== null || (mode === 'prepaid' && !hasLines))
  // Preview of the split. The server re-derives every balance; this only reads.
  const owedSelected = balances
    .filter((b) => applyTo.includes(b.id))
    .reduce((sum, b) => sum + b.owed_cents, 0)
  const towardBalance = sellingPackage ? 0 : Math.min(owedSelected, customCents)
  const customExtra = customCents - towardBalance

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
  const servicesSubtotal = serviceLines.reduce((s, l) => s + l.price_cents, 0)

  // The manager's discount, cents. Preview only — the routes re-verify the
  // role and cap it; a mistyped value can only make the preview read high.
  const manualDiscount =
    canDiscount && !sellingPackage && servicesSubtotal + retailSubtotal > 0
      ? Math.max(0, Math.round((Number(discount.replace(/[$,\s]/g, '')) || 0) * 100))
      : 0

  // No tax on a package or a service: both buy treatment time, and services
  // are not taxable in California. Products tax what is actually paid — the
  // discounted figure, integer cents in and out.
  const subtotal = sellingPackage
    ? (chosenPackage?.price_cents ?? 0)
    : servicesSubtotal + retailSubtotal + customExtra
  // The membership on a services sale, previewed the way applyMembershipBenefit
  // computes it: each line draws from its own allowance when the treatment has
  // one, otherwise from the shared pool (088); dearest-first within each
  // allowance, one per service; then member prices on the rest, then the plan
  // percentage.
  const memberCut = (() => {
    if (sellingPackage || !membership) return 0
    const allowanceFor = (serviceId: number): number | null | undefined => {
      if (membership.own.includes(serviceId)) return serviceId
      if (membership.scope.length === 0 || membership.scope.includes(serviceId)) return null
      return undefined
    }
    const remaining = new Map(membership.remaining)
    const coveredIds = new Set<number>()
    let covered = 0
    const eligible = [...serviceLines]
      .filter((l) => l.price_cents > 0 && allowanceFor(l.id) !== undefined)
      .sort((a, b) => b.price_cents - a.price_cents)
    for (const l of eligible) {
      if (coveredIds.has(l.id)) continue
      const key = allowanceFor(l.id) as number | null
      if ((remaining.get(key) ?? 0) <= 0) continue
      remaining.set(key, (remaining.get(key) ?? 0) - 1)
      coveredIds.add(l.id)
      covered += l.price_cents
    }
    let priced = 0
    for (const l of serviceLines) {
      if (coveredIds.has(l.id)) continue
      const cap = membership.prices.get(l.id)
      if (cap !== undefined) priced += Math.max(l.price_cents - cap, 0)
    }
    const rest = Math.max(servicesSubtotal - covered - priced, 0)
    return covered + priced + membershipDiscountCents(rest, membership.pct)
  })()

  // A member's product perk on the products in the sale (086), previewed with
  // the same arithmetic the sale route uses. The route re-reads the membership
  // and keeps the better of the perk and the multibuy deal; this line shows
  // only the perk, so the rung-up figure can come out lower.
  const sellingRetail = !sellingPackage && lines.length > 0
  const retailUnits: PerkUnit[] = sellingRetail
    ? lines.flatMap((l) =>
        Array.from({ length: l.qty }, () => ({
          productId: l.product.id,
          categoryId: l.product.category_id ?? null,
          priceCents: l.product.price_cents,
        }))
      )
    : []
  // The winner as far as the counts that loaded can say. A perk whose count
  // failed is priced as if it had uses; if it then wins, no figure is shown.
  const likelyRetailPerk =
    sellingRetail && membership
      ? bestProductPerk(membership.perks, retailUnits, membership.availability)
      : null
  const retailPerkPending =
    !!likelyRetailPerk && !!membership?.unchecked.includes(likelyRetailPerk.perk.id)
  const retailPerk =
    sellingRetail && membership && !retailPerkPending
      ? bestProductPerk(
          membership.perks.filter((p) => !membership.unchecked.includes(p.id)),
          retailUnits,
          membership.availability
        )
      : null
  const perkCut = retailPerk?.off ?? 0
  const perkWindow = (perk: MembershipProductPerk) =>
    perk.uses_window === 'month' ? 'month' : 'period'
  // "(used 1 of 3 this period)" beside a limited winning perk.
  const retailPerkUses =
    retailPerk && membership && retailPerk.perk.max_uses !== null
      ? `(used ${
          membership.availability.find((a) => a.perkId === retailPerk.perk.id)?.usesSoFar ?? 0
        } of ${retailPerk.perk.max_uses} this ${perkWindow(retailPerk.perk)})`
      : null
  // Nothing applies, but a perk would have without its limit: it is used up.
  const spentRetailPerk =
    sellingRetail && membership && !retailPerk && !retailPerkPending
      ? bestProductPerk(membership.perks, retailUnits)?.perk ?? null
      : null

  // The manager's discount comes off the services first, then the products,
  // the same order the sale route applies it in. A custom amount is never
  // discounted: it is already the desk's own figure.
  const servicesDue = Math.max(servicesSubtotal - memberCut, 0)
  const serviceDiscount = Math.min(manualDiscount, servicesDue)
  const productsDue = Math.max(retailSubtotal - perkCut, 0)
  const productDiscount = Math.min(manualDiscount - serviceDiscount, productsDue)
  // Tax on the products as discounted, plus a custom amount only when the desk
  // ticks that it is goods. Services and visit balances are never taxed.
  const taxedCustom = customTaxable ? customExtra : 0
  const untaxed = sellingPackage || (lines.length === 0 && taxedCustom === 0)
  const tax = untaxed ? 0 : Math.round((productsDue - productDiscount + taxedCustom) * taxRate)
  const total = sellingPackage
    ? subtotal
    : servicesDue - serviceDiscount + productsDue - productDiscount + customExtra + tax + towardBalance

  /** Clear the running sale, for when a package is to be sold instead. */
  function clearSale() {
    setLines([])
    setServiceLines([])
    setCustomAmount('')
    setCustomDesc('')
    setCustomTaxable(false)
    setDiscount('')
  }

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
          category_id: known?.category_id ?? null,
        })
        toast.success(`${p.name}, ${formatMoney(p.price_cents)}`)
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
    // The keypad owns the digit keys on the Custom amount tab.
    enabled: !receipt && !awaiting && !camera && !sellingPackage && mode !== 'custom',
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
    if (method === 'phone_link' || method === 'stripe_app') {
      toast.error('A package is paid at the counter. Pick another way to pay.')
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

  /**
   * Ring up the running sale: products, services and a typed extra, one
   * request and one payment. The server prices every line, writes the
   * services as a completed visit, the rest as an order, and settles the visit
   * first; see /api/pos/sale.
   */
  async function ringUp() {
    if (sellingPackage) {
      await ringUpPackage()
      return
    }
    if (!hasLines) {
      toast.error('Add something to the sale first.')
      return
    }
    if (customCents > 0 && customExtra > 0 && !customDesc.trim()) {
      toast.error('Say what the extra amount is for. It goes on the receipt.')
      return
    }
    if (!customerId && !walkIn.trim()) {
      toast.error('Pick a client or type a name for the walk-in.')
      return
    }
    const throughStripe = method === 'phone_link' || method === 'stripe_app'
    if (throughStripe && towardBalance > 0) {
      toast.error('An old balance cannot ride on a card payment through Stripe.', {
        description: 'Untick it under Pay off first, or pick another way to pay.',
      })
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
          serviceIds: serviceLines.map((l) => l.id),
          custom:
            customCents > 0
              ? {
                  description: customDesc.trim() || 'Visit balance',
                  amountCents: customCents,
                  taxable: customTaxable,
                }
              : null,
          applyToAppointments: customerId && customCents > 0 && !throughStripe ? applyTo : [],
          paymentMethod: method,
          notes: notes.trim() || null,
          discountCents: manualDiscount,
        }),
      })
      const data = await res.json()

      if (!res.ok) {
        if (data.error === 'visit_recorded_unpaid') {
          // The visit stands on the client's record, owing. Its lines come off
          // the counter so a second Take cannot record it twice; the products
          // and the typed amount stay, since none of that was sold.
          toast.error(data.message, { duration: 20000 })
          setServiceLines([])
          setDiscount('')
          setBalancesSeq((n) => n + 1)
          router.refresh()
          return
        }
        toast.error(data.message ?? 'Could not complete that sale.')
        return
      }

      if (data.warning) toast.warning(data.warning)

      const visit = data.visit as {
        lines: { name: string; price_cents: number }[]
        subtotal_cents: number
        discount_cents: number
        membership_cents: number
        membership_name: string | null
      } | null
      const orderLines = (data.order_lines ?? []) as { name: string; qty: number; line_cents: number }[]
      const orderMembership = data.membership_cents ?? 0

      const built: Receipt = {
        order_number: data.order?.order_number ?? null,
        subtotal_cents: (visit?.subtotal_cents ?? 0) + (data.order?.subtotal_cents ?? 0),
        tax_cents: data.order?.tax_cents ?? 0,
        total_cents: data.total_cents,
        customer: customerId
          ? (customers.find((c) => c.id === customerId)?.name ?? 'Client')
          : walkIn.trim(),
        custom: customExtra > 0 && data.order !== null,
        applied_cents: data.applied_cents ?? 0,
        // The visit's benefit and a product perk are separate cuts on separate
        // parts of the sale; together they are what the membership saved.
        membership_cents: (visit?.membership_cents ?? 0) + orderMembership,
        membership_name: visit?.membership_name ?? data.membership_name ?? null,
        services: visit?.lines ?? [],
        products: orderLines,
        discount_cents: (visit?.discount_cents ?? 0) + (data.discount_cents ?? 0) - orderMembership,
        shelf: lines.length > 0,
      }
      if (data.awaiting && data.ticket) {
        // The sale is written; the money is not. Wait for Stripe.
        setAwaiting({
          ticket: data.ticket as TicketView,
          receipt: built,
          canEmail: !!customerId && !!customers.find((c) => c.id === customerId)?.email,
        })
      } else {
        setReceipt(built)
      }
      clearSale()
      setCustomerId('')
      setWalkIn('')
      setNotes('')
      router.refresh()
    } catch {
      toast.error('Could not reach the till. Please try again.')
    } finally {
      setBusy(false)
    }
  }

  if (awaiting) {
    return (
      <AwaitingPayment
        key={awaiting.ticket.id}
        ticket={awaiting.ticket}
        customer={awaiting.receipt.customer}
        canEmail={awaiting.canEmail}
        onPaid={() => {
          setReceipt(awaiting.receipt)
          setAwaiting(null)
          router.refresh()
        }}
        onClose={() => {
          setAwaiting(null)
          // A visit left owing shows under Pay off first next time.
          setBalancesSeq((n) => n + 1)
          router.refresh()
        }}
      />
    )
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
          {receipt.order_number && (
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">Order</dt>
              <dd className="tabular-nums">{receipt.order_number}</dd>
            </div>
          )}
          {/* Services and products as two groups, one total below. */}
          {(receipt.services?.length ?? 0) > 0 && (
            <div className="border-t border-[var(--color-border)] pt-2">
              <dt className="label-caps text-[var(--color-muted)]">Services</dt>
              {receipt.services!.map((l, i) => (
                <dd key={`s-${i}`} className="mt-1 flex justify-between">
                  <span>{l.name}</span>
                  <span className="tabular-nums">{formatMoney(l.price_cents)}</span>
                </dd>
              ))}
            </div>
          )}
          {(receipt.products?.length ?? 0) > 0 && (
            <div className="border-t border-[var(--color-border)] pt-2">
              <dt className="label-caps text-[var(--color-muted)]">Products</dt>
              {receipt.products!.map((l, i) => (
                <dd key={`p-${i}`} className="mt-1 flex justify-between gap-4">
                  <span>
                    {l.name}
                    {l.qty > 1 && <span className="text-[var(--color-muted)]"> &times; {l.qty}</span>}
                  </span>
                  <span className="tabular-nums">{formatMoney(l.line_cents)}</span>
                </dd>
              ))}
            </div>
          )}
          {(receipt.applied_cents ?? 0) > 0 && (
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">Toward visit balance</dt>
              <dd className="tabular-nums">{formatMoney(receipt.applied_cents ?? 0)}</dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-[var(--color-muted)]">
              {(receipt.applied_cents ?? 0) > 0 && !receipt.services?.length && !receipt.shelf
                ? 'Extras'
                : 'Subtotal'}
            </dt>
            <dd className="tabular-nums">{formatMoney(receipt.subtotal_cents)}</dd>
          </div>
          {(receipt.membership_cents ?? 0) > 0 && (
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">{receipt.membership_name ?? 'Membership'}</dt>
              <dd className="tabular-nums">&minus;{formatMoney(receipt.membership_cents ?? 0)}</dd>
            </div>
          )}
          {(receipt.discount_cents ?? 0) > 0 && (
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">Discount</dt>
              <dd className="tabular-nums">&minus;{formatMoney(receipt.discount_cents ?? 0)}</dd>
            </div>
          )}
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
          ) : !receipt.custom &&
            !receipt.shelf &&
            !receipt.services?.length &&
            (receipt.applied_cents ?? 0) > 0 ? (
            <>The whole amount went on {receipt.customer}&rsquo;s visit balance.</>
          ) : (
            <>
              {(receipt.services?.length ?? 0) > 0 && 'The visit is on the book as completed. '}
              {receipt.shelf && 'Stock has been updated. '}
              {(receipt.applied_cents ?? 0) > 0 &&
                `${formatMoney(receipt.applied_cents ?? 0)} went on their visit balance. `}
              {receipt.custom ? (
                <>
                  This is on the customer&rsquo;s history. To record what the extra amount
                  was for, open it under Orders &rarr; Products and choose{' '}
                  <em>Assign items</em>. The total stays what was paid.
                </>
              ) : (
                <>This is on the customer&rsquo;s history.</>
              )}
            </>
          )}
        </p>

        <div className="mt-6 flex flex-wrap gap-3">
          <Button onClick={() => setReceipt(null)}>New sale</Button>
          {receipt.prepaid ? (
            <Link href="/dashboard/packages/balances">
              <Button variant="subtle">Balances</Button>
            </Link>
          ) : (
            <Link href="/dashboard/orders?view=products">
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
        {/* Always drawn, since a typed-in amount is always on offer — and it
            is the first tab and the default. Services and Packages appear only
            when there is something behind them. */}
          <div
            data-ui="tile"
            role="group"
            aria-label="What is being sold"
            className="mb-6 inline-flex flex-wrap border border-[var(--color-border)] p-1"
          >
            {(
              [
                { value: 'custom' as const, label: 'Custom amount', icon: PenLine },
                { value: 'retail' as const, label: 'Products', icon: Package },
                ...(serviceList.length > 0
                  ? [{ value: 'services' as const, label: 'Services', icon: Scissors }]
                  : []),
                ...(packageList.length > 0
                  ? [{ value: 'prepaid' as const, label: 'Packages', icon: Layers }]
                  : []),
              ]
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

        {/* A package is sold on its own. While one is picked, the other tabs
            say so instead of offering things that could not join it. */}
        {chosenPackage && mode !== 'prepaid' ? (
          <SoldOnItsOwn
            text={`${chosenPackage.name} is a package, and a package is sold on its own.`}
            action="Remove the package"
            onAction={() => setPackageId(null)}
          />
        ) : mode === 'custom' ? (
          <div className="max-w-xl">
            <p className="max-w-prose text-sm text-[var(--color-muted)]">
              An extra amount for anything not on the lists, or what the client owes on a
              visit. Any balance ticked below is settled first; what is left over goes on
              this sale beside the products and services, and can be assigned afterwards
              from Orders without changing what was paid.
            </p>

            <div className="mt-6 space-y-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
              {balances.length > 0 && (
                <fieldset className="space-y-2">
                  <legend className="label-caps mb-2 text-[var(--color-muted)]">
                    Pay off first
                  </legend>
                  {balances.map((b) => (
                    <label key={b.id} className="flex items-start gap-3 text-sm">
                      <input
                        type="checkbox"
                        checked={applyTo.includes(b.id)}
                        onChange={(e) =>
                          setApplyTo((cur) =>
                            e.target.checked ? [...cur, b.id] : cur.filter((id) => id !== b.id)
                          )
                        }
                        className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
                      />
                      <span className="min-w-0 flex-1">
                        {b.services || 'Visit'}
                        <span className="block text-xs text-[var(--color-muted)]">
                          {formatDateTimeInTimeZone(new Date(b.starts_at), STUDIO_TZ)}
                        </span>
                      </span>
                      <span className="tabular-nums">{formatMoney(b.owed_cents)}</span>
                    </label>
                  ))}
                </fieldset>
              )}


              <AmountPad
                cents={customCents}
                onKey={(k) => setCustomAmount((cur) => pressKey(cur, k))}
                onClear={() => setCustomAmount('')}
                suggestion={
                  owedSelected > 0 && customCents !== owedSelected
                    ? { label: 'What they owe', cents: owedSelected }
                    : null
                }
                onSuggest={(cents) => setCustomAmount(String(cents))}
              />

              <Field label="What it's for" htmlFor="pos_custom_desc" hint="Shows on the receipt and in their history.">
                <Input
                  id="pos_custom_desc"
                  maxLength={120}
                  placeholder="e.g. Brow tint add-on"
                  value={customDesc}
                  onChange={(e) => setCustomDesc(e.target.value)}
                />
              </Field>

              <label className="flex items-start gap-3 text-sm">
                <input
                  type="checkbox"
                  checked={customTaxable}
                  onChange={(e) => setCustomTaxable(e.target.checked)}
                  className="mt-1 h-4 w-4 accent-[var(--color-accent)]"
                />
                <span>
                  Charge sales tax
                  <span className="block text-xs text-[var(--color-muted)]">
                    Tick only if the extras are products. Visit balances and services are never taxed.
                  </span>
                </span>
              </label>
            </div>
          </div>
        ) : mode === 'services' && serviceList.length > 0 ? (
          <>
            <p className="max-w-prose text-sm text-[var(--color-muted)]">
              A treatment rung up at the counter. It lands on the book as a completed
              visit, and stock, points, deals and reports all follow. No sales tax is
              charged on it, because what they are buying is treatment time. Products
              added to the same sale are paid with it, in one payment.
            </p>

            <ul className="mt-5 grid gap-px border border-[var(--color-border)] bg-[var(--color-border)] sm:grid-cols-2 xl:grid-cols-3">
              {serviceList.map((svc) => (
                <li key={svc.id}>
                  <button
                    type="button"
                    onClick={() => {
                      if (serviceLines.some((l) => l.id === svc.id)) {
                        toast.error('Already on the sale')
                        return
                      }
                      setServiceLines((cur) => [...cur, svc])
                    }}
                    className="flex w-full flex-col gap-1 bg-[var(--color-background)] p-4 text-left transition-colors hover:bg-[var(--color-linen)] dark:hover:bg-[var(--color-surface)]"
                  >
                    <span className="label-caps text-[0.5625rem] text-[var(--color-muted)]">
                      {svc.category}
                    </span>
                    <span className="text-sm">{svc.name}</span>
                    <span className="text-xs tabular-nums text-[var(--color-muted)]">
                      {formatMoney(svc.price_cents)} · {svc.duration_minutes} min
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </>
        ) : mode === 'prepaid' && packageList.length > 0 ? (
          <>
            <p className="max-w-prose text-sm text-[var(--color-muted)]">
              A course paid for once and drawn down a session at a time. It goes on the
              client&rsquo;s account, so it needs a client, and no sales tax is charged,
              because what they are buying is treatment time.
            </p>

            {hasLines && (
              <SoldOnItsOwn
                className="mt-4"
                text="A package is sold on its own. Take this sale first, or clear it to sell a package."
                action="Clear this sale"
                onAction={clearSale}
              />
            )}

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
                      disabled={hasLines}
                      onClick={() => setPackageId(on ? null : p.id)}
                      className={cn(
                        'flex h-full w-full flex-col items-start p-5 text-left transition-colors hover:bg-[var(--color-linen)] disabled:opacity-40 disabled:hover:bg-transparent dark:hover:bg-[var(--color-background)]',
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
          ) : !hasLines ? (
            <p className="mt-4 text-sm text-[var(--color-muted)]">Nothing added yet.</p>
          ) : (
            // Every part of the running sale, whichever tab is open: each line
            // can be taken off from here.
            <div className="mt-4 space-y-5">
              {serviceLines.length > 0 && (
                <section>
                  <h3 className="label-caps mb-2 text-[0.5625rem] text-[var(--color-muted)]">Services</h3>
                  <ul className="space-y-3">
                    {serviceLines.map((svc, i) => (
                      <li key={`${svc.id}-${i}`} className="flex items-center gap-2.5 text-sm">
                        <div className="min-w-0 flex-1">
                          <span className="block truncate">{svc.name}</span>
                          <span className="text-xs tabular-nums text-[var(--color-muted)]">
                            {formatMoney(svc.price_cents)}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() =>
                            setServiceLines((cur) => cur.filter((_, idx) => idx !== i))
                          }
                          className="flex h-8 w-8 items-center justify-center text-[var(--color-muted)] hover:text-red-700"
                          aria-label={`Remove ${svc.name}`}
                        >
                          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              {lines.length > 0 && (
                <section>
                  <h3 className="label-caps mb-2 text-[0.5625rem] text-[var(--color-muted)]">Products</h3>
                  <ul className="space-y-3">
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
                </section>
              )}
              {customCents > 0 && (
                <section>
                  <h3 className="label-caps mb-2 text-[0.5625rem] text-[var(--color-muted)]">Custom amount</h3>
                  <div className="flex items-start gap-2.5 text-sm">
                    <span
                      data-ui="tile"
                      className="flex h-10 w-10 shrink-0 items-center justify-center bg-[var(--color-linen)] dark:bg-[var(--color-background)]"
                    >
                      <PenLine className="h-4 w-4 text-[var(--color-muted)]" strokeWidth={1.25} aria-hidden />
                    </span>
                    <div className="min-w-0 flex-1">
                      <span className="block truncate">{customDesc.trim() || 'Visit balance'}</span>
                      <span className="text-xs tabular-nums text-[var(--color-muted)]">
                        {towardBalance > 0
                          ? `${formatMoney(towardBalance)} on visit balance · ${formatMoney(customExtra)} extras`
                          : `${formatMoney(customCents)} · custom amount`}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setCustomAmount('')}
                      className="flex h-8 w-8 shrink-0 items-center justify-center text-[var(--color-muted)] hover:text-red-700"
                      aria-label="Remove the custom amount"
                    >
                      <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
                    </button>
                  </div>
                </section>
              )}
            </div>
          )}

          <dl className="mt-5 space-y-1.5 border-t border-[var(--color-border)] pt-4 text-sm">
            {towardBalance > 0 && (
              <div className="flex justify-between">
                <dt className="text-[var(--color-muted)]">Toward visit balance</dt>
                <dd className="tabular-nums">{formatMoney(towardBalance)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">
                {towardBalance > 0 && servicesSubtotal + retailSubtotal === 0 ? 'Extras' : 'Subtotal'}
              </dt>
              <dd className="tabular-nums">{formatMoney(subtotal)}</dd>
            </div>
            {memberCut > 0 && membership && (
              <div className="flex justify-between">
                <dt className="text-[var(--color-muted)]">{membership.name}</dt>
                <dd className="tabular-nums">&minus;{formatMoney(memberCut)}</dd>
              </div>
            )}
            {perkCut > 0 && membership && (
              <div className="flex justify-between">
                <dt className="text-[var(--color-muted)]">
                  Member perk, {membership.name}{' '}
                  <span className="text-xs">(preview)</span>
                  {retailPerkUses && <span className="text-xs"> {retailPerkUses}</span>}
                </dt>
                <dd className="tabular-nums">&minus;{formatMoney(perkCut)}</dd>
              </div>
            )}
            {retailPerkPending && membership && (
              <div className="flex justify-between text-[var(--color-muted)]">
                <dt>Member perk, {membership.name}</dt>
                <dd>Checked at checkout</dd>
              </div>
            )}
            {spentRetailPerk && membership && (
              <div className="text-xs text-[var(--color-muted)]">
                <dt className="sr-only">Member perk</dt>
                <dd>
                  Their {membership.name} perk has been used this {perkWindow(spentRetailPerk)}.
                </dd>
              </div>
            )}
            {serviceDiscount + productDiscount > 0 && (
              <div className="flex justify-between">
                <dt className="text-[var(--color-muted)]">Discount</dt>
                <dd className="tabular-nums">&minus;{formatMoney(serviceDiscount + productDiscount)}</dd>
              </div>
            )}
            <div className="flex justify-between">
              <dt className="text-[var(--color-muted)]">
                {untaxed
                  ? 'Tax'
                  : `Tax ${(taxRate * 100).toFixed(2).replace(/\.?0+$/, '')}%`}
              </dt>
              <dd className="tabular-nums">
                {untaxed ? (
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

          {/* The manager's hand on the price — off before tax, re-verified
              and capped server-side. Absent for everyone else. */}
          {canDiscount && !sellingPackage && (
            <Field
              label="Discount ($)"
              htmlFor="pos_discount"
              className="mt-4"
              hint="Comes off the services first, then the products. A custom amount is not discounted."
            >
              <Input
                id="pos_discount"
                inputMode="decimal"
                placeholder="0"
                value={discount}
                onChange={(e) => setDiscount(e.target.value)}
              />
            </Field>
          )}
        </div>

        <div className="mt-5 space-y-4 border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
          <Field
            label="Client"
            htmlFor="pos_client"
            hint={
              sellingPackage
                ? 'Required. The sessions live on their account.'
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
                  {c.email ? ` (${c.email})` : ''}
                </option>
              ))}
            </Select>
          </Field>

          {membership && (
            <p className="text-xs leading-relaxed text-[var(--color-muted)]">
              {membership.name} member
              {membership.leftLabel ? ` · ${membership.leftLabel} this period` : ''}. Applied
              automatically to services rung up here.
              {membership.perks.length > 0 &&
                ' Their product perks apply to retail too, when they beat the multibuy deal; the sale works out the best single discount.'}
            </p>
          )}

          {customerId && owedTotal > 0 && !sellingPackage && customCents === 0 && (
            <p className="text-xs leading-relaxed text-amber-700 dark:text-amber-400">
              They owe {formatMoney(owedTotal)} on{' '}
              {balances.length === 1 ? 'a visit' : `${balances.length} visits`}. This sale does not
              settle it. Add a <em>Custom amount</em> to take it together, or Take payment on the
              visit.
            </p>
          )}

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

          <Field
            label="Paid by"
            htmlFor="pos_method"
            hint={
              method === 'phone_link'
                ? 'They pay on their own phone from a code on this screen. The sale is paid once Stripe confirms it.'
                : method === 'stripe_app'
                  ? 'Charge it with Tap to Pay in the Stripe app. It is matched to this sale by amount.'
                  : undefined
            }
          >
            <Select
              id="pos_method"
              value={method}
              onChange={(e) => setMethod(e.target.value as typeof method)}
            >
              <option value="phone_link">Pay by phone (card, Apple Pay, Google Pay)</option>
              <option value="stripe_app">Card via Stripe app</option>
              <option value="card">Card</option>
              <option value="cash">Cash</option>
              <option value="apple_pay">Apple Pay</option>
              <option value="zelle">Zelle</option>
              <option value="paypal">PayPal</option>
              <option value="venmo">Venmo</option>
              <option value="cashapp">Cash App</option>
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
            disabled={
              busy ||
              (sellingPackage
                ? chosenPackage === null
                : !hasLines || (customCents > 0 && customExtra > 0 && !customDesc.trim()))
            }
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

/** A till ticket as the sale route and GET /api/pos/ticket/[id] return it. */
interface TicketView {
  id: number
  method: 'phone_link' | 'stripe_app'
  status?: 'awaiting' | 'paid' | 'cancelled' | 'expired'
  amount_cents: number
  expires_at: string
  checkout_url?: string | null
}

/** A card payment the webhook parked, with the same amount as the ticket. */
interface UnmatchedCandidate {
  id: number
  payment_intent_id: string
  amount_cents: number
  description: string | null
  paid_at: string
}

/** How often the till asks whether the money has landed. */
const POLL_MS = 3000

/** "checkout.stripe.com/c/pay/cs_live…Ab12" so the link can be read aloud. */
function shortUrl(url: string): string {
  const bare = url.replace(/^https?:\/\//, '').split('#')[0]
  return bare.length <= 40 ? bare : `${bare.slice(0, 30)}…${bare.slice(-6)}`
}

/** "12:05" from milliseconds left; never negative. */
function clockOf(ms: number): string {
  const total = Math.max(Math.floor(ms / 1000), 0)
  const m = Math.floor(total / 60)
  const sec = total % 60
  return `${m}:${String(sec).padStart(2, '0')}`
}

/**
 * The till while a sale waits for a card payment taken through Stripe (090).
 *
 * The sale is already on the record; what this waits for is the webhook,
 * which is the only thing that marks the ticket paid. It asks every three
 * seconds and stops once the ticket is paid, expired or cancelled, or when
 * the card is closed. A phone landing on the thank-you page proves nothing,
 * so nothing here listens for it.
 */
function AwaitingPayment({
  ticket,
  customer,
  canEmail,
  onPaid,
  onClose,
}: {
  ticket: TicketView
  customer: string
  canEmail: boolean
  onPaid: () => void
  onClose: () => void
}) {
  const [status, setStatus] = useState<'awaiting' | 'paid' | 'cancelled' | 'expired' | 'lost'>('awaiting')
  const [candidates, setCandidates] = useState<UnmatchedCandidate[]>([])
  const [qr, setQr] = useState<string | null>(null)
  const [now, setNow] = useState(0)
  const [working, setWorking] = useState<string | null>(null)
  const url = ticket.checkout_url ?? null
  const isPhone = ticket.method === 'phone_link'

  // The QR code, drawn in the browser from the Checkout URL.
  useEffect(() => {
    if (!url) return
    let alive = true
    QRCode.toString(url, { type: 'svg', margin: 1, width: 240, errorCorrectionLevel: 'M' })
      .then((svg) => {
        if (alive) setQr(`data:image/svg+xml;utf8,${encodeURIComponent(svg)}`)
      })
      .catch(() => {
        if (alive) setQr(null)
      })
    return () => {
      alive = false
    }
  }, [url])

  // The countdown's clock.
  useEffect(() => {
    if (status !== 'awaiting') return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [status])

  // Ask until it is settled one way or the other.
  useEffect(() => {
    if (status !== 'awaiting') return
    let alive = true
    async function tick() {
      try {
        const res = await fetch(`/api/pos/ticket/${ticket.id}`, { cache: 'no-store' })
        // Signed out, no longer allowed, or gone: asking again will not help.
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          if (alive) setStatus('lost')
          return
        }
        if (!res.ok) return
        const data = (await res.json()) as { ticket: TicketView; candidates: UnmatchedCandidate[] }
        if (!alive) return
        setCandidates(data.candidates ?? [])
        const next = data.ticket.status ?? 'awaiting'
        if (next !== 'awaiting') setStatus(next)
      } catch {
        // A missed poll is retried on the next tick.
      }
    }
    const timer = setInterval(() => void tick(), POLL_MS)
    void tick()
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [status, ticket.id])

  // Paid: the parent swaps this card for the receipt.
  useEffect(() => {
    if (status === 'paid') onPaid()
  }, [status, onPaid])

  async function act(path: 'cancel' | 'send' | 'match', body?: object) {
    setWorking(path)
    try {
      const res = await fetch(`/api/pos/ticket/${ticket.id}/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast.error(data.message ?? 'That did not go through.')
        return
      }
      if (path === 'cancel') {
        setStatus('cancelled')
        toast.success('Sale cancelled. Nothing was charged.')
      } else if (path === 'send') {
        toast.success(`Link sent to ${data.to ?? 'their email'}.`)
      } else {
        toast.success('Matched. Recording the payment.')
      }
    } catch {
      toast.error('Could not reach the till. Please try again.')
    } finally {
      setWorking(null)
    }
  }

  const left = now > 0 ? new Date(ticket.expires_at).getTime() - now : null

  if (status === 'lost') {
    return (
      <div className="mt-10 max-w-md border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
        <h2 className="display text-2xl">Reload to check this sale</h2>
        <p className="mt-4 text-sm leading-relaxed text-[var(--color-muted)]">
          This screen can no longer ask whether the payment landed. Reload the page, then look
          for the sale under Orders.
        </p>
        <div className="mt-6">
          <Button onClick={onClose}>New sale</Button>
        </div>
      </div>
    )
  }

  if (status === 'cancelled' || status === 'expired') {
    return (
      <div className="mt-10 max-w-md border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
        <h2 className="display text-2xl">{status === 'cancelled' ? 'Sale cancelled' : 'Payment not taken in time'}</h2>
        <p className="mt-4 text-sm leading-relaxed text-[var(--color-muted)]">
          {status === 'cancelled'
            ? 'Nothing was charged and no stock moved.'
            : isPhone
              ? 'The payment link has closed. Nothing was charged and no stock moved.'
              : 'Nothing has been charged yet and no stock moved. If the payment still comes through, it completes the sale.'}{' '}
          Any treatment in the sale stays on {customer}&rsquo;s record as completed with its balance
          owing, so it shows under Pay off first.
        </p>
        {status === 'cancelled' && !isPhone && (
          <p className="mt-3 text-sm leading-relaxed text-[var(--color-muted)]">
            If you already tapped the card, it will show under Orders, Card payments not matched to
            a sale.
          </p>
        )}
        <div className="mt-6">
          <Button onClick={onClose}>New sale</Button>
        </div>
      </div>
    )
  }

  return (
    <div className="mt-10 max-w-md border border-[var(--color-border)] bg-[var(--color-surface)] p-8">
      <p className="label-caps text-[var(--color-muted)]">Awaiting payment · {customer}</p>
      <p className="display mt-3 text-5xl tabular-nums">{formatMoney(ticket.amount_cents)}</p>
      {left !== null && (
        <p className="mt-2 text-xs tabular-nums text-[var(--color-muted)]">
          {left > 0 ? `Closes in ${clockOf(left)}` : 'Closing now'}
        </p>
      )}

      {isPhone ? (
        <div className="mt-6">
          {url ? (
            <>
              <div className="flex justify-center bg-white p-4">
                {qr ? (
                  // A data URL drawn in the browser; next/image has nothing to optimise.
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={qr} alt="QR code for the payment link" width={240} height={240} />
                ) : (
                  <div className="h-[240px] w-[240px]" aria-hidden />
                )}
              </div>
              <p className="mt-3 text-sm leading-relaxed">
                Have them scan this with their phone camera. They can pay by card, Apple Pay or
                Google Pay. This screen updates when the payment lands.
              </p>
              <p className="mt-2 break-all text-xs text-[var(--color-muted)]">{shortUrl(url)}</p>
              <div className="mt-4 flex flex-wrap gap-3">
                {canEmail && (
                  <Button variant="subtle" onClick={() => void act('send')} disabled={working !== null}>
                    <Mail className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                    {working === 'send' ? 'Sending…' : 'Email the link'}
                  </Button>
                )}
                <a
                  href={url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="label-caps inline-flex items-center gap-1.5 self-center text-[var(--color-muted)] hover:text-[var(--color-accent)]"
                >
                  Open on this device <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                </a>
              </div>
            </>
          ) : (
            <p className="text-sm text-[var(--color-muted)]">The payment link is not ready. Cancel and try again.</p>
          )}
        </div>
      ) : (
        <div className="mt-6">
          <p className="flex items-start gap-2.5 text-sm leading-relaxed">
            <Smartphone className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.75} aria-hidden />
            <span>
              Open the Stripe app, tap +, charge {formatMoney(ticket.amount_cents)} with Tap to Pay.
              This screen updates when the payment lands.
            </span>
          </p>
          {candidates.length > 0 && (
            <div className="mt-5 border-t border-[var(--color-border)] pt-4">
              <p className="label-caps text-[var(--color-muted)]">Card payments for this amount</p>
              <p className="mt-1 text-xs text-[var(--color-muted)]">
                Stripe could not tell which sale these were for. Pick the one you just took.
              </p>
              <ul className="mt-3 space-y-2">
                {candidates.map((c) => (
                  <li key={c.id} className="flex items-center justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="tabular-nums">{formatMoney(c.amount_cents)}</span>
                      <span className="block text-xs text-[var(--color-muted)]">
                        {formatDateTimeInTimeZone(new Date(c.paid_at), STUDIO_TZ)}
                        {c.description ? ` · ${c.description}` : ''}
                      </span>
                    </span>
                    <Button
                      variant="subtle"
                      onClick={() => void act('match', { payment_intent_id: c.payment_intent_id })}
                      disabled={working !== null}
                    >
                      This one
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      <div className="mt-8 border-t border-[var(--color-border)] pt-5">
        <Button variant="subtle" onClick={() => void act('cancel')} disabled={working !== null}>
          {working === 'cancel' ? 'Cancelling…' : 'Cancel this sale'}
        </Button>
      </div>
    </div>
  )
}

/** The one line that says a package and the running sale cannot share a receipt. */
function SoldOnItsOwn({
  text,
  action,
  onAction,
  className,
}: {
  text: string
  action: string
  onAction: () => void
  className?: string
}) {
  return (
    <div
      data-ui="tile"
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm',
        className
      )}
    >
      <span>{text}</span>
      <Button variant="subtle" onClick={onAction}>
        {action}
      </Button>
    </div>
  )
}

/** Six digits of cents: up to $9,999.99, which is the till's own ceiling. */
const MAX_PAD_DIGITS = 6

/** One keypad press against the digit string. Pure, so the keyboard and the
 *  on-screen pad cannot disagree. */
function pressKey(cur: string, key: string): string {
  if (key === 'back') return cur.slice(0, -1)
  const next = (cur + key).replace(/^0+/, '')
  return next.length > MAX_PAD_DIGITS ? cur : next
}

const PAD_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '00', '0', 'back'] as const

/**
 * The amount, as a calculator rather than a text field.
 *
 * The figure is the biggest thing on the screen because it is the one thing
 * the client is also reading over the counter. Digits fill from the right, so
 * 1-2-5-0 is $12.50 and there is no decimal point to miss.
 */
function AmountPad({
  cents,
  onKey,
  onClear,
  suggestion,
  onSuggest,
}: {
  cents: number
  onKey: (key: string) => void
  onClear: () => void
  suggestion: { label: string; cents: number } | null
  onSuggest: (cents: number) => void
}) {
  return (
    <div>
      <div className="flex items-end justify-between gap-4">
        <span className="label-caps text-[var(--color-muted)]">Amount</span>
        {cents > 0 && (
          <button
            type="button"
            onClick={onClear}
            className="label-caps text-[var(--color-muted)] hover:text-[var(--color-accent)]"
          >
            Clear
          </button>
        )}
      </div>

      <output
        aria-live="polite"
        className={cn(
          'display mt-2 block text-right text-5xl tabular-nums sm:text-6xl',
          cents === 0 && 'text-[var(--color-muted)]'
        )}
      >
        {formatMoney(cents)}
      </output>

      {suggestion && (
        <button
          type="button"
          data-ui="button"
          onClick={() => onSuggest(suggestion.cents)}
          className="label-caps mt-3 border border-[var(--color-border)] px-3 py-1.5 text-[var(--color-muted)] hover:border-[var(--color-accent)] hover:text-[var(--color-accent)]"
        >
          {suggestion.label} · {formatMoney(suggestion.cents)}
        </button>
      )}

      <div className="mt-4 grid grid-cols-3 gap-2">
        {PAD_KEYS.map((k) => (
          <button
            key={k}
            type="button"
            data-ui="button"
            onClick={() => onKey(k)}
            aria-label={k === 'back' ? 'Delete last digit' : k}
            className="flex min-h-16 items-center justify-center border border-[var(--color-border)] bg-[var(--color-background)] text-2xl tabular-nums transition-colors hover:bg-[var(--color-linen)] active:bg-[var(--color-clay-soft)] dark:hover:bg-[var(--color-surface)]"
          >
            {k === 'back' ? <Delete className="h-6 w-6" strokeWidth={1.5} aria-hidden /> : k}
          </button>
        ))}
      </div>
    </div>
  )
}
