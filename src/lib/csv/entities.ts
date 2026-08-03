/**
 * The five things the studio can move in and out as a spreadsheet, defined once.
 *
 * Read `schema.ts` first for why this is one list rather than two. What follows
 * is the reasoning behind WHICH columns are here, because on every entity the
 * interesting decision was what to leave out.
 *
 * ── The general rule ────────────────────────────────────────
 *
 * A column is importable only if the database would accept it from the person
 * doing the importing, through the same policies and triggers that guard the
 * screen. Where the database says no, this file says no, in the same words, and
 * shows her the reason. Nothing here is enforced BY this file — the policies
 * and triggers are the enforcement — but a form that offers a column the
 * database will reject is a form that produces a failed import at row 400
 * instead of a clear sentence at row 0.
 *
 * ── What is not here at all ─────────────────────────────────
 *
 * `client_notes`, `intake_submissions`, `consent_signatures`, `patch_tests` and
 * `treatment_photos` are absent from every direction. They are health
 * information (AGENTS.md rule 5), and both directions are wrong:
 *
 *  - Exporting them would put a client's clinical history in a file on a laptop
 *    with no expiry, no audit and no way to recall it. The photos are in a
 *    private bucket reachable only through short-lived signed URLs precisely so
 *    that cannot happen; putting the notes in a CSV would undo that reasoning
 *    one table over. A client who wants their own record has a path to it in
 *    the account area, which is the right shape for that request.
 *  - Importing them would fabricate provenance. `consent_signatures` carries
 *    `body_snapshot`, a verbatim copy of the text the person actually read, and
 *    the whole point of that column is that nothing can retroactively change
 *    what someone agreed to. A CSV row asserting that a consent was signed is
 *    exactly the thing it exists to prevent. A clinical note has an author and
 *    a date, and a spreadsheet has neither.
 *
 * If the old system's notes have to come across, they come across as a
 * deliberate act by a person who is willing to put their name on each one.
 */

import type { CsvEntity } from '@/lib/csv/schema'

/* ── Clients ──────────────────────────────────────────────── */

/**
 * `profiles` where role = 'client'.
 *
 * MATCHING copies `appointment_match_client` (migration 004) exactly, because
 * the studio already has an answer to "is this the same person" and an importer
 * that invented a second one would file the same client twice: email first,
 * case-insensitively; then phone, compared on digits only and only when there
 * are at least ten of them. That last clause matters — without it "555" matches
 * "555" and two strangers become one record.
 *
 * IMPORT NEEDS ADMIN, and that is not the same bar as the rest of the page.
 * A profile row is foreign-keyed to `auth.users`, and `profiles` has exactly one
 * INSERT policy: `id = auth.uid()`. There is no policy under which any staff
 * member inserts a profile for somebody else, so this import cannot run through
 * RLS at all — it goes through the service role, the same way
 * /api/admin/clients/create already does for a walk-in. When a route stands in
 * for RLS it has to be at least as strict as the policy it replaced, and the
 * policy for changing another person's profile is `is_admin()`.
 */
