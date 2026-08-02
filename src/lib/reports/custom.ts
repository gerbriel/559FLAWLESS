// 559 Flawless — the constrained custom report builder.
//
// WHY THIS IS NOT A SQL BUILDER
// -----------------------------
// The obvious feature request is "let me write my own query". This database
// holds `client_notes`, `intake_submissions`, `consent_signatures`,
// `patch_tests` and `treatment_photos` — health information about named people.
// A free-form SQL box, however well intentioned, is an arbitrary-read primitive
// pointed at clinical records, and the first injection or copy-pasted snippet
// turns into a disclosure. There is no version of that which is worth the
// convenience.
//
// So: a builder over an allow-list. A subject, columns chosen from a fixed set,
// filters from a fixed set, one grouping, one sort. It compiles to a PostgREST
// query issued through the CALLER'S OWN client, which means RLS applies exactly
// as it does everywhere else — the builder cannot surface a row the person
// could not already open by hand. The allow-list is a second, narrower fence
// inside that one: clinical columns are not merely hidden, they are absent from
// the compiler, so no combination of inputs can name them.
//
// What that costs, honestly: no joins beyond the curated embeds below, no
// computed expressions, no HAVING, no window functions, no sub-queries, and
// aggregation happens in JS over a capped row set rather than in Postgres.

import type { ReportColumn } from '@/lib/reports/types'
import { rangeToInstants } from '@/lib/reports/types'
import type { UserRole } from '@/types/database'

/**
 * `saved_reports` (migration 042) is not in `src/types/database.ts` yet — the
 * entry is listed in the migration's header for whoever regenerates it. Until
 * then the table is reached through this cast, the same way `timeclockDb`
 * handles the 035 tables. Delete this once the entry lands.
 *
 * It is ALSO what the builder's own queries go through, for a different and
 * permanent reason: postgrest-js parses the select string at the type level, so
 * a string assembled at runtime degrades to `SelectQueryError` no matter what.
 * A dynamic query has no static shape to preserve; the safety here comes from
 * the allow-list, not from the type checker.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const reportsDb = (client: unknown): any => client

/** Never fetch an unbounded table into a page. Hit this and the UI says so. */
export const ROW_CAP = 5000

// ---------------------------------------------------------------------------
// Subjects
// ---------------------------------------------------------------------------

export interface SubjectColumn {
  key: string
  label: string
  /** Exact PostgREST select fragment. Embeds must name the FK constraint. */
  select: string
  /** How to read the value back out of the returned row. */
  path: string[]
  format: NonNullable<ReportColumn['format']>
  /** May be used as the grouping key. */
  groupable?: boolean
  /** What happens to this column when rows are grouped. Omitted = dropped. */
  aggregate?: 'sum'
}

export interface SubjectFilter {
  key: string
  label: string
  /** PostgREST column to compare. Embedded columns are not filterable. */
  column: string
  options: { value: string; label: string }[]
}

export interface Subject {
  key: string
  label: string
  description: string
  table: string
  minRole: UserRole
  /** The column the date range applies to. */
  dateColumn: string
  /** A DATE column is compared to date keys; a timestamptz to instants. */
  dateIsInstant: boolean
  /** Rows where the date column is null are simply not in any window. */
  dateNullable?: boolean
  hasLocation: boolean
  /** Column holding the provider, when the subject has one. */
  providerColumn?: string
  columns: SubjectColumn[]
  filters: SubjectFilter[]
  /** Shown in the UI so nobody wonders where the clinical fields went. */
  excluded?: string
}

const APPOINTMENT_STATUSES = [
  'pending',
  'confirmed',
  'checked_in',
  'completed',
  'cancelled',
  'no_show',
]

