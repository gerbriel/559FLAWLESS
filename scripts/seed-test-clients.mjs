#!/usr/bin/env node
/**
 * Seed a handful of test clients with plausible histories.
 *
 * These exist so the dashboard has something to show while the studio is still
 * finding its way around — a Clients list, a purchase, a note, a booked visit.
 * Every account is created with `test+…@559flawless.test`, an address that
 * cannot receive mail, so no real inbox is ever touched by seed data.
 *
 * Usage:  node scripts/seed-test-clients.mjs
 * Remove: node scripts/seed-test-clients.mjs --remove
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'

// .env.local is what Next reads; mirror that rather than inventing a new file.
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // Missing file is fine — the variables may already be in the environment.
  }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!url || !serviceKey) {
  console.error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY.\n' +
      'Both live in .env.local; the service role key is under Project Settings → API.'
  )
  process.exit(1)
}

const admin = createClient(url, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
})

/** A domain reserved by RFC 2606 — nothing here can reach a real person. */
const DOMAIN = '559flawless.test'

const CLIENTS = [
  {
    email: `test+marisol@${DOMAIN}`,
    first_name: 'Marisol',
    last_name: 'Vega',
    phone: '(559) 555-0142',
    pronouns: 'she/her',
    date_of_birth: '1992-06-14',
    marketing_opt_in: true,
    note: 'Sensitive around the jawline — patch tested for the lightening peel, no reaction. Prefers a quieter room.',
    skin: { skin_type: 'combination', fitzpatrick: 4 },
  },
  {
    email: `test+dee@${DOMAIN}`,
    first_name: 'Dee',
    last_name: 'Okafor',
    phone: '(559) 555-0168',
    pronouns: 'they/them',
    date_of_birth: '1988-11-02',
    marketing_opt_in: true,
    note: 'Regular Brazilian, every five weeks. Books the last slot of the day.',
    skin: { skin_type: 'normal', fitzpatrick: 6 },
  },
  {
    email: `test+kayla@${DOMAIN}`,
    first_name: 'Kayla',
    last_name: 'Nguyen',
    phone: '(559) 555-0175',
    pronouns: 'she/her',
    date_of_birth: '2001-03-27',
    marketing_opt_in: false,
    note: 'Came in for cystic acne on the chin. On tretinoin — stopped it seven days before the peel as asked.',
    skin: { skin_type: 'oily', fitzpatrick: 3 },
  },
  {
    email: `test+robert@${DOMAIN}`,
    first_name: 'Robert',
    last_name: 'Salazar',
    phone: '(559) 555-0190',
    pronouns: 'he/him',
    date_of_birth: '1979-09-08',
    marketing_opt_in: true,
    note: 'First facial, booked as a gift. Nervous about extractions — talk him through it.',
    skin: { skin_type: 'dry', fitzpatrick: 3 },
  },
]

async function findExisting(email) {
  const { data } = await admin.from('profiles').select('id').ilike('email', email).maybeSingle()
  return data?.id ?? null
}

async function remove() {
  let removed = 0
  for (const c of CLIENTS) {
    const id = await findExisting(c.email)
    if (!id) continue
    // Deleting the auth user cascades to the profile and everything hanging
    // off it, so there is nothing else to clean up by hand.
    const { error } = await admin.auth.admin.deleteUser(id)
    if (error) {
      console.error(`  ✗ ${c.email}: ${error.message}`)
      continue
    }
    console.log(`  ✓ removed ${c.first_name} ${c.last_name}`)
    removed += 1
  }
  console.log(`\n${removed} test client(s) removed.`)
}

