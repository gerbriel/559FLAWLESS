import 'server-only'

/**
 * Reading the studio out, one entity at a time.
 *
 * Every query here runs on the ORDINARY server client, which means row-level
 * security applies to it exactly as it does to a screen. There is deliberately
 * no service-role path in this file: an export must never be able to contain a
 * row the person asking for it could not have read on the page. The page is
 * gated at manager, but the gate is not what makes that true — RLS is, and this
 * file simply declines to go around it.
 *
 * The headers come from `entities.ts`, so an export and its template are the
 * same list read twice. Export carries a handful of read-only columns the
 * template leaves out (an id, a stock count, a created date), marked as such on
 * the reference table; re-importing an export is fine, because the mapper lists
 * them as ignored rather than choking on them.
 *
 * Money is written as a bare decimal — 125.00, not $125.00 — via the same
 * `centsToDecimalString` the reports exporter uses. A spreadsheet can sum a
 * number and cannot sum a currency string, and an export exists to be summed
 * somewhere else. `formatMoney` remains the only place cents become a *display*
 * string; this is its machine-readable counterpart, and there is one of it.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { CsvEntity, CsvField } from '@/lib/csv/schema'
import { centsToDecimalString } from '@/lib/reports/types'
import { formatDateTimeInTimeZone } from '@/lib/time'

type Client = SupabaseClient<Database>

const PAGE = 1000
const IN_CHUNK = 200

/**
 * A ceiling, so a runaway table fails as a sentence rather than as a timeout.
 * Reaching it appends a final line saying so — a truncated export that does not
 * announce itself is worse than no export.
 */
export const EXPORT_ROW_CEILING = 20_000

export type ExportedTable = { headers: string[]; rows: string[][]; truncated: boolean }

type Cell = string | number | boolean | null | undefined

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** One value, formatted the way its own field says it should be. */
function cell(field: CsvField, value: Cell): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'boolean') return value ? 'yes' : 'no'
  if (field.type === 'money') {
    return typeof value === 'number' ? centsToDecimalString(value) : String(value)
  }
  return String(value)
}

function toRows(entity: CsvEntity, records: Record<string, Cell>[]): string[][] {
  return records.map((record) => entity.fields.map((field) => cell(field, record[field.key])))
}

/** The studio's zone. Every instant in an export is rendered in it. */
export async function studioTimeZone(client: Client): Promise<string> {
  const { data } = await client
    .from('locations')
    .select('id, timezone, is_active, sort_order')
    .order('sort_order')
    .order('id')
    .limit(1)
  return data?.[0]?.timezone ?? 'America/Los_Angeles'
}

function when(value: string | null, timeZone: string): string {
  if (!value) return ''
  const instant = new Date(value)
  if (Number.isNaN(instant.getTime())) return ''
  return formatDateTimeInTimeZone(instant, timeZone)
}

/** Read every page, not the first one. */
async function readAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await page(offset, offset + PAGE - 1)
    if (error) throw new Error(error.message)
    const got = data ?? []
    rows.push(...got)
    if (got.length < PAGE) return { rows, truncated: false }
    if (rows.length >= EXPORT_ROW_CEILING) return { rows: rows.slice(0, EXPORT_ROW_CEILING), truncated: true }
  }
}

/* ── Name lookups, joined here rather than embedded ───────── */
//
// PostgREST embeds would work, but they need the real constraint name in the
// select string and a wider result type for every caller. These tables are tiny
// and read once, so a Map is simpler and the select strings stay short.

async function namesOf(
  client: Client,
  table: 'service_categories' | 'product_categories' | 'brands'
): Promise<Map<number, string>> {
  const query =
    table === 'service_categories'
      ? client.from('service_categories').select('id, name')
      : table === 'product_categories'
        ? client.from('product_categories').select('id, name')
        : client.from('brands').select('id, name')

  const { data, error } = await query
  if (error) throw new Error(error.message)
  const out = new Map<number, string>()
  for (const row of data ?? []) out.set(row.id, row.name)
  return out
}

/* ── The five exports ─────────────────────────────────────── */