const clients: CsvEntity = {
  key: 'clients',
  label: 'Clients',
  lede: 'Names, contact details and marketing preferences.',
  source: 'profiles (role = client)',
  importing: {
    role: 'admin',
    roleBecause:
      'A profile row belongs to an auth account, and the only INSERT policy on profiles is "your own". This import cannot go through row-level security, so it uses the service role — and a route standing in for a policy has to be as strict as the policy it replaced. Changing another person’s profile is admin-only in the database (001), so it is admin-only here.',
    matchRule:
      'Email address first, ignoring case. If there is no email or no match, the phone number, compared on digits alone and only when there are at least ten of them. This is what the appointment_match_client trigger has always done (migration 004); the import does not invent a second answer to "is this the same person".',
    onNoMatch:
      'A row that matches nobody creates a new client, and a new client needs an email address — that is what the account is. A row with only a phone number and no match is rejected and listed, rather than being filed as a person nobody can contact.',
  },
  fields: [
    {
      key: 'first_name',
      label: 'First Name',
      type: 'text',
      required: true,
      maxLength: 80,
      description: 'Given name.',
      example: 'Maria',
      aliases: ['fname', 'firstname', 'given name', 'first', 'forename'],
    },
    {
      key: 'last_name',
      label: 'Last Name',
      type: 'text',
      required: true,
      maxLength: 80,
      description: 'Family name.',
      example: 'Vega',
      aliases: ['lname', 'lastname', 'surname', 'last', 'family name'],
    },
    {
      key: 'email',
      label: 'Email',
      type: 'email',
      maxLength: 254,
      description:
        'The match key, and the account. Required to create someone new; a client who already exists can be updated by phone instead.',
      example: 'maria.vega@example.com',
      aliases: ['email address', 'e mail', 'mail'],
    },
    {
      key: 'phone',
      label: 'Phone',
      type: 'phone',
      description: 'Mobile or home. Used as the fallback match when there is no email.',
      example: '(559) 555-0134',
      aliases: ['phone number', 'mobile', 'cell', 'telephone', 'tel', 'contact number'],
    },
    {
      key: 'date_of_birth',
      label: 'Date of Birth',
      type: 'date',
      description: 'Used for age gates on services that have one.',
      example: '1990-03-04',
      aliases: ['dob', 'birthday', 'birth date', 'born'],
    },
    {
      key: 'pronouns',
      label: 'Pronouns',
      type: 'text',
      maxLength: 40,
      description: 'How she should be referred to.',
      example: 'she/her',
      aliases: ['preferred pronouns'],
    },
    {
      key: 'marketing_opt_in',
      label: 'Marketing Opt In',
      type: 'boolean',
      description:
        'Whether she agreed to marketing email. Only import a yes you can point at a record of — this is consent, not a preference.',
      example: 'yes',
      aliases: ['marketing', 'email opt in', 'newsletter', 'subscribed', 'accepts marketing'],
    },
    {
      key: 'sms_opt_in',
      label: 'SMS Opt In',
      type: 'boolean',
      description: 'Whether she agreed to text messages. Same caution as above.',
      example: 'no',
      aliases: ['sms', 'text opt in', 'accepts sms', 'texts'],
    },
    {
      key: 'id',
      label: 'Client ID',
      type: 'text',
      readOnly: true,
      readOnlyBecause:
        'The database issues it. An id from another system means nothing here, and a client is found by email or phone.',
      description: 'Our internal identifier for this client.',
      example: '9f1c…',
    },
    {
      key: 'created_at',
      label: 'Created',
      type: 'datetime',
      readOnly: true,
      readOnlyBecause: 'The database sets it when the record is made.',
      description: 'When the client record was created, studio local time.',
      example: 'Mar 4, 2026, 10:15 AM',
    },
  ],
  excluded: [
    {
      column: 'Role and suspension',
      reason:
        'A trigger in 001 rejects any change to profiles.role or profiles.suspended_at from a non-admin, and it exists so that "update your own profile" cannot become "make yourself an admin". Every imported row is a client. Staff are added by invitation, where the role is a decision someone makes deliberately.',
    },
    {
      column: 'Consent timestamps — marketing consent date, terms accepted, privacy accepted, age verified',
      reason:
        'These record that something happened in front of a person, with an IP address kept alongside as evidence. A spreadsheet cannot attest to a consent given somewhere else, and back-dating one would make the evidence trail worthless for the one case it exists for.',
    },
    {
      column: 'Notes, intake answers, consent signatures, patch tests, photographs',
      reason:
        'Health information (rule 5). Nothing here reads it and nothing here writes it, in either direction — see the note at the top of this file.',
    },
    {
      column: 'Password',
      reason:
        'An imported account is created without one, exactly as a walk-in account is. She claims it with a sign-in link, so nobody has to invent a password and read it out.',
    },
  ],
}

/* ── Services ─────────────────────────────────────────────── */