export const SUBJECTS: Subject[] = [
  {
    key: 'appointments',
    label: 'Appointments',
    description: 'The book — who was seen, by whom, and what the visit was worth.',
    table: 'appointments',
    minRole: 'manager',
    dateColumn: 'starts_at',
    dateIsInstant: true,
    hasLocation: true,
    providerColumn: 'provider_id',
    excluded:
      'Notes, intake answers and anything else clinical are not available here, by design.',
    columns: [
      { key: 'starts_at', label: 'When', select: 'starts_at', path: ['starts_at'], format: 'date' },
      { key: 'status', label: 'Status', select: 'status', path: ['status'], format: 'text', groupable: true },
      { key: 'source', label: 'Booked via', select: 'source', path: ['source'], format: 'text', groupable: true },
      {
        key: 'provider',
        label: 'Provider',
        // Two FKs from appointments to profiles, so the constraint is named.
        select: 'provider:profiles!appointments_provider_id_fkey(display_name, first_name, last_name)',
        path: ['provider'],
        format: 'text',
        groupable: true,
      },
      {
        key: 'client',
        label: 'Client',
        select: 'client:profiles!appointments_client_id_fkey(display_name, first_name, last_name)',
        path: ['client'],
        format: 'text',
        groupable: true,
      },
      { key: 'total_cents', label: 'Booked value', select: 'total_cents', path: ['total_cents'], format: 'money', aggregate: 'sum' },
      { key: 'deposit_cents', label: 'Deposit', select: 'deposit_cents', path: ['deposit_cents'], format: 'money', aggregate: 'sum' },
    ],
    filters: [
      {
        key: 'status',
        label: 'Status',
        column: 'status',
        options: APPOINTMENT_STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
      },
      {
        key: 'source',
        label: 'Booked via',
        column: 'source',
        options: ['online', 'staff', 'phone', 'walk_in'].map((s) => ({
          value: s,
          label: s.replace(/_/g, ' '),
        })),
      },
    ],
  },
  {
    key: 'orders',
    label: 'Orders',
    description: 'Retail sales, online and at the desk.',
    table: 'orders',
    minRole: 'manager',
    dateColumn: 'created_at',
    dateIsInstant: true,
    hasLocation: true,
    columns: [
      { key: 'created_at', label: 'When', select: 'created_at', path: ['created_at'], format: 'date' },
      { key: 'order_number', label: 'Order', select: 'order_number', path: ['order_number'], format: 'text' },
      { key: 'status', label: 'Status', select: 'status', path: ['status'], format: 'text', groupable: true },
      { key: 'channel', label: 'Channel', select: 'channel', path: ['channel'], format: 'text', groupable: true },
      { key: 'payment_method', label: 'Paid by', select: 'payment_method', path: ['payment_method'], format: 'text', groupable: true },
      { key: 'fulfillment', label: 'Fulfilment', select: 'fulfillment', path: ['fulfillment'], format: 'text', groupable: true },
      {
        key: 'client',
        label: 'Client',
        select: 'client:profiles!orders_client_id_fkey(display_name, first_name, last_name)',
        path: ['client'],
        format: 'text',
        groupable: true,
      },
      { key: 'subtotal_cents', label: 'Subtotal', select: 'subtotal_cents', path: ['subtotal_cents'], format: 'money', aggregate: 'sum' },
      { key: 'discount_cents', label: 'Discount', select: 'discount_cents', path: ['discount_cents'], format: 'money', aggregate: 'sum' },
      // Held for the state, not earned. Kept separate for exactly that reason.
      { key: 'tax_cents', label: 'Tax', select: 'tax_cents', path: ['tax_cents'], format: 'money', aggregate: 'sum' },
      { key: 'total_cents', label: 'Total', select: 'total_cents', path: ['total_cents'], format: 'money', aggregate: 'sum' },
    ],
    filters: [
      {
        key: 'channel',
        label: 'Channel',
        column: 'channel',
        options: [
          { value: 'online', label: 'Online' },
          { value: 'in_store', label: 'In store' },
        ],
      },
      {
        key: 'status',
        label: 'Status',
        column: 'status',
        options: ['cart', 'pending', 'paid', 'fulfilling', 'ready_for_pickup', 'shipped', 'completed', 'cancelled', 'refunded'].map(
          (s) => ({ value: s, label: s.replace(/_/g, ' ') })
        ),
      },
    ],
  },
  {
    key: 'payments',
    label: 'Payments',
    description: 'The money-taken ledger. Refunds are negative rows and net out.',
    table: 'payments',
    minRole: 'manager',
    dateColumn: 'created_at',
    dateIsInstant: true,
    // `payments` carries no location_id — a payment belongs to the order or the
    // appointment it settles, and that is where the site lives.
    hasLocation: false,
    columns: [
      { key: 'created_at', label: 'When', select: 'created_at', path: ['created_at'], format: 'date' },
      { key: 'kind', label: 'Kind', select: 'kind', path: ['kind'], format: 'text', groupable: true },
      { key: 'method', label: 'Method', select: 'method', path: ['method'], format: 'text', groupable: true },
      { key: 'status', label: 'Status', select: 'status', path: ['status'], format: 'text', groupable: true },
      {
        key: 'client',
        label: 'Client',
        select: 'client:profiles!payments_client_id_fkey(display_name, first_name, last_name)',
        path: ['client'],
        format: 'text',
        groupable: true,
      },
      { key: 'amount_cents', label: 'Amount', select: 'amount_cents', path: ['amount_cents'], format: 'money', aggregate: 'sum' },
    ],
    filters: [
      {
        key: 'status',
        label: 'Status',
        column: 'status',
        options: ['pending', 'succeeded', 'failed', 'refunded'].map((s) => ({ value: s, label: s })),
      },
      {
        key: 'kind',
        label: 'Kind',
        column: 'kind',
        options: ['deposit', 'service', 'product', 'gift_card', 'package', 'refund'].map((s) => ({
          value: s,
          label: s.replace(/_/g, ' '),
        })),
      },
      {
        key: 'method',
        label: 'Method',
        column: 'method',
        options: ['card', 'cash', 'gift_card', 'package', 'other'].map((s) => ({
          value: s,
          label: s.replace(/_/g, ' '),
        })),
      },
    ],
  },
  {
    key: 'expenses',
    label: 'Expenses',
    description: 'What went out, by category and vendor.',
    table: 'expenses',
    minRole: 'manager',
    // A DATE column: already a studio-local calendar day, never an instant.
    dateColumn: 'incurred_on',
    dateIsInstant: false,
    hasLocation: false,
    columns: [
      { key: 'incurred_on', label: 'Date', select: 'incurred_on', path: ['incurred_on'], format: 'date' },
      { key: 'description', label: 'What', select: 'description', path: ['description'], format: 'text' },
      {
        key: 'category',
        label: 'Category',
        select: 'expense_categories(name)',
        path: ['expense_categories', 'name'],
        format: 'text',
        groupable: true,
      },
      {
        key: 'vendor',
        label: 'Vendor',
        select: 'vendors(name)',
        path: ['vendors', 'name'],
        format: 'text',
        groupable: true,
      },
      { key: 'payment_method', label: 'Paid by', select: 'payment_method', path: ['payment_method'], format: 'text', groupable: true },
      { key: 'reference', label: 'Reference', select: 'reference', path: ['reference'], format: 'text' },
      { key: 'amount_cents', label: 'Amount', select: 'amount_cents', path: ['amount_cents'], format: 'money', aggregate: 'sum' },
    ],
    filters: [
      {
        key: 'is_tax_deductible',
        label: 'Deductible',
        column: 'is_tax_deductible',
        options: [
          { value: 'true', label: 'Deductible' },
          { value: 'false', label: 'Not deductible' },
        ],
      },
      {
        key: 'payment_method',
        label: 'Paid by',
        column: 'payment_method',
        options: ['card', 'cash', 'cheque', 'transfer', 'other'].map((s) => ({ value: s, label: s })),
      },
    ],
  },
  {
    key: 'clients',
    label: 'Clients',
    description: 'Visit counts and lifetime value. No clinical fields, ever.',
    table: 'client_records',
    minRole: 'manager',
    // Rows with no visit yet fall outside every window. Stated in the notes.
    dateColumn: 'last_visit_at',
    dateIsInstant: true,
    dateNullable: true,
    hasLocation: false,
    excluded:
      'Fitzpatrick type, skin type, concerns, allergies, medications and medical notes are health information and are not selectable here.',
    columns: [
      {
        key: 'client',
        label: 'Client',
        select: 'client:profiles!client_records_client_id_fkey(display_name, first_name, last_name)',
        path: ['client'],
        format: 'text',
        groupable: true,
      },
      { key: 'first_visit_at', label: 'First visit', select: 'first_visit_at', path: ['first_visit_at'], format: 'date' },
      { key: 'last_visit_at', label: 'Last visit', select: 'last_visit_at', path: ['last_visit_at'], format: 'date' },
      { key: 'visit_count', label: 'Visits', select: 'visit_count', path: ['visit_count'], format: 'number', aggregate: 'sum' },
      { key: 'no_show_count', label: 'No-shows', select: 'no_show_count', path: ['no_show_count'], format: 'number', aggregate: 'sum' },
      { key: 'cancel_count', label: 'Cancellations', select: 'cancel_count', path: ['cancel_count'], format: 'number', aggregate: 'sum' },
      // Trigger-maintained. Read it; never recompute it here.
      { key: 'lifetime_value_cents', label: 'Lifetime value', select: 'lifetime_value_cents', path: ['lifetime_value_cents'], format: 'money', aggregate: 'sum' },
      { key: 'referral_source', label: 'Found us via', select: 'referral_source', path: ['referral_source'], format: 'text', groupable: true },
    ],
    filters: [],
  },
]