export async function exportEntity(
  client: Client,
  entity: CsvEntity,
  timeZone: string
): Promise<ExportedTable> {
  const headers = entity.fields.map((f) => f.label)

  if (entity.key === 'clients') {
    const { rows, truncated } = await readAll((from, to) =>
      client
        .from('profiles')
        .select('id, first_name, last_name, email, phone, date_of_birth, pronouns, marketing_opt_in, sms_opt_in, created_at')
        .eq('role', 'client')
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to)
    )

    /*
     * THE CONTACTS ARE IN THIS FILE TOO, and leaving them out was the tempting
     * mistake. `client_stubs` (051) holds the clients with no account — the
     * walk-in who gave a phone number, the regular nobody ever asked — and they
     * are clients in every sense except the one the login cares about. An export
     * that quietly skipped them would be a client list missing the very people
     * the import was built to stop losing, and the loss would show up nowhere:
     * the file would look complete.
     *
     * They are told apart by the Has Account column rather than by being in a
     * second file, because a studio asking "who do I have" is asking one
     * question. The columns a contact has no answer for — a date of birth,
     * marketing consent — come out empty, which on a re-import means "leave
     * that alone" and so costs nothing.
     *
     * Claimed contacts are left out: those people have accounts now and are
     * already in the rows above, under the name they chose themselves.
     */
    const contacts = await readAll((from, to) =>
      client
        .from('client_stubs')
        .select('id, first_name, last_name, email, phone, note, created_at')
        .is('claimed_by', null)
        .order('created_at', { ascending: false })
        .order('id')
        .range(from, to)
    )

    return {
      headers,
      truncated: truncated || contacts.truncated,
      rows: toRows(entity, [
        ...rows.map((row) => ({
          ...row,
          has_account: true,
          created_at: when(row.created_at, timeZone),
        })),
        ...contacts.rows.map((row) => ({
          first_name: row.first_name,
          last_name: row.last_name,
          email: row.email,
          phone: row.phone,
          note: row.note,
          has_account: false,
          // Deliberately not row.id. A contact's id is a bigint from another
          // table and the Client ID column means a profile's uuid; writing one
          // where the other belongs would be a number that looks like an answer.
          id: null,
          created_at: when(row.created_at, timeZone),
        })),
      ]),
    }
  }

  if (entity.key === 'services') {
    const categories = await namesOf(client, 'service_categories')
    const { rows, truncated } = await readAll((from, to) =>
      client
        .from('services')
        .select('id, name, slug, category_id, description, details, aftercare, price_cents, price_is_starting, duration_minutes, buffer_minutes, requires_intake, is_active, is_featured, sort_order')
        .order('sort_order')
        .order('id')
        .range(from, to)
    )

    return {
      headers,
      truncated,
      rows: toRows(
        entity,
        rows.map((row) => ({ ...row, category: categories.get(row.category_id) ?? '' }))
      ),
    }
  }

  if (entity.key === 'products') {
    const [categories, brands] = await Promise.all([
      namesOf(client, 'product_categories'),
      namesOf(client, 'brands'),
    ])
    const { rows, truncated } = await readAll((from, to) =>
      client
        .from('products')
        .select('id, sku, name, slug, barcode, category_id, brand_id, description, ingredients, how_to_use, price_cents, cost_cents, taxable, is_retail, is_professional, unit, stock_qty, low_stock_threshold, reorder_qty, external_url, is_active, is_featured, sort_order')
        .order('sort_order')
        .order('id')
        .range(from, to)
    )

    return {
      headers,
      truncated,
      rows: toRows(
        entity,
        rows.map((row) => ({
          ...row,
          category: row.category_id === null ? '' : (categories.get(row.category_id) ?? ''),
          brand: row.brand_id === null ? '' : (brands.get(row.brand_id) ?? ''),
        }))
      ),
    }
  }

  if (entity.key === 'sales') return exportSales(client, entity, timeZone)
  return exportAppointments(client, entity, timeZone)
}

/**
 * One row per line sold, with its order's totals repeated beside it.
 *
 * Deliberately NOT a revenue report. `orders.total_cents` is what was billed,
 * not what arrived; the money engine in `src/lib/reports/money.ts` is what
 * allocates succeeded payments back to the lines that earned them, and the
 * Sales and Sales Tax reports read it. This is a list of what left the shelf,
 * and the column names say "Order Total" rather than "Revenue" so it cannot be
 * mistaken for the other thing.
 *
 * Carts and unpaid orders are excluded: nothing was sold.
 */