/**
 * `services`.
 *
 * The exclusions here are not a judgement call — they are the column list from
 * `services_guard_gates` (migration 022), which raises an exception if anyone
 * but an admin changes `is_intimate`, `requires_age_verification`, `min_age`,
 * `requires_consultation`, `patch_test_hours`, `deposit_cents` or
 * `cancellation_window_hours`. 022 says why at length: those fields decide
 * whether a minor can book an intimate service and whether a no-show costs
 * anything, and they are meant to be harder to change than a price.
 *
 * An importer that offered them would produce a file that validates cleanly and
 * then fails at the database on the first row, so they are off the list and the
 * page says which lever to pull instead.
 */
const services: CsvEntity = {
  key: 'services',
  label: 'Services',
  lede: 'The treatment menu — names, prices, durations and where they sit.',
  source: 'services',
  importing: {
    role: 'manager',
    roleBecause:
      'Migration 022 opened services to `is_manager()`, so this writes through row-level security as the signed-in person. No service role is involved and nothing here can exceed what she could do on the Services screen.',
    matchRule:
      'The web address (slug). If a row has no slug, one is made from the name the same way the catalogue does, so "Signature Facial" finds signature-facial. Slug is unique on the table, which is what makes it a safe key. It follows that changing a service’s web address in the file reads as a different service and creates one — rename the address on the service itself, where the old link can be considered.',
    onNoMatch: 'A row that matches nothing creates a new service, switched on unless the file says otherwise.',
  },
  fields: [
    {
      key: 'name',
      label: 'Name',
      type: 'text',
      required: true,
      maxLength: 120,
      description: 'What it is called on the menu.',
      example: 'Signature Facial',
      aliases: ['service', 'service name', 'treatment', 'title'],
    },
    {
      key: 'slug',
      label: 'Web Address',
      type: 'text',
      maxLength: 80,
      description:
        'The match key, and the end of the page URL. Leave it blank on a new service and it is made from the name.',
      example: 'signature-facial',
      aliases: ['slug', 'url', 'handle', 'permalink'],
    },
    {
      key: 'category',
      label: 'Category',
      type: 'text',
      required: true,
      description:
        'Must already exist — by name or by web address. A category typed slightly wrong would otherwise create a second one silently, so an unknown category rejects the row and names it.',
      example: 'Facials',
      aliases: ['service category', 'group', 'type', 'department'],
    },
    {
      key: 'price_cents',
      label: 'Price',
      type: 'money',
      description:
        'What it costs. Stored as whole cents, so 85.00 lands as 8500. Zero means "quoted at consultation" and reads that way on the menu.',
      example: '125.00',
      aliases: ['price', 'cost', 'amount', 'rate', 'fee', 'charge'],
    },
    {
      key: 'price_is_starting',
      label: 'Price Is From',
      type: 'boolean',
      description: 'Yes shows the price as "from $125" rather than a flat figure.',
      example: 'no',
      aliases: ['starting price', 'price from', 'from price'],
    },
    {
      key: 'duration_minutes',
      label: 'Duration Minutes',
      type: 'integer',
      description: 'How long it is booked for.',
      example: '60',
      aliases: ['duration', 'length', 'minutes', 'time', 'mins'],
    },
    {
      key: 'buffer_minutes',
      label: 'Buffer Minutes',
      type: 'integer',
      description: 'Turnaround after it, held off the calendar.',
      example: '15',
      aliases: ['buffer', 'cleanup', 'turnaround', 'gap'],
    },
    {
      key: 'description',
      label: 'Description',
      type: 'text',
      maxLength: 2000,
      description: 'The paragraph on the menu.',
      example: 'A deep-cleansing facial tailored to your skin on the day.',
      aliases: ['summary', 'blurb', 'details short'],
    },
    {
      key: 'details',
      label: 'Details',
      type: 'text',
      maxLength: 4000,
      description: 'The longer explanation on the service page.',
      example: 'Includes cleanse, exfoliation, extractions where needed, mask and finish.',
      aliases: ['long description', 'full description', 'about'],
    },
    {
      key: 'aftercare',
      label: 'Aftercare',
      type: 'text',
      maxLength: 4000,
      description: 'What to do afterwards. Shown after booking and on the page.',
      example: 'No retinol or acids for 48 hours. SPF daily.',
      aliases: ['after care', 'post care', 'aftercare notes'],
    },
    {
      key: 'requires_intake',
      label: 'Requires Intake Form',
      type: 'boolean',
      description: 'Whether the intake form must be completed before the visit.',
      example: 'yes',
      aliases: ['intake', 'needs form', 'form required'],
    },
    {
      key: 'is_active',
      label: 'Active',
      type: 'boolean',
      description: 'No takes it off the menu without deleting its history.',
      example: 'yes',
      aliases: ['active', 'enabled', 'live', 'published', 'status', 'bookable'],
    },
    {
      key: 'is_featured',
      label: 'Featured',
      type: 'boolean',
      description: 'Yes puts it on the front page.',
      example: 'no',
      aliases: ['featured', 'highlight', 'promoted'],
    },
    {
      key: 'sort_order',
      label: 'Sort Order',
      type: 'integer',
      description: 'Lower shows first within its category.',
      example: '10',
      aliases: ['order', 'position', 'rank', 'sequence'],
    },
    {
      key: 'id',
      label: 'Service ID',
      type: 'integer',
      readOnly: true,
      readOnlyBecause: 'The database issues it. Services are matched on their web address.',
      description: 'Our internal identifier.',
      example: '12',
    },
  ],
  excluded: [
    {
      column: 'Intimate, age verification, minimum age, consultation required, patch test hours, deposit, cancellation window',
      reason:
        'The services_guard_gates trigger (022) raises an exception if anyone but an admin changes these. They decide whether a minor can book an intimate service and whether a no-show costs anything, and 022 made them deliberately harder to change than a price. Offering them here would produce a file that looks fine and fails at the row. Set them on the service itself, as an admin.',
    },
    {
      column: 'Processing time, booking approval, photo documentation',
      reason:
        'Scheduling mechanics from 036 and 039. They interact with the exclusion constraint that stops double-booking and with photo consent; neither is a spreadsheet decision.',
    },
    {
      column: 'Image',
      reason: 'Uploaded, not linked. An image URL from an old system points at a server that is about to be switched off.',
    },
  ],
}

