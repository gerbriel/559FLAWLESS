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
 *
 *  - CONTACTS go back through the ordinary server client. A client with no
 *    email address is not an account and cannot be one (see `RowTarget` below
 *    and the header of migration 051); they are a row in `client_stubs`, which
 *    051 gave a real front-desk write policy. So there is an RLS path, the
 *    caller has more than enough role for it, and the service role is not used:
 *    it is for the cases where there is no alternative, and this is not one.
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

/**
 * WHERE a planned row lands.
 *
 * Nearly everything goes to the entity's own table — a service, a product, a
 * client's profile — and says 'record'. One case cannot, and it is the reason
 * this type exists. `profiles.id` is foreign-keyed to `auth.users`, so a profile
 * IS an account, and there is no such thing here as a client without a login.
 * A row with no email address therefore becomes a 'contact': a `client_stubs`
 * row, somebody the studio knows and has not signed up yet, which is what
 * migration 051 added the table for.
 *
 * The two are counted apart the whole way through, because "forty new clients"
 * and "forty new clients, twelve of whom you still have to invite" are
 * different sentences and only the second one is true.
 */
export type RowTarget = 'record' | 'contact'

export type RowPlan = {
  line: number
  action: RowAction
  target: RowTarget
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
  /** New records: a client with an account, a service, a product. */
  create: number
  /** Records already here that this file would write over. */
  update: number
  /**
   * The same two numbers for the contact list — people with no email address,
   * added to `client_stubs` instead of being given an account. Disjoint from
   * the pair above, so those four and the rejections account for every row.
   */
  createContact: number
  updateContact: number
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
  /** Contacts, counted apart from accounts for the reason in `RowTarget`. */
  contactsCreated: number
  contactsUpdated: number
  /**
   * The reference stamped on every contact this run added, so 051's
   * `import_batch` can answer "which ones came from that file" later. Null when
   * the run added no contacts, because then there is no batch to name.
   */
  importBatch: string | null
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

/** One contact an email address or a phone number points at. */
type StubMatch = { id: number; name: string }

type StubIndex = {
  byEmail: Map<string, StubMatch>
  byPhone: Map<string, StubMatch>
}

/**
 * The people the studio has and has not signed up yet, by email and by phone.
 *
 * UNCLAIMED ONLY. A claimed stub is history — the person has an account now and
 * `indexClients` already has them — so matching a row to one would offer to
 * update a row nobody reads instead of the profile it turned into.
 *
 * There is no `count` here beside the id, unlike `ClientMatch`, and that is a
 * property of the table rather than an oversight. `profiles.email` is not
 * unique and a shared phone number is ordinary, so a client key can point at
 * two people and the importer refuses to guess which. A contact cannot:
 * `client_stubs_unclaimed_email_idx` makes an unclaimed email unique, and 051's
 * dedupe trigger refuses a second unclaimed contact with the same ten digits.
 * There is never more than one to choose between, so there is nothing to refuse.
 */
async function indexStubs(client: Client): Promise<StubIndex> {
  const byEmail = new Map<string, StubMatch>()
  const byPhone = new Map<string, StubMatch>()

  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await client
      .from('client_stubs')
      .select('id, first_name, last_name, email, phone')
      .is('claimed_by', null)
      .order('id')
      .range(offset, offset + PAGE - 1)

    if (error) throw new Error(error.message)
    const rows = data ?? []
    for (const row of rows) {
      const match: StubMatch = {
        id: row.id,
        name:
          `${row.first_name} ${row.last_name ?? ''}`.trim() ||
          row.email ||
          'a contact with no name on record',
      }
      const email = (row.email ?? '').trim().toLowerCase()
      if (email) byEmail.set(email, match)
      const digits = phoneDigits(row.phone ?? '')
      // Ten digits, as everywhere else in this file and as 051's trigger.
      if (digits.length >= 10) byPhone.set(digits, match)
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
    // Two lists, read once each: the people with accounts, and the people the
    // studio is still meaning to invite. Every row is measured against both, in
    // that order, because an account is the better answer whenever there is one.
    const [index, stubs] = await Promise.all([indexClients(client), indexStubs(client)])

    /** Rows that will become a contact with nothing to match them on. */
    let unmatchable = 0
    /** Rows carrying a note that will land on an account, where it has nowhere to go. */
    let notesDropped = 0

    // The columns a contact has no home for, collected as they are actually
    // seen. `client_stubs` holds a name, contact details and a note and stops
    // there, deliberately (051), so a file that carries dates of birth loses
    // them on the rows that become contacts. That is the correct outcome and it
    // still has to be said out loud, because a column that is read on some rows
    // and ignored on others is exactly the kind of thing an importer must not be
    // quiet about.
    const contactColumnsDropped = new Set<string>()
    const notForAContact = ['date_of_birth', 'pronouns', 'marketing_opt_in', 'sms_opt_in']
    const noteWhatAContactLoses = (values: Record<string, CsvValue>) => {
      for (const key of notForAContact) {
        if (values[key] === undefined) continue
        contactColumnsDropped.add(entity.fields.find((f) => f.key === key)?.label ?? key)
      }
    }

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
        if (row.values.note !== undefined) notesDropped++
        planned.push({
          line: row.line,
          action: 'update',
          target: 'record',
          label,
          matchedBy,
          targetId: matched.id,
          existing: matched.name,
          values: row.values,
        })
        continue
      }

      // NOBODY WITH AN ACCOUNT IS THIS PERSON. Before making one, look at the
      // list of people the studio already meant to invite. A row that matches a
      // contact updates that contact: 051's dedupe trigger would refuse a
      // second one anyway, and a refusal the importer could have avoided is a
      // bad error message. It is also how a corrected file behaves the way
      // anyone would expect — fill in the phone numbers you were missing, run it
      // again, and the contacts you made last time gain them rather than
      // arriving twice.
      //
      // Email first and then phone, the same order and the same two keys used
      // above, because a second answer to "is this the same person" is how a
      // client list grows two of everybody.
      let stub = email ? stubs.byEmail.get(email) : undefined
      let stubBy: string | null = stub ? 'email' : null
      if (!stub && digits.length >= 10) {
        stub = stubs.byPhone.get(digits)
        stubBy = stub ? 'phone' : null
      }

      if (stub) {
        if (duplicate(`contact:${stub.id}`, row.line, 'contact')) continue
        noteWhatAContactLoses(row.values)
        planned.push({
          line: row.line,
          action: 'update',
          target: 'contact',
          label,
          matchedBy: stubBy,
          targetId: stub.id,
          existing: stub.name,
          values: row.values,
        })
        continue
      }

      // A ROW THE STUDIO HAS NEVER SEEN IS A CONTACT. ALWAYS.
      //
      // This used to fork: a row carrying all four of first name, last name,
      // email and phone became an account, anything less became a contact. The
      // reasoning was that the four fields are the bar an account meets
      // everywhere else, which is true and is not the point. The effect was
      // that one spreadsheet landed in two places — some rows in Clients, some
      // in Not signed up yet — split on how complete the old system's records
      // happened to be, which is a fact about the file and not about the
      // people. The studio asked for one destination, and it is right: an
      // import is a list of people to get into the system, and where a person
      // ends up should not depend on whether whoever typed their row eight
      // years ago bothered with a surname.
      //
      // So the fork is gone. Every unrecognised row becomes a contact, and the
      // invitation is what promotes one — which was always the only path that
      // produced a real account anyway. An imported profile could never log in:
      // `profiles.id` is foreign-keyed to `auth.users` and an import cannot
      // mint an auth user, so an "account" created here was a record with
      // nobody behind it, waiting for the same invitation the contact is
      // waiting for. One row, one destination, one way out of it.
      //
      // MERGING IS UNAFFECTED, and is the reason this is safe: the two matching
      // passes above run first. A row that matches an existing profile updates
      // that profile, and a row matching an unclaimed contact updates the
      // contact. A person who has already claimed their account is found by the
      // first pass — `indexStubs` is unclaimed-only, precisely so a claimed
      // stub cannot shadow the profile it turned into. Only rows that match
      // nothing reach here. This used to
      // say "a new client needs an email address", which was true of the schema
      // and useless to the studio: the person was standing in front of them and
      // there was nowhere to put them. 051 made somewhere. What is deliberately
      // NOT done here is minting an auth user at someone+1739@studio.invalid to
      // get a profile out of it — that puts a lie in `profiles.email`, which is
      // the column 004 matches a guest booking on, so the person's next real
      // booking would create exactly the duplicate this is meant to prevent.
      //
      // A contact with an email is not a failure of this branch, it is the
      // ordinary case: it is the one the studio can invite today, and the
      // invitation is what turns a partial record into a complete account
      // without anybody guessing at a surname.
      if (digits.length < 10) unmatchable++
      noteWhatAContactLoses(row.values)
      planned.push({
        line: row.line,
        action: 'create',
        target: 'contact',
        label,
        matchedBy: null,
        targetId: null,
        values: row.values,
      })
    }

    notes.push(
      'New clients are created without a password, exactly as a walk-in is. They claim the account with a sign-in link.'
    )

    const contacts = planned.filter((p) => p.target === 'contact').length
    if (contacts > 0) {
      notes.push(
        contacts === 1
          ? 'One of these people has no email address, so they go on the contact list rather than getting an account. They are a client the studio knows; what they do not have is a login, and they get one by being invited and accepting it — not by being given a made-up address here.'
          : `${contacts} of these people have no email address, so they go on the contact list rather than getting accounts. They are clients the studio knows; what they do not have is a login, and they get one by being invited and accepting it — not by being given made-up addresses here.`
      )
    }
    if (unmatchable > 0) {
      notes.push(
        unmatchable === 1
          ? 'One of those has neither an email address nor a phone number. There is nothing to recognise that person by, so importing this file a second time would add them again rather than finding them.'
          : `${unmatchable} of those have neither an email address nor a phone number. There is nothing to recognise them by, so importing this file a second time would add them again rather than finding them.`
      )
    }
    if (notesDropped > 0) {
      notes.push(
        `The Note column is not stored on ${notesDropped === 1 ? 'one of these rows, because it belongs' : `${notesDropped} of these rows, because they belong`} to somebody who already has an account. A client with an account has a record of their own, and what goes on it is clinical and does not arrive by spreadsheet. Notes on everyone else are kept.`
      )
    }
    if (contactColumnsDropped.size > 0) {
      notes.push(
        `${[...contactColumnsDropped].join(', ')} ${contactColumnsDropped.size === 1 ? 'is' : 'are'} not kept for the people who become contacts. A contact is a name, a way of reaching somebody and a note, and nothing else — a date of birth and a marketing consent belong to a person who has agreed to the studio holding them, and these people have not been asked yet. They are asked when they claim their account, and what they answer is theirs.`
      )
    }
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
        target: 'record',
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
        target: 'record',
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

  const count = (action: RowAction, target: RowTarget) =>
    planned.filter((p) => p.action === action && p.target === target).length

  return {
    create: count('create', 'record'),
    update: count('update', 'record'),
    createContact: count('create', 'contact'),
    updateContact: count('update', 'contact'),
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
type ContactInsert = Database['public']['Tables']['client_stubs']['Insert']
type ContactUpdate = Database['public']['Tables']['client_stubs']['Update']

/** Whichever of these columns the row actually has a value for. */
function pick(values: Record<string, CsvValue>, keys: readonly string[]): Payload {
  const out: Payload = {}
  for (const key of keys) {
    if (values[key] !== undefined) out[key] = values[key]
  }
  return out
}

function payloadFor(entity: CsvEntity, values: Record<string, CsvValue>): Payload {
  if (entity.key === 'clients') {
    // `note` is deliberately absent: `profiles` has no column for it, and the
    // one place a note about a client belongs is their record, which is
    // clinical and is not importable in either direction. `contactPayload`
    // below carries it, because a contact has nowhere else for it to go and it
    // is often the only thing the old list said about the person.
    return pick(values, [
      'first_name', 'last_name', 'email', 'phone', 'date_of_birth', 'pronouns',
      'marketing_opt_in', 'sms_opt_in',
    ])
  }

  if (entity.key === 'services') {
    const out = pick(values, [
      'name', 'slug', 'description', 'details', 'aftercare', 'price_cents', 'price_is_starting',
      'duration_minutes', 'buffer_minutes', 'requires_intake', 'is_active', 'is_featured', 'sort_order',
    ])
    if (values.category_id != null) out.category_id = values.category_id
    return out
  }

  const out = pick(values, [
    'sku', 'name', 'slug', 'barcode', 'description', 'ingredients', 'how_to_use', 'price_cents',
    'cost_cents', 'taxable', 'is_retail', 'is_professional', 'unit', 'low_stock_threshold',
    'reorder_qty', 'external_url', 'is_active', 'is_featured', 'sort_order',
  ])
  if (values.category_id != null) out.category_id = values.category_id
  if (values.brand_id != null) out.brand_id = values.brand_id
  return out
}

/**
 * The five columns a contact has, out of the same row a profile would have used.
 *
 * Everything else on a client row — a date of birth, marketing consent, pronouns
 * — is deliberately dropped rather than stored somewhere adjacent. `client_stubs`
 * has no column for any of it, and 051 is explicit about why: a contact is a
 * name, a way of reaching somebody, and an intention to sign them up. The rest
 * belongs to a person who has agreed to the studio holding it, and this person
 * has not been asked yet. They will be, on the form they fill in when they claim
 * the account.
 */
function contactPayload(values: Record<string, CsvValue>): Payload {
  return pick(values, ['first_name', 'last_name', 'email', 'phone', 'note'])
}

/**
 * A refusal from `client_stubs`, in a sentence rather than in SQLSTATE.
 *
 * Switched on the CODE and never on the message, the way the category and
 * inventory screens do it. The message belongs to 051's trigger and a later
 * migration is free to reword it; the code is the contract. 23505 covers all
 * three of the refusals that trigger raises — the email belongs to an account,
 * the phone belongs to an account, the phone is already on the list to invite —
 * and from out here they are one answer: the studio already has this person, so
 * nothing was added a second time. Which of the three it was matters less than
 * where to go and look, so the sentence says that instead.
 */
function contactRefusal(error: { code?: string | null; message: string }): string {
  switch (error.code) {
    case '23505':
      return 'somebody here already has that email address or phone number — they either have an account already or are already on the list to invite, so this row was not added a second time. Look them up on the Clients screen'
    case '23514':
      return 'the database rejected the details on this row — a contact needs a first name, and it has to be under 120 characters'
    case '42501':
      return 'the database refused this write for your role — adding a contact is front desk and above'
    case '23503':
      return 'the account recorded as adding this contact no longer exists'
    default:
      return readable(error.message)
  }
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
 *
 * A CLIENT ROW HAS TWO DESTINATIONS and they are written by two different
 * clients, for two different reasons. An account goes through the service role,
 * because `profiles` has no policy that would let one person insert another's
 * row. A contact goes through the caller's own client, because `client_stubs`
 * has one and there is nothing to go around.
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
  let contactsCreated = 0
  let contactsUpdated = 0
  let importBatch: string | null = null

  const creates = plan.planned.filter((p) => p.action === 'create' && p.target === 'record')
  const updates = plan.planned.filter((p) => p.action === 'update' && p.target === 'record')
  const contactCreates = plan.planned.filter((p) => p.action === 'create' && p.target === 'contact')
  const contactUpdates = plan.planned.filter((p) => p.action === 'update' && p.target === 'contact')

  if (entity.key === 'clients') {
    if (!admin) throw new Error('the client importer needs the service-role client')

    // ── The contacts, and why they go first ──────────────────
    //
    // Not for speed, though they are the cheap half — one insert each against
    // one table, where an account is an auth user and two writes behind it.
    // It is because of a rule only one side of this knows about: 051 refuses a
    // contact whose phone number already belongs to an account, and nothing
    // refuses an account whose phone number belongs to a contact. A file
    // holding the same number twice, once with an email address and once
    // without, therefore has an order that works and an order that fails, and
    // this is the one that works.
    //
    // One batch reference across the whole run, stamped on every contact it
    // adds, so `import_batch` can answer "which ones came out of that file"
    // when somebody asks in three weeks. Generated here rather than passed in
    // because a run is what it names, and a run starts here.
    if (contactCreates.length > 0) importBatch = crypto.randomUUID()

    const insertContacts = (payloads: Payload[]) =>
      client.from('client_stubs').insert(payloads as ContactInsert[])

    const newContact = (row: RowPlan): Payload => ({
      ...contactPayload(row.values),
      // 051 constrains `source` to manual / import / walk_in. This one is an
      // import, and saying so is what lets the studio tell the list it typed
      // from the list it pasted.
      source: 'import',
      import_batch: importBatch,
      created_by: actorId,
    })

    for (const batch of chunk(contactCreates, INSERT_CHUNK)) {
      const { error } = await insertContacts(batch.map(newContact))

      if (!error) {
        contactsCreated += batch.length
        continue
      }

      // The dedupe trigger fires per row, so one refused contact refuses the
      // statement it travelled in. Retried one at a time, the other forty-nine
      // land and the failure is attributed to the row that caused it.
      for (const row of batch) {
        const { error: rowError } = await insertContacts([newContact(row)])
        if (rowError) {
          failures.push({ line: row.line, label: row.label, message: contactRefusal(rowError) })
        } else contactsCreated++
      }
    }

    await mapLimit(contactUpdates, UPDATE_CONCURRENCY, async (row) => {
      // Only what she mapped, and never `source` or `import_batch`: those say
      // where this contact came from originally, and a later file touching them
      // is not a new origin.
      const { error } = await client
        .from('client_stubs')
        .update(contactPayload(row.values) as ContactUpdate)
        .eq('id', Number(row.targetId))
      if (error) failures.push({ line: row.line, label: row.label, message: contactRefusal(error) })
      else contactsUpdated++
    })

    // NOTHING HERE MINTS AN ACCOUNT ANY MORE, and that is the point of the
    // change rather than a side effect of it.
    //
    // This used to call `admin.auth.admin.createUser` for every row carrying a
    // full set of details: a spreadsheet produced real logins, with confirmed
    // addresses, for people who had never asked for one and did not know it had
    // happened. It also made the import a two-destination operation, which is
    // what the studio noticed — some rows in Clients, some in Not signed up yet,
    // split on how complete the old records were.
    //
    // The planner now files every unrecognised row as a contact, so `creates`
    // is empty for clients and the loop that stood here could not run. It is
    // deleted rather than left unreachable: code that mints auth users is the
    // last thing to leave lying around behind a condition that is currently
    // false, and its presence would keep telling the next reader that importing
    // a CSV is a way to create accounts. It is not. An invitation is.
    //
    // `creates` itself stays — services and products still insert through it
    // further down. It is only ever empty on this branch.

    await mapLimit(updates, UPDATE_CONCURRENCY, async (row) => {
      const { error } = await admin
        .from('profiles')
        .update(payloadFor(entity, row.values) as ProfileUpdate)
        .eq('id', String(row.targetId))
      if (error) failures.push({ line: row.line, label: row.label, message: readable(error.message) })
      else updated++
    })

    return {
      created,
      updated,
      contactsCreated,
      contactsUpdated,
      importBatch,
      failed: failures.length,
      failures,
    }
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

  // Nothing but a client can be a contact, so these two are zero here and the
  // shape of the answer stays the same either way.
  return {
    created,
    updated,
    contactsCreated,
    contactsUpdated,
    importBatch,
    failed: failures.length,
    failures,
  }
}
