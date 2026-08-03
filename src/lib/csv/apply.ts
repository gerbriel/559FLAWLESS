import 'server-only'

/**
 * Working out what an import would do, and then doing it.
 *
 * Two entry points, and the relationship between them is the safety property of
 * the whole feature:
 *
 *   planImport()   reads. It never writes anything, ever.
 *   commitImport() writes, after calling the same matching code planImport did.
 *
 * She sees a plan before anything happens because the plan is produced by
 * running the real thing with the writes left out — not by a separate estimate
 * that might be optimistic. `prepare()` has already run on both sides, so both
 * agree about which rows are valid; this file adds the only question `prepare`
 * cannot answer on its own, which is whether the row already exists.
 *
 * `server-only` at the top is not decoration. `commitImport` takes a
 * service-role client for one of the three entities, and a file that can reach
 * the browser is a file that must never be handed one.
 *
 * WHICH CLIENT DOES THE WRITING, and why it differs by entity:
 *
 *  - services and products go through the ordinary server client, so every
 *    write is subject to row-level security as the signed-in person. Migration
 *    022 opened services to is_manager(); 021 opened product creation to
 *    is_manager() and product updates to is_staff(). Nothing here can exceed
 *    what she could do on the Services or Inventory screen, and nothing here
 *    needs to.
 *
 *  - clients cannot. `profiles.id` is foreign-keyed to `auth.users`, and the
 *    only INSERT policy on `profiles` is `id = auth.uid()` — "your own". There
 *    is no policy under which one person inserts a profile for another, so
 *    there is no RLS path to creating a client at all; /api/admin/clients/create
 *    already uses the service role for exactly this reason. The route
 *    authenticates and authorises before this is called, at admin, because
 *    admin is what the database asks for to change somebody else's profile.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { CsvEntity, CsvValue } from '@/lib/csv/schema'
import type { PreparedRow, RowProblem } from '@/lib/csv/prepare'
import { phoneDigits, slugify } from '@/lib/csv/values'

type Client = SupabaseClient<Database>

/** PostgREST caps a response; page rather than take the first page and guess. */
const PAGE = 1000
/** `.in()` lists travel in the URL, so they are chunked well short of any limit. */
const IN_CHUNK = 200
/** New rows go up in batches; a batch that fails is retried one row at a time. */
const INSERT_CHUNK = 50
/** Updates are one request each, so they run a few at a time rather than 500 at once. */
const UPDATE_CONCURRENCY = 6

export type RowAction = 'create' | 'update'

export type RowPlan = {
  line: number
  action: RowAction
  /** How the row identifies itself on screen. */
  label: string
  /** 'email', 'phone', 'slug', 'sku' — or null on a create. */
  matchedBy: string | null
  targetId: string | number | null
  /**
   * Who is about to be written over, named from the RECORD rather than from the
   * file. On an update these are two different people until proven otherwise,
   * and showing only the file's version of the name is how a preview can say
   * "Maria Vega" while it is about to overwrite Ana Diaz.
   */
  existing?: string | null
  values: Record<string, CsvValue>
}

export type ImportPlan = {
  create: number
  update: number
  planned: RowPlan[]
  /** Everything that stops a row, from prepare() and from matching. */
  problems: RowProblem[]
  /** Things worth saying that are not faults. */
  notes: string[]
}

export type CommitFailure = { line: number; label: string; message: string }

export type CommitOutcome = {
  created: number
  updated: number
  failed: number
  failures: CommitFailure[]
}

/* ── Small helpers ────────────────────────────────────────── */

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/** Run over a list a few at a time, in order, collecting every result. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      results[index] = await run(items[index])
    }
  })
  await Promise.all(workers)
  return results
}

const text = (value: CsvValue | undefined): string | null =>
  typeof value === 'string' && value !== '' ? value : null

/**
 * A database error as a sentence she can act on.
 *
 * The raw text is kept on the end because when the friendly version is wrong,
 * the raw version is the only thing that helps.
 */
