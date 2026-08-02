/**
 * The shared money engine behind the four financial reports.
 *
 * NOT a ReportModule — nothing here is registered or rendered. It is the one
 * implementation of "what money moved in this window", imported by
 * `sales.ts`, `sales-tax.ts` and `transaction-detail.ts`.
 *
 * WHY one module rather than a query in each report: Sales, Sales Tax and
 * Transaction Detail have to agree to the cent over the same range, and the only
 * way to guarantee that is for all three to read the same rows through the same
 * predicate. Three hand-written queries that "should" match are three chances to
 * drift, and the drift is invisible until an accountant finds it.
 *
 * The rules encoded here, in order of importance:
 *
 *  1. Revenue is money TAKEN. The unit of account is a row in `payments` with
 *     `status = 'succeeded'` — never `appointments.total_cents`, never
 *     `orders.total_cents`. A completed appointment nobody paid for is not
 *     revenue. Refunds are negative rows and net out where they fall.
 *  2. Date boundaries are studio-local, resolved through `locations.timezone`
 *     and converted with `zonedTimeToUtc`. An 11pm sale on the 31st belongs to
 *     the 31st.
 *  3. Integer cents throughout. The only division is `allocate()`, which is
 *     exact integer arithmetic — see the note on its safe range.
 *  4. `payments` has no `location_id`. A payment's site is its parent's:
 *     `orders.location_id` or `appointments.location_id`. A payment with
 *     neither parent has no site, and is reported as such rather than being
 *     quietly assigned to the default location.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { addDaysToDateKey, dateKeyInTimeZone, zonedTimeToUtc } from '@/lib/time'

/** PostgREST caps a response; page rather than silently take the first page. */
const PAGE_SIZE = 1000
/** `.in()` lists go in the URL, so they are chunked well below any header limit. */
const ID_CHUNK = 200
/**
 * A hard ceiling so a mis-specified range cannot try to render a million rows.
 * Hitting it is reported in `notes[]` — a truncated report that does not say so
 * is worse than no report.
 */
export const ROW_CEILING = 50_000

type Client = SupabaseClient<Database>

interface PgErrorLike {
  message: string
}

/** The subset of ReportContext this module needs. Kept structural so it does
 *  not depend on the shell's type landing first. */
export interface MoneyContext {
  supabase: Client
  from: string
  to: string
  locationId: number | null
  providerId: string | null
  timeZone: string
}

// ── Integer arithmetic ───────────────────────────────────────

/**
 * Split `amount` across `weights` so the parts are integers that sum EXACTLY
 * to `amount`. Used to apportion one payment over the service lines it covers,
 * and to apportion an order's tax/base/delivery over a partial payment.
 *
 * Cumulative-floor rather than round-each-then-fix: the running total is
 * `floor(amount * cumulativeWeight / totalWeight)`, so the last part closes on
 * `amount` by construction and no correction pass is needed.
 *
 * There is no float here despite the `/`. `amount * cumulativeWeight` is a
 * product of two integers; at studio scale (an amount under $100,000 = 1e7
 * cents against weights summing under 1e7) it peaks around 1e14, which is well
 * inside the 2^53 range where a double represents every integer exactly. The
 * division is then exact-quotient-then-floor.
 *
 * Negative amounts (refunds) allocate by magnitude and carry the sign, so a
 * refund reverses the split it is reversing.
 */
export function allocate(amount: number, weights: number[]): number[] {
  const n = weights.length
  if (n === 0) return []

  // A negative weight has no meaning as a share and would break the monotonic
  // cumulative sum, so it is floored rather than trusted.
  const safe = weights.map((w) => (Number.isFinite(w) && w > 0 ? Math.trunc(w) : 0))
  const total = safe.reduce((a, b) => a + b, 0)

  // Nothing to weight by — putting it all on the first bucket is honest;
  // inventing an even split would assert a fact the data does not contain.
  if (total <= 0) {
    const out = new Array<number>(n).fill(0)
    out[0] = amount
    return out
  }

  const sign = amount < 0 ? -1 : 1
  const magnitude = Math.abs(amount)
  const out: number[] = []
  let cumulativeWeight = 0
  let cumulativeAmount = 0
  for (let i = 0; i < n; i++) {
    cumulativeWeight += safe[i]
    const next = Math.floor((magnitude * cumulativeWeight) / total)
    out.push(sign * (next - cumulativeAmount))
    cumulativeAmount = next
  }
  return out
}