export function findSubject(key: string | undefined | null): Subject | null {
  return SUBJECTS.find((s) => s.key === key) ?? null
}

// ---------------------------------------------------------------------------
// A definition — what a saved report actually is
// ---------------------------------------------------------------------------

export interface CustomDefinition {
  subject: string
  columns: string[]
  /** filter key → chosen value. Only keys in the subject's allow-list survive. */
  filters: Record<string, string>
  groupBy: string | null
  sort: string | null
  sortDir: 'asc' | 'desc'
}

/**
 * Normalise anything into a definition made only of allow-listed parts.
 *
 * This is the fence. Everything downstream — the select string, the filters,
 * the grouping — is built from the output of this function, so an input that is
 * not on a list simply ceases to exist rather than being escaped and passed on.
 */
export function sanitiseDefinition(
  raw: Partial<CustomDefinition> & Record<string, unknown>
): CustomDefinition | null {
  const subject = findSubject(typeof raw.subject === 'string' ? raw.subject : null)
  if (!subject) return null

  const requested = Array.isArray(raw.columns)
    ? raw.columns.filter((c): c is string => typeof c === 'string')
    : []
  // Filtering the subject's own list rather than mapping the request is what
  // makes this an allow-list: an unknown key cannot survive the intersection,
  // and the column order is the subject's, so the same tick-boxes always
  // produce the same table.
  let columns = subject.columns.filter((c) => requested.includes(c.key)).map((c) => c.key)
  // An empty selection renders a table of nothing. Open on something useful.
  if (columns.length === 0) columns = subject.columns.slice(0, 4).map((c) => c.key)

  const filters: Record<string, string> = {}
  const rawFilters = (raw.filters ?? {}) as Record<string, unknown>
  for (const f of subject.filters) {
    const value = rawFilters[f.key]
    if (typeof value !== 'string' || value === '') continue
    if (f.options.some((o) => o.value === value)) filters[f.key] = value
  }

  const groupCandidate = typeof raw.groupBy === 'string' ? raw.groupBy : null
  const groupBy =
    groupCandidate && subject.columns.some((c) => c.key === groupCandidate && c.groupable)
      ? groupCandidate
      : null

  // Under a grouping the only columns that survive are the key, the count and
  // the summable ones, so a sort must name one of those.
  const sortable = groupBy
    ? [groupBy, 'row_count', ...subject.columns.filter((c) => c.aggregate).map((c) => c.key)]
    : columns
  const sortCandidate = typeof raw.sort === 'string' ? raw.sort : null
  const sort = sortCandidate && sortable.includes(sortCandidate) ? sortCandidate : null

  return {
    subject: subject.key,
    columns,
    filters,
    groupBy,
    sort,
    sortDir: raw.sortDir === 'asc' ? 'asc' : 'desc',
  }
}