/* ── Products and inventory ───────────────────────────────── */

/**
 * `products`.
 *
 * STOCK IS EXPORT-ONLY, and this was the hardest call on the page.
 *
 * Every movement of stock is a row in `inventory_log` with the balance after it,
 * and 007 wrote both in one statement specifically "so the two can never drift".
 * The only door is `adjust_stock`. Writing `products.stock_qty` from an import
 * would move the count without moving the ledger, and from then on the studio
 * has two numbers that disagree and no record of which is right.
 *
 * Going through `adjust_stock` instead would keep the ledger honest, but that
 * function notifies every manager and admin on each call by design (021, for
 * deliberate counts that need a human eye) — so a 200-line import would be 200
 * notifications each, and the one count that mattered would be buried in them.
 *
 * So the product RECORD imports and the COUNT does not. Stock is set by counting,
 * on the Inventory screen. The column is in the export so a stock-take can start
 * from a real list.
 */
const products: CsvEntity = {
  key: 'products',
  label: 'Products & inventory',
  lede: 'The retail and back-bar catalogue. Stock counts export but do not import — see below.',
  source: 'products',
  importing: {
    role: 'manager',
    roleBecause:
      'Creating a product is `is_manager()` (021) and updating one is `is_staff()`. This writes through row-level security as the signed-in person; no service role is involved.',
    matchRule:
      'The SKU, exactly as written. It is unique on the table and it is the studio’s own code, which makes it the one identifier that means the same thing in the old system and this one. A barcode is imported but is not the key — two suppliers can print the same GTIN on a repack.',
    onNoMatch: 'A row with an unrecognised SKU creates a new product.',
  },
  fields: [
    {
      key: 'sku',
      label: 'SKU',
      type: 'text',
      required: true,
      maxLength: 60,
      description: 'The match key. The studio’s own code for the item.',
      example: 'RA-CLEANSE-200',
      aliases: ['item code', 'product code', 'code', 'item number', 'stock code', 'part number'],
    },
    {
      key: 'name',
      label: 'Name',
      type: 'text',
      required: true,
      maxLength: 160,
      description: 'What it is called on the shelf and in the shop.',
      example: 'Daily Foaming Cleanser 200ml',
      aliases: ['product', 'product name', 'title', 'item', 'description short'],
    },
    {
      key: 'slug',
      label: 'Web Address',
      type: 'text',
      maxLength: 80,
      description:
        'The end of the shop page URL. Leave it blank on a new product and it is made from the name; leave it blank on an existing one and its address does not move.',
      example: 'daily-foaming-cleanser-200ml',
      aliases: ['slug', 'url', 'handle', 'permalink'],
    },
    {
      key: 'barcode',
      label: 'Barcode',
      type: 'text',
      maxLength: 20,
      description: 'The GTIN printed on the packaging — digits only. Scannable at the till.',
      example: '0712345678901',
      aliases: ['upc', 'ean', 'gtin', 'scan code', 'bar code'],
    },
    {
      key: 'brand',
      label: 'Brand',
      type: 'text',
      description: 'Must already exist. An unknown brand rejects the row rather than creating one from a typo.',
      example: 'Rhonda Allison',
      aliases: ['manufacturer', 'maker', 'vendor', 'supplier', 'line'],
    },
    {
      key: 'category',
      label: 'Category',
      type: 'text',
      description: 'Must already exist. Same reasoning as brand.',
      example: 'Cleansers',
      aliases: ['product category', 'group', 'type', 'department'],
    },
    {
      key: 'price_cents',
      label: 'Retail Price',
      type: 'money',
      description: 'What a client pays. Stored as whole cents.',
      example: '38.00',
      aliases: ['price', 'retail', 'rrp', 'msrp', 'sell price', 'amount'],
    },
    {
      key: 'cost_cents',
      label: 'Cost',
      type: 'money',
      description: 'What the studio pays. Staff-only; never shown in the shop.',
      example: '19.50',
      aliases: ['cost price', 'wholesale', 'buy price', 'unit cost'],
    },
    {
      key: 'taxable',
      label: 'Taxable',
      type: 'boolean',
      description: 'Whether sales tax applies.',
      example: 'yes',
      aliases: ['tax', 'vat', 'is taxable', 'sales tax'],
    },
    {
      key: 'is_retail',
      label: 'Retail',
      type: 'boolean',
      description: 'Yes lists it in the shop.',
      example: 'yes',
      aliases: ['retail', 'for sale', 'sellable', 'shop'],
    },
    {
      key: 'is_professional',
      label: 'Back Bar',
      type: 'boolean',
      description: 'Yes means it is used during treatments rather than sold.',
      example: 'no',
      aliases: ['professional', 'back bar', 'pro', 'in house', 'consumable'],
    },
    {
      key: 'unit',
      label: 'Unit',
      type: 'text',
      maxLength: 24,
      description: 'What the back bar counts in — bottle, case, lb.',
      example: 'bottle',
      aliases: ['uom', 'unit of measure', 'measure', 'packaging'],
    },
    {
      key: 'low_stock_threshold',
      label: 'Low Stock At',
      type: 'decimal',
      description: 'The count at which it is flagged as running out.',
      example: '3',
      aliases: ['reorder point', 'min stock', 'low stock', 'par level', 'minimum'],
    },
    {
      key: 'reorder_qty',
      label: 'Reorder Quantity',
      type: 'decimal',
      description: 'How much to order when it runs low.',
      example: '6',
      aliases: ['reorder', 'order qty', 'restock qty'],
    },
    {
      key: 'description',
      label: 'Description',
      type: 'text',
      maxLength: 2000,
      description: 'The paragraph in the shop.',
      example: 'A gentle gel cleanser for daily use on combination skin.',
      aliases: ['details', 'summary', 'blurb'],
    },
    {
      key: 'ingredients',
      label: 'Ingredients',
      type: 'text',
      maxLength: 4000,
      description: 'The INCI list from the packaging.',
      example: 'Aqua, Glycerin, Cocamidopropyl Betaine…',
      aliases: ['inci', 'contents', 'formulation'],
    },
    {
      key: 'how_to_use',
      label: 'How To Use',
      type: 'text',
      maxLength: 2000,
      description: 'Directions.',
      example: 'Massage into damp skin morning and night, rinse well.',
      aliases: ['directions', 'usage', 'instructions', 'application'],
    },
    {
      key: 'external_url',
      label: 'External Link',
      type: 'text',
      maxLength: 500,
      description:
        'Set only for items fulfilled by the Rhonda Allison marketplace. Those link out instead of entering the cart, and the database refuses to let them hold stock.',
      example: '',
      aliases: ['link', 'url', 'marketplace', 'shop link'],
    },
    {
      key: 'is_active',
      label: 'Active',
      type: 'boolean',
      description: 'No hides it without losing its sales history.',
      example: 'yes',
      aliases: ['active', 'enabled', 'live', 'status', 'discontinued'],
    },
    {
      key: 'is_featured',
      label: 'Featured',
      type: 'boolean',
      description: 'Yes puts it on the shop front page.',
      example: 'no',
      aliases: ['featured', 'highlight', 'promoted'],
    },
    {
      key: 'sort_order',
      label: 'Sort Order',
      type: 'integer',
      description: 'Lower shows first.',
      example: '10',
      aliases: ['order', 'position', 'rank'],
    },
    {
      key: 'stock_qty',
      label: 'Stock On Hand',
      type: 'decimal',
      readOnly: true,
      readOnlyBecause:
        'Every movement of stock is also a row in the inventory ledger, and 007 writes the two together so they can never drift. An import that set this number would move the count and not the ledger. Set stock by counting, on the Inventory screen.',
      description: 'How many are on the shelf right now.',
      example: '12',
    },
    {
      key: 'id',
      label: 'Product ID',
      type: 'integer',
      readOnly: true,
      readOnlyBecause: 'The database issues it. Products are matched on SKU.',
      description: 'Our internal identifier.',
      example: '204',
    },
  ],
  excluded: [
    {
      column: 'Stock on hand',
      reason:
        'Exports, does not import. The ledger and the count are written in one statement so they cannot disagree (007), and the only door to a stock change notifies every manager per call by design (021) — a 200-line import would bury the count that mattered under 199 that did not.',
    },
    {
      column: 'Images and gallery',
      reason: 'Uploaded, not linked, for the same reason as service images.',
    },
    {
      column: 'Archived date',
      reason: 'Set by archiving. Use Active = no.',
    },
  ],
}