/** Sum a column of cents. Separate function so no report writes `+` on money by hand. */
export function sumCents(values: readonly number[]): number {
  let total = 0
  for (const v of values) total += v
  return total
}

// ── The window ───────────────────────────────────────────────

export interface Window {
  /** Inclusive lower bound, as an absolute instant. */
  startIso: string
  /** EXCLUSIVE upper bound. Half-open so a DST day is 23 or 25 hours, never 24. */
  endIso: string
}

/**
 * `from`/`to` are inclusive calendar days in the studio's zone. The upper bound
 * is the start of the day AFTER `to`, compared with `<`, so the last day is
 * whole however many hours it happens to have.
 */
export function windowBounds(from: string, to: string, timeZone: string): Window {
  return {
    startIso: zonedTimeToUtc(from, '00:00', timeZone).toISOString(),
    endIso: zonedTimeToUtc(addDaysToDateKey(to, 1), '00:00', timeZone).toISOString(),
  }
}

// ── Row shapes read from the database ────────────────────────

type PaymentRow = {
  id: number
  amount_cents: number
  method: string
  kind: string
  status: string
  note: string | null
  created_at: string
  order_id: number | null
  appointment_id: string | null
  client_id: string | null
  processed_by: string | null
  stripe_payment_intent_id: string | null
  stripe_charge_id: string | null
}

type OrderRow = {
  id: number
  order_number: string | null
  location_id: number
  channel: string
  payment_method: string | null
  status: string
  subtotal_cents: number
  discount_cents: number
  tax_cents: number
  shipping_cents: number
  total_cents: number
  sold_by: string | null
  guest_name: string | null
  created_at: string
  paid_at: string | null
}

type AppointmentRow = {
  id: string
  location_id: number
  provider_id: string
  client_id: string | null
  status: string
  starts_at: string
  total_cents: number
  guest_first_name: string | null
  guest_last_name: string | null
}

type ServiceLineRow = {
  appointment_id: string
  service_id: number | null
  name_snapshot: string
  price_cents: number
}

type PersonRow = {
  id: string
  first_name: string | null
  last_name: string | null
  display_name: string | null
  email: string | null
}

export type LocationRow = {
  id: number
  name: string
  timezone: string
  is_active: boolean
  sort_order: number
}

// ── The normalised ledger ────────────────────────────────────

export type Channel = 'in_studio' | 'online'
export type Line = 'service' | 'retail' | 'unattributed'

/** One succeeded payment, with everything the four reports need resolved. */
export interface LedgerEntry {
  paymentId: number
  /** Signed integer cents. Negative is a refund. */
  amountCents: number
  method: string
  kind: string
  note: string | null
  /** The instant the money moved. */
  at: Date
  /** 'YYYY-MM-DD' in the reporting zone — the day this belongs to. */
  dayKey: string
  /** 'YYYY-MM' in the reporting zone. */
  monthKey: string
  channel: Channel
  line: Line
  /** Null when the payment has no order and no appointment. */
  locationId: number | null
  locationName: string
  clientName: string
  clientId: string | null
  providerId: string | null
  providerName: string | null
  /** `orders.sold_by` — who rang a retail sale up. Null for an online order. */
  sellerId: string | null
  sellerName: string | null
  processedById: string | null
  processedByName: string
  /** Human handle for the thing paid for: 'FL-2608-00012' or the appointment. */
  reference: string
  orderId: number | null
  appointmentId: string | null
  /** Present when `line === 'retail'`. */
  order: OrderRow | null
  /** Present when the payment is against an appointment. */
  appointment: AppointmentRow | null
  /** The service lines of that appointment, for the by-service breakdown. */
  serviceLines: ServiceLineRow[]
}