/**
 * The select string for a definition.
 *
 * Assembled at runtime, which the codebase otherwise forbids — see `reportsDb`
 * above for why that rule cannot apply to a builder and what replaces it. Every
 * fragment joined here is a literal from `SUBJECTS`; nothing user-supplied ever
 * reaches this string.
 */
export function buildSelect(subject: Subject, definition: CustomDefinition): string {
  const chosen = subject.columns.filter((c) => definition.columns.includes(c.key))
  const fragments = chosen.map((c) => c.select)
  // The grouping key has to be fetched even when it is not a displayed column.
  if (definition.groupBy && !definition.columns.includes(definition.groupBy)) {
    const g = subject.columns.find((c) => c.key === definition.groupBy)
    if (g) fragments.push(g.select)
  }
  return fragments.join(', ')
}

/** The date bounds to apply, in whatever shape the subject's column wants. */
export function dateBounds(
  subject: Subject,
  from: string,
  to: string,
  timeZone: string
): { gte: string; lt?: string; lte?: string } {
  if (!subject.dateIsInstant) return { gte: from, lte: to }
  const { startIso, endIso } = rangeToInstants(from, to, timeZone)
  return { gte: startIso, lt: endIso }
}

// ---------------------------------------------------------------------------
// Reading rows back
// ---------------------------------------------------------------------------

