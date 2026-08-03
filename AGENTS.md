<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# 559 Flawless

Booking, CRM, and retail platform for a single-room skin studio in Fresno —
facials, waxing (including Brazilian), nails, and corrective skin treatments
including intimate-area brightening.

**Next.js 16 (App Router) · React 19 · Supabase · Tailwind 4 · Stripe.**

This project is standalone. It shares no code or database with anything else in
`WebDevProjects/`, though it borrows two patterns deliberately — see *Lineage*.

---

## Commands

```bash
npm run dev      # local dev server
npm run build    # production build (run before calling anything done)
npm run lint     # eslint, including the React Compiler rules
npx tsc --noEmit # typecheck
```

---

## The rules that matter

### 1. The double-booking guard lives in the database

`appointments` carries a GiST exclusion constraint on `(provider_id, slot)`.
Application code checks availability so the UI can render sensibly; the
constraint is what makes it *true*. Two clients that both pass validation race
into the insert, exactly one commits, the loser gets SQLSTATE `23P01`, which
`src/lib/booking.ts` turns into a 409 `slot_taken`.

Never "optimise" that check away, and never add an anon `INSERT` policy to
`appointments`. `src/lib/booking.ts` with the service-role client is the only
public path in — one implementation, in one runtime. A second copy of this logic
(an edge function, say) is exactly how the guard drifts and breaks.

### 2. The client never supplies a price or a duration

The booking request names *which* service, never what it costs or how long it
takes. `priceService()` reads both from the database, applies any per-provider
override, and computes the totals server-side. Same for retail checkout: the
cart holds product ids and quantities only.

### 3. Wall-clock vs. instants

`provider_schedules.start_time`, `availability_blocks.*`, and `block_date` are
**wall-clock in the provider's IANA zone**. Everything stored, compared, or sent
to Google is an absolute instant.

All conversion goes through `src/lib/time.ts`. No `setHours`, no `setDate`, no
`toISOString().split('T')[0]` anywhere in this codebase. `zonedTimeToUtc`
resolves DST edges deliberately: spring-forward gaps resolve forward, fall-back
overlaps resolve to the first occurrence.

Reading the clock in a Server Component goes through `requestNow()`, not a bare
`Date.now()` — one named seam, and it keeps React's purity lint honest.

### 4. RLS is the security boundary, not the UI

Every table has row-level security. The role helpers in migration `001`
(`is_staff`, `is_front_desk`, `is_manager`, `is_admin`, `treats_client`) are
what policies are written against, and `src/types/database.ts` mirrors them for
the UI. The UI copies exist to hide buttons; the SQL copies are what actually
stop a request.

`createAdminClient()` bypasses RLS. Import it only from route handlers that have
already authenticated and authorised the caller. Never from a Client Component.

Role escalation is blocked at the database: a trigger rejects any change to
`profiles.role` or `profiles.suspended_at` from a non-admin, so the otherwise
sensible "update own profile" policy can't be used to self-promote.

### 5. Clinical data is the sensitive part

`client_notes`, `intake_submissions`, `consent_signatures`, `patch_tests`, and
`treatment_photos` hold health information. Two invariants:

- Nothing there is readable by `anon`, ever.
- A client can read their own record but cannot edit clinical history. Signed
  consent and provider notes are append-only from the client side.

Consent signatures store `body_snapshot` — a verbatim copy of the text that was
on screen — plus the form version. Editing a template later can never rewrite
what someone actually agreed to. That is the entire point; don't "normalise" it
away into a foreign key.

Treatment photos live in a **private** bucket, addressed
`<client_uuid>/<appointment_uuid>/<file>`, served only via short-lived signed
URLs minted server-side. Per-image consent is a `CHECK` constraint, not a
convention.

### 6. Intimate services

Brazilian waxing and intimate-area brightening are ordinary licensed esthetic
services and are presented that way: plain clinical language, no euphemism, no
imagery. What the code enforces:

- `services.requires_age_verification` gates booking behind an 18+ attestation,
  recorded as `appointments.age_attested_at`. The client's tick is necessary but
  never sufficient — the service's own flag is what makes it required.
- A dedicated consent form (`intimate-services`) with a 180-day revalidation.
- No photograph of an intimate area without separate written consent.
- Copy consistently states the client may narrow the scope or stop at any point
  without giving a reason. Keep that; it is not filler.

### 7. Money is integer cents

Everywhere, in the database and in the app. There is no float arithmetic on
prices and there must not be any. `formatMoney()` is the only place cents become
a string.

Stripe webhooks are the authoritative record that money moved — a browser
landing on a `success_url` proves nothing. Handlers are idempotent because
Stripe retries.

---

## Layout