export interface Ledger {
  entries: LedgerEntry[]
  window: Window
  locations: LocationRow[]
  locationName: (id: number | null) => string
  /** True when the row ceiling was hit; every report must say so. */
  truncated: boolean
  /** Payments that fell outside the location filter because they have no site. */
  unattributedExcluded: number
  /** Active locations whose zone differs from the reporting zone. */
  foreignZones: string[]
}

// ── Paging helpers ───────────────────────────────────────────

async function pageAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: PgErrorLike | null }>
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []
  for (let offset = 0; offset < ROW_CEILING; offset += PAGE_SIZE) {
    const { data, error } = await query(offset, offset + PAGE_SIZE - 1)
    if (error) throw new Error(error.message)
    const batch = data ?? []
    rows.push(...batch)
    if (batch.length < PAGE_SIZE) return { rows, truncated: false }
  }
  return { rows, truncated: true }
}

async function fetchByIds<K extends string | number, T>(
  ids: readonly K[],
  query: (batch: K[]) => PromiseLike<{ data: T[] | null; error: PgErrorLike | null }>
): Promise<T[]> {
  if (ids.length === 0) return []
  const unique = Array.from(new Set(ids))
  const rows: T[] = []
  for (let i = 0; i < unique.length; i += ID_CHUNK) {
    const { data, error } = await query(unique.slice(i, i + ID_CHUNK))
    if (error) throw new Error(error.message)
    rows.push(...(data ?? []))
  }
  return rows
}