async function seed() {
  // Anything hung off an appointment needs somebody to have performed it.
  const { data: provider } = await admin
    .from('profiles')
    .select('id')
    .neq('role', 'client')
    .is('suspended_at', null)
    .limit(1)
    .maybeSingle()

  const { data: services } = await admin
    .from('services')
    .select('id, name, price_cents, duration_minutes, buffer_minutes')
    .eq('is_active', true)
    .limit(4)

  const { data: products } = await admin
    .from('products')
    .select('id, name, sku, price_cents, stock_qty')
    .eq('is_active', true)
    .eq('is_retail', true)
    .gt('stock_qty', 2)
    .limit(2)

  for (const [i, c] of CLIENTS.entries()) {
    if (await findExisting(c.email)) {
      console.log(`  · ${c.first_name} ${c.last_name} already exists — skipping`)
      continue
    }

    const { data: created, error: createError } = await admin.auth.admin.createUser({
      email: c.email,
      email_confirm: true,
      user_metadata: { first_name: c.first_name, last_name: c.last_name, phone: c.phone },
    })

    if (createError || !created?.user) {
      console.error(`  ✗ ${c.email}: ${createError?.message}`)
      continue
    }

    const clientId = created.user.id
    const now = new Date().toISOString()

    await admin
      .from('profiles')
      .update({
        role: 'client',
        email: c.email,
        phone: c.phone,
        pronouns: c.pronouns,
        date_of_birth: c.date_of_birth,
        marketing_opt_in: c.marketing_opt_in,
        marketing_consent_at: c.marketing_opt_in ? now : null,
        terms_accepted_at: now,
        terms_version_accepted: 1,
        privacy_accepted_at: now,
        profile_completed_at: now,
      })
      .eq('id', clientId)

    await admin
      .from('client_records')
      .upsert({ client_id: clientId, ...c.skin }, { onConflict: 'client_id' })

    if (provider?.id) {
      await admin.from('client_notes').insert({
        client_id: clientId,
        author_id: provider.id,
        body: c.note,
      })
    }

    // Give the first two a past visit and the third an upcoming one, so the
    // calendar and the history both have something in them.
    const service = services?.[i % (services?.length || 1)]
    if (provider?.id && service) {
      const when = new Date()
      when.setDate(when.getDate() + (i < 2 ? -(7 * (i + 1)) : 3 + i))
      when.setHours(11 + i, 0, 0, 0)

      const ends = new Date(when.getTime() + service.duration_minutes * 60_000)
      const past = when < new Date()

      const { data: appt } = await admin
        .from('appointments')
        .insert({
          provider_id: provider.id,
          client_id: clientId,
          starts_at: when.toISOString(),
          ends_at: ends.toISOString(),
          buffer_minutes: service.buffer_minutes,
          status: past ? 'completed' : 'confirmed',
          source: 'staff',
          completed_at: past ? when.toISOString() : null,
          // `slot` is deliberately absent — the appointments_set_slot trigger
          // owns it, and writing it by hand is a malformed-range error.
        })
        .select('id')
        .single()

      if (appt) {
        await admin.from('appointment_services').insert({
          appointment_id: appt.id,
          service_id: service.id,
          name_snapshot: service.name,
          price_cents: service.price_cents,
          duration_minutes: service.duration_minutes,
        })
      }
    }

    // One in-studio purchase, so the Purchases section is not empty.
    const product = products?.[i % (products?.length || 1)]
    if (product && provider?.id && i < 2) {
      const { data: order } = await admin
        .from('orders')
        .insert({
          client_id: clientId,
          status: 'cart',
          channel: 'in_store',
          fulfillment: 'pickup',
          payment_method: i === 0 ? 'card' : 'cash',
          sold_by: provider.id,
          tax_cents: Math.round(product.price_cents * 0.0835),
        })
        .select('id')
        .single()

      if (order) {
        await admin.from('order_items').insert({
          order_id: order.id,
          product_id: product.id,
          name_snapshot: product.name,
          sku_snapshot: product.sku,
          unit_price_cents: product.price_cents,
          qty: 1,
        })
        // Moving to `paid` is what assigns the order number and takes the stock
        // off the shelf — the same path the till uses.
        await admin
          .from('orders')
          .update({ status: 'paid', paid_at: now })
          .eq('id', order.id)
      }
    }

    if (c.marketing_opt_in) {
      await admin
        .from('newsletter_subscribers')
        .upsert(
          { email: c.email, first_name: c.first_name, status: 'active', source: 'seed' },
          { onConflict: 'email' }
        )
    }

    console.log(`  ✓ ${c.first_name} ${c.last_name} — ${c.email}`)
  }
}

const removing = process.argv.includes('--remove')
console.log(removing ? 'Removing test clients…\n' : 'Seeding test clients…\n')

await (removing ? remove() : seed())

if (!removing) {
  console.log(
    `\nDone. These are test accounts on @${DOMAIN}, which cannot receive email.` +
      '\nRemove them any time with: node scripts/seed-test-clients.mjs --remove'
  )
}