/* ── Sales history ────────────────────────────────────────── */

/**
 * `order_items` joined to `orders` — one row per line sold.
 *
 * EXPORT ONLY, and this is the least negotiable of the five.
 *
 * A sale is not a record that someone typed; it is a record that money moved.
 * The authority for that is a Stripe webhook, or a payment row written at the
 * till — never a browser, and certainly never a spreadsheet. Accepting sales
 * from a CSV would let anyone with a manager login manufacture revenue that the
 * Sales, Sales Tax and Transaction Detail reports would then all faithfully
 * report, because those reports read the same ledger. There is no way to import
 * a sale that does not also mean "the books can be edited".
 *
 * It would also walk straight through the stock triggers: `orders` decrements
 * `products.stock_qty` when it becomes paid, so a back-dated import would take
 * inventory off today's shelf for a sale that happened last year.
 *
 * Historic sales from an old system belong in the old system's report, kept as
 * a file. This export exists so this system's history can be kept the same way.
 */
const sales: CsvEntity = {
  key: 'sales',
  label: 'Sales history',
  lede: 'Every line sold, with its order. Export only.',
  source: 'order_items joined to orders',
  importing: null,
  notImportable:
    'A sale is a record that money moved, and the authority for that is the payment ledger — a Stripe webhook or a payment taken at the till. If a spreadsheet could write one, the books could be edited, and every financial report reads that same ledger and would repeat the number without question. Back-dating one would also take stock off today’s shelf, because an order decrements inventory when it is paid. Keep an old system’s sales as an old system’s export.',
  fields: [
    { key: 'order_number', label: 'Order Number', type: 'text', readOnly: true, description: 'The order this line belongs to.', example: 'SO-1042' },
    { key: 'sold_at', label: 'Sold', type: 'datetime', readOnly: true, description: 'When it was paid, studio local time. Falls back to when the order was raised if it is not yet paid.', example: 'Mar 4, 2026, 2:10 PM' },
    { key: 'channel', label: 'Channel', type: 'text', readOnly: true, description: 'Online, or rung up in store.', example: 'in_store' },
    { key: 'status', label: 'Status', type: 'text', readOnly: true, description: 'Where the order got to.', example: 'completed' },
    { key: 'payment_method', label: 'Payment Method', type: 'text', readOnly: true, description: 'Only set for in-store sales; online orders pay through Stripe.', example: 'card' },
    { key: 'client_name', label: 'Client', type: 'text', readOnly: true, description: 'Who bought it, or the guest name.', example: 'Maria Vega' },
    { key: 'client_email', label: 'Client Email', type: 'email', readOnly: true, description: 'Their email, where there is one.', example: 'maria.vega@example.com' },
    { key: 'sku', label: 'SKU', type: 'text', readOnly: true, description: 'The code as it was at the time of sale, not as it is now.', example: 'RA-CLEANSE-200' },
    { key: 'product_name', label: 'Product', type: 'text', readOnly: true, description: 'The name as it was at the time of sale.', example: 'Daily Foaming Cleanser 200ml' },
    { key: 'qty', label: 'Quantity', type: 'decimal', readOnly: true, description: 'How many.', example: '2' },
    { key: 'unit_price_cents', label: 'Unit Price', type: 'money', readOnly: true, description: 'What one cost, frozen at the sale.', example: '38.00' },
    { key: 'line_total_cents', label: 'Line Total', type: 'money', readOnly: true, description: 'Quantity times unit price.', example: '76.00' },
    { key: 'order_subtotal_cents', label: 'Order Subtotal', type: 'money', readOnly: true, description: 'The whole order before discount, tax and shipping. Repeated on every line of the order.', example: '76.00' },
    { key: 'order_discount_cents', label: 'Order Discount', type: 'money', readOnly: true, description: 'Discount on the whole order.', example: '0.00' },
    { key: 'order_tax_cents', label: 'Order Tax', type: 'money', readOnly: true, description: 'Sales tax on the whole order. The state’s money, not revenue.', example: '5.89' },
    { key: 'order_shipping_cents', label: 'Order Shipping', type: 'money', readOnly: true, description: 'Postage on the whole order.', example: '0.00' },
    { key: 'order_total_cents', label: 'Order Total', type: 'money', readOnly: true, description: 'What was billed for the whole order.', example: '81.89' },
  ],
  excluded: [
    {
      column: 'Cost and margin',
      reason:
        'Present in the Retail Sales report, which allocates payments back to the lines that earned them and declares which rows fell back to a current cost. A flat CSV cannot carry that caveat, and a margin figure without its caveat is a margin figure nobody should act on.',
    },
    {
      column: 'Card details, Stripe ids',
      reason: 'Nothing about a payment instrument belongs in a file on a laptop.',
    },
  ],
}