type Raw = Record<string, unknown>

function personName(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const p = value as Record<string, unknown>
  const display = typeof p.display_name === 'string' ? p.display_name.trim() : ''
  if (display) return display
  const first = typeof p.first_name === 'string' ? p.first_name : ''
  const last = typeof p.last_name === 'string' ? p.last_name : ''
  const joined = `${first} ${last}`.trim()
  return joined || null
}

/**
 * Pull one column's value out of a PostgREST row.
 *
 * An embed comes back as a nested object (or, for a to-many, an array — which
 * none of the curated embeds are, but the guard costs nothing and stops a
 * "[object Object]" cell if that ever changes).
 */
export function readCell(row: Raw, column: SubjectColumn): string | number | null {
  let value: unknown = row
  for (const step of column.path) {
    if (value == null || typeof value !== 'object') return null
    value = (Array.isArray(value) ? value[0] : (value as Raw))[step]
  }

  if (value == null) return null
  if (typeof value === 'object') return personName(value)
  if (typeof value === 'number') return value
  if (typeof value === 'boolean') return value ? 'Yes' : 'No'
  return String(value)
}

export interface CompiledResult {
  columns: ReportColumn[]
  rows: Record<string, string | number | null>[]
  /** True when the fetch hit ROW_CAP and the numbers are therefore partial. */
  truncated: boolean
}

/**
 * Turn raw rows into the report shape, grouping and sorting in JS.
 *
 * PostgREST has no GROUP BY, so aggregation happens here over the capped row
 * set. That is a real limit and the UI says so out loud: a grouping that had to
 * truncate is arithmetic on a sample, and a total nobody can trust is worse
 * than no total.
 *
 * Money stays in integer cents through every sum. The only division is the
 * formatter's, and that happens after all of this.
 */
