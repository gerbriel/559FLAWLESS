# 559 Flawless

Booking, CRM, and retail platform for a skin studio — facials, waxing, nails,
and corrective skin treatments.

Next.js 16 · React 19 · Supabase · Tailwind 4 · Stripe.

---

## Setup

### 1. Install

```bash
npm install
cp .env.example .env.local
```

### 2. Create the Supabase project

Make a project at [supabase.com](https://supabase.com), then fill in `.env.local`
from **Project settings → API**:

```
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=      # server only — bypasses RLS
```

### 3. Run the migrations

In order, in the Supabase SQL editor — or with the CLI:

```bash
npx supabase link --project-ref <ref>
npx supabase db push
```

| File | What it creates |
|---|---|
| `001_foundation.sql` | Roles, profiles, RLS helper functions |
| `002_catalog.sql` | Service categories, services, add-ons, rooms |
| `003_scheduling.sql` | Provider hours, blocks, closures, calendar sync, booking policy |
| `004_bookings.sql` | Appointments **+ the double-booking exclusion constraint** |
| `005_crm_clinical.sql` | Client records, notes, consent, intake, patch tests, photos |
| `006_messaging.sql` | Threads, messages, notifications and their triggers |
| `007_inventory.sql` | Products, stock movement log, approval queue, vendors, POs |
| `008_commerce.sql` | Orders, gift cards, packages, payments ledger |
| `009_analytics_marketing.sql` | Analytics events, announcements, testimonials, site copy |
| `010_seed.sql` | Service menu, consent templates, intake questions, FAQs |
| `011_storage.sql` | Storage buckets and their policies |

Then regenerate the types so the app compiles against the real schema:

```bash
npx supabase gen types typescript --project-id <ref> > src/types/database.ts
```

### 4. Create your first admin

Sign up through the app, then in the SQL editor:

```sql
update public.profiles set role = 'admin' where email = 'you@example.com';
```

Role changes are deliberately blocked from the app — a trigger rejects any
non-admin attempt to change `role` or `suspended_at`, so this is the only way in
for the first one.

### 5. Add a provider

```sql
-- Make someone a provider and let them take online bookings
update public.profiles
set role = 'provider',
    display_name = 'Yesenia R.',
    slug = 'yesenia',
    accepts_online_booking = true,
    timezone = 'America/Los_Angeles'
where email = 'provider@example.com';

-- Link every active service to them
insert into public.provider_services (provider_id, service_id)
select p.id, s.id
from public.profiles p, public.services s
where p.slug = 'yesenia' and s.is_active
on conflict do nothing;
```

Then set their weekly hours in **Dashboard → My hours**. Nothing is bookable
until a provider has hours, at least one linked service, and
`accepts_online_booking = true`.

### 6. Stripe (optional to start)

```
STRIPE_SECRET_KEY=
NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=
STRIPE_WEBHOOK_SECRET=
```

Locally:

```bash
stripe listen --forward-to localhost:3000/api/stripe/webhook
```

Without these, booking still works — deposit and retail checkout return a clear
"not configured yet" message rather than failing obscurely.

### 7. Run it

```bash
npm run dev
```

---

## What's in it

**Public** — service menu with per-category and per-service pages, a four-step
booking flow with an 18+ gate on intimate services, retail shop and cart, gift
cards and treatment series, contact form that opens a staff message thread, FAQ,
policies, privacy, terms.

**Client account** — upcoming and past appointments, self-service cancellation
inside the policy window, deposit payment, health intake, versioned consent
signing, message threads, order history, communication and photo-release
preferences.

**Staff dashboard** — today's book, week calendar, client CRM with treatment
notes and contraindication flags, message inbox with internal notes, analytics
(traffic, booking funnel, revenue, no-show rate, service mix), inventory for both
retail and back bar with a manager approval queue, orders, review moderation, and
booking policy settings.

**Under it** — a race-safe booking engine backed by a database exclusion
constraint, row-level security on every table, five roles, and an audit trail on
appointment status changes and stock movements.

---

## Notes for whoever works on this next

Read `AGENTS.md`. It covers the invariants that are easy to break by accident —
where the double-booking guard actually lives, why prices never come from the
client, the wall-clock/instant split, and the rules around clinical data.