async function exportSales(client: Client, entity: CsvEntity, timeZone: string): Promise<ExportedTable> {
  const headers = entity.fields.map((f) => f.label)

  const { rows: orders, truncated } = await readAll((from, to) =>
    client
      .from('orders')
      .select('id, order_number, client_id, guest_name, guest_email, status, channel, payment_method, subtotal_cents, discount_cents, tax_cents, shipping_cents, total_cents, paid_at, created_at')
      .not('status', 'in', '("cart","pending_payment","cancelled")')
      .order('created_at', { ascending: false })
      .range(from, to)
  )

  if (orders.length === 0) return { headers, rows: [], truncated }

  const orderIds = orders.map((o) => o.id)
  const items: {
    order_id: number
    name_snapshot: string
    sku_snapshot: string | null
    unit_price_cents: number
    qty: number
    line_total_cents: number
    id: number
  }[] = []

  for (const group of chunk(orderIds, IN_CHUNK)) {
    const { data, error } = await client
      .from('order_items')
      .select('id, order_id, name_snapshot, sku_snapshot, unit_price_cents, qty, line_total_cents')
      .in('order_id', group)
      .order('id')
    if (error) throw new Error(error.message)
    items.push(...(data ?? []))
  }

  const clientIds = [...new Set(orders.map((o) => o.client_id).filter((id): id is string => !!id))]
  const people = new Map<string, { name: string; email: string }>()
  for (const group of chunk(clientIds, IN_CHUNK)) {
    const { data, error } = await client
      .from('profiles')
      .select('id, first_name, last_name, email')
      .in('id', group)
    if (error) throw new Error(error.message)
    for (const person of data ?? []) {
      people.set(person.id, {
        name: `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim(),
        email: person.email ?? '',
      })
    }
  }

  const byId = new Map(orders.map((o) => [o.id, o]))
  const records = items.flatMap((item) => {
    const order = byId.get(item.order_id)
    if (!order) return []
    const person = order.client_id ? people.get(order.client_id) : undefined
    return [
      {
        order_number: order.order_number ?? String(order.id),
        sold_at: when(order.paid_at ?? order.created_at, timeZone),
        channel: order.channel,
        status: order.status,
        payment_method: order.payment_method ?? '',
        client_name: person?.name || order.guest_name || '',
        client_email: person?.email || order.guest_email || '',
        sku: item.sku_snapshot ?? '',
        product_name: item.name_snapshot,
        qty: item.qty,
        unit_price_cents: item.unit_price_cents,
        line_total_cents: item.line_total_cents,
        order_subtotal_cents: order.subtotal_cents,
        order_discount_cents: order.discount_cents,
        order_tax_cents: order.tax_cents,
        order_shipping_cents: order.shipping_cents,
        order_total_cents: order.total_cents,
      },
    ]
  })

  return { headers, rows: toRows(entity, records), truncated }
}

async function exportAppointments(client: Client, entity: CsvEntity, timeZone: string): Promise<ExportedTable> {
  const headers = entity.fields.map((f) => f.label)

  const { rows, truncated } = await readAll((from, to) =>
    client
      .from('appointments')
      .select('id, provider_id, client_id, guest_first_name, guest_last_name, guest_email, guest_phone, starts_at, ends_at, status, source, subtotal_cents, total_cents, deposit_cents, deposit_status, created_at')
      .order('starts_at', { ascending: false })
      .range(from, to)
  )

  const personIds = [
    ...new Set(
      rows.flatMap((row) => [row.provider_id, row.client_id]).filter((id): id is string => !!id)
    ),
  ]
  const people = new Map<string, { name: string; email: string; phone: string }>()
  for (const group of chunk(personIds, IN_CHUNK)) {
    const { data, error } = await client
      .from('profiles')
      .select('id, first_name, last_name, display_name, email, phone')
      .in('id', group)
    if (error) throw new Error(error.message)
    for (const person of data ?? []) {
      people.set(person.id, {
        name:
          person.display_name ||
          `${person.first_name ?? ''} ${person.last_name ?? ''}`.trim(),
        email: person.email ?? '',
        phone: person.phone ?? '',
      })
    }
  }

  const records = rows.map((row) => {
    const provider = people.get(row.provider_id)
    const person = row.client_id ? people.get(row.client_id) : undefined
    // Both ends are absolute instants, so this subtraction is safe anywhere;
    // only the rendering above needs the zone.
    const minutes = Math.round(
      (new Date(row.ends_at).getTime() - new Date(row.starts_at).getTime()) / 60_000
    )
    return {
      starts_at: when(row.starts_at, timeZone),
      ends_at: when(row.ends_at, timeZone),
      duration_minutes: Number.isFinite(minutes) ? minutes : '',
      provider_name: provider?.name ?? '',
      client_name:
        person?.name ||
        `${row.guest_first_name ?? ''} ${row.guest_last_name ?? ''}`.trim(),
      client_email: person?.email || row.guest_email || '',
      client_phone: person?.phone || row.guest_phone || '',
      status: row.status,
      source: row.source,
      subtotal_cents: row.subtotal_cents,
      total_cents: row.total_cents,
      deposit_cents: row.deposit_cents,
      deposit_status: row.deposit_status,
      created_at: when(row.created_at, timeZone),
    }
  })

  return { headers, rows: toRows(entity, records), truncated }
}