export function compileRows(
  subject: Subject,
  definition: CustomDefinition,
  raw: Raw[],
  truncated: boolean
): CompiledResult {
  const chosen = subject.columns.filter((c) => definition.columns.includes(c.key))

  if (!definition.groupBy) {
    const columns: ReportColumn[] = chosen.map((c) => ({
      key: c.key,
      label: c.label,
      format: c.format,
      total: c.aggregate === 'sum' ? 'sum' : null,
    }))
    const rows = raw.map((r) => {
      const out: Record<string, string | number | null> = {}
      for (const c of chosen) out[c.key] = readCell(r, c)
      return out
    })
    return { columns, rows: sortRows(rows, definition), truncated }
  }

  const groupColumn = subject.columns.find((c) => c.key === definition.groupBy)!
  const sums = chosen.filter((c) => c.aggregate === 'sum')

  const buckets = new Map<string, Record<string, string | number | null>>()
  for (const r of raw) {
    const label = readCell(r, groupColumn)
    const key = label === null ? ' none' : String(label)

    let bucket = buckets.get(key)
    if (!bucket) {
      bucket = { [groupColumn.key]: label ?? '—', row_count: 0 }
      for (const c of sums) bucket[c.key] = 0
      buckets.set(key, bucket)
    }
    bucket.row_count = (bucket.row_count as number) + 1
    for (const c of sums) {
      const v = readCell(r, c)
      if (typeof v === 'number') bucket[c.key] = (bucket[c.key] as number) + v
    }
  }

  const columns: ReportColumn[] = [
    { key: groupColumn.key, label: groupColumn.label, format: groupColumn.format },
    { key: 'row_count', label: 'Rows', format: 'number', total: 'sum' },
    ...sums.map<ReportColumn>((c) => ({
      key: c.key,
      label: c.label,
      format: c.format,
      total: 'sum',
    })),
  ]

  return { columns, rows: sortRows(Array.from(buckets.values()), definition), truncated }
}

/**
 * Compile a definition and run it on the caller's client.
 *
 * The page and the CSV export both come through here, so an exported file can
 * never be built from a slightly different query than the one on screen.
 */
export async function runCustomQuery(
  supabase: unknown,
  subject: Subject,
  definition: CustomDefinition,
  scope: {
    from: string
    to: string
    timeZone: string
    locationId: number | null
    providerId: string | null
  }
): Promise<CompiledResult & { error: string | null }> {
  const bounds = dateBounds(subject, scope.from, scope.to, scope.timeZone)

  let query = reportsDb(supabase)
    .from(subject.table)
    .select(buildSelect(subject, definition))
    .gte(subject.dateColumn, bounds.gte)
    // One over the cap, so "there is more" is a fact rather than a guess about
    // whether the count happened to land exactly on the limit.
    .limit(ROW_CAP + 1)

  query = bounds.lt
    ? query.lt(subject.dateColumn, bounds.lt)
    : query.lte(subject.dateColumn, bounds.lte)

  if (subject.hasLocation && scope.locationId !== null) {
    query = query.eq('location_id', scope.locationId)
  }
  if (subject.providerColumn && scope.providerId) {
    query = query.eq(subject.providerColumn, scope.providerId)
  }
  for (const f of subject.filters) {
    const value = definition.filters[f.key]
    // `f.column` is a literal from SUBJECTS and `value` was checked against
    // f.options — neither is user text by the time it reaches PostgREST.
    if (value) query = query.eq(f.column, value)
  }

  // Newest first, so a truncated result is a coherent recent window rather than
  // an arbitrary slice of the period.
  query = query.order(subject.dateColumn, { ascending: false })

  const { data, error } = await query
  const fetched = (data ?? []) as Raw[]
  const truncated = fetched.length > ROW_CAP
  const compiled = compileRows(subject, definition, fetched.slice(0, ROW_CAP), truncated)

  return { ...compiled, error: error ? String(error.message ?? error) : null }
}

function sortRows(
  rows: Record<string, string | number | null>[],
  definition: CustomDefinition
): Record<string, string | number | null>[] {
  if (!definition.sort) return rows
  const key = definition.sort
  const dir = definition.sortDir === 'asc' ? 1 : -1

  return [...rows].sort((a, b) => {
    const x = a[key]
    const y = b[key]
    // Empty cells sink to the bottom whichever way the sort runs — a blank is
    // not "smallest", it is absent, and burying it is what a reader expects.
    if (x == null && y == null) return 0
    if (x == null) return 1
    if (y == null) return -1
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * dir
    return String(x).localeCompare(String(y)) * dir
  })
}