function readable(message: string): string {
  if (/duplicate key/i.test(message) && /slug/i.test(message)) {
    return 'something else already uses that web address'
  }
  if (/duplicate key/i.test(message) && /sku/i.test(message)) {
    return 'something else already uses that SKU'
  }
  if (/products_external_has_no_stock/i.test(message)) {
    return 'a product with an external link cannot hold stock, and this one has some on the shelf'
  }
  if (/services_guard_gates|Only an admin can/i.test(message)) {
    return message.replace(/^.*?(Only an admin[^"]*)$/i, '$1')
  }
  if (/violates row-level security/i.test(message)) {
    return 'the database refused this write for your role'
  }
  if (/check constraint/i.test(message)) {
    return `the database rejected the values on this row (${message})`
  }
  return message
}

/* ── Reading what already exists ──────────────────────────── */

/**
 * One client an email address or a phone number points at — and how many it
 * points at in total.
 *
 * The count is the whole reason this is a record and not a bare id. Neither
 * `profiles.email` nor `profiles.phone` is unique, and a shared number is
 * ordinary: a mother and daughter on one mobile, a couple on one landline, two
 * profiles made for the same person years apart. `appointment_match_client`
 * takes `limit 1` and lives with the ambiguity because the worst it can do is
 * file one appointment under the wrong name, which somebody notices. An
 * importer taking `limit 1` would overwrite a name, an email and a date of
 * birth on a record nobody was looking at, and there is no undo.
 */
type ClientMatch = { id: string; name: string; count: number }

type ClientIndex = {
  byEmail: Map<string, ClientMatch>
  byPhone: Map<string, ClientMatch>
}

/**
 * Every client, by email and by digits-only phone.
 *
 * Read in full rather than queried per row. `appointment_match_client` compares
 * `lower(email)` and `regexp_replace(phone, '\D', '', 'g')`, neither of which
 * PostgREST can express on the left-hand side of a filter, so the choice is a
 * few thousand short rows over the wire once, or an `or=(...)` URL with five
 * hundred `ilike`s in it. The first is cheaper and, more importantly, it lets
 * the comparison be written here in the same shape the trigger uses instead of
 * approximated in a query string.
 *
 * The name comes back with the id so the preview can say whose record is about
 * to change. It is read from the database, never from the file.
 */
async function indexClients(client: Client): Promise<ClientIndex> {
  const byEmail = new Map<string, ClientMatch>()
  const byPhone = new Map<string, ClientMatch>()

  const record = (index: Map<string, ClientMatch>, key: string, id: string, name: string) => {
    const seen = index.get(key)
    // Keep the first as the candidate but count the rest: a key with more than
    // one holder is refused below rather than resolved by luck of the ordering.
    if (seen) seen.count++
    else index.set(key, { id, name, count: 1 })
  }

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client
      .from('profiles')
      .select('id, email, phone, first_name, last_name')
      .eq('role', 'client')
      .order('id')
      .range(offset, offset + PAGE - 1)

    if (error) throw new Error(error.message)
    const rows = data ?? []
    for (const row of rows) {
      const name =
        `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim() ||
        row.email ||
        'a client with no name on record'
      if (row.email) record(byEmail, row.email.toLowerCase(), row.id, name)
      const digits = phoneDigits(row.phone ?? '')
      // The trigger refuses to match on fewer than ten digits, and so does this.
      if (digits.length >= 10) record(byPhone, digits, row.id, name)
    }
    if (rows.length < PAGE) break
  }

  return { byEmail, byPhone }
}

async function indexByColumn(
  client: Client,
  table: 'services' | 'products',
  column: 'slug' | 'sku',
  keys: readonly string[]
): Promise<Map<string, number>> {
  const index = new Map<string, number>()
  if (keys.length === 0) return index

  for (const group of chunk([...new Set(keys)], IN_CHUNK)) {
    // Two single literals, one per table. Concatenating a select widens it to
    // `string` and collapses the result type to SelectQueryError.
    const query =
      table === 'services'
        ? client.from('services').select('id, slug').in('slug', group)
        : client.from('products').select('id, sku').in('sku', group)

    const { data, error } = await query
    if (error) throw new Error(error.message)
    for (const row of data ?? []) {
      const key = table === 'services' ? (row as { slug: string }).slug : (row as { sku: string }).sku
      index.set(key, (row as { id: number }).id)
    }
  }
  return index
}

/** Name and slug both point at the id, so "Facials" and "facials" both land. */
type NameIndex = Map<string, number>

function addName(index: NameIndex, id: number, ...names: (string | null)[]) {
  for (const name of names) {
    if (!name) continue
    const key = name.toLowerCase().replace(/[^a-z0-9]+/g, '')
    if (key && !index.has(key)) index.set(key, id)
  }
}

const lookupName = (index: NameIndex, value: string): number | undefined =>
  index.get(value.toLowerCase().replace(/[^a-z0-9]+/g, ''))

async function indexServiceCategories(client: Client): Promise<NameIndex> {
  const { data, error } = await client.from('service_categories').select('id, name, slug')
  if (error) throw new Error(error.message)
  const index: NameIndex = new Map()
  for (const row of data ?? []) addName(index, row.id, row.name, row.slug)
  return index
}

async function indexProductCategories(client: Client): Promise<NameIndex> {
  const { data, error } = await client.from('product_categories').select('id, name, slug')
  if (error) throw new Error(error.message)
  const index: NameIndex = new Map()
  for (const row of data ?? []) addName(index, row.id, row.name, row.slug)
  return index
}

async function indexBrands(client: Client): Promise<NameIndex> {
  const { data, error } = await client.from('brands').select('id, name, slug')
  if (error) throw new Error(error.message)
  const index: NameIndex = new Map()
  for (const row of data ?? []) addName(index, row.id, row.name, row.slug)
  return index
}

/* ── Planning ─────────────────────────────────────────────── */

/**
 * What each valid row would do, and what would stop the rest.
 *
 * Reads only. This is what the preview screen shows, and the commit calls it
 * again rather than being told the answer.
 */
export async function planImport(
  client: Client,
  entity: CsvEntity,
  rows: readonly PreparedRow[]
): Promise<ImportPlan> {
  const planned: RowPlan[] = []
  const problems: RowProblem[] = []
  const notes: string[] = []

  // A key that appears twice in one file. The second row would silently update
  // what the first one created, which looks like it worked and is not what
  // anybody meant.
  const seen = new Map<string, number>()
  const duplicate = (key: string, line: number, what: string): boolean => {
    const first = seen.get(key)
    if (first !== undefined) {
      problems.push({
        line,
        column: null,
        field: null,
        message: `the same ${what} appears on row ${first} of this file`,
      })
      return true
    }
    seen.set(key, line)
    return false
  }

  if (entity.key === 'clients') {
    const index = await indexClients(client)

    for (const row of rows) {
      const email = text(row.values.email)
      const phone = text(row.values.phone)
      const digits = phone ? phoneDigits(phone) : ''
      const name = `${text(row.values.first_name) ?? ''} ${text(row.values.last_name) ?? ''}`.trim()
      const label = name || email || phone || `row ${row.line}`

      if (email && duplicate(`email:${email}`, row.line, 'email address')) continue
      if (!email && digits.length >= 10 && duplicate(`phone:${digits}`, row.line, 'phone number')) continue

      let matched: ClientMatch | undefined
      let matchedBy: string | null = null

      // AMBIGUITY IS REFUSED, NOT RESOLVED. A key held by more than one client
      // cannot say which of them this row is, and picking the first would mean
      // silently rewriting a stranger's name and date of birth. The row is
      // rejected and named, which is a minute's work; the alternative is a
      // record nobody can restore.
      if (email) {
        const hit = index.byEmail.get(email)
        if (hit && hit.count > 1) {
          problems.push({
            line: row.line,
            column: null,
            field: 'email',
            message: `${hit.count} client records here already share that email address, so there is no saying which one this row means — merge them first`,
          })
          continue
        }
        if (hit) {
          matched = hit
          matchedBy = 'email'
        }
      }
      if (!matched && digits.length >= 10) {
        const hit = index.byPhone.get(digits)
        if (hit && hit.count > 1) {
          problems.push({
            line: row.line,
            column: null,
            field: 'phone',
            // Reached whether or not the row carries an email: an email that
            // matched nobody still leaves the phone as the only candidate, and
            // a shared phone is no candidate at all. Refusing costs one row
            // filed by hand; matching costs a record nobody can restore.
            message: `${hit.count} client records here already share that phone number, so matching on it would overwrite one of them at random — merge those records first, or add this person on the Clients screen`,
          })
          continue
        }
        if (hit) {
          matched = hit
          matchedBy = 'phone'
        }
      }

      if (matched) {
        // Two rows can arrive at one record by different roads — one on an
        // email, the next on the phone number beside it — and the checks above
        // cannot see that, because they compare what is in the FILE. This
        // compares what was matched, which is the only thing that decides what
        // gets written over. Without it both rows are planned, both are sent,
        // and whichever finishes last is the one that survives.
        if (duplicate(`client:${matched.id}`, row.line, 'client record')) continue
        planned.push({
          line: row.line,
          action: 'update',
          label,
          matchedBy,
          targetId: matched.id,
          existing: matched.name,
          values: row.values,
        })
        continue
      }

      // A new client is a new account, and an account is an email address.
      if (!email) {
        problems.push({
          line: row.line,
          column: null,
          field: 'email',
          message: 'nobody here matches this phone number, and a new client needs an email address',
        })
        continue
      }

      planned.push({ line: row.line, action: 'create', label, matchedBy: null, targetId: null, values: row.values })
    }

    notes.push(
      'New clients are created without a password, exactly as a walk-in is. They claim the account with a sign-in link.'
    )
  }

  if (entity.key === 'services') {
    const categories = await indexServiceCategories(client)
    const slugs = rows.map((row) => text(row.values.slug) ?? slugify(String(row.values.name ?? '')))
    const existing = await indexByColumn(client, 'services', 'slug', slugs)

    rows.forEach((row, at) => {
      const slug = slugs[at]
      const label = text(row.values.name) ?? slug
      if (!slug) {
        problems.push({ line: row.line, column: null, field: 'slug', message: 'no name to build a web address from' })
        return
      }
      if (duplicate(`slug:${slug}`, row.line, 'web address')) return

      const categoryName = text(row.values.category)
      const categoryId = categoryName ? lookupName(categories, categoryName) : undefined
      const id = existing.get(slug)

      // The column is required for a new service; on an update, leaving it out
      // means "leave the category alone", which is the file-wide blank rule.
      if (categoryName && categoryId === undefined) {
        problems.push({
          line: row.line,
          column: null,
          field: 'category',
          message: `there is no service category called “${categoryName}” — create it first, on the Services screen`,
        })
        return
      }
      if (!id && categoryId === undefined) {
        problems.push({
          line: row.line,
          column: null,
          field: 'category',
          message: 'a new service needs a category that already exists',
        })
        return
      }

      // `services.price_cents` and `services.duration_minutes` are NOT NULL
      // with no default (002). On an UPDATE, leaving a column out means "leave
      // it alone" and the existing value stands. On a CREATE there is no
      // existing value, so the insert is refused by the database — on every row,
      // with the raw constraint text, after a preview that promised the lot
      // would land. Refusing here instead is the same answer, one screen
      // earlier and in a sentence.
      if (!id) {
        const missing: string[] = []
        if (row.values.price_cents === undefined) missing.push('a price')
        if (row.values.duration_minutes === undefined) missing.push('a duration')
        if (missing.length > 0) {
          problems.push({
            line: row.line,
            column: null,
            field: row.values.price_cents === undefined ? 'price_cents' : 'duration_minutes',
            message: `a new service needs ${missing.join(' and ')} — the database keeps no default for ${missing.length === 1 ? 'it' : 'them'}, so map ${missing.length === 1 ? 'that column' : 'those columns'} or add the service on the Services screen`,
          })
          return
        }
      }

      planned.push({
        line: row.line,
        action: id ? 'update' : 'create',
        label,
        matchedBy: id ? 'slug' : null,
        targetId: id ?? null,
        values: { ...row.values, slug, category_id: categoryId ?? null },
      })
    })
  }

  if (entity.key === 'products') {
    const categories = await indexProductCategories(client)
    const brands = await indexBrands(client)
    const skus = rows.map((row) => text(row.values.sku) ?? '')
    const existing = await indexByColumn(client, 'products', 'sku', skus)

    rows.forEach((row, at) => {
      const sku = skus[at]
      const label = text(row.values.name) ?? sku
      if (duplicate(`sku:${sku}`, row.line, 'SKU')) return

      const categoryName = text(row.values.category)
      const brandName = text(row.values.brand)
      const categoryId = categoryName ? lookupName(categories, categoryName) : undefined
      const brandId = brandName ? lookupName(brands, brandName) : undefined

      if (categoryName && categoryId === undefined) {
        problems.push({
          line: row.line,
          column: null,
          field: 'category',
          message: `there is no product category called “${categoryName}” — create it first, on the Inventory screen`,
        })
        return
      }
      if (brandName && brandId === undefined) {
        problems.push({
          line: row.line,
          column: null,
          field: 'brand',
          message: `there is no brand called “${brandName}” — create it first, on the Inventory screen`,
        })
        return
      }

      const id = existing.get(sku)
      // A slug is derived only when creating. On an update the product already
      // has one, it is in a URL somewhere, and re-deriving it from a name that
      // changed would quietly break that link — the match was on SKU, so
      // nothing here asked for the address to move. Mapping the Web Address
      // column is how she moves it deliberately.
      const slug = text(row.values.slug) ?? (id ? undefined : slugify(text(row.values.name) ?? sku))

      planned.push({
        line: row.line,
        action: id ? 'update' : 'create',
        label,
        matchedBy: id ? 'sku' : null,
        targetId: id ?? null,
        values: {
          ...row.values,
          ...(slug === undefined ? {} : { slug }),
          category_id: categoryId ?? null,
          brand_id: brandId ?? null,
        },
      })
    })
  }

  return {
    create: planned.filter((p) => p.action === 'create').length,
    update: planned.filter((p) => p.action === 'update').length,
    planned,
    problems,
    notes,
  }
}

/* ── Writing ──────────────────────────────────────────────── */

/**
 * Only what she mapped and filled in, renamed to the database's columns.
 *
 * Fields she did not map are simply absent, which on an update is what makes a
 * blank cell mean "leave it alone" — see the long note in prepare.ts.
 */
type Payload = Record<string, CsvValue>
type ProfileUpdate = Database['public']['Tables']['profiles']['Update']
type ServiceInsert = Database['public']['Tables']['services']['Insert']
type ServiceUpdate = Database['public']['Tables']['services']['Update']
type ProductInsert = Database['public']['Tables']['products']['Insert']
type ProductUpdate = Database['public']['Tables']['products']['Update']

function payloadFor(entity: CsvEntity, values: Record<string, CsvValue>): Payload {
  const out: Payload = {}
  const carry = (key: string) => {
    if (values[key] !== undefined) out[key] = values[key]
  }

  if (entity.key === 'clients') {
    for (const key of ['first_name', 'last_name', 'email', 'phone', 'date_of_birth', 'pronouns', 'marketing_opt_in', 'sms_opt_in']) {
      carry(key)
    }
    return out
  }

  if (entity.key === 'services') {
    for (const key of [
      'name', 'slug', 'description', 'details', 'aftercare', 'price_cents', 'price_is_starting',
      'duration_minutes', 'buffer_minutes', 'requires_intake', 'is_active', 'is_featured', 'sort_order',
    ]) {
      carry(key)
    }
    if (values.category_id != null) out.category_id = values.category_id
    return out
  }

  for (const key of [
    'sku', 'name', 'slug', 'barcode', 'description', 'ingredients', 'how_to_use', 'price_cents',
    'cost_cents', 'taxable', 'is_retail', 'is_professional', 'unit', 'low_stock_threshold',
    'reorder_qty', 'external_url', 'is_active', 'is_featured', 'sort_order',
  ]) {
    carry(key)
  }
  if (values.category_id != null) out.category_id = values.category_id
  if (values.brand_id != null) out.brand_id = values.brand_id
  return out
}

/**
 * Do it.
 *
 * PARTIAL FAILURE, decided here and stated on the screen before she presses the
 * button, in these words: a row that fails validation is never written, and a
 * row that fails at the database leaves everything already written in place.
 *
 * There is no all-or-nothing option and it would be dishonest to offer one.
 * Creating a client is three calls — an auth user, a profile, a client record —
 * across two systems, and no transaction spans them. Rather than pretend to a
 * rollback that cannot exist, the import validates everything up front so that
 * almost nothing reaches this stage broken, then reports precisely which rows
 * did not land so they can be fixed and re-run. Re-running is safe: the second
 * pass matches what the first pass created and updates it instead.
 *
 * New rows go up in batches of fifty. When a batch is refused, it is retried a
 * row at a time so the failure is attributed to the row that caused it rather
 * than to the forty-nine beside it.
 */
export async function commitImport(
  client: Client,
  admin: Client | null,
  entity: CsvEntity,
  plan: ImportPlan,
  actorId: string
): Promise<CommitOutcome> {
  const failures: CommitFailure[] = []
  let created = 0
  let updated = 0

  const creates = plan.planned.filter((p) => p.action === 'create')
  const updates = plan.planned.filter((p) => p.action === 'update')

  if (entity.key === 'clients') {
    if (!admin) throw new Error('the client importer needs the service-role client')

    // One at a time is not a performance oversight: each create is an auth user
    // followed by a profile write, and the auth API is rate-limited.
    await mapLimit(creates, 3, async (row) => {
      const payload = payloadFor(entity, row.values)
      const email = String(payload.email ?? '')
      const { data, error } = await admin.auth.admin.createUser({
        email,
        // Confirmed on creation, as in /api/admin/clients/create: the studio has
        // this person's details already, and an unconfirmed account cannot
        // receive the sign-in link they will use to claim it.
        email_confirm: true,
        user_metadata: {
          first_name: payload.first_name ?? null,
          last_name: payload.last_name ?? null,
          phone: payload.phone ?? null,
        },
      })

      if (error || !data.user) {
        failures.push({ line: row.line, label: row.label, message: readable(error?.message ?? 'the account could not be created') })
        return
      }

      const id = data.user.id
      // handle_new_user has already made the profile from the metadata; this
      // fills in the rest and records who brought them in.
      //
      // The cast is the seam between a payload assembled at runtime and a
      // column list known at compile time. `payloadFor` builds it from a literal
      // allow-list of column names, one per entity, so the keys are exactly the
      // columns — but TypeScript cannot see that through the Record, and
      // widening the Record to keep it happy would lose the allow-list, which is
      // the part doing the actual work.
      const { error: profileError } = await admin
        .from('profiles')
        .update({
          ...payload,
          role: 'client',
          created_by_staff_id: actorId,
        } as ProfileUpdate)
        .eq('id', id)

      if (profileError) {
        // Roll back the account rather than leave one with no profile behind it.
        await admin.auth.admin.deleteUser(id)
        failures.push({ line: row.line, label: row.label, message: readable(profileError.message) })
        return
      }

      await admin.from('client_records').upsert({ client_id: id }, { onConflict: 'client_id' })
      created++
    })

    await mapLimit(updates, UPDATE_CONCURRENCY, async (row) => {
      const { error } = await admin
        .from('profiles')
        .update(payloadFor(entity, row.values) as ProfileUpdate)
        .eq('id', String(row.targetId))
      if (error) failures.push({ line: row.line, label: row.label, message: readable(error.message) })
      else updated++
    })

    return { created, updated, failed: failures.length, failures }
  }

  // Services and products are handled by the same shape of code but not by the
  // same call: `from('services' | 'products')` gives supabase-js a union it
  // cannot resolve to one row type, so the two tables are named explicitly and
  // the branch is one line rather than a cast over everything downstream.
  const isService = entity.key === 'services'

  const insertMany = (payloads: Payload[]) =>
    isService
      ? client.from('services').insert(payloads as ServiceInsert[])
      : client.from('products').insert(payloads as ProductInsert[])

  const updateOne = (payload: Payload, id: number) =>
    isService
      ? client.from('services').update(payload as ServiceUpdate).eq('id', id)
      : client.from('products').update(payload as ProductUpdate).eq('id', id)

  for (const batch of chunk(creates, INSERT_CHUNK)) {
    const { error } = await insertMany(batch.map((row) => payloadFor(entity, row.values)))

    if (!error) {
      created += batch.length
      continue
    }

    // Isolate: forty-nine good rows should not be punished for the fiftieth.
    for (const row of batch) {
      const { error: rowError } = await insertMany([payloadFor(entity, row.values)])
      if (rowError) failures.push({ line: row.line, label: row.label, message: readable(rowError.message) })
      else created++
    }
  }

  await mapLimit(updates, UPDATE_CONCURRENCY, async (row) => {
    const { error } = await updateOne(payloadFor(entity, row.values), Number(row.targetId))
    if (error) failures.push({ line: row.line, label: row.label, message: readable(error.message) })
    else updated++
  })

  return { created, updated, failed: failures.length, failures }
}