/* ── Appointments ─────────────────────────────────────────── */

/**
 * `appointments`.
 *
 * EXPORT ONLY. AGENTS.md rule 1: `src/lib/booking.ts` with the service-role
 * client is the ONLY public path into this table — one implementation, in one
 * runtime — and the GiST exclusion constraint on `(provider_id, slot)` is what
 * makes "not double-booked" true rather than merely checked. A CSV importer
 * would be a second way in, which is precisely the drift that rule warns about:
 * it would have to re-derive the slot, re-check blocks, closures and cached
 * calendar busy time, and handle a 23P01 race, and the day it fell out of step
 * with booking.ts is the day two clients arrive at once.
 *
 * The export is here because a calendar is worth having on paper.
 */
const appointments: CsvEntity = {
  key: 'appointments',
  label: 'Appointments',
  lede: 'The calendar as a list. Export only.',
  source: 'appointments',
  importing: null,
  notImportable:
    'src/lib/booking.ts is the only way an appointment is created — one implementation, in one runtime — and a database exclusion constraint is what actually stops two clients being booked into the same slot. A CSV importer would be a second copy of that logic, and the first time the two disagreed, two people would arrive at once. Book past appointments through the calendar if they need to be here.',
  fields: [
    { key: 'starts_at', label: 'Starts', type: 'datetime', readOnly: true, description: 'Studio local time.', example: 'Mar 4, 2026, 10:00 AM' },
    { key: 'ends_at', label: 'Ends', type: 'datetime', readOnly: true, description: 'Studio local time.', example: 'Mar 4, 2026, 11:00 AM' },
    { key: 'duration_minutes', label: 'Duration Minutes', type: 'integer', readOnly: true, description: 'Booked length, not counting the buffer after it.', example: '60' },
    { key: 'provider_name', label: 'Provider', type: 'text', readOnly: true, description: 'Who is treating.', example: 'Alina R.' },
    { key: 'client_name', label: 'Client', type: 'text', readOnly: true, description: 'Who is booked, or the guest name.', example: 'Maria Vega' },
    { key: 'client_email', label: 'Client Email', type: 'email', readOnly: true, description: 'Their email, where there is one.', example: 'maria.vega@example.com' },
    { key: 'client_phone', label: 'Client Phone', type: 'phone', readOnly: true, description: 'Their number, where there is one.', example: '(559) 555-0134' },
    { key: 'status', label: 'Status', type: 'text', readOnly: true, description: 'Pending, confirmed, checked in, completed, cancelled or no show.', example: 'completed' },
    { key: 'source', label: 'Source', type: 'text', readOnly: true, description: 'Booked online, by staff, walk-in or by phone.', example: 'online' },
    { key: 'subtotal_cents', label: 'Subtotal', type: 'money', readOnly: true, description: 'Services before any deposit.', example: '125.00' },
    { key: 'total_cents', label: 'Total', type: 'money', readOnly: true, description: 'What the visit came to.', example: '125.00' },
    { key: 'deposit_cents', label: 'Deposit', type: 'money', readOnly: true, description: 'Taken to hold the slot.', example: '25.00' },
    { key: 'deposit_status', label: 'Deposit Status', type: 'text', readOnly: true, description: 'None, pending, paid, forfeited or refunded.', example: 'paid' },
    { key: 'created_at', label: 'Booked', type: 'datetime', readOnly: true, description: 'When it was booked, studio local time.', example: 'Feb 20, 2026, 8:41 PM' },
  ],
  excluded: [
    {
      column: 'Client notes and staff notes',
      reason:
        'The free-text on an appointment is where a skin concern gets written down, which makes it clinical in practice whatever the column is called. It stays behind the login.',
    },
    {
      column: 'Consent and age attestation timestamps',
      reason: 'Evidence that something was agreed to in front of a person. It is read on the appointment, not carried around in a file.',
    },
  ],
}

export const CSV_ENTITIES: readonly CsvEntity[] = [
  clients,
  services,
  products,
  sales,
  appointments,
]

export function csvEntity(key: string): CsvEntity | undefined {
  return CSV_ENTITIES.find((e) => e.key === key)
}