```
src/
  app/
    (public)/      storefront: home, services, booking, shop, cart, policies
    (auth)/        login, signup
    account/       client area — appointments, forms & consent, messages, orders
    dashboard/     staff — today, calendar, clients (CRM), messages, analytics,
                   inventory + approvals, orders, marketing, settings
    api/           availability, book, stripe/{deposit,checkout,webhook}
  lib/
    booking.ts       server-authoritative booking engine
    availability.ts  slot generation — the one source of truth for "is this open"
    time.ts          DST-safe zone helpers
    supabase/        client / server / admin / middleware
  components/
    booking/       the multi-step booking flow
    layout/        site + dashboard chrome
    shared/        forms, charts, and other cross-cutting pieces
    ui/            primitives (button, card, field, badge, section)
  types/database.ts  the schema contract

supabase/migrations/  001–011, applied in order
```

## Roles

| Role | Can do |
|---|---|
| `client` | Book, buy, sign forms, message, see their own record |
| `provider` | Own calendar and hours, treat clients, write notes, propose stock changes |
| `front_desk` | Book for anyone, handle messages, full client list, orders |
| `manager` | Front desk + inventory writes, approvals, analytics, marketing |
| `admin` | Everything, including pricing, service gates, and booking policy |

---

## Working on the schema

Migrations are numbered and applied in order. To change the schema, add a new
numbered migration — don't edit an applied one.

After a schema change, regenerate the types:

```bash
npx supabase gen types typescript --project-id <ref> > src/types/database.ts
```

Until you do, `src/types/database.ts` is hand-maintained and is what the app
compiles against. Two things about it are load-bearing:

- Row shapes are `type` aliases, **not** `interface`. Interfaces lack implicit
  index signatures and so fail supabase-js's `Record<string, unknown>`
  constraint, which silently collapses every query result to `never`.
- `Relationships` entries must carry the **real** Postgres constraint name
  (`<table>_<column>_fkey`). `appointments` has two FKs to `profiles`, so embeds
  must disambiguate: `profiles!appointments_provider_id_fkey(...)`.

### Select strings must be single literals

postgrest-js parses the select string *at the type level*. `'a, b' + ' c'`
widens to `string` and the result type degrades to `SelectQueryError`. Always
one literal, however long.

## Charts

Chart colors come from the validated tokens in `globals.css` (`.viz-root`) —
never raw hex in a component. Light and dark are separately *selected* sets, not
an automatic flip, each validated against its own surface (lightness band,
chroma floor, CVD separation, normal-vision floor, contrast). Changing a value
means re-running the validator, not eyeballing it.

## Design

Editorial minimalism: generous whitespace, full-bleed imagery, uppercase
wide-tracked labels (`.label-caps`), a serif display face (`.display`) against
Inter for body. Warm porcelain-to-espresso neutrals with a rose-clay accent —
deliberately not clinical white. Square corners; the only radius in the system
is on chart data-ends.

### The dashboard is softer

That last sentence is the storefront's rule, and it stays. Staff spend hours a
day on the other side of the login, so `/dashboard` rounds its surfaces and
pills its controls — same palette, same typefaces, same labels, softer edges.

The softening is one scope, not forty literals. `src/app/dashboard/layout.tsx`
carries `.dash`, which defines `--radius-panel`, `--radius-tile` and
`--radius-control` and rounds anything marked `data-ui="button" | "input" |
"panel" | "tile"`. The shared `Button`, `ButtonLink`, `Input`, `Textarea` and
`Select` primitives already carry the attribute, so a dashboard screen built
from them is correct without knowing any of this exists — and the same
component on the storefront is still square.

The staff screens share a vocabulary in `src/components/ui/dashboard.tsx`
(`PageHeader`, `Panel`, `HeroPanel`, `HowItWorks`, `ActionTile`, `EmptyState`,
`StatTile`, `Avatar`, `Thumb`, `SearchField`, `Pagination`, `Toolbar`) and
`dashboard-client.tsx` (`FilterPills`, `Stepper`). Compose those rather than
rebuilding them per page — the reason no two screens agreed on padding before
was that every one of them had its own copy.

---

## Lineage

Two patterns were borrowed on purpose:

- **united-metal-components** — the staff/CRM shape: role enum with discrete
  staff roles, SECURITY DEFINER triggers that fan a public submission out to
  staff notifications and match it to a customer record, segment-aware
  analytics, and the inventory approval queue where non-managers propose changes
  that an admin applies with their own client (no dynamic SQL, no service role).
- **Axis - Website** — the booking engine: re-derive the requested slot
  server-side in the provider's timezone, re-check it against blocks, closures,
  existing bookings and cached calendar busy time, and let a DB exclusion
  constraint settle the race. Its dependency-free timezone module was ported
  wholesale into `src/lib/time.ts`.

Neither project shares code or a database with this one.