function personName(p: PersonRow | undefined, fallback: string): string {
  if (!p) return fallback
  const full = [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
  return p.display_name || full || p.email || fallback
}

// ── Loading ──────────────────────────────────────────────────

/**
 * Every succeeded payment in the window, resolved against its parent.
 *
 * This is the single predicate the three takings reports share. Change it here
 * and all three move together; that is the entire point of the module.
 */
export async function loadLedger(ctx: MoneyContext): Promise<Ledger> {
  const db = ctx.supabase
  const win = windowBounds(ctx.from, ctx.to, ctx.timeZone)

  const { data: locationData, error: locationError } = await db
    .from('locations')
    .select('id, name, timezone, is_active, sort_order')
    .order('sort_order', { ascending: true })
  if (locationError) throw new Error(locationError.message)
  const locations = (locationData ?? []) as LocationRow[]
  const locationById = new Map(locations.map((l) => [l.id, l]))
  const locationName = (id: number | null) =>
    id == null ? 'Unattributed' : (locationById.get(id)?.name ?? `Location ${id}`)

  // A second site in another district is the whole reason `location_id` exists;
  // if one ever has a different zone, the single reporting zone is a stated
  // approximation rather than a silent one.
  const foreignZones = Array.from(
    new Set(
      locations
        .filter((l) => l.is_active && l.timezone !== ctx.timeZone)
        .map((l) => l.timezone)
    )
  )

  const { rows: payments, truncated } = await pageAll<PaymentRow>((from, to) =>
    db
      .from('payments')
      .select(
        'id, amount_cents, method, kind, status, note, created_at, order_id, appointment_id, client_id, processed_by, stripe_payment_intent_id, stripe_charge_id'
      )
      .eq('status', 'succeeded')
      .gte('created_at', win.startIso)
      .lt('created_at', win.endIso)
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to)
  )

  const orderIds = payments.map((p) => p.order_id).filter((v): v is number => v != null)
  const appointmentIds = payments
    .map((p) => p.appointment_id)
    .filter((v): v is string => v != null)

  const orders = await fetchByIds<number, OrderRow>(orderIds, (batch) =>
    db
      .from('orders')
      .select(
        'id, order_number, location_id, channel, payment_method, status, subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents, sold_by, guest_name, created_at, paid_at'
      )
      .in('id', batch)
  )
  const orderById = new Map(orders.map((o) => [o.id, o]))

  const appointments = await fetchByIds<string, AppointmentRow>(appointmentIds, (batch) =>
    db
      .from('appointments')
      .select(
        'id, location_id, provider_id, client_id, status, starts_at, total_cents, guest_first_name, guest_last_name'
      )
      .in('id', batch)
  )
  const appointmentById = new Map(appointments.map((a) => [a.id, a]))

  const serviceLines = await fetchByIds<string, ServiceLineRow>(appointmentIds, (batch) =>
    db
      .from('appointment_services')
      .select('appointment_id, service_id, name_snapshot, price_cents')
      .in('appointment_id', batch)
  )
  const linesByAppointment = new Map<string, ServiceLineRow[]>()
  for (const line of serviceLines) {
    const bucket = linesByAppointment.get(line.appointment_id)
    if (bucket) bucket.push(line)
    else linesByAppointment.set(line.appointment_id, [line])
  }

  // Clients, providers and whoever took the money, in one pass.
  const personIds: string[] = []
  for (const p of payments) {
    if (p.client_id) personIds.push(p.client_id)
    if (p.processed_by) personIds.push(p.processed_by)
  }
  for (const a of appointments) {
    personIds.push(a.provider_id)
    if (a.client_id) personIds.push(a.client_id)
  }
  for (const o of orders) if (o.sold_by) personIds.push(o.sold_by)

  const people = await fetchByIds<string, PersonRow>(personIds, (batch) =>
    db.from('profiles').select('id, first_name, last_name, display_name, email').in('id', batch)
  )
  const personById = new Map(people.map((p) => [p.id, p]))

  let unattributedExcluded = 0
  const entries: LedgerEntry[] = []

  for (const p of payments) {
    const order = p.order_id != null ? (orderById.get(p.order_id) ?? null) : null
    const appointment = p.appointment_id ? (appointmentById.get(p.appointment_id) ?? null) : null

    // Rule 4: a payment's site is its parent's, or it has none.
    const locationId = order?.location_id ?? appointment?.location_id ?? null

    if (ctx.locationId != null) {
      if (locationId == null) {
        unattributedExcluded += 1
        continue
      }
      if (locationId !== ctx.locationId) continue
    }

    // A provider filter follows the work: the esthetician who performed the
    // appointment, or the member of staff who rang the sale up.
    if (ctx.providerId != null) {
      const matches =
        appointment?.provider_id === ctx.providerId || order?.sold_by === ctx.providerId
      if (!matches) continue
    }

    const at = new Date(p.created_at)
    const dayKey = dateKeyInTimeZone(at, ctx.timeZone)

    // Where the money was taken, not where the work happens. An order states it
    // outright; an appointment payment is online exactly when Stripe handled it,
    // which is what distinguishes a booking deposit from cash at the desk.
    const channel: Channel = order
      ? order.channel === 'in_store'
        ? 'in_studio'
        : 'online'
      : p.stripe_payment_intent_id || p.stripe_charge_id
        ? 'online'
        : 'in_studio'

    const line: Line = order ? 'retail' : appointment ? 'service' : 'unattributed'

    const clientId = p.client_id ?? appointment?.client_id ?? null
    const guestName =
      [appointment?.guest_first_name, appointment?.guest_last_name].filter(Boolean).join(' ') ||
      order?.guest_name ||
      ''
    const clientName = clientId
      ? personName(personById.get(clientId), 'Client')
      : guestName || 'Walk-in / guest'

    const providerId = appointment?.provider_id ?? null
    const reference = order
      ? (order.order_number ?? `Order ${order.id}`)
      : appointment
        ? `Appointment ${appointment.id.slice(0, 8)}`
        : (p.note ?? 'Unattributed')

    entries.push({
      paymentId: p.id,
      amountCents: p.amount_cents,
      method: p.method,
      kind: p.kind,
      note: p.note,
      at,
      dayKey,
      monthKey: dayKey.slice(0, 7),
      channel,
      line,
      locationId,
      locationName: locationName(locationId),
      clientId,
      clientName,
      providerId,
      providerName: providerId ? personName(personById.get(providerId), 'Provider') : null,
      sellerId: order?.sold_by ?? null,
      sellerName: order?.sold_by ? personName(personById.get(order.sold_by), 'Staff') : null,
      processedById: p.processed_by,
      processedByName: p.processed_by
        ? personName(personById.get(p.processed_by), 'Staff')
        : channel === 'online'
          ? 'Online (Stripe)'
          : 'Not recorded',
      reference,
      orderId: p.order_id,
      appointmentId: p.appointment_id,
      order,
      appointment,
      serviceLines: appointment ? (linesByAppointment.get(appointment.id) ?? []) : [],
    })
  }

  return {
    entries,
    window: win,
    locations,
    locationName,
    truncated,
    unattributedExcluded,
    foreignZones,
  }
}

// ── Derived splits every report agrees on ────────────────────

/** What an order-linked payment consists of, in integer cents that sum to it. */
export interface RetailSplit {
  /** Product subtotal after discount — the sales-tax base. */
  baseCents: number
  /** `orders.tax_cents`. The state's money; never revenue. */
  taxCents: number
  /** Separately stated delivery. Exempt in California; still money taken. */
  shippingCents: number
  /**
   * Whatever `total_cents` holds that base + tax + delivery does not explain.
   * `order_item_recalc()` clamps a total at zero, so a discount larger than the
   * subtotal leaves a gap; carrying it explicitly keeps the identity exact
   * instead of losing cents into a rounding story.
   */
  residualCents: number
}

/**
 * Apportion one payment across an order's components.
 *
 * A retail order in this app is paid in full at the point of sale, so the usual
 * case is a payment equal to `total_cents` and the split is the order's own
 * figures unchanged. The proportional path exists for the two cases that do
 * occur: a partial refund, and a refund landing in a later period than the sale.
 */
export function splitRetailPayment(amountCents: number, order: OrderRow): RetailSplit {
  const base = order.subtotal_cents - order.discount_cents
  const tax = order.tax_cents
  const shipping = order.shipping_cents
  const residual = order.total_cents - (base + tax + shipping)

  if (amountCents === order.total_cents) {
    return { baseCents: base, taxCents: tax, shippingCents: shipping, residualCents: residual }
  }

  const [b, t, s, r] = allocate(amountCents, [base, tax, shipping, residual])
  return { baseCents: b, taxCents: t, shippingCents: s, residualCents: r }
}

/** One appointment payment spread over the services it paid for. */
export interface ServiceShare {
  serviceKey: string
  serviceName: string
  amountCents: number
}

export function splitServicePayment(entry: LedgerEntry): ServiceShare[] {
  const lines = entry.serviceLines
  if (lines.length === 0) {
    return [
      { serviceKey: 'unspecified', serviceName: 'Unspecified service', amountCents: entry.amountCents },
    ]
  }
  const shares = allocate(
    entry.amountCents,
    lines.map((l) => l.price_cents)
  )
  return lines.map((l, i) => ({
    // A deleted service leaves `service_id` null but keeps its frozen name, so
    // the name is the fallback key rather than lumping every orphan together.
    serviceKey: l.service_id != null ? `s${l.service_id}` : `n:${l.name_snapshot}`,
    serviceName: l.name_snapshot,
    amountCents: shares[i],
  }))
}

// ── Small shared shaping helpers ─────────────────────────────

/** Group entries into a Map, preserving first-seen order. */
export function groupBy<T, K>(items: readonly T[], key: (item: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    const bucket = out.get(k)
    if (bucket) bucket.push(item)
    else out.set(k, [item])
  }
  return out
}

/** Every calendar day in the range, so a day with no takings still shows as zero. */
export function dayKeys(from: string, to: string): string[] {
  const out: string[] = []
  let cursor = from
  // A range is a handful of months at most; the guard is against a reversed
  // or absurd range rather than a real one.
  for (let i = 0; i < 3660 && cursor <= to; i++) {
    out.push(cursor)
    cursor = addDaysToDateKey(cursor, 1)
  }
  return out
}
