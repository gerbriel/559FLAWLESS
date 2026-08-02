-- ============================================================
-- 559 Flawless — migrations 032 through 041
--
-- 020-031 already applied. Paste this and run it. Safe to re-run.
-- Verified: all 41 apply on a virgin PostgreSQL 17, and 032-041
-- re-apply cleanly three times over.
--
-- 032 multi-location   035 time tracking     038 notifications
-- 033 expenses         036 scheduling        039 client bans + photos
-- 034 permissions      037 resources +       040 barcodes
--     + commissions        waitlist          041 team profiles
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- 032_locations.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 032: a second room, one business
--
-- The studio is one room on W Shaw Ave. The owner wants to be able to open a
-- second without starting the client record over, so this migration draws the
-- line between what belongs to the BUSINESS and what belongs to a BUILDING.
--
-- Belongs to the business, and is deliberately NOT given a location_id:
--   profiles, client_records, client_notes, intake_submissions,
--   consent_signatures, patch_tests, treatment_photos, messages, orders' client
--   — the whole clinical and CRM side. A client who books a facial at one site
--   and a wax at the other is one person with one history. That is the explicit
--   requirement, and splitting the client list is the one mistake here that
--   could not be undone later.
--
-- Belongs to a building, and gets one:
--   appointments (where the visit happened), orders (where the sale happened —
--   sales tax is assessed by district, so this is a filing requirement),
--   business_hours, closures, provider_schedules, availability_blocks, rooms,
--   inventory movements and stock counts.
--
-- Two things that look like columns but are link tables, because the answer is
-- many-to-many and a column would force a lie:
--   staff_locations  — one esthetician works Tuesdays here and Thursdays there.
--   service_locations — the menu, and the price, can differ by site.
--
-- Nothing below assumes more than one location exists. Nothing below assumes
-- only one ever will.
-- ============================================================

-- ── The places ───────────────────────────────────────────────
create table if not exists public.locations (
  id            bigserial primary key,
  name          text not null,
  slug          text not null unique,
  address_line1 text,
  city          text,
  state         text,
  postal        text,
  -- Authoritative for this site's wall-clock. Everything stored is still an
  -- absolute instant; this is what a "10:00" on a schedule row means. A second
  -- studio could sit in another zone, so nothing may hardcode Los Angeles.
  timezone      text not null default 'America/Los_Angeles',
  phone         text,
  email         text,
  is_active     boolean not null default true,
  sort_order    int not null default 0
);

comment on table public.locations is
  'Physical sites. Exactly one is seeded for the existing studio; the rest of '
  'the schema is written so that one is not a special case.';

/**
 * The primary location — first by sort_order among the active ones.
 *
 * Deliberately not a flag column: the contract other work is built against
 * publishes this table's shape exactly, and "primary" is already expressible
 * as "the one she put first". Reordering the list in Settings moves it.
 *
 * STABLE and SECURITY DEFINER because it is a column default on tables an
 * ordinary client writes to — a cart insert must not fail because RLS hid
 * every location row from the person inserting it. It reads nothing that is
 * not already public.
 */
create or replace function public.default_location_id()
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(
    (select id from public.locations where is_active order by sort_order, id limit 1),
    -- Every site deactivated is a misconfiguration, not a reason for the next
    -- booking to fail on a not-null violation.
    (select id from public.locations order by sort_order, id limit 1)
  );
$$;

-- ── Seed the studio that already exists ──────────────────────
--
-- Taken from site_content.contact (seeded in 010, corrected in 019) rather than
-- typed in again here, so the address on the location row and the address in
-- the footer are the same string from the same day. The zone comes from
-- booking_settings, which is where the studio's clock has always been.
--
-- Guarded on "no locations at all", not on the slug: once she renames this row
-- or opens a second site, a re-run must leave both alone.

insert into public.locations
  (name, slug, address_line1, city, state, postal, timezone, phone, email, is_active, sort_order)
select
  coalesce(nullif(c.value ->> 'city', ''), 'Studio'),
  coalesce(
    nullif(lower(regexp_replace(coalesce(c.value ->> 'city', ''), '[^a-zA-Z0-9]+', '-', 'g')), ''),
    'studio'
  ),
  nullif(c.value ->> 'address', ''),
  nullif(c.value ->> 'city', ''),
  nullif(c.value ->> 'state', ''),
  nullif(c.value ->> 'postal', ''),
  coalesce((select b.timezone from public.booking_settings b where b.id = 1), 'America/Los_Angeles'),
  nullif(c.value ->> 'phone', ''),
  nullif(c.value ->> 'email', ''),
  true,
  0
from public.site_content c
where c.key = 'contact'
  and not exists (select 1 from public.locations);

-- A database whose site_content never got its contact row still needs somewhere
-- for every existing appointment to point at.
insert into public.locations (name, slug, timezone, is_active, sort_order)
select
  'Studio',
  'studio',
  coalesce((select b.timezone from public.booking_settings b where b.id = 1), 'America/Los_Angeles'),
  true,
  0
where not exists (select 1 from public.locations);

-- ── Who works where ──────────────────────────────────────────
--
-- NOT a column on profiles. A provider can hold Tuesdays at one site and
-- Thursdays at another, and a manager covers both; a single column would make
-- one of those unrepresentable and the other a lie.
create table if not exists public.staff_locations (
  profile_id  uuid   not null references public.profiles(id) on delete cascade,
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),
  -- Their home site: what the dashboard opens on, and where a booking made
  -- without a stated location lands.
  is_primary  boolean not null default false,
  created_at  timestamptz not null default now(),
  primary key (profile_id, location_id)
);

create index if not exists staff_locations_location_idx
  on public.staff_locations (location_id);

-- One home site each. A partial unique index rather than a check, because the
-- constraint is across rows.
create unique index if not exists staff_locations_one_primary_idx
  on public.staff_locations (profile_id) where is_primary;

-- Everyone on staff today works at the studio that exists today. Guarded on
-- "has no site at all" rather than on the conflict target: once someone has
-- been moved to a second site as their home, re-running this must not try to
-- hand them a second primary row and trip the index above.
insert into public.staff_locations (profile_id, location_id, is_primary)
select p.id, public.default_location_id(), true
from public.profiles p
where p.role <> 'client'
  and not exists (select 1 from public.staff_locations sl where sl.profile_id = p.id)
on conflict (profile_id, location_id) do nothing;

/**
 * Does the caller work at this site?
 *
 * The basis for anything that SHOULD be scoped. Most things are not: in a
 * two-room business the front desk answering the phone needs to see both
 * calendars, so the existing policies stay open on purpose. Use this where a
 * narrower answer is genuinely wanted.
 */
create or replace function public.works_at(p_location bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.staff_locations sl
    join public.profiles p on p.id = sl.profile_id
    where sl.profile_id = auth.uid()
      and sl.location_id = p_location
      and p.suspended_at is null
  );
$$;

/** Every site the caller works at, for `= any(...)` filters in a policy. */
create or replace function public.staff_location_ids()
returns bigint[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(sl.location_id), '{}'::bigint[])
  from public.staff_locations sl
  where sl.profile_id = auth.uid();
$$;

/** The caller's home site, falling back to the primary location. */
create or replace function public.my_location_id()
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(
    (select sl.location_id from public.staff_locations sl
     where sl.profile_id = auth.uid() and sl.is_primary limit 1),
    (select sl.location_id from public.staff_locations sl
     where sl.profile_id = auth.uid() order by sl.location_id limit 1),
    public.default_location_id()
  );
$$;

-- ── The menu, per site ───────────────────────────────────────
--
-- NOT a column on services. The catalogue is one catalogue — a service keeps
-- one id, one slug, one set of consent forms and one treatment history no
-- matter which room it is performed in. What varies is whether a given room
-- offers it and what it charges.
create table if not exists public.service_locations (
  service_id  bigint not null references public.services(id) on delete cascade,
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),
  -- Null = charge the catalogue price. Integer cents, like every other price
  -- in this schema. A per-provider override on provider_services still wins
  -- over this one: the person doing the work is the more specific fact.
  price_cents_override int check (price_cents_override is null or price_cents_override >= 0),
  is_active   boolean not null default true,
  primary key (service_id, location_id)
);

create index if not exists service_locations_location_idx
  on public.service_locations (location_id) where is_active;

-- The existing menu is offered at the existing studio, at the existing price.
insert into public.service_locations (service_id, location_id, is_active)
select s.id, public.default_location_id(), true
from public.services s
on conflict (service_id, location_id) do nothing;

/**
 * What a service costs at a site, in cents.
 *
 * The client never supplies a price; this is one of the places the server
 * reads one. Null location means the primary site.
 */
create or replace function public.service_price_at(p_service bigint, p_location bigint default null)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(
    (select sl.price_cents_override
     from public.service_locations sl
     where sl.service_id = p_service
       and sl.location_id = coalesce(p_location, public.default_location_id())
       and sl.is_active),
    (select s.price_cents from public.services s where s.id = p_service)
  );
$$;

-- A new site opens with the full active menu, which she then trims. The
-- alternative — a new location that offers nothing — looks broken rather than
-- empty, and there are no bookable hours there yet regardless.
create or replace function public.location_seed_menu()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.service_locations (service_id, location_id, is_active)
  select s.id, new.id, true from public.services s where s.is_active
  on conflict (service_id, location_id) do nothing;

  insert into public.product_stock (product_id, location_id, qty)
  select p.id, new.id, 0 from public.products p
  on conflict (product_id, location_id) do nothing;

  return null;
end;
$$;

-- A new service is offered everywhere until she says otherwise, for the same
-- reason: a service that exists but is bookable nowhere reads as a bug.
create or replace function public.service_seed_locations()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.service_locations (service_id, location_id, is_active)
  select new.id, l.id, true from public.locations l
  on conflict (service_id, location_id) do nothing;
  return null;
end;
$$;

drop trigger if exists services_seed_locations on public.services;
create trigger services_seed_locations after insert on public.services
  for each row execute function public.service_seed_locations();

-- ── Stock: shared catalogue, per-site count ──────────────────
--
-- A product is one product. Its SKU, its ingredients, its photograph and its
-- price are the same bottle wherever it sits, so `products` stays whole. What
-- is per-site is HOW MANY are on that shelf, and that is this table.
--
-- `products.stock_qty` is kept, and kept meaning what it has always meant: the
-- count at the PRIMARY location. It is a mirror of this table's primary-site
-- row, maintained by trigger in both directions.
--
-- The alternative — making stock_qty a roll-up across every site — was
-- rejected. Today the two are identical, so the choice is only about how each
-- fails on the day a second room opens. A roll-up fails silently and expensively:
-- the till at the new site reads "12 on hand", sells twelve, and ten of them
-- are on a shelf in another building. The primary-site mirror fails loudly and
-- cheaply: that till reads zero and refuses the sale until it is taught to pass
-- p_location. A refusal is recoverable; an oversold customer is not. It also
-- keeps `adjust_stock`'s return value and the low-stock alert about one shelf a
-- person can walk over to and count.
create table if not exists public.product_stock (
  product_id  bigint not null references public.products(id) on delete cascade,
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),
  qty         numeric(12,2) not null default 0,
  -- Null = use the product's own threshold. A busier site may want a deeper
  -- floor on the same bottle.
  low_stock_threshold numeric(12,2),
  updated_at  timestamptz not null default now(),
  primary key (product_id, location_id)
);

create index if not exists product_stock_location_idx
  on public.product_stock (location_id);

-- Everything currently counted is currently at the studio that exists.
-- ON CONFLICT DO NOTHING, not DO UPDATE: a re-run must never overwrite a count
-- somebody has since corrected.
insert into public.product_stock (product_id, location_id, qty)
select p.id, public.default_location_id(), p.stock_qty
from public.products p
on conflict (product_id, location_id) do nothing;

/**
 * Keep products.stock_qty showing the primary site's count.
 *
 * The pair of triggers below look circular and are not: each one writes only
 * when the value actually differs, so the second hop is a no-op and the chain
 * stops. That guard is load-bearing — remove it and an ordinary stock
 * adjustment recurses until "stack depth limit exceeded".
 */
create or replace function public.product_stock_mirror()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.location_id = public.default_location_id() then
    update public.products
    set stock_qty = new.qty
    where id = new.product_id and stock_qty is distinct from new.qty;
  end if;
  return null;
end;
$$;

drop trigger if exists product_stock_mirror on public.product_stock;
create trigger product_stock_mirror
  after insert or update of qty on public.product_stock
  for each row execute function public.product_stock_mirror();

/**
 * And the other direction: `staff updates products` (021) lets anyone on staff
 * write stock_qty straight from the Inventory page. That path predates this
 * table and still works; this is what stops it drifting away from it.
 *
 * AFTER, not BEFORE. A BEFORE trigger here reaches product_stock, whose own
 * mirror reaches back into the products row the current command is still
 * holding — Postgres rejects that outright with "tuple to be updated was
 * already modified by an operation triggered by the current command". By AFTER
 * time the row is settled and the mirror's write finds nothing to change.
 */
create or replace function public.product_stock_sync_back()
returns trigger language plpgsql security definer set search_path = public as $$
declare loc bigint;
begin
  loc := public.default_location_id();

  update public.product_stock
  set qty = new.stock_qty, updated_at = now()
  where product_id = new.id and location_id = loc and qty is distinct from new.stock_qty;

  if not found then
    insert into public.product_stock (product_id, location_id, qty)
    values (new.id, loc, new.stock_qty)
    on conflict (product_id, location_id) do nothing;
  end if;

  return null;
end;
$$;

drop trigger if exists products_stock_sync_back on public.products;
create trigger products_stock_sync_back
  after update of stock_qty on public.products
  for each row when (new.stock_qty is distinct from old.stock_qty)
  execute function public.product_stock_sync_back();

-- A product added after this migration needs a shelf at every site.
create or replace function public.product_seed_stock_rows()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.product_stock (product_id, location_id, qty)
  select new.id, l.id, case when l.id = public.default_location_id() then new.stock_qty else 0 end
  from public.locations l
  on conflict (product_id, location_id) do nothing;
  return null;
end;
$$;

drop trigger if exists products_seed_stock on public.products;
create trigger products_seed_stock after insert on public.products
  for each row execute function public.product_seed_stock_rows();

drop trigger if exists locations_seed_menu on public.locations;
create trigger locations_seed_menu after insert on public.locations
  for each row execute function public.location_seed_menu();

-- ── The one entry point for changing stock, now with an address ──
--
-- Same name, same first five arguments, same return: every existing caller —
-- the Inventory editor's RPC, order_decrement_stock, appointment_consume_stock
-- — keeps working untouched and lands on the primary site. Dropped and
-- recreated rather than overloaded, because two functions differing only by a
-- defaulted trailing argument make every five-argument call ambiguous.
drop function if exists public.adjust_stock(bigint, numeric, public.stock_reason, text, uuid);

create or replace function public.adjust_stock(
  p_product_id bigint,
  p_change     numeric,
  p_reason     public.stock_reason,
  p_note       text default null,
  p_appointment uuid default null,
  p_location   bigint default null
) returns numeric language plpgsql security definer set search_path = public as $$
declare
  new_balance  numeric;
  loc          bigint;
  loc_name     text;
  multi_site   boolean;
  product_name text;
  product_unit text;
  actor_name   text;
  actor_role   public.user_role;
begin
  select role into actor_role from public.profiles where id = auth.uid();

  -- auth.uid() is null for the service role and the SQL editor, which are
  -- already privileged. An authenticated caller must be staff.
  if auth.uid() is not null and (actor_role is null or actor_role = 'client') then
    raise exception 'Only staff can adjust stock';
  end if;

  loc := coalesce(p_location, public.default_location_id());

  select name, unit into product_name, product_unit
  from public.products where id = p_product_id;

  if product_name is null then
    raise exception 'Unknown product %', p_product_id;
  end if;

  -- A product created before this site opened has no shelf here yet.
  insert into public.product_stock (product_id, location_id, qty)
  values (p_product_id, loc, 0)
  on conflict (product_id, location_id) do nothing;

  update public.product_stock
  set qty = qty + p_change, updated_at = now()
  where product_id = p_product_id and location_id = loc
  returning qty into new_balance;

  insert into public.inventory_log
    (product_id, location_id, change_qty, balance_after, reason, note, appointment_id, changed_by)
  values (p_product_id, loc, p_change, new_balance, p_reason, p_note, p_appointment, auth.uid());

  -- Tell the managers, but only about deliberate counts. 'sold' and 'consumed'
  -- fire automatically on every sale and every completed appointment; notifying
  -- on those would bury the ones that need a human eye.
  if p_reason not in ('sold', 'consumed') and auth.uid() is not null then
    select trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))
    into actor_name from public.profiles where id = auth.uid();

    select count(*) > 1 into multi_site from public.locations where is_active;
    if multi_site then
      select name into loc_name from public.locations where id = loc;
    end if;

    insert into public.notifications (user_id, type, title, body, link)
    select p.id, 'system',
           'Stock updated — ' || product_name,
           coalesce(nullif(actor_name,''), 'Someone') || ' recorded ' ||
           (case when p_change >= 0 then '+' else '' end) || p_change || ' ' || product_unit ||
           ' (' || replace(p_reason::text, '_', ' ') || ')' ||
           coalesce(' at ' || loc_name, '') || '. Now ' || new_balance || '.',
           '/dashboard/inventory'
    from public.profiles p
    where p.role in ('manager', 'admin')
      and p.suspended_at is null
      and p.id <> auth.uid();   -- no point telling you what you just did
  end if;

  return new_balance;
end;
$$;

/** What is on that shelf right now. Null location means the primary site. */
create or replace function public.stock_on_hand(p_product_id bigint, p_location bigint default null)
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(
    (select ps.qty from public.product_stock ps
     where ps.product_id = p_product_id
       and ps.location_id = coalesce(p_location, public.default_location_id())),
    0
  );
$$;

-- Same two halves as 024, now asked of one shelf rather than of the business:
-- no stock sends the client to the marketplace, no price is a gap in the
-- catalogue for staff to close.
drop function if exists public.product_is_sellable(bigint);

create or replace function public.product_is_sellable(
  p_product_id bigint,
  p_location   bigint default null
) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.products p
    join public.product_stock ps
      on ps.product_id = p.id
     and ps.location_id = coalesce(p_location, public.default_location_id())
    where p.id = p_product_id
      and p.is_active
      and p.is_retail
      and p.archived_at is null
      and p.price_cents > 0
      and ps.qty > 0
  );
$$;

-- ── Retrofit: where did this happen? ─────────────────────────
--
-- Every column below is NOT NULL with the primary location as its default, so
-- every row already in the database is now attributed to the studio it actually
-- happened at, and nothing that inserts without naming a location breaks.

-- Where the visit happened.
alter table public.appointments
  add column if not exists location_id bigint not null
    default public.default_location_id()
    references public.locations(id) on delete restrict;

create index if not exists appointments_location_start_idx
  on public.appointments (location_id, starts_at desc);

-- NB: appointments_no_overlap stays scoped to (provider_id, slot) and is
-- deliberately NOT widened with location_id. A person cannot be in two
-- buildings at once, so a provider's double-booking guard has to hold ACROSS
-- sites — adding location_id to that constraint would let the same esthetician
-- be booked at both studios at 2pm.

-- Where the sale happened. Sales tax is assessed by district, so a receipt that
-- cannot say which counter it was rung up at cannot be filed.
alter table public.orders
  add column if not exists location_id bigint not null
    default public.default_location_id()
    references public.locations(id) on delete restrict;

create index if not exists orders_location_idx
  on public.orders (location_id, created_at desc);

-- Rooms are furniture. appointments_room_no_overlap needs no change: room ids
-- are unique across the business, so a room can only ever collide with itself.
alter table public.rooms
  add column if not exists location_id bigint not null
    default public.default_location_id()
    references public.locations(id) on delete restrict;

-- Movements happened somewhere too, which is what makes a per-site stock
-- history answerable.
alter table public.inventory_log
  add column if not exists location_id bigint not null
    default public.default_location_id()
    references public.locations(id) on delete restrict;

create index if not exists inventory_log_location_idx
  on public.inventory_log (location_id, created_at desc);

-- ── Opening hours, per site ──────────────────────────────────
--
-- The primary key was day_of_week alone: one week, for one business. Widening
-- it is the only change in this migration that alters an existing key, and it
-- has two consequences worth writing down rather than discovering:
--
--   1. 010's seed ends `on conflict (day_of_week) do nothing`, which no longer
--      names a unique constraint. Replaying 010 on an already-migrated database
--      now errors there. 001-018 were never re-runnable (001 stops at `create
--      type`), so this is not a path that worked before either — but it is a
--      path that got shorter, and 010 must not be edited to fix it.
--   2. Anything reading or writing business_hours without a location now sees
--      seven rows per site. That is correct and it is also not yet handled by
--      the footer, the Settings form, or anything else that predates this
--      migration. With one location nothing changes; with two, those callers
--      need a location filter.
do $$
begin
  if exists (
    select 1 from pg_constraint
    where conrelid = 'public.business_hours'::regclass
      and contype = 'p'
      and array_length(conkey, 1) = 1
  ) then
    alter table public.business_hours drop constraint business_hours_pkey;
  end if;
end $$;

alter table public.business_hours
  add column if not exists location_id bigint not null
    default public.default_location_id()
    references public.locations(id) on delete restrict;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.business_hours'::regclass and contype = 'p'
  ) then
    alter table public.business_hours
      add constraint business_hours_pkey primary key (location_id, day_of_week);
  end if;
end $$;

-- A new site opens with the existing week as its starting point, which is
-- closer to right than seven blank days.
create or replace function public.location_seed_hours()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.business_hours (location_id, day_of_week, opens_at, closes_at, is_closed)
  select new.id, d, null, null, false
  from generate_series(0, 6) d
  on conflict (location_id, day_of_week) do nothing;
  return null;
end;
$$;

drop trigger if exists locations_seed_hours on public.locations;
create trigger locations_seed_hours after insert on public.locations
  for each row execute function public.location_seed_hours();

-- ── Closures, per site ───────────────────────────────────────
-- One studio closing for a burst pipe is not the other one closing.
alter table public.closures drop constraint if exists closures_closure_date_key;

alter table public.closures
  add column if not exists location_id bigint not null
    default public.default_location_id()
    references public.locations(id) on delete restrict;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.closures'::regclass and conname = 'closures_location_date_key'
  ) then
    alter table public.closures
      add constraint closures_location_date_key unique (location_id, closure_date);
  end if;
end $$;

-- ── Working hours, per site ──────────────────────────────────
-- The point of the whole exercise: Tuesdays here, Thursdays there. Both rows
-- belong to the same provider and neither is a duplicate of the other, which is
-- why there is no unique constraint to widen.
alter table public.provider_schedules
  add column if not exists location_id bigint not null
    default public.default_location_id()
    references public.locations(id) on delete restrict;

create index if not exists provider_schedules_location_idx
  on public.provider_schedules (location_id, provider_id, day_of_week) where is_active;

-- A block is time off at a place. A dentist appointment blocks both sites in
-- practice, but a delivery that ties up one room does not — so it is recorded
-- against the room it ties up, and callers that mean "everywhere" write a row
-- per site.
alter table public.availability_blocks
  add column if not exists location_id bigint not null
    default public.default_location_id()
    references public.locations(id) on delete restrict;

create index if not exists availability_blocks_location_idx
  on public.availability_blocks (location_id, block_date);

-- ── RLS ──────────────────────────────────────────────────────
alter table public.locations         enable row level security;
alter table public.staff_locations   enable row level security;
alter table public.service_locations enable row level security;
alter table public.product_stock     enable row level security;

-- The booking page, the footer and the map all need an address. None of this is
-- private — it is on the front of the building — and the same fields are
-- already public in site_content.
drop policy if exists "public reads active locations" on public.locations;
create policy "public reads active locations" on public.locations
  for select to anon, authenticated using (is_active or public.is_staff());

drop policy if exists "manager writes locations" on public.locations;
create policy "manager writes locations" on public.locations
  for all using (public.is_manager()) with check (public.is_manager());

-- Staff see the whole roster across both sites. In a business this size the
-- front desk covering the phone has to know who is where; scoping this to your
-- own site would just mean phoning to ask.
drop policy if exists "staff reads staff locations" on public.staff_locations;
create policy "staff reads staff locations" on public.staff_locations
  for select using (public.is_staff() or profile_id = auth.uid());

-- The booking page filters providers by the chosen site, so it needs to know
-- where a bookable provider works — and nothing more. A manager's or a front
-- desk's assignment stays internal.
drop policy if exists "public reads bookable provider locations" on public.staff_locations;
create policy "public reads bookable provider locations" on public.staff_locations
  for select to anon, authenticated using (
    exists (
      select 1 from public.profiles p
      where p.id = profile_id
        and p.accepts_online_booking
        and p.suspended_at is null
    )
  );

drop policy if exists "manager writes staff locations" on public.staff_locations;
create policy "manager writes staff locations" on public.staff_locations
  for all using (public.is_manager()) with check (public.is_manager());

drop policy if exists "public reads active service locations" on public.service_locations;
create policy "public reads active service locations" on public.service_locations
  for select to anon, authenticated using (is_active or public.is_staff());

-- Admin-only for the same reason `services` is: price_cents_override IS a
-- price, and a front desk must not be able to move one.
drop policy if exists "admin writes service locations" on public.service_locations;
create policy "admin writes service locations" on public.service_locations
  for all using (public.is_admin()) with check (public.is_admin());

-- Exactly what `products` already exposes: a count for something the shop is
-- allowed to show anyway. Back-bar stock stays internal.
drop policy if exists "public reads sellable stock" on public.product_stock;
create policy "public reads sellable stock" on public.product_stock
  for select to anon, authenticated using (
    exists (
      select 1 from public.products p
      where p.id = product_id and p.is_active and p.is_retail and p.archived_at is null
    )
    or public.is_staff()
  );

-- Counting is not a manager decision — whoever is holding the bottle knows the
-- number. Same reasoning as 021, and adjust_stock still notifies afterwards.
drop policy if exists "staff updates stock" on public.product_stock;
create policy "staff updates stock" on public.product_stock
  for update using (public.is_staff()) with check (public.is_staff());

drop policy if exists "manager creates stock rows" on public.product_stock;
create policy "manager creates stock rows" on public.product_stock
  for insert with check (public.is_manager());

drop policy if exists "manager deletes stock rows" on public.product_stock;
create policy "manager deletes stock rows" on public.product_stock
  for delete using (public.is_manager());

-- ─────────────────────────────────────────────────────────────
-- 033_expenses.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 033: money going out
--
-- Everything up to here records revenue. `payments` is the ledger for money in,
-- `orders` and `appointments` are what it was for, and 025 closed the last gap
-- in it. Nothing anywhere records the studio paying for anything, so "how did
-- the month go" has only ever been answerable as a gross takings figure — which
-- for a single-room studio paying suite rent, a Rhonda Allison wholesale
-- account, insurance and a licence renewal is not a number that means much.
--
-- This adds the other half: what was spent, on what, when, and whether it is
-- deductible — plus the two report helpers that turn both halves into a profit
-- figure without double-counting stock. See the note on `is_cogs` below; that
-- is the one genuinely subtle thing in this file.
--
-- Re-runnable in full. Every object is guarded, because a migration you cannot
-- apply twice is a migration you cannot recover a half-applied deploy with.
-- ============================================================

-- ── What day is it, in the studio's zone? ────────────────────
--
-- The SQL counterpart of `dateKeyInTimeZone(new Date(requestNow()), tz)`. The
-- database server runs in UTC, so `current_date` rolls over at 4pm or 5pm local
-- and an expense entered on a Tuesday evening would be booked to Wednesday.
-- The zone is read from `booking_settings` — the same single row the booking
-- engine derives wall-clock from, so the two can never disagree about which day
-- it is.
create or replace function public.studio_today()
returns date language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce(
    (select b.timezone from public.booking_settings b where b.id = 1),
    'America/Los_Angeles'
  ))::date;
$$;

-- ── Categories ───────────────────────────────────────────────
--
-- Seeded with what this business actually spends on, because an empty category
-- list is the reason expense tracking gets abandoned in week two. The studio can
-- add their own; nothing here is closed.
--
-- `is_cogs` is the load-bearing column. A case of wax bought in March is a cash
-- outflow in March, but its *cost of goods* lands in whichever month the service
-- that consumed it was performed — and that second figure is already derivable
-- from `order_items` against `products.cost_cents`. Add both into one "expenses"
-- total and the stock is counted twice. So stock purchases are flagged here,
-- `profit_summary()` reports them on their own line, and the net figure uses the
-- derived COGS rather than the purchase. Removing this flag silently makes every
-- margin figure in the app wrong, which is why it is a column and not a
-- convention.
create table if not exists public.expense_categories (
  id          bigserial primary key,
  name        text not null,
  slug        text not null unique,
  description text,

  is_cogs     boolean not null default false,
  -- The tick the entry form starts on. Almost everything a studio buys is
  -- deductible; the exceptions (an owner's draw, a personal charge on the
  -- business card) are exactly the ones worth making someone untick.
  default_deductible boolean not null default true,

  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into public.expense_categories (slug, name, description, is_cogs, sort_order) values
  ('product-stock',   'Product & back-bar stock',
   'Retail inventory and professional product consumed during treatments.', true, 10),
  ('disposables',     'Disposables',
   'Gloves, sticks, strips, table paper, cotton, sanitising supplies.', false, 20),
  ('rent',            'Rent',
   'Suite rent and any common-area charge.', false, 30),
  ('utilities',       'Utilities',
   'Electricity, water, internet, phone.', false, 40),
  ('insurance',       'Insurance',
   'Professional liability, general liability, contents.', false, 50),
  ('licensing',       'Licensing & continuing education',
   'Esthetician and establishment licences, certifications, classes.', false, 60),
  ('software',        'Software & subscriptions',
   'Booking, accounting, hosting, design tools.', false, 70),
  ('marketing',       'Marketing & advertising',
   'Ads, print, photography, promotional product.', false, 80),
  ('processing-fees', 'Card processing fees',
   'Stripe and terminal fees. Not netted out of revenue anywhere else, so they '
   'belong here or they vanish.', false, 90),
  ('equipment',       'Equipment',
   'Steamers, lamps, beds, sterilisers, and their repair.', false, 100),
  ('laundry',         'Laundry & linens',
   'Towels, sheets, laundry service.', false, 110),
  ('professional',    'Professional services',
   'Bookkeeper, accountant, legal.', false, 120),
  ('other',           'Other',
   'Anything that does not fit — review these when they pile up.', false, 900)
on conflict (slug) do nothing;

-- ── Recurring templates ──────────────────────────────────────
--
-- WHY a separate table rather than `expenses.is_recurring` plus a generator:
--
--  1. A row in `expenses` is evidence that money left the account. A recurring
--     rule is an intention about money that has not left it yet. Putting both
--     in one table means every read has to remember which kind it is looking
--     at, and every sum has to filter — which is precisely the mistake that
--     makes a total wrong once and quietly wrong forever after.
--
--  2. Rent goes up. With a flag, "the rent is now $1,400" either rewrites the
--     eleven rows already posted at $1,325 or forks into an unrelated second
--     flagged row with no link to the first. With a template, you edit the
--     template: history stays as it was paid, and next month posts at the new
--     figure. That is the behaviour a bookkeeper expects.
--
--  3. Generation has to be idempotent, and idempotency needs a stable identity
--     for "this rule, this period". A flag gives you nothing to key on — you
--     would be matching on (category, vendor, amount, roughly this date), which
--     breaks the first time the amount changes. The template's id plus the
--     scheduled date is a real key, and it is enforced by a unique index below,
--     so `generate_recurring_expenses()` can be run by a cron, by hand, and
--     twice in the same minute without ever posting rent twice.
--
-- No `interval_count` ("every 2 months"): four cadences cover suite rent,
-- software, quarterly insurance and an annual licence, which is the whole of
-- this business. Arbitrary intervals would double the date arithmetic to
-- support a case that does not exist here.
create table if not exists public.recurring_expenses (
  id          bigserial primary key,
  description text not null,
  amount_cents int not null check (amount_cents <> 0),
  category_id bigint not null references public.expense_categories(id) on delete restrict,

  -- A known supplier from 007, or just a name for the ones not worth a record.
  vendor_id   bigint references public.vendors(id) on delete set null,
  vendor_name text,

  payment_method text not null default 'card'
    check (payment_method in ('card', 'cash', 'check', 'ach', 'autopay', 'other')),
  note        text,
  is_tax_deductible boolean not null default true,

  cadence     text not null default 'monthly'
    check (cadence in ('weekly', 'monthly', 'quarterly', 'yearly')),
  -- The first occurrence. Every later one is derived from it, never stored, so
  -- there is no `next_due_on` to drift out of step with what was actually posted.
  starts_on   date not null,
  ends_on     date,
  is_active   boolean not null default true,

  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint recurring_expenses_window check (ends_on is null or ends_on >= starts_on)
);

create index if not exists recurring_expenses_active_idx
  on public.recurring_expenses (starts_on) where is_active;

-- ── The expenses themselves ──────────────────────────────────
create table if not exists public.expenses (
  id           bigserial primary key,

  -- A date, deliberately not a timestamptz. An expense has no time of day —
  -- rent is due on the 1st, not at midnight in some zone — and storing an
  -- instant would invent a precision the receipt does not have and then make
  -- every month boundary a timezone question. Rule 3 governs scheduling, where
  -- the instant is the fact; here the calendar day is the fact.
  incurred_on  date not null default public.studio_today(),

  -- Negative is a vendor credit — a returned case, a refunded subscription.
  -- Zero is not a transaction. Same reasoning as record_payment() in 025.
  amount_cents int not null check (amount_cents <> 0),

  category_id  bigint not null references public.expense_categories(id) on delete restrict,
  description  text not null check (length(btrim(description)) > 0),

  vendor_id    bigint references public.vendors(id) on delete set null,
  -- The corner shop, a one-off contractor: real vendors get a `vendors` row,
  -- everything else gets a name and that is fine.
  vendor_name  text,

  payment_method text not null default 'card'
    check (payment_method in ('card', 'cash', 'check', 'ach', 'autopay', 'other')),

  -- Two different things, both optional. `reference` is what is printed on the
  -- paper — invoice number, check number, the last four. `receipt_path` is an
  -- object key in the private `receipts` bucket, served only through a
  -- short-lived signed URL, same rule as treatment photography.
  reference    text,
  receipt_path text,

  -- 007 already models a wholesale order properly, with vendor, lines and
  -- received quantities. Paying for one is not a second kind of purchase order;
  -- it is this expense pointing at that record. The unique index below is the
  -- point: a PO can be expensed once, so the classic "paid it, then paid it
  -- again from the statement" cannot happen silently.
  purchase_order_id bigint references public.purchase_orders(id) on delete set null,

  is_tax_deductible boolean not null default true,
  note         text,

  -- Set when this row was posted from a template, together with the scheduled
  -- date it was posted *for*. The two are separate because `incurred_on` is
  -- editable — rent paid late on the 4th is still the 1st's rent — and the
  -- generator keys off the schedule, not off when the cheque cleared.
  recurring_id     bigint references public.recurring_expenses(id) on delete set null,
  recurring_period date,

  recorded_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint expenses_recurring_pair
    check ((recurring_id is null) = (recurring_period is null))
);

create index if not exists expenses_date_idx     on public.expenses (incurred_on desc);
create index if not exists expenses_category_idx on public.expenses (category_id, incurred_on desc);
create index if not exists expenses_vendor_idx   on public.expenses (vendor_id) where vendor_id is not null;

-- The idempotency guarantee for recurring generation, stated as an index so it
-- holds against a concurrent second run and not merely against a careful one.
create unique index if not exists expenses_recurring_period_idx
  on public.expenses (recurring_id, recurring_period)
  where recurring_id is not null;

-- One purchase order, one expense.
create unique index if not exists expenses_purchase_order_idx
  on public.expenses (purchase_order_id)
  where purchase_order_id is not null;

drop trigger if exists expenses_touch on public.expenses;
create trigger expenses_touch before update on public.expenses
  for each row execute function public.touch_updated_at();

drop trigger if exists recurring_expenses_touch on public.recurring_expenses;
create trigger recurring_expenses_touch before update on public.recurring_expenses
  for each row execute function public.touch_updated_at();

-- Linking an expense to a purchase order but naming a different supplier is
-- always a mistake, and it is the kind that only surfaces a year later when the
-- vendor totals do not match the statements. Fill it from the PO instead of
-- asking, and correct it if it disagrees.
create or replace function public.expense_inherit_po_vendor()
returns trigger language plpgsql security definer set search_path = public as $$
declare po_vendor bigint;
begin
  if new.purchase_order_id is null then
    return new;
  end if;
  select po.vendor_id into po_vendor
  from public.purchase_orders po where po.id = new.purchase_order_id;
  if po_vendor is not null then
    new.vendor_id := po_vendor;
  end if;
  return new;
end;
$$;

drop trigger if exists expenses_inherit_po_vendor on public.expenses;
create trigger expenses_inherit_po_vendor
  before insert or update of purchase_order_id on public.expenses
  for each row execute function public.expense_inherit_po_vendor();

-- Deleting a template must not delete the rent that was already paid under it,
-- so the FK is ON DELETE SET NULL — but that clears `recurring_id` and leaves
-- `recurring_period` behind, which the pair constraint rejects, and the delete
-- fails with a check-constraint error that names neither table the studio was
-- looking at. (Postgres 15 could declare SET NULL over both columns; this has to
-- work on 14.) Detaching first is also the honest outcome: with no rule left,
-- those rows are ordinary expenses that happen to have been posted for a month,
-- and nothing can ever re-post them.
create or replace function public.recurring_expense_detach()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.expenses
  set recurring_id = null, recurring_period = null
  where recurring_id = old.id;
  return old;
end;
$$;

drop trigger if exists recurring_expenses_detach on public.recurring_expenses;
create trigger recurring_expenses_detach
  before delete on public.recurring_expenses
  for each row execute function public.recurring_expense_detach();

-- ── Recurring generation ─────────────────────────────────────

/**
 * Every date a rule falls due from its start through `p_through`.
 *
 * IMMUTABLE and parameterised rather than reading the rule itself, so the
 * dashboard can preview a schedule for a template nobody has saved yet.
 *
 * Occurrence n is `starts_on + n × step`, computed from the start every time,
 * and NOT `generate_series(start, stop, interval)` — which was the obvious way
 * to write this and is wrong at month end. generate_series steps from the value
 * it last produced, so a rule due on the 31st goes 31 Jan → 28 Feb → 28 Mar and
 * stays on the 28th forever after: February permanently reschedules the rent.
 * Measuring each occurrence from the start instead gives 31 Jan → 28 Feb →
 * 31 Mar → 30 Apr, which is what "due on the 31st" means to the landlord.
 *
 * The upper bound on n divides by the SHORTEST possible span for the cadence
 * (28 days for a month, 89 for a quarter — Feb–May in a common year), so it can
 * only ever overshoot; the `<= stop` filter trims the tail.
 */
create or replace function public.recurring_expense_dates(
  p_starts_on date,
  p_cadence   text,
  p_ends_on   date,
  p_through   date
) returns setof date language sql immutable as $$
  with span as (
    select
      least(p_through, coalesce(p_ends_on, p_through)) as stop,
      case p_cadence
        when 'weekly'    then interval '1 week'
        when 'monthly'   then interval '1 month'
        when 'quarterly' then interval '3 months'
        else                  interval '1 year'
      end as step,
      case p_cadence
        when 'weekly'    then 7
        when 'monthly'   then 28
        when 'quarterly' then 89
        else                  365
      end as shortest_days
  )
  select occurrence.d::date
  from span s
  cross join generate_series(
    0, greatest((s.stop - p_starts_on) / s.shortest_days, 0)) g(n)
  cross join lateral (select p_starts_on + (g.n * s.step)) occurrence(d)
  where occurrence.d::date <= s.stop;
$$;

/**
 * Post every occurrence that has come due and is not already on the books.
 *
 * Returns how many rows it actually wrote, so "nothing to post" and "posted
 * four" are distinguishable — running it twice returns 4 then 0, which is the
 * observable form of the idempotency the unique index enforces.
 *
 * SECURITY DEFINER with an explicit manager check, matching announcement_stats
 * in 028: the function needs to write past RLS, so it has to state for itself
 * who is allowed to call it. A null auth.uid() is the service role, a migration
 * or a scheduled job — all already privileged.
 */
create or replace function public.generate_recurring_expenses(p_through date default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  cutoff  date := coalesce(p_through, public.studio_today());
  written int;
begin
  if auth.uid() is not null and not public.is_manager() then
    raise exception 'Only a manager can post recurring expenses';
  end if;

  insert into public.expenses (
    incurred_on, amount_cents, category_id, description,
    vendor_id, vendor_name, payment_method, note, is_tax_deductible,
    recurring_id, recurring_period, recorded_by
  )
  select
    d, r.amount_cents, r.category_id, r.description,
    r.vendor_id, r.vendor_name, r.payment_method, r.note, r.is_tax_deductible,
    r.id, d,
    -- Whoever pressed the button owns the posting; an unattended run has no
    -- auth.uid() and falls back to whoever set the rule up, which is a truer
    -- answer than leaving it blank.
    coalesce(auth.uid(), r.created_by)
  from public.recurring_expenses r
  cross join lateral public.recurring_expense_dates(
    r.starts_on, r.cadence, r.ends_on, cutoff) d
  where r.is_active
  on conflict (recurring_id, recurring_period) where recurring_id is not null
  do nothing;

  get diagnostics written = row_count;
  return written;
end;
$$;

/**
 * The next date this rule falls due that has not been posted yet.
 *
 * "Not posted" rather than "after today" on purpose: a rule created in March
 * with a January start is behind, and the dashboard should say so rather than
 * cheerfully pointing at April. Lookahead is capped at two years so an active
 * rule with no end date still terminates.
 */
create or replace function public.recurring_expense_next_due(p_rule bigint)
returns date language sql stable security definer set search_path = public as $$
  select min(d)
  from public.recurring_expenses r
  cross join lateral public.recurring_expense_dates(
    r.starts_on, r.cadence, r.ends_on,
    (public.studio_today() + interval '2 years')::date) d
  where r.id = p_rule
    and public.is_manager()
    and not exists (
      select 1 from public.expenses e
      where e.recurring_id = r.id and e.recurring_period = d
    );
$$;

-- ── Report helpers ───────────────────────────────────────────
--
-- Both are SECURITY DEFINER and both re-check `is_manager()` in their own body.
-- A view would have been the obvious shape and is the wrong one: a Postgres view
-- runs as its owner unless created `with (security_invoker = on)`, which is how
-- `user_management_list` leaked every client's record until 028 dropped it. A
-- function that states its own authorisation cannot be reintroduced insecurely
-- by a later `create or replace` that forgets a setting.

/** What was spent per category over a date range, newest spend first. */
create or replace function public.expense_totals(p_from date, p_to date)
returns table (
  category_id   bigint,
  category_name text,
  is_cogs       boolean,
  entry_count   bigint,
  total_cents   bigint
) language sql stable security definer set search_path = public as $$
  select
    c.id,
    c.name,
    c.is_cogs,
    count(e.id),
    coalesce(sum(e.amount_cents), 0)::bigint
  from public.expense_categories c
  join public.expenses e
    on e.category_id = c.id
   and e.incurred_on between p_from and p_to
  where public.is_manager()
  group by c.id, c.name, c.is_cogs
  order by coalesce(sum(e.amount_cents), 0) desc;
$$;

/**
 * Revenue, cost of goods and expenses for a period, as integer cents.
 *
 * The reason this is one function and not three queries in the page: the
 * relationship between `stock_purchase_cents` and `cogs_cents` is not obvious
 * and getting it wrong is invisible. They measure the same product twice, from
 * different ends — what was bought, and what was sold — so exactly one of them
 * can be subtracted. `net_cents` uses cogs and reports the purchase figure
 * beside it for cash-flow, clearly labelled, never summed in.
 *
 * Revenue is recognised when the work happened (`appointments.starts_at`) and
 * when the order was paid, not when either was created — a facial booked in
 * March for April is April's revenue.
 *
 * Product revenue is net of sales tax: tax collected is the state's money being
 * held, not takings. Shipping stays in, because the postage it pays for is an
 * expense on the other side of this same report.
 *
 * COGS uses `products.cost_cents` as it stands today, because `order_items`
 * snapshots the price sold at but not the cost paid. That is accurate until a
 * wholesale price changes, and then it restates history. Fixing it properly
 * means a `cost_snapshot_cents` on `order_items` filled at sale time; noted
 * here rather than done, because it is a change to how a sale is written and
 * belongs with that code.
 */
create or replace function public.profit_summary(p_from date, p_to date)
returns table (
  service_revenue_cents   bigint,
  product_revenue_cents   bigint,
  cogs_cents              bigint,
  operating_expense_cents bigint,
  stock_purchase_cents    bigint,
  gross_margin_cents      bigint,
  net_cents               bigint
) language sql stable security definer set search_path = public as $$
  with tz as (
    select coalesce(
      (select b.timezone from public.booking_settings b where b.id = 1),
      'America/Los_Angeles') as zone
  ),
  window_bounds as (
    -- The same calendar days the expense side uses, turned into the instants the
    -- revenue side is stored in. Half-open at the top so the last day is whole
    -- however many hours it has: a DST Sunday is 23 or 25, never 24.
    select
      (p_from::timestamp at time zone t.zone)                        as from_at,
      ((p_to + 1)::timestamp at time zone t.zone)                    as to_at
    from tz t
  ),
  services as (
    select coalesce(sum(a.total_cents), 0)::bigint as cents
    from public.appointments a, window_bounds w
    where a.status = 'completed'
      and a.starts_at >= w.from_at and a.starts_at < w.to_at
  ),
  sold_orders as (
    select o.id, o.total_cents, o.tax_cents
    from public.orders o, window_bounds w
    where o.status in ('paid', 'fulfilling', 'ready_for_pickup', 'shipped', 'completed')
      and coalesce(o.paid_at, o.created_at) >= w.from_at
      and coalesce(o.paid_at, o.created_at) <  w.to_at
  ),
  products_sold as (
    select coalesce(sum(o.total_cents - o.tax_cents), 0)::bigint as cents
    from sold_orders o
  ),
  cogs as (
    select coalesce(sum(oi.qty * p.cost_cents), 0)::bigint as cents
    from sold_orders o
    join public.order_items oi on oi.order_id = o.id
    join public.products p     on p.id = oi.product_id
  ),
  spend as (
    select
      coalesce(sum(e.amount_cents) filter (where not c.is_cogs), 0)::bigint as operating,
      coalesce(sum(e.amount_cents) filter (where c.is_cogs), 0)::bigint     as stock
    from public.expenses e
    join public.expense_categories c on c.id = e.category_id
    where e.incurred_on between p_from and p_to
  )
  select
    s.cents,
    pr.cents,
    cg.cents,
    sp.operating,
    sp.stock,
    (s.cents + pr.cents - cg.cents)               as gross_margin_cents,
    (s.cents + pr.cents - cg.cents - sp.operating) as net_cents
  from services s, products_sold pr, cogs cg, spend sp
  where public.is_manager();
$$;

-- ── Receipts bucket (private) ────────────────────────────────
-- Object keys are `<yyyy-mm>/<uuid>.<ext>`. Nothing about a receipt identifies a
-- client, so unlike the treatment bucket the path carries no authorisation
-- information — the policy is a flat manager check and the file is only ever
-- reached through a signed URL minted server-side.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do nothing;

drop policy if exists "manager reads receipts" on storage.objects;
create policy "manager reads receipts" on storage.objects
  for select to authenticated using (bucket_id = 'receipts' and public.is_manager());

drop policy if exists "manager writes receipts" on storage.objects;
create policy "manager writes receipts" on storage.objects
  for insert to authenticated with check (bucket_id = 'receipts' and public.is_manager());

drop policy if exists "manager updates receipts" on storage.objects;
create policy "manager updates receipts" on storage.objects
  for update to authenticated using (bucket_id = 'receipts' and public.is_manager());

drop policy if exists "manager deletes receipts" on storage.objects;
create policy "manager deletes receipts" on storage.objects
  for delete to authenticated using (bucket_id = 'receipts' and public.is_manager());

-- ── RLS ──────────────────────────────────────────────────────
--
-- Manager and admin only, for reads as much as writes, on all three tables.
--
-- Front desk is excluded deliberately, and this is the one place in the app
-- where that role does not follow `is_front_desk()`. What the studio pays for
-- rent, what its wholesale margin is, and what it pays a bookkeeper are not
-- operational facts needed to run a day at the desk — they are the terms of the
-- business. Providers see nothing at all, including the category list, because
-- a category list with "Rent" and "Professional services" in it is already a
-- statement about how the business is run.
--
-- No policy mentions `anon`, so anon reads resolve to zero rows under RLS.

alter table public.expense_categories enable row level security;
alter table public.expenses           enable row level security;
alter table public.recurring_expenses enable row level security;

drop policy if exists "manager reads expense categories" on public.expense_categories;
create policy "manager reads expense categories" on public.expense_categories
  for select using (public.is_manager());

drop policy if exists "manager writes expense categories" on public.expense_categories;
create policy "manager writes expense categories" on public.expense_categories
  for all using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager reads expenses" on public.expenses;
create policy "manager reads expenses" on public.expenses
  for select using (public.is_manager());

drop policy if exists "manager writes expenses" on public.expenses;
create policy "manager writes expenses" on public.expenses
  for all using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager reads recurring expenses" on public.recurring_expenses;
create policy "manager reads recurring expenses" on public.recurring_expenses
  for select using (public.is_manager());

drop policy if exists "manager writes recurring expenses" on public.recurring_expenses;
create policy "manager writes recurring expenses" on public.recurring_expenses
  for all using (public.is_manager()) with check (public.is_manager());

comment on column public.expense_categories.is_cogs is
  'Stock purchases. Reported on their own line by profit_summary() and never '
  'added to operating expense, because the same product is already counted as '
  'cost of goods when it sells. Flipping this on a category changes every '
  'margin figure in the app.';

comment on column public.expenses.recurring_period is
  'The scheduled date this row was posted for, as opposed to incurred_on, which '
  'is when it was actually paid and may be edited. The unique index on '
  '(recurring_id, recurring_period) is what stops generate_recurring_expenses() '
  'posting the same month twice.';

-- ─────────────────────────────────────────────────────────────
-- 034_staff_permissions_commissions.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 034: what a person may do, and what they earn
--
-- Two things the owner asked for that turn out to be the same shape: the
-- studio's rules are per-person now, not per-tier, and they have to keep being
-- true about the past.
--
-- ── Part 1: permissions ─────────────────────────────────────
--
-- Authorisation today is the five-value `user_role` enum and the four helpers
-- in 001, and thirty-odd migrations of RLS are written against them. Nothing
-- here changes that. The role stays the baseline and grants sit on top of it:
--
--     permissions        the catalogue — what a permission even is
--     role_permissions   what each role holds by default
--     staff_permissions  per-person overrides, either direction
--     has_permission()   override first, then the role default, then no
--
-- Every existing policy keeps working untouched because none of them are
-- touched. New policies — including the commission tables below — can be as
-- fine-grained as they like. Migrating the existing thirty-one migrations onto
-- has_permission() in one pass would be a very good way to take the studio's
-- security boundary apart on a Tuesday, so it is not attempted here.
--
-- Being precise about what this is: has_permission() gates exactly what is
-- written against it and nothing else. Until a policy adopts it, a permission
-- describes intent and drives the UI. The commission tables in Part 2 are
-- written against it from the start, so the mechanism is load-bearing today,
-- not decorative.
--
-- The dangerous part is the grant path. 001 installs a trigger that refuses any
-- change to `profiles.role` from a non-admin, precisely so the otherwise
-- sensible "update own profile" policy cannot be used to self-promote. A table
-- of per-person permissions is that same hole cut a second time unless the
-- write path is guarded at least as well, so it is:
--
--   * You cannot grant yourself anything. Not a permission you lack, and not
--     one you already hold — an explicit grant outlives the role that
--     justified it, so "grant myself what I already have" is a real escalation
--     with a delay on it.
--   * You cannot grant what you do not hold. The set of permissions in
--     circulation can spread between people, but nobody can conjure one that
--     nobody had. Only an admin can introduce one.
--   * manage_permissions and manage_staff are admin-only to grant, flagged
--     is_sensitive in the catalogue, so the ability to spread anything at all
--     is admin-conferred.
--   * The check reads the role of `granted_by` — a stored NOT NULL column —
--     rather than auth.uid(), the way 031 checks `invited_by`. Triggers fire
--     for the service role too, so "only an admin granted this" is a property
--     of the row and not of whichever route handler wrote it.
--   * An admin cannot be overridden at all. is_admin() short-circuits every
--     policy in the database; a revoked permission on an admin would hide a
--     button while the SQL still said yes, which is the UI-as-security mistake
--     AGENTS.md warns about.
--
-- ── Part 2: commissions ─────────────────────────────────────
--
-- A plan is a rate card. An assignment binds a person to a plan, at a site,
-- between two dates — so a report for March reads March's plan and not
-- today's. That is the part people get wrong, and it is why the assignment
-- carries the dates rather than the plan carrying "current rate".
--
-- Commission is on money TAKEN. `payments` (025) is the ledger, refunds are
-- negative rows in it, and a no-show nobody paid for earns nothing. Billed
-- totals never enter the calculation.
--
-- Everything is integer cents and integer basis points — 4000 is 40.00%. The
-- arithmetic accumulates a numerator over a common denominator and divides
-- exactly once, so there is one truncation per figure and no float anywhere.
-- ============================================================

-- ════════════════════════════════════════════════════════════
--  PART 1 — PERMISSIONS
-- ════════════════════════════════════════════════════════════

-- ── The catalogue ────────────────────────────────────────────
create table if not exists public.permissions (
  key          text primary key,
  label        text not null,
  description  text not null,
  -- Groups the matrix in the dashboard. Free text rather than an enum so
  -- adding one is an insert, not a migration.
  category     text not null,
  -- Granting one of these is the power to grant everything else, so it stays
  -- admin-only however the studio configures the rest.
  is_sensitive boolean not null default false,
  sort_order   int not null default 0
);

comment on table public.permissions is
  'Every permission the studio can grant. The role enum is still the baseline; '
  'these sit on top of it.';

-- ── What each role holds without anyone deciding anything ────
--
-- Seeded to match what the roles can already do, so installing this migration
-- changes nobody''s access on the day it runs. `admin` has no rows on purpose:
-- an admin holds everything by definition and has_permission() says so
-- directly, which keeps the two statements from drifting apart.
create table if not exists public.role_permissions (
  role       public.user_role not null,
  permission text not null references public.permissions(key) on delete cascade,
  primary key (role, permission)
);

-- ── Per-person overrides ─────────────────────────────────────
create table if not exists public.staff_permissions (
  id         bigserial primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  permission text not null references public.permissions(key) on delete cascade,
  -- true grants what the role does not give; false takes away what it does.
  granted    boolean not null,
  reason     text,

  -- Who did this. NOT NULL is enforced in the guard trigger rather than the
  -- column, so that deleting the account of someone who once granted a
  -- permission does not take everyone else's permissions with it — the row
  -- keeps working, it just stops naming a granter. On the way in it is
  -- mandatory, and it is what the tier check is read from.
  granted_by uuid references public.profiles(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (profile_id, permission)
);

create index if not exists staff_permissions_profile_idx
  on public.staff_permissions (profile_id);

comment on table public.staff_permissions is
  'Per-person grants and revocations. One row beats the role default in either '
  'direction; no row means the role default applies.';

comment on column public.staff_permissions.granted_by is
  'The staff member who made this override. The self-grant guard reads this '
  'column, not auth.uid(), so the service role cannot attribute a grant to '
  'someone who could not have made it.';

-- An override is a statement about a person, not about a site. Every RLS
-- policy that will ever call has_permission() asks one question — "may this
-- caller do this?" — and a per-location answer would have to resolve a grant
-- at one site against a revocation at another before it could reply. A
-- security helper that returns "it depends" is a security helper nobody can
-- reason about, so this table is deliberately not location-scoped. Commission,
-- where the per-site answer is the whole point, is.

drop trigger if exists staff_permissions_touch on public.staff_permissions;
create trigger staff_permissions_touch
  before update on public.staff_permissions
  for each row execute function public.touch_updated_at();

-- ── The helper everything else is written against ────────────
--
-- SECURITY DEFINER for the same reason the 001 helpers are: a policy on
-- staff_permissions has to be able to read staff_permissions without
-- recursing through its own RLS. search_path is pinned to defeat shadowing.

/**
 * Does this profile hold this permission?
 *
 * Override first, then the role default, then no. Unknown permission names
 * return false rather than raising — a typo in a policy should deny, not throw
 * a 500 at whoever tripped over it. The foreign keys on both mapping tables
 * mean a typo cannot get stored in the first place.
 */
create or replace function public.profile_has_permission(
  p_profile    uuid,
  p_permission text
) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = p_profile
      and p.suspended_at is null
      and (
        -- An admin passes every check in the database already. Saying anything
        -- else here would be a UI-deep fiction.
        p.role = 'admin'
        or coalesce(
             (select sp.granted
                from public.staff_permissions sp
               where sp.profile_id = p.id
                 and sp.permission = p_permission),
             (select true
                from public.role_permissions rp
               where rp.role = p.role
                 and rp.permission = p_permission),
             false
           )
      )
  );
$$;

/** The same question about whoever is making this request. */
create or replace function public.has_permission(p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.profile_has_permission(auth.uid(), p_permission);
$$;

comment on function public.has_permission(text) is
  'Per-person permission check: the override wins, then the role default. '
  'Returns false for the service role (auth.uid() is null), which is correct — '
  'the service role bypasses RLS and never needs to ask.';

/**
 * May this person hand this permission to somebody else?
 *
 * Two rules, and the second one is the interesting one: you must already hold
 * what you are handing over. That makes the set of permissions in circulation
 * closed under everything a non-admin can do — it can spread between people
 * but it cannot grow. Only an admin introduces a permission nobody had.
 */
create or replace function public.can_grant_permission(
  p_actor      uuid,
  p_permission text
) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_actor
      and p.suspended_at is null
      and p.role <> 'client'
  )
  and (
    (select p.role = 'admin' from public.profiles p where p.id = p_actor)
    or (
      -- coalesce to true: a permission that is not in the catalogue is treated
      -- as sensitive, so an unknown name fails closed rather than open.
      not coalesce(
        (select pm.is_sensitive from public.permissions pm where pm.key = p_permission),
        true)
      and public.profile_has_permission(p_actor, 'manage_permissions')
      and public.profile_has_permission(p_actor, p_permission)
    )
  );
$$;

/**
 * Everything a person effectively holds, and why.
 *
 * `source` is 'role' or 'override' — the matrix in Settings needs to show the
 * difference, because "she can do this because she is a manager" and "she can
 * do this because you ticked it in March" are different facts.
 */
create or replace function public.effective_permissions(p_profile uuid)
returns table (
  permission  text,
  label       text,
  category    text,
  granted     boolean,
  source      text,
  sort_order  int
) language sql stable security definer set search_path = public as $$
  select
    pm.key,
    pm.label,
    pm.category,
    public.profile_has_permission(p_profile, pm.key),
    case
      when (select p.role from public.profiles p where p.id = p_profile) = 'admin'
        then 'role'
      when exists (
        select 1 from public.staff_permissions sp
        where sp.profile_id = p_profile and sp.permission = pm.key
      ) then 'override'
      else 'role'
    end,
    pm.sort_order
  from public.permissions pm
  where auth.uid() is null
     or p_profile = auth.uid()
     or public.is_admin()
     or public.has_permission('manage_permissions')
  order by pm.sort_order, pm.key;
$$;

-- ── The guard ────────────────────────────────────────────────
--
-- This is the trigger the whole feature stands on. RLS below says the same
-- things, but RLS only binds callers who are subject to it and
-- createAdminClient() is not one of them. Putting the rules here makes them
-- true for psql, for the service role, and for a route handler written in a
-- hurry at eleven at night.

create or replace function public.staff_permissions_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor       uuid;
  target_role public.user_role;
begin
  if tg_op = 'DELETE' then
    -- Clearing an override restores the role default, which is a privilege
    -- change in whichever direction the row was pointing.
    actor := auth.uid();

    -- No JWT means a migration, psql, or the service role — all already
    -- privileged, exactly as 001 documents for the profiles guard.
    if actor is null or public.is_admin() then
      return old;
    end if;

    if old.profile_id = actor and old.granted = false then
      raise exception
        'You cannot clear a restriction on your own account — an admin has to.';
    end if;

    if not public.can_grant_permission(actor, old.permission) then
      raise exception 'You cannot change % for anyone.', old.permission;
    end if;

    return old;
  end if;

  if new.granted_by is null then
    raise exception 'A permission override has to record who made it';
  end if;

  actor := new.granted_by;

  -- You act as yourself. Combined with the checks below — which all read the
  -- role of exactly this column — impersonating someone more senior buys
  -- nothing, because the row would then have to survive their tier check.
  if auth.uid() is not null and actor is distinct from auth.uid() then
    raise exception 'A permission override is recorded against whoever made it';
  end if;

  select role into target_role from public.profiles where id = new.profile_id;
  if target_role is null then
    raise exception 'There is no such profile to give a permission to';
  end if;
  if target_role = 'client' then
    raise exception
      'Permissions are for staff. Give them a staff role first.';
  end if;
  if target_role = 'admin' then
    raise exception
      'An admin already passes every check in the database — an override here '
      'would hide a button without stopping anything. Change the role instead.';
  end if;

  -- The hole 001 was written to close, cut a second time. Note that this
  -- refuses a self-grant of something you ALREADY hold, which looks harmless
  -- and is not: the override outlives the role that justified it, so it is a
  -- promotion with a delay on it.
  if new.profile_id = actor and new.granted then
    raise exception 'You cannot grant yourself a permission.';
  end if;

  if not public.can_grant_permission(actor, new.permission) then
    raise exception 'You cannot grant or revoke %.', new.permission;
  end if;

  return new;
end;
$$;

drop trigger if exists staff_permissions_guard on public.staff_permissions;
create trigger staff_permissions_guard
  before insert or update or delete on public.staff_permissions
  for each row execute function public.staff_permissions_guard();

/** The default map is the shape of the roles themselves. Admin only. */
create or replace function public.role_permissions_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can change what a role holds by default';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists role_permissions_guard on public.role_permissions;
create trigger role_permissions_guard
  before insert or update or delete on public.role_permissions
  for each row execute function public.role_permissions_guard();

-- ── A role change restates what someone may do ───────────────
--
-- Overrides do not survive it. A front desk employee who was granted
-- view_financial_reports and is then moved to provider should not keep it by
-- inertia; the person doing the demotion is deciding what this person may do,
-- and inherited exceptions are how "why can she see that?" happens six months
-- later. Re-granting is two clicks in the matrix.
--
-- This delete can never be refused by the guard above: changing a role
-- requires an admin (001), and the guard's DELETE branch lets an admin — and
-- the service role, which is how redeem_invitation promotes an invitee —
-- through unconditionally.
create or replace function public.clear_permission_overrides_on_role_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role then
    delete from public.staff_permissions where profile_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists profiles_clear_permission_overrides on public.profiles;
create trigger profiles_clear_permission_overrides
  after update of role on public.profiles
  for each row execute function public.clear_permission_overrides_on_role_change();

-- ── Setting one, from the dashboard ──────────────────────────
/**
 * Grant, revoke, or clear one permission for one person.
 *
 * p_granted true grants, false revokes, null clears the override so the role
 * default applies again. Returns what the person effectively holds afterwards.
 *
 * SECURITY DEFINER on purpose. The guard trigger is the authority either way —
 * it fires for definer calls exactly as it does for anyone else — and coming
 * through here means a refusal arrives as a sentence somebody can act on
 * rather than as "new row violates row-level security policy".
 */
create or replace function public.set_staff_permission(
  p_profile    uuid,
  p_permission text,
  p_granted    boolean,
  p_reason     text default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Sign in before changing permissions';
  end if;
  if not exists (select 1 from public.permissions where key = p_permission) then
    raise exception 'There is no permission called %', p_permission;
  end if;

  if p_granted is null then
    delete from public.staff_permissions
    where profile_id = p_profile and permission = p_permission;
  else
    insert into public.staff_permissions
      (profile_id, permission, granted, reason, granted_by)
    values (p_profile, p_permission, p_granted, p_reason, actor)
    on conflict (profile_id, permission) do update
      set granted    = excluded.granted,
          reason     = excluded.reason,
          granted_by = excluded.granted_by;
  end if;

  perform public.log_user_activity(
    p_profile,
    'permission_changed',
    jsonb_build_object(
      'permission', p_permission,
      'granted',    p_granted,
      'reason',     p_reason
    ),
    actor
  );

  return public.profile_has_permission(p_profile, p_permission);
end;
$$;

-- ── RLS ──────────────────────────────────────────────────────
alter table public.permissions       enable row level security;
alter table public.role_permissions  enable row level security;
alter table public.staff_permissions enable row level security;

-- The catalogue and the default map are labels and shape, not secrets — staff
-- need them to render anything at all. No anon policy on any of the three.
drop policy if exists "staff reads permissions" on public.permissions;
create policy "staff reads permissions" on public.permissions
  for select to authenticated using (public.is_staff());

drop policy if exists "admin writes permissions" on public.permissions;
create policy "admin writes permissions" on public.permissions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "staff reads role defaults" on public.role_permissions;
create policy "staff reads role defaults" on public.role_permissions
  for select to authenticated using (public.is_staff());

drop policy if exists "admin writes role defaults" on public.role_permissions;
create policy "admin writes role defaults" on public.role_permissions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- You may always see what you yourself hold. Being told what you can do is not
-- a privilege; being able to change it is.
drop policy if exists "read own permission overrides" on public.staff_permissions;
create policy "read own permission overrides" on public.staff_permissions
  for select to authenticated
  using (profile_id = auth.uid() or public.has_permission('manage_permissions'));

drop policy if exists "manage permission overrides" on public.staff_permissions;
create policy "manage permission overrides" on public.staff_permissions
  for all to authenticated
  using (public.has_permission('manage_permissions'))
  with check (public.has_permission('manage_permissions'));

grant select on public.permissions      to authenticated;
grant select on public.role_permissions to authenticated;
grant select, insert, update, delete on public.staff_permissions to authenticated;
grant usage, select on sequence public.staff_permissions_id_seq to authenticated;
grant all on public.permissions       to service_role;
grant all on public.role_permissions  to service_role;
grant all on public.staff_permissions to service_role;
grant usage, select on sequence public.staff_permissions_id_seq to service_role;
revoke all on public.permissions       from anon;
revoke all on public.role_permissions  from anon;
revoke all on public.staff_permissions from anon;

grant execute on function public.has_permission(text)                       to authenticated;
grant execute on function public.profile_has_permission(uuid, text)         to authenticated;
grant execute on function public.can_grant_permission(uuid, text)           to authenticated;
grant execute on function public.effective_permissions(uuid)                to authenticated;
grant execute on function public.set_staff_permission(uuid, text, boolean, text)
  to authenticated;
revoke all on function public.set_staff_permission(uuid, text, boolean, text) from anon;

-- ── Seed: the catalogue ──────────────────────────────────────
insert into public.permissions (key, label, description, category, is_sensitive, sort_order) values
  ('view_own_calendar', 'See their own calendar',
   'Their own appointments and hours.', 'Calendar', false, 10),
  ('view_calendar_all', 'See everyone''s calendar',
   'The whole studio''s day, not just their own column.', 'Calendar', false, 20),

  ('manage_clients', 'Manage clients',
   'The full client list: contact details, history, and adding someone new.',
   'Clients', false, 30),
  ('view_client_clinical', 'See clinical records',
   'Intake answers, treatment notes, patch tests, consent, and photos. Health '
   'information — grant it to the people who treat clients.', 'Clients', false, 40),

  ('manage_services', 'Edit the service menu',
   'Add, retire, and reword services and add-ons, including the age and '
   'consent gates.', 'Catalogue', false, 50),
  ('view_pricing', 'See cost and margin',
   'What products cost the studio and what each service actually earns. Not '
   'the same as the menu price, which is public.', 'Catalogue', false, 60),
  ('manage_pricing', 'Change prices',
   'Set service and product prices, deposits, and per-provider overrides.',
   'Catalogue', false, 70),

  ('manage_inventory', 'Manage inventory',
   'Add and retire products, set reorder levels, and run the back bar.',
   'Inventory', false, 80),
  ('adjust_stock', 'Count stock',
   'Record a delivery, a breakage, or a recount. Whoever is holding the bottle '
   'knows the number.', 'Inventory', false, 90),

  ('view_reports', 'See reports',
   'Bookings, retention, service mix, and how busy the room is.',
   'Reports', false, 100),
  ('view_financial_reports', 'See money reports',
   'Revenue, payouts, and commission — for the studio, not just for them.',
   'Reports', false, 110),
  ('manage_expenses', 'Record expenses',
   'Enter what the studio spent and on what.', 'Reports', false, 120),

  ('sell_retail', 'Ring up a sale',
   'Take payment at the counter and handle product orders.', 'Retail', false, 130),

  ('manage_staff', 'Manage staff',
   'Add and edit staff records, hours, and commission plans. Admin-only to '
   'grant.', 'Staff', true, 140),
  ('manage_permissions', 'Manage permissions',
   'Change what other people may do. Admin-only to grant, because it is the '
   'power to grant everything else.', 'Staff', true, 150),

  ('send_marketing', 'Send marketing',
   'Newsletters, campaigns, and broadcast messages.', 'Marketing', false, 160),
  ('manage_settings', 'Change studio settings',
   'Booking policy, opening hours, tax, and the public pages.',
   'Settings', false, 170)
on conflict (key) do update
  set label        = excluded.label,
      description  = excluded.description,
      category     = excluded.category,
      is_sensitive = excluded.is_sensitive,
      sort_order   = excluded.sort_order;

-- ── Seed: the defaults, matching what the roles can already do ──
--
-- `admin` is absent deliberately — see the comment on role_permissions.
-- `client` is absent because a client holds no staff permission at all.
insert into public.role_permissions (role, permission) values
  ('provider',   'view_own_calendar'),
  ('provider',   'view_client_clinical'),
  ('provider',   'adjust_stock'),

  ('front_desk', 'view_own_calendar'),
  ('front_desk', 'view_calendar_all'),
  ('front_desk', 'manage_clients'),
  ('front_desk', 'view_client_clinical'),
  ('front_desk', 'adjust_stock'),
  ('front_desk', 'sell_retail'),

  ('manager',    'view_own_calendar'),
  ('manager',    'view_calendar_all'),
  ('manager',    'manage_clients'),
  ('manager',    'view_client_clinical'),
  ('manager',    'view_pricing'),
  ('manager',    'manage_inventory'),
  ('manager',    'adjust_stock'),
  ('manager',    'view_reports'),
  ('manager',    'manage_expenses'),
  ('manager',    'sell_retail'),
  ('manager',    'send_marketing')
on conflict do nothing;

-- ════════════════════════════════════════════════════════════
--  PART 2 — COMMISSIONS
-- ════════════════════════════════════════════════════════════

-- ── The rate card ────────────────────────────────────────────
--
-- Rates are basis points. 4000 is 40.00%, and the whole calculation stays in
-- integers from the ledger to the payout.
create table if not exists public.commission_plans (
  id          bigserial primary key,
  name        text not null,
  description text,

  service_rate_bp int not null default 0
    check (service_rate_bp between 0 and 10000),
  retail_rate_bp  int not null default 0
    check (retail_rate_bp between 0 and 10000),
  -- Paid on top of the percentage, once per service performed. A studio that
  -- pays "35% plus $5 a facial" needs both.
  service_flat_cents int not null default 0 check (service_flat_cents >= 0),

  is_active  boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists commission_plans_name_key
  on public.commission_plans (lower(name));

-- A plan is a catalogue entry, not a place: the same "Provider standard" card
-- can be handed out at two sites. The location lives on the assignment, which
-- is where "she earns more at the Clovis room" actually means something.

/** Per-category rates, e.g. 45% on peels and 30% on everything else. */
create table if not exists public.commission_category_rates (
  plan_id     bigint not null references public.commission_plans(id) on delete cascade,
  category_id bigint not null references public.service_categories(id) on delete cascade,
  rate_bp     int check (rate_bp is null or rate_bp between 0 and 10000),
  flat_cents  int check (flat_cents is null or flat_cents >= 0),
  primary key (plan_id, category_id),
  constraint commission_category_rate_says_something
    check (rate_bp is not null or flat_cents is not null)
);

/** One service that pays differently from its category. The most specific
    statement available, so it wins over everything else. */
create table if not exists public.commission_service_rates (
  plan_id    bigint not null references public.commission_plans(id) on delete cascade,
  service_id bigint not null references public.services(id) on delete cascade,
  rate_bp    int check (rate_bp is null or rate_bp between 0 and 10000),
  flat_cents int check (flat_cents is null or flat_cents >= 0),
  primary key (plan_id, service_id),
  constraint commission_service_rate_says_something
    check (rate_bp is not null or flat_cents is not null)
);

/**
 * Tiers: the rate improves once the month passes a number.
 *
 * The band is read from what the provider has actually collected in the
 * calendar month the appointment falls in, at that site, in that site's
 * wall-clock. So a figure asked for mid-month moves as the month fills and
 * settles when the month closes, which is what a percentage-of-monthly-revenue
 * arrangement means.
 */
create table if not exists public.commission_tiers (
  id               bigserial primary key,
  plan_id          bigint not null references public.commission_plans(id) on delete cascade,
  applies_to       text not null check (applies_to in ('service', 'retail')),
  min_period_cents int not null check (min_period_cents >= 0),
  rate_bp          int not null check (rate_bp between 0 and 10000),
  unique (plan_id, applies_to, min_period_cents)
);

-- ── Who is on what, and since when ───────────────────────────
create table if not exists public.staff_commission_plans (
  id          bigserial primary key,
  profile_id  uuid   not null references public.profiles(id) on delete cascade,
  plan_id     bigint not null references public.commission_plans(id) on delete restrict,
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),

  -- Wall-clock dates in the location's zone, not instants. "She moved to the
  -- new plan on the first of March" is a statement about a calendar.
  effective_from date not null,
  effective_to   date,

  note       text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint staff_commission_plan_window
    check (effective_to is null or effective_to >= effective_from)
);

create index if not exists staff_commission_plans_lookup_idx
  on public.staff_commission_plans (profile_id, location_id, effective_from desc);

-- Two plans in force for one person at one site on one day is not a policy
-- decision anyone can make, so it is not representable. Same instinct as the
-- double-booking guard in 004: the application can render whatever it likes,
-- the constraint is what makes it true. btree_gist comes from 001.
alter table public.staff_commission_plans
  drop constraint if exists staff_commission_plans_no_overlap;
alter table public.staff_commission_plans
  add constraint staff_commission_plans_no_overlap
  exclude using gist (
    profile_id  with =,
    location_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  );

comment on table public.staff_commission_plans is
  'Which plan a person is on, at which site, between which dates. A report for '
  'March has to read March''s row — that is what the dates are for.';

drop trigger if exists commission_plans_touch on public.commission_plans;
create trigger commission_plans_touch
  before update on public.commission_plans
  for each row execute function public.touch_updated_at();

drop trigger if exists staff_commission_plans_touch on public.staff_commission_plans;
create trigger staff_commission_plans_touch
  before update on public.staff_commission_plans
  for each row execute function public.touch_updated_at();

-- ── A rate that has been in force is frozen ──────────────────
--
-- Otherwise every historical figure is a lie waiting to happen: edit "Provider
-- standard" from 40% to 45% and last March silently repays itself. The
-- remedy is the one the assignment table already exists for — make a new plan
-- and assign it from a date.
--
-- Renaming, describing and deactivating stay open, because none of those
-- change a number. Assignments themselves stay editable by an admin: getting
-- an assignment wrong has to be fixable, and moving somebody's dates is a
-- visible act on a five-row table, where quietly editing a rate under an
-- unchanged plan name is not. Freeze the change nobody can see.
create or replace function public.commission_plan_freeze_rates()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.service_rate_bp    is distinct from old.service_rate_bp
      or new.retail_rate_bp  is distinct from old.retail_rate_bp
      or new.service_flat_cents is distinct from old.service_flat_cents)
     and exists (
       select 1 from public.staff_commission_plans scp
       where scp.plan_id = old.id
         and scp.effective_from <= current_date
     ) then
    raise exception
      'This plan has already been in force. Create a new plan and assign it '
      'from a date rather than changing what someone was owed.';
  end if;
  return new;
end;
$$;

drop trigger if exists commission_plans_freeze_rates on public.commission_plans;
create trigger commission_plans_freeze_rates
  before update on public.commission_plans
  for each row execute function public.commission_plan_freeze_rates();

/** The same argument, for the rate tables hanging off the plan. */
create or replace function public.commission_rate_row_freeze()
returns trigger language plpgsql security definer set search_path = public as $$
declare target bigint;
begin
  target := case when tg_op = 'DELETE' then old.plan_id else new.plan_id end;
  if exists (
    select 1 from public.staff_commission_plans scp
    where scp.plan_id = target and scp.effective_from <= current_date
  ) then
    raise exception
      'This plan has already been in force. Create a new plan rather than '
      'changing what someone was owed.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists commission_category_rates_freeze on public.commission_category_rates;
create trigger commission_category_rates_freeze
  before insert or update or delete on public.commission_category_rates
  for each row execute function public.commission_rate_row_freeze();

drop trigger if exists commission_service_rates_freeze on public.commission_service_rates;
create trigger commission_service_rates_freeze
  before insert or update or delete on public.commission_service_rates
  for each row execute function public.commission_rate_row_freeze();

drop trigger if exists commission_tiers_freeze on public.commission_tiers;
create trigger commission_tiers_freeze
  before insert or update or delete on public.commission_tiers
  for each row execute function public.commission_rate_row_freeze();

-- ── Nobody puts themselves on a plan ─────────────────────────
create or replace function public.staff_commission_plans_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  row_profile uuid;
  row_out     public.staff_commission_plans;
begin
  if tg_op = 'DELETE' then
    row_profile := old.profile_id;
    row_out     := old;
  else
    row_profile := new.profile_id;
    row_out     := new;
  end if;

  -- Migration, psql, or the service role — already privileged, as in 001.
  if auth.uid() is null or public.is_admin() then
    return row_out;
  end if;

  if row_profile = auth.uid() then
    raise exception 'You cannot put yourself on a commission plan.';
  end if;

  if not public.has_permission('manage_staff') then
    raise exception 'You cannot change commission plans.';
  end if;

  return row_out;
end;
$$;

drop trigger if exists staff_commission_plans_guard on public.staff_commission_plans;
create trigger staff_commission_plans_guard
  before insert or update or delete on public.staff_commission_plans
  for each row execute function public.staff_commission_plans_guard();

-- ── Resolving a plan for a date ──────────────────────────────

/**
 * The site's wall-clock date for an instant.
 *
 * `locations.timezone` is authoritative and there is no fallback: an unknown
 * location returns null and every figure downstream returns zero, which is the
 * right answer for "I cannot tell you where this happened".
 */
create or replace function public.commission_service_date(
  p_instant  timestamptz,
  p_location bigint
) returns date language sql stable security definer set search_path = public as $$
  select (p_instant at time zone l.timezone)::date
  from public.locations l
  where l.id = p_location;
$$;

-- Where the work happened comes from `appointments.location_id` and
-- `orders.location_id`, both added in 032. Nothing below infers a site, which
-- is what makes "she earns more at the second room" mean something the moment
-- there is a second room.

/**
 * The plan in force for this person, at this site, on this date.
 *
 * Deliberately does not care whether the plan is still active: a retired plan
 * still governs the months it was in force, and a report for those months has
 * to say what was actually owed.
 */
create or replace function public.commission_plan_on(
  p_profile  uuid,
  p_location bigint,
  p_on       date
) returns bigint language sql stable security definer set search_path = public as $$
  select scp.plan_id
  from public.staff_commission_plans scp
  where scp.profile_id  = p_profile
    and scp.location_id = p_location
    and scp.effective_from <= p_on
    and (scp.effective_to is null or scp.effective_to >= p_on)
  order by scp.effective_from desc
  limit 1;
$$;

/** Money actually taken on this person's services in a window, at a site. */
create or replace function public.commission_collected_service_cents(
  p_profile  uuid,
  p_location bigint,
  p_from     date,
  p_to       date
) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(pay.amount_cents), 0)::bigint
  from public.payments pay
  join public.appointments a on a.id = pay.appointment_id
  where a.provider_id = p_profile
    and a.location_id = p_location
    and pay.status = 'succeeded'
    and public.commission_service_date(a.starts_at, p_location) between p_from and p_to;
$$;

/** The same for retail rung up by this person. */
create or replace function public.commission_collected_retail_cents(
  p_profile  uuid,
  p_location bigint,
  p_from     date,
  p_to       date
) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(pay.amount_cents), 0)::bigint
  from public.payments pay
  join public.orders o on o.id = pay.order_id
  where o.sold_by = p_profile
    and o.location_id = p_location
    and pay.status = 'succeeded'
    and public.commission_service_date(
          coalesce(o.paid_at, o.created_at), p_location) between p_from and p_to;
$$;

/** The best tier the period's takings reach, or null for "use the plan rate". */
create or replace function public.commission_tier_rate(
  p_plan         bigint,
  p_kind         text,
  p_period_cents bigint
) returns int language sql stable security definer set search_path = public as $$
  select t.rate_bp
  from public.commission_tiers t
  where t.plan_id = p_plan
    and t.applies_to = p_kind
    and t.min_period_cents <= greatest(p_period_cents, 0)
  order by t.min_period_cents desc
  limit 1;
$$;

/**
 * May this person be told what that person earned?
 *
 * Yourself always; otherwise it is a money report.
 */
create or replace function public.can_read_commission(p_profile uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is null
      or auth.uid() = p_profile
      or public.is_admin()
      or public.has_permission('view_financial_reports')
      or public.has_permission('manage_staff');
$$;

-- ── The calculation ──────────────────────────────────────────

/**
 * What this appointment earned its provider, in cents.
 *
 * Reads the plan that was in force on the day of the appointment, in the
 * site's wall-clock — not today's plan. Pays on money taken, so an appointment
 * nobody paid for is worth nothing however it is marked, and a forfeited
 * deposit on a no-show is worth the deposit, because that money did arrive.
 * Refunds are negative rows in `payments` and net themselves out.
 *
 * Rate precedence, most specific first: the service, then its category, then
 * the tier the month has reached, then the plan's own rate.
 *
 * The arithmetic: every line contributes to one numerator over the common
 * denominator (line value × 10000), and there is exactly one integer division
 * at the end. No float, one truncation, and partial payment is honoured pro
 * rata rather than by paying on what was merely billed.
 *
 * p_location is a filter, not an override — the appointment knows where it
 * happened, and asking about a site it did not happen at is answered with zero
 * rather than with that site's rates applied to somebody else's work.
 */
create or replace function public.commission_for_appointment(
  p_appointment uuid,
  p_location    bigint default null
) returns int language plpgsql stable security definer set search_path = public as $$
declare
  a            public.appointments%rowtype;
  loc          bigint;
  svc_date     date;
  plan         bigint;
  collected    bigint;
  line_value   bigint;
  period_cents bigint;
  tier_bp      int;
  plan_rate    int;
  plan_flat    int;
  numerator    bigint;
begin
  select * into a from public.appointments where id = p_appointment;
  if not found then
    return 0;
  end if;

  if not public.can_read_commission(a.provider_id) then
    raise exception 'You cannot read commission figures for someone else';
  end if;

  loc := a.location_id;
  if p_location is not null and p_location <> loc then
    return 0;
  end if;

  svc_date := public.commission_service_date(a.starts_at, loc);
  if svc_date is null then
    return 0;
  end if;

  -- No plan in force at that site on that day is not an error, it is zero.
  -- Falling back to a plan from a different site would quietly pay the wrong
  -- rate, which is worse than paying nothing and being asked about it.
  plan := public.commission_plan_on(a.provider_id, loc, svc_date);
  if plan is null then
    return 0;
  end if;

  select coalesce(sum(pay.amount_cents), 0) into collected
  from public.payments pay
  where pay.appointment_id = a.id and pay.status = 'succeeded';

  if collected <= 0 then
    return 0;
  end if;

  select coalesce(sum(price_cents), 0) into line_value
  from public.appointment_services where appointment_id = a.id;

  if line_value <= 0 then
    return 0;
  end if;

  -- A tip or an overpayment is not service revenue.
  collected := least(collected, line_value);

  select cp.service_rate_bp, cp.service_flat_cents
    into plan_rate, plan_flat
  from public.commission_plans cp where cp.id = plan;

  period_cents := public.commission_collected_service_cents(
    a.provider_id, loc,
    date_trunc('month', svc_date)::date,
    (date_trunc('month', svc_date) + interval '1 month - 1 day')::date
  );
  tier_bp := public.commission_tier_rate(plan, 'service', period_cents);

  select coalesce(sum(
           collected * line.price_cents * coalesce(line.rate_bp, tier_bp, plan_rate)
           -- Flat is per service performed, so add-on lines do not attract it.
           + case when line.service_id is not null
                  then collected * coalesce(line.flat_cents, plan_flat) * 10000
                  else 0 end
         ), 0)
    into numerator
  from (
    select
      s.service_id,
      s.price_cents::bigint as price_cents,
      coalesce(sr.rate_bp, cr.rate_bp)       as rate_bp,
      coalesce(sr.flat_cents, cr.flat_cents) as flat_cents
    from public.appointment_services s
    left join public.services svc on svc.id = s.service_id
    left join public.commission_service_rates sr
      on sr.plan_id = plan and sr.service_id = s.service_id
    left join public.commission_category_rates cr
      on cr.plan_id = plan and cr.category_id = svc.category_id
    where s.appointment_id = a.id
  ) line;

  -- Truncating rather than rounding costs under a cent per line and keeps the
  -- figure reproducible from the ledger without a rounding convention to argue
  -- about.
  return (numerator / (line_value * 10000))::int;
end;
$$;

/**
 * What this retail order earned whoever rang it up, in cents.
 *
 * An online order has no `sold_by` and earns nobody anything — no one stood at
 * a counter. Commission is on the goods, not on the sales tax or the postage,
 * so the base is subtotal less discount while the collection ratio is measured
 * against the total the client actually owed.
 */
create or replace function public.commission_for_order(
  p_order    bigint,
  p_location bigint default null
) returns int language plpgsql stable security definer set search_path = public as $$
declare
  o            public.orders%rowtype;
  loc          bigint;
  sale_date    date;
  plan         bigint;
  collected    bigint;
  base         bigint;
  period_cents bigint;
  rate_bp      int;
begin
  select * into o from public.orders where id = p_order;
  if not found or o.sold_by is null then
    return 0;
  end if;

  if not public.can_read_commission(o.sold_by) then
    raise exception 'You cannot read commission figures for someone else';
  end if;

  loc := o.location_id;
  if p_location is not null and p_location <> loc then
    return 0;
  end if;

  sale_date := public.commission_service_date(coalesce(o.paid_at, o.created_at), loc);
  if sale_date is null then
    return 0;
  end if;

  plan := public.commission_plan_on(o.sold_by, loc, sale_date);
  if plan is null then
    return 0;
  end if;

  select coalesce(sum(pay.amount_cents), 0) into collected
  from public.payments pay
  where pay.order_id = o.id and pay.status = 'succeeded';

  if collected <= 0 or o.total_cents <= 0 then
    return 0;
  end if;
  collected := least(collected, o.total_cents::bigint);

  base := greatest(o.subtotal_cents - o.discount_cents, 0)::bigint;
  if base <= 0 then
    return 0;
  end if;

  period_cents := public.commission_collected_retail_cents(
    o.sold_by, loc,
    date_trunc('month', sale_date)::date,
    (date_trunc('month', sale_date) + interval '1 month - 1 day')::date
  );

  rate_bp := coalesce(
    public.commission_tier_rate(plan, 'retail', period_cents),
    (select cp.retail_rate_bp from public.commission_plans cp where cp.id = plan)
  );

  return ((collected * base * rate_bp) / (o.total_cents::bigint * 10000))::int;
end;
$$;

/**
 * What one person earned over a window, at one site or across all of them.
 *
 * p_location null means every site, which is the figure the studio pays out;
 * naming a site is how "what did the Clovis room cost me" gets answered. Each
 * appointment and order is priced by the plan in force on its own date, so a
 * window that straddles a plan change comes out right without anyone having to
 * split it by hand.
 */
create or replace function public.commission_for_period(
  p_profile  uuid,
  p_from     date,
  p_to       date,
  p_location bigint default null
) returns table (
  service_cents bigint,
  retail_cents  bigint,
  total_cents   bigint
) language plpgsql stable security definer set search_path = public as $$
declare
  loc      bigint;
  svc_sum  bigint := 0;
  ret_sum  bigint := 0;
  r        record;
begin
  if not public.can_read_commission(p_profile) then
    raise exception 'You cannot read commission figures for someone else';
  end if;

  for loc in
    select l.id from public.locations l
    where p_location is null or l.id = p_location
  loop
    for r in
      select a.id
      from public.appointments a
      where a.provider_id = p_profile
        and a.location_id = loc
        and public.commission_service_date(a.starts_at, loc) between p_from and p_to
    loop
      svc_sum := svc_sum + public.commission_for_appointment(r.id, loc);
    end loop;

    for r in
      select o.id
      from public.orders o
      where o.sold_by = p_profile
        and o.location_id = loc
        and public.commission_service_date(
              coalesce(o.paid_at, o.created_at), loc) between p_from and p_to
    loop
      ret_sum := ret_sum + public.commission_for_order(r.id, loc);
    end loop;
  end loop;

  service_cents := svc_sum;
  retail_cents  := ret_sum;
  total_cents   := svc_sum + ret_sum;
  return next;
end;
$$;

-- ── RLS ──────────────────────────────────────────────────────
alter table public.commission_plans          enable row level security;
alter table public.commission_category_rates enable row level security;
alter table public.commission_service_rates  enable row level security;
alter table public.commission_tiers          enable row level security;
alter table public.staff_commission_plans    enable row level security;

-- What you are paid is not a secret from you. Everyone else needs a reason.
drop policy if exists "read commission plans" on public.commission_plans;
create policy "read commission plans" on public.commission_plans
  for select to authenticated
  using (
    public.has_permission('view_financial_reports')
    or public.has_permission('manage_staff')
    or exists (
      -- Qualified: staff_commission_plans has an `id` of its own, and an
      -- unqualified one here binds to the inner table, not to the plan.
      select 1 from public.staff_commission_plans scp
      where scp.plan_id = commission_plans.id and scp.profile_id = auth.uid()
    )
  );

drop policy if exists "manage commission plans" on public.commission_plans;
create policy "manage commission plans" on public.commission_plans
  for all to authenticated
  using (public.has_permission('manage_staff'))
  with check (public.has_permission('manage_staff'));

drop policy if exists "read category rates" on public.commission_category_rates;
create policy "read category rates" on public.commission_category_rates
  for select to authenticated
  using (
    public.has_permission('view_financial_reports')
    or public.has_permission('manage_staff')
    or exists (
      select 1 from public.staff_commission_plans scp
      where scp.plan_id = commission_category_rates.plan_id
        and scp.profile_id = auth.uid()
    )
  );

drop policy if exists "manage category rates" on public.commission_category_rates;
create policy "manage category rates" on public.commission_category_rates
  for all to authenticated
  using (public.has_permission('manage_staff'))
  with check (public.has_permission('manage_staff'));

drop policy if exists "read service rates" on public.commission_service_rates;
create policy "read service rates" on public.commission_service_rates
  for select to authenticated
  using (
    public.has_permission('view_financial_reports')
    or public.has_permission('manage_staff')
    or exists (
      select 1 from public.staff_commission_plans scp
      where scp.plan_id = commission_service_rates.plan_id
        and scp.profile_id = auth.uid()
    )
  );

drop policy if exists "manage service rates" on public.commission_service_rates;
create policy "manage service rates" on public.commission_service_rates
  for all to authenticated
  using (public.has_permission('manage_staff'))
  with check (public.has_permission('manage_staff'));

drop policy if exists "read commission tiers" on public.commission_tiers;
create policy "read commission tiers" on public.commission_tiers
  for select to authenticated
  using (
    public.has_permission('view_financial_reports')
    or public.has_permission('manage_staff')
    or exists (
      select 1 from public.staff_commission_plans scp
      where scp.plan_id = commission_tiers.plan_id
        and scp.profile_id = auth.uid()
    )
  );

drop policy if exists "manage commission tiers" on public.commission_tiers;
create policy "manage commission tiers" on public.commission_tiers
  for all to authenticated
  using (public.has_permission('manage_staff'))
  with check (public.has_permission('manage_staff'));

drop policy if exists "read own commission assignment" on public.staff_commission_plans;
create policy "read own commission assignment" on public.staff_commission_plans
  for select to authenticated
  using (
    profile_id = auth.uid()
    or public.has_permission('view_financial_reports')
    or public.has_permission('manage_staff')
  );

drop policy if exists "manage commission assignments" on public.staff_commission_plans;
create policy "manage commission assignments" on public.staff_commission_plans
  for all to authenticated
  using (public.has_permission('manage_staff'))
  with check (public.has_permission('manage_staff'));

grant select, insert, update, delete on public.commission_plans          to authenticated;
grant select, insert, update, delete on public.commission_category_rates to authenticated;
grant select, insert, update, delete on public.commission_service_rates  to authenticated;
grant select, insert, update, delete on public.commission_tiers          to authenticated;
grant select, insert, update, delete on public.staff_commission_plans    to authenticated;
grant usage, select on sequence public.commission_plans_id_seq       to authenticated;
grant usage, select on sequence public.commission_tiers_id_seq       to authenticated;
grant usage, select on sequence public.staff_commission_plans_id_seq to authenticated;

grant all on public.commission_plans          to service_role;
grant all on public.commission_category_rates to service_role;
grant all on public.commission_service_rates  to service_role;
grant all on public.commission_tiers          to service_role;
grant all on public.staff_commission_plans    to service_role;
grant usage, select on sequence public.commission_plans_id_seq       to service_role;
grant usage, select on sequence public.commission_tiers_id_seq       to service_role;
grant usage, select on sequence public.staff_commission_plans_id_seq to service_role;

revoke all on public.commission_plans          from anon;
revoke all on public.commission_category_rates from anon;
revoke all on public.commission_service_rates  from anon;
revoke all on public.commission_tiers          from anon;
revoke all on public.staff_commission_plans    from anon;

grant execute on function public.commission_for_appointment(uuid, bigint)       to authenticated;
grant execute on function public.commission_for_order(bigint, bigint)           to authenticated;
grant execute on function public.commission_for_period(uuid, date, date, bigint) to authenticated;
grant execute on function public.commission_plan_on(uuid, bigint, date)         to authenticated;
grant execute on function public.can_read_commission(uuid)                      to authenticated;
revoke all on function public.commission_for_appointment(uuid, bigint)          from anon;
revoke all on function public.commission_for_order(bigint, bigint)              from anon;
revoke all on function public.commission_for_period(uuid, date, date, bigint)   from anon;

-- ── Seed: something to assign ────────────────────────────────
-- One plan, at the rates the studio quoted. Nobody is assigned to it — who is
-- on what is a decision, and the dashboard is where it gets made.
insert into public.commission_plans (name, description, service_rate_bp, retail_rate_bp)
select 'Provider standard',
       'The default rate card: 40% of service revenue collected, 10% of retail.',
       4000, 1000
where not exists (
  select 1 from public.commission_plans where lower(name) = 'provider standard'
);

-- ─────────────────────────────────────────────────────────────
-- 035_time_tracking.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 035: time tracking
--
-- Clock in, clock out, breaks the studio defines itself, and a nudge for the
-- two things people actually forget.
--
-- This is a wage record. That single fact decides every design choice below:
--
--   • The invariants live in the database. A UI that forgets to check is a
--     bug; a database that lets two shifts overlap is a payroll dispute. Same
--     reasoning as the booking guard in 004 — the exclusion constraint is what
--     makes it TRUE, the app just renders sensibly.
--   • Nothing is recomputed from a template after the fact. A break carries a
--     snapshot of whether it was paid, exactly as consent_signatures carries
--     body_snapshot, because renaming "Lunch" to paid next year must not
--     silently restate what someone was paid for last year.
--   • Every change to a punch after it was made is logged with its author.
--     An unaudited edit to a wage record is indistinguishable from wage theft.
--
-- What this deliberately does NOT do: overtime, daily/weekly thresholds, the
-- seventh-consecutive-day rule, meal-period premiums, split-shift differentials.
-- See the note above worked_minutes(). Half of California's wage order is worse
-- than none of it.
-- ============================================================

-- ── Whole minutes, once, in one place ────────────────────────
--
-- Payroll is integer minutes for the same reason money is integer cents: a
-- float that is 0.4 seconds off is a number nobody can reconcile. Every
-- duration in this migration goes through here.
--
-- Truncation, not rounding, and floored on BOTH the shift and the unpaid break
-- it deducts. The sub-minute residue that survives is therefore always in the
-- worker's favour and never more than a minute per break — which is the
-- direction a wage record should err in when it has to err.
create or replace function public.timeclock_whole_minutes(
  p_from timestamptz,
  p_to   timestamptz
) returns integer language sql immutable as $$
  select case
    when p_from is null or p_to is null or p_to <= p_from then 0
    else floor(extract(epoch from (p_to - p_from))::numeric / 60)::int
  end;
$$;

comment on function public.timeclock_whole_minutes(timestamptz, timestamptz) is
  'Whole minutes between two instants, floored. The only duration arithmetic in time tracking.';

-- ── 1. Break types ───────────────────────────────────────────
--
-- The studio writes these, not the schema. What the schema insists on is that
-- somebody decided `is_paid` — there is no default, because a break type that
-- quietly defaults either way is the single most expensive typo in this file.
--
-- California, for the record: a meal period is unpaid and is at least thirty
-- minutes, during which the employee is relieved of all duty; a rest period is
-- paid and counts as hours worked. Those are the two rows seeded below. They
-- are seeded as a starting point, not as law — the studio can edit them.
create table if not exists public.break_types (
  id          bigserial primary key,

  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),

  name        text not null,

  -- Paid time stays in hours worked. Unpaid time is deducted. That is the
  -- entire reason this table exists.
  is_paid     boolean not null,

  -- What the clock offers as a starting length. Advisory: the recorded break
  -- is measured from its own start and end, never from this.
  default_minutes int check (default_minutes is null or default_minutes between 1 and 480),

  -- Shown under the name on the clock, e.g. the "relieved of all duty" wording
  -- a meal period requires.
  description text,

  sort_order  int not null default 0,
  is_active   boolean not null default true,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint break_types_name_present check (length(btrim(name)) > 0)
);

-- Per location: two sites may run different break policies, and "Lunch" at one
-- is not "Lunch" at the other.
create unique index if not exists break_types_name_per_location
  on public.break_types (location_id, lower(btrim(name)));

create index if not exists break_types_active_idx
  on public.break_types (location_id, sort_order) where is_active;

drop trigger if exists break_types_touch on public.break_types;
create trigger break_types_touch before update on public.break_types
  for each row execute function public.touch_updated_at();

-- ── 2. Time entries ──────────────────────────────────────────
--
-- One row per shift. An open shift has a null clocked_out_at.
--
-- Two locations, one shift: `location_id` is where the shift STARTED and is
-- what the shift is attributed to in every report; `clock_out_location_id`
-- records where it ended when that differs. Clocking out somewhere else is
-- ALLOWED, deliberately. Somebody genuinely does open one studio and close
-- another, and a system that refuses does not prevent the drive — it just
-- makes the person write down a punch that never happened. Recording both ends
-- keeps the record true and makes the discrepancy visible to whoever is
-- reconciling it. Attribution has to pick one end, and the start is the one
-- the roster was built against.
create table if not exists public.time_entries (
  id          bigserial primary key,

  staff_id    uuid not null references public.profiles(id) on delete cascade,

  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),
  -- Null means "same place they started".
  clock_out_location_id bigint references public.locations(id) on delete restrict,

  clocked_in_at  timestamptz not null default now(),
  clocked_out_at timestamptz,

  -- The shift as a range, so the exclusion constraint below can do its work.
  -- An OPEN shift has an unbounded upper bound: it occupies from the punch
  -- until further notice, which is what makes "clock in twice" and "clock in
  -- while already on the clock somewhere else" the same violation.
  --
  -- The `case` is not decoration. A generated column is computed before any
  -- CHECK runs, so a backwards pair would blow up inside tstzrange() with
  -- "range lower bound must be less than or equal to range upper bound" — true,
  -- unhelpful, and not what the person did wrong. Leaving the bound unset lets
  -- time_entries_out_after_in below reject it in words instead.
  span tstzrange generated always as
    (tstzrange(clocked_in_at,
               case when clocked_out_at > clocked_in_at then clocked_out_at end,
               '[)')) stored,

  -- How the punch arrived. 'manual' is a correction, and the edit log below is
  -- the record of who made it.
  source text not null default 'app'
    check (source in ('app', 'manual', 'import')),

  note text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Cannot clock out before clocking in. Strict >: a zero-length shift is a
  -- misfire, not a shift.
  constraint time_entries_out_after_in
    check (clocked_out_at is null or clocked_out_at > clocked_in_at),

  -- No overlapping shifts for one person, at any location, ever. This is the
  -- 004 pattern: two concurrent clock-ins both pass the app's check, both
  -- reach the insert, exactly one commits and the loser gets 23P01.
  constraint time_entries_no_overlap
    exclude using gist (staff_id with =, span with &&)
);

-- Belt to the exclusion constraint's braces, and a better error message: this
-- one fires as a plain unique violation on the common case, "clock in twice".
create unique index if not exists time_entries_one_open_per_staff
  on public.time_entries (staff_id) where clocked_out_at is null;

create index if not exists time_entries_staff_idx
  on public.time_entries (staff_id, clocked_in_at desc);
create index if not exists time_entries_location_idx
  on public.time_entries (location_id, clocked_in_at desc);
create index if not exists time_entries_open_idx
  on public.time_entries (clocked_in_at) where clocked_out_at is null;

drop trigger if exists time_entries_touch on public.time_entries;
create trigger time_entries_touch before update on public.time_entries
  for each row execute function public.touch_updated_at();

-- ── 3. Breaks inside a shift ─────────────────────────────────
create table if not exists public.time_entry_breaks (
  id            bigserial primary key,

  time_entry_id bigint not null references public.time_entries(id) on delete cascade,
  break_type_id bigint not null references public.break_types(id) on delete restrict,

  started_at    timestamptz not null default now(),
  ended_at      timestamptz,

  -- Whether THIS break was paid, decided when it was taken. Editing the type
  -- afterwards cannot reach back and change what was already worked. Same
  -- reasoning as consent_signatures.body_snapshot in 005: the record has to
  -- survive the template it came from. Filled by trigger from the type.
  is_paid_snapshot boolean not null,
  -- Likewise the label, so a timesheet from March still reads "Lunch" after
  -- the type is renamed.
  name_snapshot text not null,

  -- Same guarded shape as time_entries.span, for the same reason.
  span tstzrange generated always as
    (tstzrange(started_at,
               case when ended_at > started_at then ended_at end,
               '[)')) stored,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint time_entry_breaks_end_after_start
    check (ended_at is null or ended_at > started_at),

  -- You are on one break at a time, and two breaks cannot overlap. Same
  -- unbounded-upper trick as above: an open break blocks a second one.
  constraint time_entry_breaks_no_overlap
    exclude using gist (time_entry_id with =, span with &&)
);

create index if not exists time_entry_breaks_entry_idx
  on public.time_entry_breaks (time_entry_id, started_at);

drop trigger if exists time_entry_breaks_touch on public.time_entry_breaks;
create trigger time_entry_breaks_touch before update on public.time_entry_breaks
  for each row execute function public.touch_updated_at();

-- ── 4. The edit log ──────────────────────────────────────────
--
-- Append-only, and nothing has a policy to write it — the trigger below is
-- SECURITY DEFINER and is the only thing that ever inserts. A row here means
-- someone changed a wage record after the punch was made, and says who, when,
-- from what, to what, and why.
create table if not exists public.time_entry_edits (
  id            bigserial primary key,

  -- ON DELETE SET NULL, and nullable, deliberately. A cascade here would mean
  -- that deleting a shift also destroys the record of who deleted it, which is
  -- the one moment the log is most worth having. The entry goes; the log stays
  -- and goes orphaned, which is why staff_id below is denormalised rather than
  -- read back through the entry.
  time_entry_id bigint references public.time_entries(id) on delete set null,

  -- Whose timesheet this was. Survives the entry.
  staff_id      uuid not null references public.profiles(id) on delete cascade,

  -- Null only if the account was deleted afterwards; the row itself stays.
  edited_by     uuid references public.profiles(id) on delete set null,
  edited_at     timestamptz not null default now(),

  action        text not null check (action in ('created', 'corrected', 'deleted')),
  reason        text,

  before_clocked_in_at  timestamptz,
  before_clocked_out_at timestamptz,
  before_location_id    bigint,
  after_clocked_in_at   timestamptz,
  after_clocked_out_at  timestamptz,
  after_location_id     bigint
);

create index if not exists time_entry_edits_entry_idx
  on public.time_entry_edits (time_entry_id, edited_at desc);
create index if not exists time_entry_edits_staff_idx
  on public.time_entry_edits (staff_id, edited_at desc);

-- ── 5. Guards ────────────────────────────────────────────────

/**
 * Clients do not have shifts. Nothing else in the schema says so, and a
 * mis-typed uuid that lands on a client's profile would otherwise produce a
 * timesheet for somebody who was having a facial.
 */
create or replace function public.time_entry_staff_only()
returns trigger language plpgsql security definer set search_path = public as $$
declare subject_role public.user_role;
begin
  select role into subject_role from public.profiles where id = new.staff_id;
  if subject_role is null then
    raise exception 'No such staff member';
  end if;
  if subject_role = 'client' then
    raise exception 'Only staff have shifts';
  end if;
  return new;
end;
$$;

drop trigger if exists time_entries_staff_only on public.time_entries;
create trigger time_entries_staff_only
  before insert or update of staff_id on public.time_entries
  for each row execute function public.time_entry_staff_only();

/**
 * A break belongs to its shift and cannot escape it.
 *
 * Checked from both sides, because there are two ways to break the invariant:
 * move the break out of the shift, or move the shift out from under the break.
 * This is the break's side.
 */
create or replace function public.time_entry_break_within_shift()
returns trigger language plpgsql security definer set search_path = public as $$
declare entry record;
begin
  select clocked_in_at, clocked_out_at into entry
  from public.time_entries where id = new.time_entry_id;

  -- `not found`, never `entry is null`: a record is NULL only when EVERY field
  -- is, so a row with an open clocked_out_at reads as not-null and a row that
  -- was never found reads as null. Testing the record instead of FOUND is how
  -- a guard silently stops guarding.
  if not found then
    raise exception 'No such shift';
  end if;

  if new.started_at < entry.clocked_in_at then
    raise exception 'A break cannot start before the shift it belongs to';
  end if;

  if entry.clocked_out_at is not null then
    if new.started_at >= entry.clocked_out_at then
      raise exception 'A break cannot start after the shift has ended';
    end if;
    if new.ended_at is null or new.ended_at > entry.clocked_out_at then
      raise exception 'A break cannot run past the end of its shift';
    end if;
  end if;

  -- Snapshot the type on the way in, before NOT NULL is checked.
  if new.is_paid_snapshot is null or new.name_snapshot is null then
    select bt.is_paid, btrim(bt.name)
    into new.is_paid_snapshot, new.name_snapshot
    from public.break_types bt where bt.id = new.break_type_id;

    if new.is_paid_snapshot is null then
      raise exception 'No such break type';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists time_entry_breaks_within_shift on public.time_entry_breaks;
create trigger time_entry_breaks_within_shift
  before insert or update on public.time_entry_breaks
  for each row execute function public.time_entry_break_within_shift();

/**
 * The shift's side of the same invariant.
 *
 * An open break at clock-out is refused rather than closed for them. Closing
 * it at the punch would count the whole afternoon as lunch and cost them the
 * pay; leaving it open would leave an unbounded unpaid deduction. Neither is a
 * number anyone should have to argue about, so the clock asks them to end the
 * break first — which is why TimeClock offers "End break" as the primary
 * action whenever one is running.
 */
create or replace function public.time_entry_shift_covers_breaks()
returns trigger language plpgsql security definer set search_path = public as $$
declare stray record;
begin
  if new.clocked_in_at = old.clocked_in_at
     and new.clocked_out_at is not distinct from old.clocked_out_at then
    return new;
  end if;

  select b.name_snapshot, b.started_at, b.ended_at into stray
  from public.time_entry_breaks b
  where b.time_entry_id = new.id
    and (
      b.started_at < new.clocked_in_at
      or (new.clocked_out_at is not null
          and (b.ended_at is null or b.ended_at > new.clocked_out_at))
    )
  limit 1;

  -- FOUND, not `stray is not null` — see the note in
  -- time_entry_break_within_shift. The break this most needs to catch is one
  -- still running, whose ended_at is null, which would make the record itself
  -- test as NULL and wave the clock-out straight through.
  if found then
    if stray.ended_at is null then
      raise exception 'End the % break before closing this shift', stray.name_snapshot;
    end if;
    raise exception 'The % break falls outside those times', stray.name_snapshot;
  end if;

  return new;
end;
$$;

drop trigger if exists time_entries_cover_breaks on public.time_entries;
create trigger time_entries_cover_breaks
  before update on public.time_entries
  for each row execute function public.time_entry_shift_covers_breaks();

/**
 * The audit trail.
 *
 * Every write that moves a punch is logged, with one exception: the ordinary
 * clock-out, which clock_out() flags for the duration of its own transaction.
 * That exception is narrow on purpose — a manager fixing a forgotten clock-out
 * looks identical to a real clock-out in the row data, and is exactly the edit
 * that must not go unrecorded. Only the function that IS the punch is allowed
 * to say so.
 */
create or replace function public.time_entry_audit()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    -- A punch you made yourself is not an edit. Anything else is somebody
    -- creating a shift on another person's timesheet, which is.
    if auth.uid() is not null and auth.uid() is distinct from new.staff_id then
      insert into public.time_entry_edits
        (time_entry_id, staff_id, edited_by, action, reason,
         after_clocked_in_at, after_clocked_out_at, after_location_id)
      values (new.id, new.staff_id, auth.uid(), 'created', new.note,
              new.clocked_in_at, new.clocked_out_at, new.location_id);
    end if;
    return null;
  end if;

  if tg_op = 'DELETE' then
    -- Null time_entry_id, not old.id: this fires BEFORE the row is gone but
    -- commits after, and a foreign key to a row that is on its way out is a
    -- constraint violation waiting for the statement to finish. staff_id is
    -- what makes the orphan still mean something.
    insert into public.time_entry_edits
      (time_entry_id, staff_id, edited_by, action,
       before_clocked_in_at, before_clocked_out_at, before_location_id)
    values (null, old.staff_id, auth.uid(), 'deleted',
            old.clocked_in_at, old.clocked_out_at, old.location_id);
    return null;
  end if;

  if new.clocked_in_at = old.clocked_in_at
     and new.clocked_out_at is not distinct from old.clocked_out_at
     and new.location_id = old.location_id then
    return null;
  end if;

  if coalesce(current_setting('time_tracking.punch', true), '') = 'on' then
    return null;
  end if;

  insert into public.time_entry_edits
    (time_entry_id, staff_id, edited_by, action, reason,
     before_clocked_in_at, before_clocked_out_at, before_location_id,
     after_clocked_in_at,  after_clocked_out_at,  after_location_id)
  values (new.id, new.staff_id, auth.uid(), 'corrected', new.note,
          old.clocked_in_at, old.clocked_out_at, old.location_id,
          new.clocked_in_at, new.clocked_out_at, new.location_id);

  return null;
end;
$$;

drop trigger if exists time_entries_audit on public.time_entries;
create trigger time_entries_audit
  after insert or update or delete on public.time_entries
  for each row execute function public.time_entry_audit();

-- ── 6. Hours worked ──────────────────────────────────────────
--
-- WHAT THIS COMPUTES: elapsed time on the clock, minus unpaid breaks. Paid
-- breaks are left in, because paid break time IS hours worked.
--
-- WHAT THIS DOES NOT COMPUTE, deliberately:
--
--   • Overtime. California pays daily overtime over 8, double time over 12,
--     weekly overtime over 40, and a separate seventh-consecutive-day rule —
--     and which of those applies depends on the workweek the employer has
--     declared, the alternative workweek schedule if any, and whether the
--     person is exempt. None of that is knowable from a punch clock.
--   • Meal-period premiums. A missed or late or short meal period owes an hour
--     of pay at the regular rate, and "regular rate" is itself a computation
--     over commissions and non-discretionary bonuses this system has never
--     seen.
--   • Split-shift differentials, reporting-time pay, rest-period premiums.
--
-- That is payroll software's job. A half-right overtime number carries all the
-- authority of a real one and none of the correctness, and it is the number
-- somebody would pay from. The hook is the honest one: worked minutes per
-- person per day, per location, exact to the minute, which is precisely the
-- input a payroll provider asks for. Export it and let them compute the rest.

drop function if exists public.timesheet_entries(timestamptz, timestamptz, uuid, bigint);

/**
 * Every shift that STARTED in [p_from, p_to), with its arithmetic.
 *
 * Started, not overlapped: a shift that runs past midnight belongs to the day
 * it began, which is how a timesheet is read and how a roster is built.
 *
 * SECURITY INVOKER — the RLS policies below are the filter. A provider asking
 * for someone else's staff id gets no rows rather than an error, which is the
 * right way for this to fail.
 */
create function public.timesheet_entries(
  p_from     timestamptz,
  p_to       timestamptz,
  p_staff    uuid   default null,
  p_location bigint default null
) returns table (
  entry_id              bigint,
  staff_id              uuid,
  staff_name            text,
  location_id           bigint,
  location_name         text,
  clock_out_location_id bigint,
  clocked_in_at         timestamptz,
  clocked_out_at        timestamptz,
  is_open               boolean,
  gross_minutes         integer,
  paid_break_minutes    integer,
  unpaid_break_minutes  integer,
  worked_minutes        integer,
  source                text,
  note                  text,
  edit_count            integer,
  last_edited_at        timestamptz,
  last_edited_by_name   text
) language sql stable security invoker set search_path = public as $$
  select
    e.id,
    e.staff_id,
    nullif(btrim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
    e.location_id,
    l.name,
    e.clock_out_location_id,
    e.clocked_in_at,
    e.clocked_out_at,
    e.clocked_out_at is null,
    public.timeclock_whole_minutes(e.clocked_in_at, e.clocked_out_at),
    coalesce(b.paid_minutes, 0),
    coalesce(b.unpaid_minutes, 0),
    -- An open shift contributes zero. It has not finished, and a wage figure
    -- for a shift still running is a guess; the clock shows elapsed time live
    -- instead, which is a different claim.
    case when e.clocked_out_at is null then 0
         else greatest(public.timeclock_whole_minutes(e.clocked_in_at, e.clocked_out_at)
                       - coalesce(b.unpaid_minutes, 0), 0) end,
    e.source,
    e.note,
    coalesce(ed.n, 0),
    ed.last_at,
    ed.last_by
  from public.time_entries e
  left join public.profiles  p on p.id = e.staff_id
  left join public.locations l on l.id = e.location_id
  left join lateral (
    select
      sum(case when tb.is_paid_snapshot
               then public.timeclock_whole_minutes(tb.started_at, tb.ended_at) end)::int
        as paid_minutes,
      sum(case when not tb.is_paid_snapshot
               then public.timeclock_whole_minutes(tb.started_at, tb.ended_at) end)::int
        as unpaid_minutes
    from public.time_entry_breaks tb
    where tb.time_entry_id = e.id
  ) b on true
  left join lateral (
    select count(*)::int as n,
           max(x.edited_at) as last_at,
           (select nullif(btrim(coalesce(ep.first_name,'') || ' ' || coalesce(ep.last_name,'')), '')
              from public.time_entry_edits y
              left join public.profiles ep on ep.id = y.edited_by
             where y.time_entry_id = e.id
             order by y.edited_at desc limit 1) as last_by
    from public.time_entry_edits x
    where x.time_entry_id = e.id
  ) ed on true
  where e.clocked_in_at >= p_from
    and e.clocked_in_at <  p_to
    and (p_staff    is null or e.staff_id    = p_staff)
    and (p_location is null or e.location_id = p_location)
  order by e.clocked_in_at desc, e.id desc;
$$;

comment on function public.timesheet_entries(timestamptz, timestamptz, uuid, bigint) is
  'Shifts that started in [p_from, p_to), with unpaid breaks deducted. Null p_staff / p_location aggregate across everyone / every location.';

/**
 * Worked minutes for one person over a range. Integer minutes; the sum of
 * per-shift figures, so a week total is exactly the sum of its days.
 *
 * Read the block above before adding anything to this. It is minutes on the
 * clock, and nothing else.
 */
create or replace function public.worked_minutes(
  p_staff    uuid,
  p_from     timestamptz,
  p_to       timestamptz,
  p_location bigint default null
) returns integer language sql stable security invoker set search_path = public as $$
  select coalesce(sum(t.worked_minutes), 0)::int
  from public.timesheet_entries(p_from, p_to, p_staff, p_location) t;
$$;

comment on function public.worked_minutes(uuid, timestamptz, timestamptz, bigint) is
  'Minutes on the clock less unpaid breaks. NOT overtime-aware — see 035_time_tracking.sql.';

-- ── 7. The punches ───────────────────────────────────────────
--
-- A punch is inherently "me, now", so these are the only write path a worker
-- has: RLS below grants direct INSERT/UPDATE on time_entries to managers only.
-- SECURITY DEFINER, so each one re-derives the actor from auth.uid() rather
-- than taking an argument for it.

create or replace function public.clock_in(
  p_location_id bigint default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  actor    uuid := auth.uid();
  actor_role public.user_role;
  target_location bigint;
  new_id   bigint;
begin
  if actor is null then
    raise exception 'Sign in before clocking in';
  end if;

  select role into actor_role from public.profiles
  where id = actor and suspended_at is null;

  if actor_role is null or actor_role = 'client' then
    raise exception 'Only staff can clock in';
  end if;

  target_location := coalesce(p_location_id, public.default_location_id());
  if not exists (select 1 from public.locations where id = target_location and is_active) then
    raise exception 'That location is not open';
  end if;

  begin
    insert into public.time_entries (staff_id, location_id, clocked_in_at, source)
    values (actor, target_location, now(), 'app')
    returning id into new_id;
  exception
    when unique_violation or exclusion_violation then
      -- Two taps, two tabs, or a shift somebody never closed. All the same
      -- answer, and the DB is what decided it — not a check the app did first.
      raise exception 'You are already clocked in';
  end;

  return new_id;
end;
$$;

create or replace function public.clock_out(
  p_location_id bigint default null,
  p_note        text   default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  actor    uuid := auth.uid();
  entry    record;
begin
  if actor is null then
    raise exception 'Sign in before clocking out';
  end if;

  select * into entry from public.time_entries
  where staff_id = actor and clocked_out_at is null
  for update;

  if not found then
    raise exception 'You are not clocked in';
  end if;

  if p_location_id is not null
     and not exists (select 1 from public.locations where id = p_location_id) then
    raise exception 'No such location';
  end if;

  -- This is the punch itself, not a correction to one. Flagged for this
  -- transaction only, and cleared immediately after.
  perform set_config('time_tracking.punch', 'on', true);

  update public.time_entries
  set clocked_out_at = now(),
      clock_out_location_id =
        case when p_location_id is not null and p_location_id <> entry.location_id
             then p_location_id else clock_out_location_id end,
      note = coalesce(p_note, note)
  where id = entry.id;

  perform set_config('time_tracking.punch', '', true);

  return entry.id;
end;
$$;

create or replace function public.start_break(
  p_break_type_id bigint
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  actor    uuid := auth.uid();
  entry_id bigint;
  new_id   bigint;
begin
  if actor is null then
    raise exception 'Sign in first';
  end if;

  select id into entry_id from public.time_entries
  where staff_id = actor and clocked_out_at is null;

  if entry_id is null then
    raise exception 'Clock in before taking a break';
  end if;

  if not exists (select 1 from public.break_types where id = p_break_type_id and is_active) then
    raise exception 'No such break';
  end if;

  begin
    insert into public.time_entry_breaks (time_entry_id, break_type_id, started_at)
    values (entry_id, p_break_type_id, now())
    returning id into new_id;
  exception
    when unique_violation or exclusion_violation then
      raise exception 'You are already on a break';
  end;

  return new_id;
end;
$$;

create or replace function public.end_break()
returns bigint language plpgsql security definer set search_path = public as $$
declare
  actor    uuid := auth.uid();
  break_id bigint;
begin
  if actor is null then
    raise exception 'Sign in first';
  end if;

  select b.id into break_id
  from public.time_entry_breaks b
  join public.time_entries e on e.id = b.time_entry_id
  where e.staff_id = actor and e.clocked_out_at is null and b.ended_at is null;

  if break_id is null then
    raise exception 'You are not on a break';
  end if;

  update public.time_entry_breaks set ended_at = now() where id = break_id;
  return break_id;
end;
$$;

/**
 * A manager corrects a punch. People forget to clock out; that is not a reason
 * to leave a fourteen-hour shift on the record.
 *
 * The reason is required. A correction with no reason is the thing an audit
 * cannot answer, and typing six words is not a hardship next to that.
 */
create or replace function public.correct_time_entry(
  p_entry_id    bigint,
  p_clocked_in  timestamptz,
  p_clocked_out timestamptz,
  p_reason      text,
  p_location_id bigint default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare entry record;
begin
  if auth.uid() is not null and not public.is_manager() then
    raise exception 'Only a manager can correct a timesheet';
  end if;

  if p_reason is null or length(btrim(p_reason)) < 3 then
    raise exception 'Say why the timesheet is being corrected';
  end if;

  select * into entry from public.time_entries where id = p_entry_id for update;
  if not found then
    raise exception 'No such shift';
  end if;

  if p_clocked_in is null then
    raise exception 'A shift needs a start';
  end if;
  if p_clocked_out is not null and p_clocked_out <= p_clocked_in then
    raise exception 'A shift cannot end before it started';
  end if;

  -- No punch flag here: this is exactly the write the audit trigger exists for.
  update public.time_entries
  set clocked_in_at  = p_clocked_in,
      clocked_out_at = p_clocked_out,
      location_id    = coalesce(p_location_id, location_id),
      source         = 'manual',
      note           = btrim(p_reason)
  where id = p_entry_id;

  return p_entry_id;
end;
$$;

-- ── 8. Reminders ─────────────────────────────────────────────
--
-- Split in two on purpose. The selection is a pure, side-effect-free function
-- you can read the output of and argue with; the sender is a thin wrapper that
-- writes notifications and dedupes. Everything worth testing is in the first.

drop function if exists public.time_clock_reminder_candidates(integer, integer, integer);

/**
 * Who should be nudged, right now.
 *
 * Clock in: rostered on provider_schedules for today, the shift started more
 * than p_late_in_minutes ago, it has not ended yet, and they are not on the
 * clock. Not nudged if the studio is closed that day or they have a whole-day
 * block — nagging somebody on holiday is how people learn to ignore
 * notifications.
 *
 * Clock out: an open shift, and either the last rostered shift of that day
 * ended more than p_late_out_minutes ago, or — for somebody with no roster at
 * all, which front desk and managers often are — it has simply been open for
 * more than p_orphan_hours. That second arm is the one that catches the real
 * failure, the punch nobody ever closed.
 *
 * provider_schedules is wall-clock in the person's own zone (see 003), so the
 * shift instants are resolved through profiles.timezone, falling back to the
 * default location's zone. Postgres resolves DST edges its own way here rather
 * than through src/lib/time.ts; for a reminder that is already fifteen minutes
 * late by design, an hour's disagreement twice a year is not worth a second
 * implementation of the timezone rules.
 */
create function public.time_clock_reminder_candidates(
  p_late_in_minutes  integer default 15,
  p_late_out_minutes integer default 15,
  p_orphan_hours     integer default 12
) returns table (
  staff_id    uuid,
  kind        text,
  shift_start timestamptz,
  shift_end   timestamptz,
  local_date  date,
  timezone    text,
  entry_id    bigint
) language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_manager() then
    raise exception 'Only a manager can read the reminder sweep';
  end if;

  return query
  with fallback as (
    select coalesce(
      (select l.timezone from public.locations l where l.id = public.default_location_id()),
      'America/Los_Angeles'
    ) as tz
  ),
  staff as (
    select p.id,
           coalesce(nullif(btrim(p.timezone), ''), f.tz) as tz
    from public.profiles p
    cross join fallback f
    where p.role <> 'client' and p.suspended_at is null
  ),
  today as (
    select s.id, s.tz,
           (now() at time zone s.tz)::date as local_date,
           extract(dow from (now() at time zone s.tz))::int as dow
    from staff s
  ),
  shifts as (
    select t.id as staff_id, t.tz, t.local_date,
           ((t.local_date + sch.start_time) at time zone t.tz) as shift_start,
           ((t.local_date + sch.end_time)   at time zone t.tz) as shift_end
    from today t
    join public.provider_schedules sch
      on sch.provider_id = t.id
     and sch.is_active
     and sch.day_of_week = t.dow
  )
  select sh.staff_id, 'clock_in'::text, sh.shift_start, sh.shift_end,
         sh.local_date, sh.tz, null::bigint
  from shifts sh
  where now() >= sh.shift_start + make_interval(mins => p_late_in_minutes)
    and now() <  sh.shift_end
    and not exists (
      select 1 from public.time_entries e
      where e.staff_id = sh.staff_id and e.span @> now()
    )
    and not exists (
      select 1 from public.closures c where c.closure_date = sh.local_date
    )
    and not exists (
      select 1 from public.availability_blocks ab
      where ab.provider_id = sh.staff_id
        and ab.block_date = sh.local_date
        and ab.start_time is null      -- the whole day, not a gap in it
    )

  union all

  select e.staff_id, 'clock_out'::text, due.shift_start, due.shift_end,
         (e.clocked_in_at at time zone st.tz)::date, st.tz, e.id
  from public.time_entries e
  join staff st on st.id = e.staff_id
  left join lateral (
    -- The last shift rostered for the day the punch began. Last, not first, so
    -- a split shift is due out at the end of the afternoon and not the morning.
    select ((( e.clocked_in_at at time zone st.tz)::date + sch.start_time) at time zone st.tz)
             as shift_start,
           ((( e.clocked_in_at at time zone st.tz)::date + sch.end_time)   at time zone st.tz)
             as shift_end
    from public.provider_schedules sch
    where sch.provider_id = e.staff_id
      and sch.is_active
      and sch.day_of_week = extract(dow from (e.clocked_in_at at time zone st.tz))::int
    order by sch.end_time desc
    limit 1
  ) due on true
  where e.clocked_out_at is null
    and (
      (due.shift_end is not null
        and now() >= due.shift_end + make_interval(mins => p_late_out_minutes))
      or
      (due.shift_end is null
        and now() >= e.clocked_in_at + make_interval(hours => p_orphan_hours))
    );
end;
$$;

comment on function public.time_clock_reminder_candidates(integer, integer, integer) is
  'Side-effect free. Who is late to clock in or out right now, and why.';

/**
 * Write the nudges. Idempotent per local day per kind, so calling this every
 * fifteen minutes produces one reminder, not ninety-six.
 *
 * The dedupe key is the notification link, which is why the two links carry a
 * `remind` parameter: it is the only thing in `notifications` that identifies
 * what a row is about without parsing its title.
 */
create or replace function public.send_time_clock_reminders(
  p_late_in_minutes  integer default 15,
  p_late_out_minutes integer default 15,
  p_orphan_hours     integer default 12
) returns integer language plpgsql security definer set search_path = public as $$
declare
  c           record;
  -- v_ prefixed because `link` and `title` are columns on notifications, and an
  -- unprefixed local of the same name is an ambiguous reference, not a shadow.
  v_link      text;
  v_day_start timestamptz;
  v_sent      integer := 0;
begin
  if auth.uid() is not null and not public.is_manager() then
    raise exception 'Only a manager can run the reminder sweep';
  end if;

  for c in
    select * from public.time_clock_reminder_candidates(
      p_late_in_minutes, p_late_out_minutes, p_orphan_hours)
  loop
    v_link := '/dashboard/timesheets?remind=' || c.kind;
    v_day_start := (c.local_date::timestamp at time zone c.timezone);

    if exists (
      select 1 from public.notifications n
      where n.user_id = c.staff_id
        and n.link = v_link
        and n.created_at >= v_day_start
    ) then
      continue;
    end if;

    if c.kind = 'clock_in' then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        c.staff_id, 'system', 'You have not clocked in',
        'Your shift started at ' ||
          to_char(c.shift_start at time zone c.timezone, 'FMHH12:MI AM') ||
          '. Open the clock when you get a moment — a missing punch is easier to fix today than at payroll.',
        v_link
      );
    else
      insert into public.notifications (user_id, type, title, body, link)
      values (
        c.staff_id, 'system', 'You are still clocked in',
        case when c.shift_end is null
          then 'That shift has been open a while. Clock out so your hours are right.'
          else 'Your shift ended at ' ||
               to_char(c.shift_end at time zone c.timezone, 'FMHH12:MI AM') ||
               ' and you are still on the clock. Clock out so your hours are right.'
        end,
        v_link
      );
    end if;

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

comment on function public.send_time_clock_reminders(integer, integer, integer) is
  'Writes clock in/out nudges to notifications. Safe to call repeatedly; one per person per kind per local day.';

-- ── 9. Seed the two breaks California actually names ──────────
insert into public.break_types (location_id, name, is_paid, default_minutes, description, sort_order)
select public.default_location_id(), 'Lunch', false, 30,
       'Unpaid. At least thirty minutes, relieved of all duty — leave the room, leave the building, it is your time.',
       10
where not exists (
  select 1 from public.break_types
  where location_id = public.default_location_id() and lower(btrim(name)) = 'lunch'
);

insert into public.break_types (location_id, name, is_paid, default_minutes, description, sort_order)
select public.default_location_id(), 'Rest break', true, 10,
       'Paid. Counts as time worked, so it is not deducted from your hours.',
       20
where not exists (
  select 1 from public.break_types
  where location_id = public.default_location_id() and lower(btrim(name)) = 'rest break'
);

-- ── 10. RLS ──────────────────────────────────────────────────
--
-- Nothing here is readable by anon, ever. There are no `to anon` policies and
-- no grants to anon below — a timesheet says where a named person was, hour by
-- hour, and that is not public information about anybody.

alter table public.break_types       enable row level security;
alter table public.time_entries      enable row level security;
alter table public.time_entry_breaks enable row level security;
alter table public.time_entry_edits  enable row level security;

drop policy if exists "staff read break types" on public.break_types;
create policy "staff read break types" on public.break_types
  for select to authenticated using (public.is_staff());

drop policy if exists "manager manages break types" on public.break_types;
create policy "manager manages break types" on public.break_types
  for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- Your own timesheet, always. Everyone's, if you run the place.
drop policy if exists "read own time entries" on public.time_entries;
create policy "read own time entries" on public.time_entries
  for select to authenticated
  using (staff_id = auth.uid() or public.is_manager());

-- Direct writes are a manager's correction tool. A worker's own punches go
-- through clock_in / clock_out, which is what keeps "now" honest: without this
-- split, "update own time entry" would let anyone set their own clock-in to
-- three hours ago.
drop policy if exists "manager writes time entries" on public.time_entries;
create policy "manager writes time entries" on public.time_entries
  for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

drop policy if exists "read own breaks" on public.time_entry_breaks;
create policy "read own breaks" on public.time_entry_breaks
  for select to authenticated
  using (
    public.is_manager()
    or exists (
      select 1 from public.time_entries e
      where e.id = time_entry_id and e.staff_id = auth.uid()
    )
  );

drop policy if exists "manager writes breaks" on public.time_entry_breaks;
create policy "manager writes breaks" on public.time_entry_breaks
  for all to authenticated
  using (public.is_manager()) with check (public.is_manager());

-- You can see that your own timesheet was edited, and by whom. That is the
-- point of keeping it: the person whose pay it is has the strongest interest in
-- reading it.
-- Against staff_id, not a join back to time_entries — a log row whose entry was
-- deleted must stay readable by the person whose pay it was, and that is
-- precisely the row a join would drop.
drop policy if exists "read edits to own timesheet" on public.time_entry_edits;
create policy "read edits to own timesheet" on public.time_entry_edits
  for select to authenticated
  using (staff_id = auth.uid() or public.is_manager());

-- No insert, update or delete policy on time_entry_edits at all. The audit
-- trigger runs as the table owner and is the only writer there will ever be.

-- ── 11. Grants ───────────────────────────────────────────────
grant select on public.break_types, public.time_entries,
                public.time_entry_breaks, public.time_entry_edits to authenticated;
grant insert, update, delete on public.break_types, public.time_entries,
                                public.time_entry_breaks to authenticated;
grant usage, select on sequence public.break_types_id_seq       to authenticated;
grant usage, select on sequence public.time_entries_id_seq      to authenticated;
grant usage, select on sequence public.time_entry_breaks_id_seq to authenticated;

grant all on public.break_types, public.time_entries,
             public.time_entry_breaks, public.time_entry_edits to service_role;
grant usage, select on sequence public.break_types_id_seq       to service_role;
grant usage, select on sequence public.time_entries_id_seq      to service_role;
grant usage, select on sequence public.time_entry_breaks_id_seq to service_role;
grant usage, select on sequence public.time_entry_edits_id_seq  to service_role;

revoke all on public.break_types       from anon;
revoke all on public.time_entries      from anon;
revoke all on public.time_entry_breaks from anon;
revoke all on public.time_entry_edits  from anon;

-- Append-only, twice over. Having no INSERT/UPDATE/DELETE policy already stops
-- this (RLS matches no row, so the statement quietly affects nothing), but
-- Supabase's default privileges hand `authenticated` full DML on every new
-- table, and "protected because we forgot to write a policy" is a guarantee
-- that lasts exactly until someone adds a convenient one. The revoke says it
-- out loud: the audit trigger is the only writer, and it runs as the owner.
revoke insert, update, delete, truncate on public.time_entry_edits from authenticated;

grant execute on function public.timeclock_whole_minutes(timestamptz, timestamptz)
  to authenticated, service_role;
grant execute on function public.timesheet_entries(timestamptz, timestamptz, uuid, bigint)
  to authenticated, service_role;
grant execute on function public.worked_minutes(uuid, timestamptz, timestamptz, bigint)
  to authenticated, service_role;
grant execute on function public.clock_in(bigint)          to authenticated;
grant execute on function public.clock_out(bigint, text)   to authenticated;
grant execute on function public.start_break(bigint)       to authenticated;
grant execute on function public.end_break()               to authenticated;
grant execute on function public.correct_time_entry(bigint, timestamptz, timestamptz, text, bigint)
  to authenticated;

-- The sweep runs as the service role from the cron route. Managers get it too
-- so "run it now" is possible from the dashboard without a service key.
grant execute on function public.time_clock_reminder_candidates(integer, integer, integer)
  to authenticated, service_role;
grant execute on function public.send_time_clock_reminders(integer, integer, integer)
  to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────
-- 036_scheduling_mechanics.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 036: scheduling mechanics
--
-- Four things the owner asked for, all of which lean on the same nerve: the
-- GiST exclusion constraint that makes double-booking impossible.
--
--   1. Processing time — a peel or a colour has dead minutes in the middle.
--      The client is developing; the provider is not doing anything.
--   2. Gap time — minimum and maximum idle either side of a booking, and a
--      floor under the fragments slot generation is allowed to leave behind.
--   3. Deliberate overlaps — staff-only, for the case the studio knows about.
--   4. Approval routing — per-service and per-client rules that land a booking
--      as `pending` rather than `confirmed`.
--
-- ── WHAT HAPPENED TO THE GUARD ───────────────────────────────
--
-- It got sharper. It did not get weaker, and nothing here can be used to make
-- it weaker from the public booking page.
--
-- `slot` still exists and still means exactly what it meant in 004: the whole
-- contiguous window the CLIENT occupies, starts_at through ends_at plus
-- turnover. That is what `appointments_room_no_overlap` keys on, and a client
-- sitting under a mask is still in the room. Nothing about rooms changes here.
--
-- What changes is that PROVIDER time is no longer assumed to be the same
-- interval. `provider_slot` is a tstzmultirange holding the segments where the
-- provider is actually working — `slot` minus each processing gap — and the
-- provider exclusion constraint moved onto it:
--
--     exclude using gist (provider_id with =, provider_slot with &&)
--     where (status <> 'cancelled' and not allows_overlap)
--
-- With no processing time configured, `provider_slot` is a multirange holding
-- one range identical to `slot`, and the constraint is the 004 constraint
-- exactly. With processing time it is strictly more precise: the gap is
-- bookable by someone else, every active minute is not. There is no input to
-- this system that produces an empty `provider_slot` — a CHECK refuses one,
-- because an empty multirange overlaps nothing and would be a hole.
--
-- The swap runs inside a DO block on purpose. A DO block is a single statement
-- and therefore a single transaction, and the replacement is added BEFORE the
-- original is dropped, so there is no instant — not even inside the migration —
-- at which `appointments` sits without a provider overlap guard.
--
-- Like 032, the guard stays scoped to (provider_id, ...) and is deliberately
-- not widened with location_id: a person cannot be in two buildings at once.
--
-- ── AND THE ESCAPE HATCH ─────────────────────────────────────
--
-- `allows_overlap` takes a row out of the constraint's index entirely, which is
-- the honest meaning of "the studio has decided these two can share a slot".
-- Two independent locks keep the public out of it:
--
--   • a plain CHECK refuses `allows_overlap` on `source = 'online'`. It is a
--     table constraint, so it holds against the service role, the SQL editor,
--     and anything anyone writes later. src/lib/booking.ts hardcodes
--     source = 'online' for every public booking.
--   • a trigger requires a live staff authoriser and a written reason.
--
-- Be clear about what a flagged row means: it leaves the index in BOTH
-- directions. It does not conflict with anything, and nothing conflicts with
-- it. That is unavoidable — the moment two bookings are allowed to share a
-- provider's time, no constraint can tell a third one that it is one too many
-- without a capacity model the studio does not have. What keeps the public off
-- that time is the availability layer: loadAvailability counts every
-- non-cancelled appointment as busy regardless of the flag, and createBooking
-- re-derives against the same list before it inserts. provider_busy_segments
-- below does the same. A deliberate overlap is a staff decision end to end.
--
-- Requires migration 032 (locations, staff_locations, appointments.location_id).
-- Re-runnable in full: apply it three times, nothing complains.
-- ============================================================

-- ── 1. Processing time and approval policy on the service ────
--
-- Minutes measured from the START of the service, not from the appointment:
-- a service that is second in a combined booking carries its own offset and
-- the appointment adds the ones before it.
alter table public.services
  add column if not exists processing_start_minutes int not null default 0,
  add column if not exists processing_minutes       int not null default 0,
  add column if not exists requires_booking_approval boolean not null default false;

comment on column public.services.processing_minutes is
  'Minutes in the middle of this service during which the provider is free and '
  'the client is not. 0 = none, which is every service until someone says '
  'otherwise. See appointments.provider_slot for what it actually buys.';

-- The window has to leave real work on both sides of it. Five minutes is the
-- floor: a "processing gap" that starts at minute zero is not a gap, it is a
-- service the provider does not attend, and it would produce an appointment
-- that holds no provider time at all.
alter table public.services drop constraint if exists services_processing_window_valid;
alter table public.services add constraint services_processing_window_valid check (
  processing_start_minutes >= 0
  and processing_minutes >= 0
  and (
    processing_minutes = 0
    or (
      processing_start_minutes >= 5
      and processing_start_minutes + processing_minutes <= duration_minutes - 5
    )
  )
);

-- ── 2. Per-location scheduling policy ────────────────────────
--
-- Approval rules and the gap defaults a provider inherits when they have not
-- set their own. One row per site; a site with no row behaves as all-off,
-- which is the pre-036 behaviour.
create table if not exists public.scheduling_policies (
  location_id bigint primary key
    references public.locations(id) on delete restrict
    default public.default_location_id(),

  -- ── Approval routing ───────────────────────────────────────
  -- booking_settings.auto_confirm (003) is still the master switch and still
  -- holds every booking when it is off. These narrow it to the cases that
  -- actually want a human: someone the studio has never met, and someone who
  -- has form for not turning up.
  require_approval_new_client boolean not null default false,
  -- N or more no-shows on the record sends the next booking to review.
  -- 0 = never.
  no_show_threshold int not null default 0 check (no_show_threshold >= 0),

  -- ── Gap defaults ───────────────────────────────────────────
  default_min_gap_minutes      int not null default 0
    check (default_min_gap_minutes between 0 and 240),
  default_max_gap_minutes      int
    check (default_max_gap_minutes is null or default_max_gap_minutes between 0 and 1440),
  default_min_fragment_minutes int not null default 0
    check (default_min_fragment_minutes between 0 and 240),

  -- Off by default, and deliberately so. Freeing the provider during a
  -- processing gap only helps if there is somewhere else for the second client
  -- to sit; in a single-room studio there is not. The database models the gap
  -- either way — this decides whether the public booking page offers it.
  allow_processing_overlap boolean not null default false,

  updated_at timestamptz not null default now(),

  constraint scheduling_policy_gap_range_valid check (
    default_max_gap_minutes is null or default_max_gap_minutes >= default_min_gap_minutes
  )
);

comment on table public.scheduling_policies is
  'Per-site booking mechanics: which bookings need a human, and how tightly the '
  'day is packed. Filter by location_id for one site; omit the filter to see all.';

drop trigger if exists scheduling_policies_touch on public.scheduling_policies;
create trigger scheduling_policies_touch before update on public.scheduling_policies
  for each row execute function public.touch_updated_at();

insert into public.scheduling_policies (location_id)
select l.id from public.locations l
on conflict (location_id) do nothing;

-- ── 3. Per-provider gap settings ─────────────────────────────
--
-- Keyed by (provider, site) because the answer genuinely differs: the drive
-- between two studios is real time and a provider working both wants a wider
-- floor on the day she is at the second one.
create table if not exists public.provider_scheduling_settings (
  provider_id uuid   not null references public.profiles(id) on delete cascade,
  location_id bigint not null references public.locations(id) on delete restrict
    default public.default_location_id(),

  -- Idle the studio wants either side of a booking. Applied against other
  -- appointments only, never against the start or end of the working day:
  -- a 9am booking on a 9am open is not a gap violation.
  min_gap_minutes int not null default 0 check (min_gap_minutes between 0 and 240),
  -- The other direction: keep the day compact. On a day that already has
  -- something in it, an offered slot has to sit within this of the nearest
  -- booking. Null = no ceiling.
  max_gap_minutes int check (max_gap_minutes is null or max_gap_minutes between 0 and 1440),
  -- "Don't leave me a fifteen-minute orphan." A slot that would strand a free
  -- stretch shorter than this — against a neighbour OR against the edge of the
  -- working window — is not offered. 0 = off.
  min_fragment_minutes int not null default 0 check (min_fragment_minutes between 0 and 240),

  -- Overrides the site policy when set; null inherits.
  allow_processing_overlap boolean,

  updated_at timestamptz not null default now(),

  primary key (provider_id, location_id),
  constraint provider_gap_range_valid check (
    max_gap_minutes is null or max_gap_minutes >= min_gap_minutes
  )
);

create index if not exists provider_scheduling_settings_location_idx
  on public.provider_scheduling_settings (location_id);

drop trigger if exists provider_scheduling_settings_touch on public.provider_scheduling_settings;
create trigger provider_scheduling_settings_touch
  before update on public.provider_scheduling_settings
  for each row execute function public.touch_updated_at();

-- ── 4. New columns on appointments ───────────────────────────
alter table public.appointments
  -- Minute offsets from starts_at where the provider is free. Offsets, not
  -- instants, so rescheduling moves the gap with the appointment instead of
  -- leaving it behind at the old time.
  add column if not exists processing_windows int4multirange not null default '{}'::int4multirange,
  -- The active segments: `slot` minus those windows, resolved to instants.
  -- Maintained by appointment_set_slot. Application code never writes it,
  -- exactly as it never writes `slot`.
  add column if not exists provider_slot tstzmultirange,

  -- The staff escape hatch.
  add column if not exists allows_overlap boolean not null default false,
  add column if not exists overlap_reason text,
  add column if not exists overlap_authorized_by uuid references public.profiles(id) on delete set null,

  -- Why this booking is sitting in the queue, so the queue can say so.
  add column if not exists approval_reason text;

comment on column public.appointments.provider_slot is
  'Provider ACTIVE time, as a multirange. The double-booking guard lives on '
  'this column. Equal to a one-range multirange of `slot` unless the booked '
  'services declare processing time. Never written by application code.';

alter table public.appointments drop constraint if exists appointments_approval_reason_known;
alter table public.appointments add constraint appointments_approval_reason_known check (
  approval_reason is null
  or approval_reason in ('studio_policy', 'service_policy', 'first_visit', 'no_show_history')
);

-- ── 5. The slot trigger, extended ────────────────────────────
--
-- Same job as 004, one more output. `slot` is byte-for-byte what it was.
create or replace function public.appointment_set_slot()
returns trigger language plpgsql as $$
declare
  window_range tstzrange;
  gaps tstzmultirange := '{}'::tstzmultirange;
  gap  int4range;
begin
  -- Unchanged from 004: the client's window plus turnover. Room capacity and
  -- every calendar view read this.
  window_range := tstzrange(
    new.starts_at,
    new.ends_at + make_interval(mins => new.buffer_minutes),
    '[)'
  );
  new.slot := window_range;

  for gap in select w from unnest(new.processing_windows) w loop
    gaps := gaps + tstzmultirange(tstzrange(
      new.starts_at + make_interval(mins => lower(gap)),
      new.starts_at + make_interval(mins => upper(gap)),
      '[)'
    ));
  end loop;

  new.provider_slot := tstzmultirange(window_range) - gaps;
  return new;
end;
$$;

-- `slot` and `provider_slot` join the column list so that an application write
-- to either one is immediately overwritten by the recomputation rather than
-- quietly believed. They are derived columns; this makes that structural.
drop trigger if exists appointments_set_slot on public.appointments;
create trigger appointments_set_slot
  before insert or update of
    starts_at, ends_at, buffer_minutes, processing_windows, slot, provider_slot
  on public.appointments
  for each row execute function public.appointment_set_slot();

-- Backfill before the constraint depends on it. Runs once; the WHERE clause
-- makes a re-run a no-op rather than a mass updated_at bump.
update public.appointments
set provider_slot = tstzmultirange(slot)
where provider_slot is null;

alter table public.appointments alter column provider_slot set not null;

-- An empty multirange overlaps nothing, so it would sit outside the guard
-- while looking like a booking. Refuse it at the table.
alter table public.appointments drop constraint if exists appointments_provider_slot_present;
alter table public.appointments add constraint appointments_provider_slot_present
  check (provider_slot <> '{}'::tstzmultirange);

-- ── 6. The escape hatch, locked ──────────────────────────────
--
-- Lock one: a table constraint. `createBooking` hardcodes source = 'online'
-- for every public request, so no public booking can carry the flag no matter
-- which client, which role, or which future route handler writes the row.
alter table public.appointments drop constraint if exists appointments_overlap_is_never_public;
alter table public.appointments add constraint appointments_overlap_is_never_public
  check (not allows_overlap or source <> 'online');

-- Lock two: an overlap is somebody's decision, in writing, on the record.
alter table public.appointments drop constraint if exists appointments_overlap_is_documented;
alter table public.appointments add constraint appointments_overlap_is_documented
  check (
    not allows_overlap
    or (overlap_authorized_by is not null and length(btrim(coalesce(overlap_reason, ''))) >= 3)
  );

-- ── 7. The constraint swap ───────────────────────────────────
--
-- One statement, one transaction, replacement first. See the header.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.appointments'::regclass
      and conname = 'appointments_provider_no_overlap'
  ) then
    alter table public.appointments
      add constraint appointments_provider_no_overlap
      exclude using gist (provider_id with =, provider_slot with &&)
      where (status <> 'cancelled' and not allows_overlap);
  end if;

  -- Only now, with the replacement in place and validated against every
  -- existing row, does the original come out.
  alter table public.appointments drop constraint if exists appointments_no_overlap;
end
$$;

-- ── 8. Authorising an overlap ────────────────────────────────
create or replace function public.appointment_guard_overlap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not new.allows_overlap then
    return new;
  end if;

  -- Already flagged and staying flagged: this is an edit to some other column,
  -- not a fresh escalation.
  if tg_op = 'UPDATE' and old.allows_overlap then
    return new;
  end if;

  -- No JWT means the service role, a migration, or the SQL editor — all of
  -- which are already privileged, and none of which can reach `source =
  -- 'online'` past the CHECK above. Same posture as guard_profile_privileges.
  if auth.uid() is not null and not public.is_front_desk() then
    raise exception 'Only front desk and up can deliberately overlap a booking';
  end if;

  if not exists (
    select 1 from public.profiles p
    where p.id = new.overlap_authorized_by
      and p.role <> 'client'
      and p.suspended_at is null
  ) then
    raise exception 'An overlap has to be authorised by an active staff member';
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_guard_overlap on public.appointments;
create trigger appointments_guard_overlap
  before insert or update on public.appointments
  for each row execute function public.appointment_guard_overlap();

-- ── 9. Processing windows, derived from the booked services ──
--
-- The appointment does not know its services at INSERT — the line items land
-- afterwards — so this recomputes from `appointment_services`, the same shape
-- as appointment_recalc_totals in 004.
--
-- The order matters and is the line order: services run back to back, so
-- service k's gap sits at (sum of the durations before it) + its own offset.
-- Add-ons sort after every service and simply extend the tail.
--
-- The window moves in the safe direction while this settles. The appointment
-- is inserted holding its whole span of provider time and only releases the
-- gap once the lines are known — never the reverse.
create or replace function public.appointment_recalc_processing()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target uuid;
  windows int4multirange := '{}'::int4multirange;
  elapsed int := 0;
  line record;
begin
  if tg_op = 'DELETE' then
    target := old.appointment_id;
  else
    target := new.appointment_id;
  end if;

  for line in
    select s.processing_start_minutes as ps,
           s.processing_minutes       as pm,
           al.duration_minutes        as dur
    from public.appointment_services al
    join public.services s on s.id = al.service_id
    where al.appointment_id = target
      and al.service_id is not null
    order by al.sort_order, al.id
  loop
    -- A per-provider duration override can be shorter than the catalogue one
    -- the window was measured against. If it no longer fits, there is no gap —
    -- the conservative reading, and the provider stays booked.
    if line.pm > 0 and line.ps + line.pm <= line.dur then
      windows := windows + int4multirange(
        int4range(elapsed + line.ps, elapsed + line.ps + line.pm, '[)')
      );
    end if;
    elapsed := elapsed + line.dur;
  end loop;

  update public.appointments a
  set processing_windows = windows
  where a.id = target
    and a.processing_windows is distinct from windows;

  return null;
end;
$$;

drop trigger if exists appointment_services_recalc_processing on public.appointment_services;
create trigger appointment_services_recalc_processing
  after insert or update or delete on public.appointment_services
  for each row execute function public.appointment_recalc_processing();

-- ── 10. Reading the gap configuration ────────────────────────

/** A provider's home site, for policy lookups. Falls back to the primary. */
create or replace function public.provider_home_location_id(p_provider uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(
    (select sl.location_id from public.staff_locations sl
      where sl.profile_id = p_provider and sl.is_primary limit 1),
    (select sl.location_id from public.staff_locations sl
      where sl.profile_id = p_provider order by sl.location_id limit 1),
    public.default_location_id()
  );
$$;

/**
 * The gap rules in force for one provider at one site: their own row where
 * they have set one, the site policy underneath it, zero underneath that.
 *
 * Read by src/lib/scheduling.ts and handed to generateSlots. Every field
 * resolves to a no-op default, so a studio that never opens the settings page
 * gets exactly the slot list it got before this migration.
 */
create or replace function public.provider_scheduling_config(
  p_provider uuid,
  p_location bigint default null
) returns table (
  location_id bigint,
  min_gap_minutes int,
  max_gap_minutes int,
  min_fragment_minutes int,
  allow_processing_overlap boolean
) language sql stable security definer set search_path = public as $$
  select
    l.id,
    coalesce(pss.min_gap_minutes,      sp.default_min_gap_minutes,      0),
    coalesce(pss.max_gap_minutes,      sp.default_max_gap_minutes),
    coalesce(pss.min_fragment_minutes, sp.default_min_fragment_minutes, 0),
    coalesce(pss.allow_processing_overlap, sp.allow_processing_overlap, false)
  from (select coalesce(p_location, public.provider_home_location_id(p_provider)) as id) l
  left join public.scheduling_policies sp
    on sp.location_id = l.id
  left join public.provider_scheduling_settings pss
    on pss.provider_id = p_provider and pss.location_id = l.id;
$$;

/**
 * Everything that occupies a provider between two instants, one row per
 * segment, so slot generation never has to parse a multirange.
 *
 * Active segments come out of `provider_slot`; a processing gap comes out as
 * its own row flagged is_processing, because it blocks the ROOM even when it
 * does not block the provider. The caller decides which of those to honour —
 * see allow_processing_overlap. Cached external calendar busy time is included
 * because from the provider's side there is no difference.
 */
create or replace function public.provider_busy_segments(
  p_provider uuid,
  p_from timestamptz,
  p_to   timestamptz
) returns table (
  starts_at timestamptz,
  ends_at   timestamptz,
  is_processing boolean
) language sql stable security definer set search_path = public as $$
  select lower(seg), upper(seg), false
  from public.appointments a
  cross join lateral unnest(a.provider_slot) seg
  where a.provider_id = p_provider
    and a.status <> 'cancelled'
    and a.starts_at >= p_from
    and a.starts_at <= p_to
  union all
  select lower(gap), upper(gap), true
  from public.appointments a
  cross join lateral unnest(
    tstzmultirange(a.slot) - a.provider_slot
  ) gap
  where a.provider_id = p_provider
    and a.status <> 'cancelled'
    and a.starts_at >= p_from
    and a.starts_at <= p_to
  union all
  select cb.starts_at, cb.ends_at, false
  from public.calendar_busy cb
  where cb.provider_id = p_provider
    and cb.ends_at >= p_from
    and cb.starts_at <= p_to;
$$;

-- ── 11. Approval routing ─────────────────────────────────────

/**
 * Why this booking needs a human, or null if it does not.
 *
 * Called twice for the same booking and that is deliberate: the client-shaped
 * rules can be answered before the row exists, the service-shaped one cannot
 * (line items land after the appointment). Passing null for p_service_ids asks
 * only the questions that are answerable yet.
 *
 * Order is by bluntness. The studio-wide switch is a decision already made and
 * short-circuits everything under it.
 */
create or replace function public.booking_review_reason(
  p_client_id   uuid,
  p_guest_email text,
  p_guest_phone text,
  p_service_ids bigint[] default null,
  p_location_id bigint   default null
) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  loc bigint;
  want_new_client boolean;
  no_show_limit int;
  prior_visits int;
  misses int;
begin
  if not coalesce((select b.auto_confirm from public.booking_settings b where b.id = 1), true) then
    return 'studio_policy';
  end if;

  if p_service_ids is not null and exists (
    select 1 from public.services s
    where s.id = any(p_service_ids) and s.requires_booking_approval
  ) then
    return 'service_policy';
  end if;

  loc := coalesce(p_location_id, public.default_location_id());

  select sp.require_approval_new_client, sp.no_show_threshold
    into want_new_client, no_show_limit
  from public.scheduling_policies sp
  where sp.location_id = loc;

  want_new_client := coalesce(want_new_client, false);
  no_show_limit   := coalesce(no_show_limit, 0);

  -- "Never been here" means no booking on the record that was not cancelled.
  -- Matched the same way appointment_match_client matches: account first, then
  -- email, then a ten-digit phone.
  if want_new_client then
    select count(*) into prior_visits
    from public.appointments a
    where a.status <> 'cancelled'
      and (
        (p_client_id is not null and a.client_id = p_client_id)
        or (p_client_id is null and p_guest_email is not null
            and lower(a.guest_email) = lower(p_guest_email))
        or (p_client_id is null and p_guest_phone is not null
            and length(regexp_replace(p_guest_phone, '\D', '', 'g')) >= 10
            and regexp_replace(coalesce(a.guest_phone, ''), '\D', '', 'g')
              = regexp_replace(p_guest_phone, '\D', '', 'g'))
      );

    if prior_visits = 0 then
      return 'first_visit';
    end if;
  end if;

  if no_show_limit > 0 and p_client_id is not null then
    select count(*) into misses
    from public.appointments a
    where a.client_id = p_client_id and a.status = 'no_show';

    if misses >= no_show_limit then
      return 'no_show_history';
    end if;
  end if;

  return null;
end;
$$;

/**
 * Hold an online booking for review when a rule says so.
 *
 * Named to sort after appointments_match_client, which is not decoration: that
 * trigger is what turns a guest booking into a client_id, and "has this person
 * been here before" is unanswerable until it has run.
 *
 * Staff bookings are untouched. Somebody already made the decision.
 */
create or replace function public.appointment_route_approval()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  reason text;
begin
  if new.source <> 'online' or new.status <> 'confirmed' then
    return new;
  end if;

  reason := public.booking_review_reason(
    new.client_id, new.guest_email, new.guest_phone, null, new.location_id
  );

  if reason is not null then
    new.status := 'pending';
    new.approval_reason := reason;
  end if;

  return new;
end;
$$;

drop trigger if exists appointments_route_approval on public.appointments;
create trigger appointments_route_approval
  before insert on public.appointments
  for each row execute function public.appointment_route_approval();

/**
 * The half of the routing that has to wait for the line items.
 *
 * `src/lib/booking.ts` should ask booking_review_reason() before it inserts, so
 * the response it hands the browser says "pending" the first time. This is the
 * backstop for every other path, and for the case where the answer changes
 * between the two.
 */
create or replace function public.appointment_services_route_approval()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.service_id is null then
    return null;
  end if;

  update public.appointments a
  set status = 'pending',
      approval_reason = 'service_policy'
  where a.id = new.appointment_id
    and a.source = 'online'
    and a.status = 'confirmed'
    and exists (
      select 1 from public.services s
      where s.id = new.service_id and s.requires_booking_approval
    );

  return null;
end;
$$;

drop trigger if exists appointment_services_route_approval on public.appointment_services;
create trigger appointment_services_route_approval
  after insert on public.appointment_services
  for each row execute function public.appointment_services_route_approval();

/** Plain-language copy for a review reason, shared by the queue and the bell. */
create or replace function public.booking_review_label(p_reason text)
returns text language sql immutable as $$
  select case p_reason
    when 'studio_policy'   then 'Every online booking is held for review'
    when 'service_policy'  then 'This service is always reviewed'
    when 'first_visit'     then 'First visit'
    when 'no_show_history' then 'Missed appointments on record'
    else 'Held for review'
  end;
$$;

/**
 * Tell the front desk a booking is waiting, and tell the client when it is not
 * waiting any more.
 *
 * A separate trigger rather than an edit to appointment_notify (006): that
 * function already fires for these rows and says the right thing about them
 * being booked. This adds what it does not say.
 */
create or replace function public.appointment_notify_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who text;
  became_pending boolean;
  was_approved boolean;
begin
  -- NEW is unassigned during DELETE and OLD during INSERT, and touching an
  -- unassigned record raises rather than returning null. Branch on TG_OP.
  if tg_op = 'INSERT' then
    became_pending := new.status = 'pending';
    was_approved := false;
  else
    became_pending := new.status = 'pending' and old.status is distinct from new.status;
    was_approved := old.status = 'pending' and new.status = 'confirmed';
  end if;

  if not became_pending and not was_approved then
    return null;
  end if;

  who := coalesce(
    nullif((select trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))
            from public.profiles p where p.id = new.client_id), ''),
    nullif(trim(coalesce(new.guest_first_name, '') || ' ' || coalesce(new.guest_last_name, '')), ''),
    'A client'
  );

  if became_pending then
    perform public.notify_roles(
      array['front_desk', 'manager', 'admin']::public.user_role[],
      'appointment_booked',
      'Needs review — ' || who,
      public.booking_review_label(new.approval_reason)
        || ' · ' || to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
      '/dashboard/appointments/pending',
      new.id
    );
  elsif was_approved and new.client_id is not null then
    insert into public.notifications (user_id, type, title, body, link, appointment_id)
    values (new.client_id, 'appointment_changed', 'Your appointment is confirmed',
            to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
            '/account/appointments/' || new.id, new.id);
  end if;

  return null;
end;
$$;

drop trigger if exists appointments_notify_review on public.appointments;
create trigger appointments_notify_review
  after insert or update on public.appointments
  for each row execute function public.appointment_notify_review();

create index if not exists appointments_pending_review_idx
  on public.appointments (starts_at)
  where status = 'pending';

-- ── 12. Who may call the helpers ─────────────────────────────
--
-- These are SECURITY DEFINER, which means they read straight past RLS, and
-- Postgres grants EXECUTE on a new function to PUBLIC by default. Left alone,
-- `booking_review_reason(null, 'someone@example.com', null, null)` would answer
-- "first_visit" or null to an anonymous caller — an account-existence oracle
-- for anybody who can reach the PostgREST endpoint, on the one table that knows
-- who has had intimate services.
--
-- Only the server-side booking engine needs them, and it holds the service
-- role. The trigger paths are unaffected: a SECURITY DEFINER trigger function
-- runs as the owner, and nested calls are checked against the owner.
--
-- booking_review_label stays open. It maps a string to a sentence and knows
-- nothing.
revoke execute on function
  public.booking_review_reason(uuid, text, text, bigint[], bigint)
  from public, anon, authenticated;
revoke execute on function
  public.provider_busy_segments(uuid, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke execute on function
  public.provider_scheduling_config(uuid, bigint)
  from public, anon, authenticated;
revoke execute on function
  public.provider_home_location_id(uuid)
  from public, anon, authenticated;

grant execute on function
  public.booking_review_reason(uuid, text, text, bigint[], bigint) to service_role;
grant execute on function
  public.provider_busy_segments(uuid, timestamptz, timestamptz) to service_role;
grant execute on function
  public.provider_scheduling_config(uuid, bigint) to service_role;
grant execute on function
  public.provider_home_location_id(uuid) to service_role;

-- ── 13. RLS ──────────────────────────────────────────────────
alter table public.scheduling_policies           enable row level security;
alter table public.provider_scheduling_settings  enable row level security;

-- Slot generation runs server-side through the service-role client, which
-- bypasses RLS, so none of this needs to be public. It is operational
-- configuration and it stays behind the staff door.
drop policy if exists "staff read scheduling policy" on public.scheduling_policies;
create policy "staff read scheduling policy" on public.scheduling_policies
  for select using (public.is_staff());

drop policy if exists "manager writes scheduling policy" on public.scheduling_policies;
create policy "manager writes scheduling policy" on public.scheduling_policies
  for all using (public.is_manager()) with check (public.is_manager());

-- Same shape as provider_schedules in 003: your own calendar is yours, and a
-- manager can reach anyone's.
drop policy if exists "staff read provider gap settings" on public.provider_scheduling_settings;
create policy "staff read provider gap settings" on public.provider_scheduling_settings
  for select using (public.is_staff());

drop policy if exists "provider manages own gap settings" on public.provider_scheduling_settings;
create policy "provider manages own gap settings" on public.provider_scheduling_settings
  for all using (provider_id = auth.uid() or public.is_manager())
  with check (provider_id = auth.uid() or public.is_manager());

-- ─────────────────────────────────────────────────────────────
-- 037_resources_waitlist.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 037: resources and the waitlist
--
-- Two halves of the same problem — a slot is a thing the studio can only sell
-- once, and the studio has more than one kind of it.
--
--   * A treatment needs a provider AND a room AND, often, a piece of kit. Two
--     clients cannot share the one LED mask even with two estheticians free, so
--     "is this time open" has to mean more than "is the provider free".
--   * When a booking falls through, the freed slot is worth something to the
--     people who already told us they wanted it. Nothing recorded that they had.
--
-- Re-runnable in full. Every object is guarded — a migration you cannot apply
-- twice is a migration you cannot recover a half-applied deploy with.
-- ============================================================


-- ════════════════════════════════════════════════════════════
-- PART 1 — RESOURCES
-- ════════════════════════════════════════════════════════════

do $$ begin
  create type public.resource_kind as enum ('room', 'equipment');
exception when duplicate_object then null; end $$;

-- ── The table ────────────────────────────────────────────────
--
-- 002 already has `rooms`, and 004 already has an exclusion constraint on
-- `appointments(room_id, slot)`. That is the right idea applied to one third of
-- the problem: it models the room a booking was *assigned* and nothing that is
-- consumed alongside it, and it cannot express "two of these exist".
--
-- So `resources` generalises `rooms` rather than replacing it. Every existing
-- room is adopted below — one resource row per room, linked by `room_id` — and
-- the mirror trigger keeps a room added later schedulable without anyone having
-- to remember. `rooms.category_ids` (which services a room may host) stays where
-- it is; nothing else models it and duplicating it here would give it two homes.
--
-- `quantity` is the column the old design could not have. A studio with two
-- identical wax warmers can run two waxes at once; a studio with one cannot, and
-- that is a number, not a boolean.
create table if not exists public.resources (
  id          bigserial primary key,

  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),

  -- The `rooms` row this resource stands for, when it stands for one. Null for
  -- equipment and for rooms created after this migration. Unique, so the
  -- adoption below is exactly one-to-one and re-running it is a no-op.
  room_id     bigint unique references public.rooms(id) on delete cascade,

  name        text not null,
  kind        public.resource_kind not null default 'equipment',

  -- How many of it there are. 0 means "we own one but it is in for repair" —
  -- an honest state, and one that correctly makes every service needing it
  -- unbookable rather than silently letting it be double-booked.
  quantity    int not null default 1 check (quantity >= 0),

  is_active   boolean not null default true,
  sort_order  int not null default 0,
  notes       text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists resources_location_idx
  on public.resources (location_id, sort_order) where is_active;

comment on table public.resources is
  'Anything a booking consumes besides the provider: rooms, beds, wax warmers, '
  'LED masks, steamers. Extends `rooms` from 002 — every room is adopted here '
  'as a resource of kind ''room'' via resources.room_id.';

comment on column public.resources.quantity is
  'How many units exist. Capacity, not a flag: with two warmers two waxes can '
  'run at once. This is the whole reason a plain exclusion constraint is not '
  'sufficient — see appointment_resources.';

drop trigger if exists resources_touch on public.resources;
create trigger resources_touch before update on public.resources
  for each row execute function public.touch_updated_at();

-- Adopt the rooms that already exist. Idempotent on room_id.
insert into public.resources (room_id, name, kind, quantity, is_active, sort_order)
select r.id, r.name, 'room', 1, r.is_active, r.sort_order
from public.rooms r
on conflict (room_id) do nothing;

-- Keep an adopted room's name and availability in step with its `rooms` row, and
-- adopt any room added later. Without this, a room created through the old admin
-- screen would be invisible to scheduling — which is precisely the drift that
-- makes a second copy of a concept dangerous.
create or replace function public.rooms_mirror_resource()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.resources (room_id, name, kind, quantity, is_active, sort_order)
    values (new.id, new.name, 'room', 1, new.is_active, new.sort_order)
    on conflict (room_id) do nothing;
  else
    update public.resources
       set name = new.name, is_active = new.is_active, sort_order = new.sort_order
     where room_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists rooms_mirror_resource on public.rooms;
create trigger rooms_mirror_resource
  after insert or update on public.rooms
  for each row execute function public.rooms_mirror_resource();

-- ── What a service consumes ──────────────────────────────────
create table if not exists public.service_resources (
  service_id  bigint not null references public.services(id) on delete cascade,
  resource_id bigint not null references public.resources(id) on delete cascade,
  -- Almost always 1. Two would mean a treatment that occupies two beds.
  quantity    int not null default 1 check (quantity > 0),
  primary key (service_id, resource_id)
);

create index if not exists service_resources_resource_idx
  on public.service_resources (resource_id);

-- ── What a booking has reserved ──────────────────────────────
--
-- `slot`, `is_held` and `is_exclusive` are all denormalised from elsewhere, and
-- all three are denormalised for the same reason: an exclusion constraint is an
-- index over ONE table. It cannot join to `appointments` to learn the window, it
-- cannot join to `appointments` to learn the status, and it cannot join to
-- `resources` to learn the capacity. Everything the guard tests has to be on the
-- row. `sync_appointment_resources` below is the single writer that keeps them
-- true, so there is one place for them to be wrong rather than five.
create table if not exists public.appointment_resources (
  id             bigserial primary key,
  appointment_id uuid   not null references public.appointments(id) on delete cascade,
  resource_id    bigint not null references public.resources(id) on delete cascade,
  quantity       int    not null default 1 check (quantity > 0),

  -- [starts_at, ends_at + buffer), copied from appointments.slot. The turnover
  -- buffer holds the room as surely as the treatment does.
  slot           tstzrange not null,

  -- A cancelled appointment releases what it held. Same rule as
  -- appointments_no_overlap in 004, which excludes `status = 'cancelled'`.
  is_held        boolean not null default true,

  -- resources.quantity <= 1. See the constraint immediately below: this is the
  -- flag that decides which of the two guards owns this row.
  is_exclusive   boolean not null default true,

  created_at     timestamptz not null default now(),
  unique (appointment_id, resource_id)
);

-- ── The guard, part one: capacity of exactly one ─────────────
--
-- Straight out of 004. A single-unit resource behaves exactly like a provider:
-- two overlapping holds is the contradiction, the GiST index is what makes it
-- impossible, and the loser of the race gets SQLSTATE 23P01 — which
-- src/lib/booking.ts already turns into a 409 `slot_taken`, with no change
-- needed there.
-- Checked against the catalog rather than caught as an exception: an exclusion
-- constraint also creates an index of the same name, so a second run raises
-- `relation already exists` (42P07) and not `duplicate_object`.
do $$ begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.appointment_resources'::regclass
      and conname  = 'appointment_resources_no_overlap'
  ) then
    alter table public.appointment_resources
      add constraint appointment_resources_no_overlap
      exclude using gist (resource_id with =, slot with &&)
      where (is_held and is_exclusive);
  end if;
end $$;

-- Backs the capacity-of-many check below, which the partial index above does
-- not cover.
create index if not exists appointment_resources_busy_idx
  on public.appointment_resources using gist (resource_id, slot) where is_held;

create index if not exists appointment_resources_appt_idx
  on public.appointment_resources (appointment_id);

-- ── The guard, part two: capacity of many ────────────────────
--
-- WHY THE CONSTRAINT ALONE CANNOT DO THIS.
--
-- An exclusion constraint asserts a predicate over *pairs* of rows: no two rows
-- may both satisfy it. "At most N of these may overlap at once" is not a
-- property of a pair — it is an aggregate over a set. With two wax warmers and
-- three overlapping bookings, every individual pair is perfectly legal (two
-- warmers, two bookings) and yet the three together are not. GiST sees pairs. It
-- cannot see the triple, and no choice of operator makes it able to.
--
-- So capacity > 1 needs a counting check, and a counting check needs a lock. Two
-- transactions each inserting the last available hold cannot see each other's
-- uncommitted row under MVCC: both count one in use, both conclude there is room,
-- both commit, and the studio has three clients and two warmers. That invisible
-- race is exactly what the exclusion constraint closes at the index level for
-- capacity 1 and what nothing can close for capacity N without serialising.
--
-- `select ... for update` on the `resources` row is that serialisation, and it
-- is the right row to take: it means "I am about to consume this resource's
-- capacity", so a concurrent booking waits, and a concurrent attempt to *lower*
-- the capacity waits too rather than racing underneath us.
--
-- The count itself is a sweep, not a sum. Summing every overlapping hold is
-- wrong: with capacity 2, a hold at 9–10 and another at 10–11 do not overlap
-- each other, so a new 9:30–10:30 booking is legal even though three holds touch
-- its window. What matters is peak concurrency inside the window, so the
-- endpoints are clamped to it and swept.
--
-- Note what this deliberately does NOT honour: `appointments.allows_overlap`.
-- Letting staff double-book a provider is a decision about a person's time, and
-- a person can agree to work through their break. Two clients cannot agree to
-- share one wax warmer.
create or replace function public.appointment_resource_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  cap  int;
  peak int;
  res_name text;
begin
  -- BEFORE, not AFTER, and the early return is checked before any lock is
  -- taken. Both matter — see sync_appointment_resources for why an insert here
  -- that locks `resources` after the row is written deadlocks under load.
  --
  -- Capacity 1 belongs to appointment_resources_no_overlap, and `is_exclusive`
  -- is that fact denormalised onto the row. Returning here means a single-unit
  -- resource never takes a row lock at all: it is guarded by the index, exactly
  -- as a provider's calendar is.
  if not new.is_held or new.is_exclusive then
    return new;
  end if;

  select r.quantity, r.name into cap, res_name
  from public.resources r
  where r.id = new.resource_id
  for update;

  if cap is null or cap <= 1 then
    return new;
  end if;

  with others as (
    select ar.quantity,
           greatest(lower(ar.slot), lower(new.slot)) as t0,
           least(upper(ar.slot), upper(new.slot))    as t1
    from public.appointment_resources ar
    where ar.resource_id = new.resource_id
      and ar.id <> new.id
      and ar.is_held
      and ar.slot && new.slot
  ),
  points as (
    select t0 as t,  quantity as d from others
    union all
    select t1,      -quantity     from others
  ),
  merged as (select t, sum(d) as d from points group by t),
  running as (select sum(d) over (order by t) as concurrent from merged)
  select coalesce(max(concurrent), 0)::int into peak from running;

  if peak + new.quantity > cap then
    -- 23P01 deliberately: the same SQLSTATE the exclusion constraint raises, so
    -- every caller has one code to handle for "that slot just went".
    raise exception '% is fully booked for that time (% of % in use)',
      res_name, peak, cap
      using errcode = '23P01';
  end if;

  return new;
end;
$$;

drop trigger if exists appointment_resources_capacity on public.appointment_resources;
create trigger appointment_resources_capacity
  before insert or update on public.appointment_resources
  for each row execute function public.appointment_resource_guard();

-- ── Keeping the denormalised columns true ────────────────────
--
-- The single writer. Recomputes an appointment's entire reservation set from
-- what it has actually booked, so a service added, removed or rescheduled lands
-- in one code path instead of three that drift.
create or replace function public.sync_appointment_resources(p_appointment uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  appt public.appointments%rowtype;
  held boolean;
begin
  select * into appt from public.appointments where id = p_appointment;
  if not found then
    return;
  end if;

  held := appt.status <> 'cancelled';

  -- Take every capacity lock this booking needs UP FRONT, in id order.
  --
  -- Two distinct deadlocks are being avoided here, and both were observed
  -- before this existed.
  --
  --   * Inserting into appointment_resources takes a KEY SHARE lock on the
  --     resources row through the foreign key. The guard then wants FOR UPDATE
  --     on that same row — a lock UPGRADE. Two bookings each holding KEY SHARE
  --     and each waiting to upgrade deadlock, and the loser gets 40P01, which
  --     no caller knows how to read. Locking first makes the FK's weaker lock a
  --     no-op instead of a hazard.
  --   * A visit needing two multi-unit resources could take them in either
  --     order. `order by r.id` gives every transaction the same order.
  --
  -- Only quantity > 1 is locked. A single-unit resource is settled by the
  -- exclusion constraint, which needs no lock and must not acquire one.
  perform 1
  from public.resources r
  where r.quantity > 1
    and r.id in (
      select sr.resource_id
      from public.appointment_services aps
      join public.service_resources sr on sr.service_id = aps.service_id
      where aps.appointment_id = p_appointment
      union
      select r2.id from public.resources r2
      where appt.room_id is not null and r2.room_id = appt.room_id
    )
  order by r.id
  for update;

  -- Drop anything no longer called for. A service removed from the visit
  -- releases its kit; that is not history worth keeping.
  delete from public.appointment_resources ar
  where ar.appointment_id = p_appointment
    and not exists (
      select 1
      from public.appointment_services aps
      join public.service_resources sr on sr.service_id = aps.service_id
      where aps.appointment_id = p_appointment
        and sr.resource_id = ar.resource_id
    )
    and not exists (
      select 1 from public.resources r
      where r.id = ar.resource_id
        and appt.room_id is not null
        and r.room_id = appt.room_id
    );

  insert into public.appointment_resources
    (appointment_id, resource_id, quantity, slot, is_held, is_exclusive)
  select p_appointment, r.id, max(need.quantity)::int, appt.slot, held, r.quantity <= 1
  from (
    -- What the booked services consume. Two services in one visit that both
    -- want the warmer want ONE warmer — they run back to back inside a single
    -- continuous block — so this is a max, never a sum.
    select sr.resource_id, sr.quantity
    from public.appointment_services aps
    join public.service_resources sr on sr.service_id = aps.service_id
    where aps.appointment_id = p_appointment

    union all

    -- The room 004 assigned directly, bridged in so the old column and the new
    -- table cannot disagree about who has the room.
    select r2.id, 1
    from public.resources r2
    where appt.room_id is not null and r2.room_id = appt.room_id
  ) need
  join public.resources r on r.id = need.resource_id
  where r.is_active
  group by r.id, r.quantity
  -- Not cosmetic. A facial holding both the room and the LED mask writes two
  -- rows, and both are settled by the exclusion index. Two bookings inserting
  -- them in opposite orders each block on the other's uncommitted index entry
  -- and deadlock — observed, before this line existed, roughly one race in six.
  -- A fixed order means they always contend on the same resource first, and one
  -- of them simply loses with 23P01.
  order by r.id
  on conflict (appointment_id, resource_id) do update
    set quantity     = excluded.quantity,
        slot         = excluded.slot,
        is_held      = excluded.is_held,
        is_exclusive = excluded.is_exclusive;
end;
$$;

create or replace function public.appointment_services_sync_resources()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target uuid;
begin
  -- By TG_OP, not coalesce(new.x, old.x): NEW is unassigned during DELETE and
  -- referencing a field of it raises rather than returning null. Same trap 004
  -- documents on appointment_recalc_totals.
  if tg_op = 'DELETE' then
    target := old.appointment_id;
  else
    target := new.appointment_id;
  end if;

  perform public.sync_appointment_resources(target);

  if tg_op <> 'DELETE' then
    -- The line items are the first moment we know what the visit is for, which
    -- is also the first moment a waitlist entry can be said to have been filled.
    perform public.waitlist_mark_converted(target);
  end if;

  return null;
end;
$$;

create or replace function public.appointment_sync_resources()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.sync_appointment_resources(new.id);
  return null;
end;
$$;

drop trigger if exists appointments_sync_resources on public.appointments;
create trigger appointments_sync_resources
  after insert or update of status, starts_at, ends_at, buffer_minutes, room_id
  on public.appointments
  for each row execute function public.appointment_sync_resources();

-- Changing capacity moves rows between the two guards. Going from two warmers
-- down to one while two overlapping bookings hold them is a real contradiction,
-- and the exclusion constraint says so — this only translates it into a sentence
-- the person clicking Save can act on.
create or replace function public.resources_sync_exclusive()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.quantity is distinct from old.quantity then
    begin
      update public.appointment_resources
         set is_exclusive = (new.quantity <= 1)
       where resource_id = new.id
         and is_exclusive <> (new.quantity <= 1);
    exception when exclusion_violation then
      raise exception
        'Bookings already overlap on %, so it cannot be reduced to %. Move or cancel one of them first.',
        new.name, new.quantity
        using errcode = '23P01';
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists resources_sync_exclusive on public.resources;
create trigger resources_sync_exclusive
  after update of quantity on public.resources
  for each row execute function public.resources_sync_exclusive();

-- ── Which location is this appointment at? ───────────────────
--
-- `appointments.location_id` is the answer when it exists, and it is read
-- through `to_jsonb(a) ->> 'location_id'` rather than named directly. That is
-- not squeamishness: the column arrives in a migration owned elsewhere, and a
-- direct reference would make this file fail to apply against a database where
-- it has not landed yet. An absent key is simply null, so the fallbacks below
-- take over — no dynamic SQL, no catalogue branching, and nothing to change if
-- the column appears or moves later.
--
-- Failing that, it is derived from what the booking physically holds: a resource
-- is location-scoped, so the room a booking is in says where the booking is.
create or replace function public.appointment_location_id(p_appointment uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(to_jsonb(a) ->> 'location_id', '')::bigint
       from public.appointments a where a.id = p_appointment),
    (select r.location_id
       from public.appointment_resources ar
       join public.resources r on r.id = ar.resource_id
      where ar.appointment_id = p_appointment
      order by r.kind, r.id
      limit 1),
    (select r.location_id
       from public.appointments a
       join public.resources r on r.room_id = a.room_id
      where a.id = p_appointment
      limit 1),
    public.default_location_id()
  );
$$;

-- ── Reading it back ──────────────────────────────────────────
--
-- Which resources stand in the way of booking these services into this window,
-- and by how much. Staff-facing: it names the resource, so the front desk can
-- say "the LED mask is out until three" rather than "no".
create or replace function public.resource_conflicts(
  p_location_id         bigint,
  p_starts_at           timestamptz,
  p_ends_at             timestamptz,
  p_service_ids         bigint[],
  p_exclude_appointment uuid default null
) returns table (
  resource_id   bigint,
  resource_name text,
  kind          public.resource_kind,
  capacity      int,
  required      int,
  peak_in_use   int
) language sql stable security definer set search_path = public as $$
  with req as (
    select r.id,
           r.name,
           r.kind,
           -- Inactive is capacity zero, not "ignore me". A service whose only
           -- steamer is out of service is not bookable, and saying so here is
           -- the difference between a clear message and a mystery.
           case when r.is_active then r.quantity else 0 end as capacity,
           max(sr.quantity)::int as required
    from public.service_resources sr
    join public.resources r on r.id = sr.resource_id
    where sr.service_id = any(p_service_ids)
      and r.location_id = coalesce(p_location_id, public.default_location_id())
    group by r.id, r.name, r.kind, r.is_active, r.quantity
  ),
  others as (
    select ar.resource_id,
           ar.quantity,
           greatest(lower(ar.slot), p_starts_at) as t0,
           least(upper(ar.slot), p_ends_at)      as t1
    from public.appointment_resources ar
    join req on req.id = ar.resource_id
    where ar.is_held
      and ar.slot && tstzrange(p_starts_at, p_ends_at, '[)')
      and (p_exclude_appointment is null or ar.appointment_id <> p_exclude_appointment)
  ),
  points as (
    select resource_id, t0 as t,  quantity as d from others
    union all
    select resource_id, t1,      -quantity     from others
  ),
  merged as (select resource_id, t, sum(d) as d from points group by resource_id, t),
  running as (
    select resource_id, sum(d) over (partition by resource_id order by t) as concurrent
    from merged
  ),
  peak as (select resource_id, max(concurrent)::int as concurrent from running group by resource_id)
  select req.id, req.name, req.kind, req.capacity, req.required,
         coalesce(peak.concurrent, 0)
  from req
  left join peak on peak.resource_id = req.id
  where coalesce(peak.concurrent, 0) + req.required > req.capacity
    -- auth.uid() null means no JWT: a migration, the SQL editor, or the service
    -- role — all already privileged. Same reasoning as 001's privilege guard.
    and (public.is_staff() or auth.uid() is null);
$$;

-- The availability integration point.
--
-- Returns the windows inside [p_from, p_to) during which these services could
-- not be performed for want of a resource, in exactly the shape
-- `AvailabilityInput.busy` already takes ({ starts_at, ends_at }). Slot
-- generation therefore needs no new concept: resource contention is busy time,
-- and the existing overlap test rejects it like any other.
--
-- A resource with no free capacity for the whole period (inactive, quantity 0,
-- or simply smaller than the requirement) yields the entire window, which is the
-- correct answer rather than an empty one.
create or replace function public.resource_busy_intervals(
  p_location_id         bigint,
  p_from                timestamptz,
  p_to                  timestamptz,
  p_service_ids         bigint[],
  p_exclude_appointment uuid default null
) returns table (
  starts_at timestamptz,
  ends_at   timestamptz
) language sql stable security definer set search_path = public as $$
  with req as (
    select r.id,
           case when r.is_active then r.quantity else 0 end as capacity,
           max(sr.quantity)::int as required
    from public.service_resources sr
    join public.resources r on r.id = sr.resource_id
    where sr.service_id = any(p_service_ids)
      and r.location_id = coalesce(p_location_id, public.default_location_id())
    group by r.id, r.is_active, r.quantity
  ),
  others as (
    select ar.resource_id,
           ar.quantity,
           greatest(lower(ar.slot), p_from) as t0,
           least(upper(ar.slot), p_to)      as t1
    from public.appointment_resources ar
    join req on req.id = ar.resource_id
    where ar.is_held
      and ar.slot && tstzrange(p_from, p_to, '[)')
      and (p_exclude_appointment is null or ar.appointment_id <> p_exclude_appointment)
  ),
  points as (
    -- The two zero-weight seeds put a segment boundary at each end of the window
    -- for every required resource, so one with no reservations at all still
    -- produces a segment to test against its capacity.
    select id as resource_id, p_from as t, 0 as d from req
    union all
    select id, p_to, 0 from req
    union all
    select resource_id, t0,  quantity from others
    union all
    select resource_id, t1, -quantity from others
  ),
  merged as (select resource_id, t, sum(d) as d from points group by resource_id, t),
  running as (
    select resource_id,
           t,
           sum(d) over (partition by resource_id order by t) as concurrent,
           lead(t)  over (partition by resource_id order by t) as t_next
    from merged
  )
  select running.t, running.t_next
  from running
  join req on req.id = running.resource_id
  where running.t_next is not null
    and running.concurrent + req.required > req.capacity;
$$;

-- ── RLS ──────────────────────────────────────────────────────
--
-- Nothing here is public. The booking page never queries these directly — it
-- reads slots, and `resource_busy_intervals` (security definer) is what folds
-- resource contention into them without exposing which room is where.
alter table public.resources             enable row level security;
alter table public.service_resources     enable row level security;
alter table public.appointment_resources enable row level security;

drop policy if exists "staff read resources" on public.resources;
create policy "staff read resources" on public.resources
  for select to authenticated using (public.is_staff());

-- Rooms and equipment are operational, not financial: a manager buying a second
-- warmer should not need the owner's login. Pricing and booking gates stay
-- admin-only where 002 left them.
drop policy if exists "manager writes resources" on public.resources;
create policy "manager writes resources" on public.resources
  for all to authenticated using (public.is_manager()) with check (public.is_manager());

drop policy if exists "staff read service resources" on public.service_resources;
create policy "staff read service resources" on public.service_resources
  for select to authenticated using (public.is_staff());

drop policy if exists "manager writes service resources" on public.service_resources;
create policy "manager writes service resources" on public.service_resources
  for all to authenticated using (public.is_manager()) with check (public.is_manager());

-- Reservations are written by `sync_appointment_resources` and by nothing else.
-- There is deliberately no insert or update policy: a hand-written row here
-- would be a hold on a resource with no booking behind it.
drop policy if exists "staff read appointment resources" on public.appointment_resources;
create policy "staff read appointment resources" on public.appointment_resources
  for select to authenticated using (
    public.is_front_desk() or exists (
      select 1 from public.appointments a
      where a.id = appointment_id and a.provider_id = auth.uid()
    )
  );

revoke all on public.resources             from anon;
revoke all on public.service_resources     from anon;
revoke all on public.appointment_resources from anon;
grant select, insert, update, delete on public.resources         to authenticated;
grant select, insert, update, delete on public.service_resources to authenticated;
grant select on public.appointment_resources to authenticated;
grant usage, select on sequence public.resources_id_seq to authenticated, service_role;
grant usage, select on sequence public.appointment_resources_id_seq to service_role;
grant all on public.resources             to service_role;
grant all on public.service_resources     to service_role;
grant all on public.appointment_resources to service_role;

revoke all on function public.resource_conflicts(bigint, timestamptz, timestamptz, bigint[], uuid) from anon;
grant execute on function public.resource_conflicts(bigint, timestamptz, timestamptz, bigint[], uuid)
  to authenticated, service_role;
revoke all on function public.resource_busy_intervals(bigint, timestamptz, timestamptz, bigint[], uuid) from anon;
grant execute on function public.resource_busy_intervals(bigint, timestamptz, timestamptz, bigint[], uuid)
  to authenticated, service_role;
grant execute on function public.appointment_location_id(uuid) to authenticated, service_role;


-- ════════════════════════════════════════════════════════════
-- PART 2 — WAITLIST
-- ════════════════════════════════════════════════════════════

do $$ begin
  create type public.waitlist_status as enum (
    'waiting',    -- in the queue
    'notified',   -- holding a claim window on a specific freed slot
    'converted',  -- booked something that matched
    'expired',    -- ran out of runway, or out of offers
    'cancelled'   -- withdrawn by the client or the studio
  );
exception when duplicate_object then null; end $$;

-- A distinct notification type so the bell can say what this is. Adding an enum
-- value is transaction-safe in PG12+ as long as nothing *uses* it in the same
-- transaction; the literal below lives inside a function body, which is text
-- until it runs.
do $$ begin
  alter type public.notification_type add value if not exists 'waitlist_offer';
exception when others then null; end $$;

-- ── Policy ───────────────────────────────────────────────────
--
-- THE FAIRNESS DECISION, and it is a real one.
--
-- Two honest options. Tell everyone who matches and let them race, or tell the
-- person who has waited longest and give them a window to answer.
--
-- Racing is not fairness; it is a test of who happened to be holding their
-- phone. The person who asked first in January loses to the person who asked on
-- Tuesday and happens to be at lunch, and every loser was told about a slot they
-- could not have. So the default is FIRST COME, FIRST SERVED with an exclusive
-- claim window: the earliest matching entry is offered the slot and nobody else
-- is told until they have had `claim_window_minutes` to take it.
--
-- Configurable, because the studio may reasonably disagree and the cost is one
-- column each:
--   * `batch_size`          — offer to the first N at once. 1 is strict FCFS.
--   * `claim_window_minutes`— how long the queue waits on one person.
--   * `urgent_within_hours` — inside this, politeness loses to filling the
--     chair: everyone matching is told at once, because a slot at 4pm that
--     nobody claims by 2pm is simply a slot the studio does not sell.
--   * `max_offers_per_entry`— someone who ignores three offers is not waiting.
--
-- Note what this is NOT: a hold on the slot. Nothing here reserves the
-- appointment — a phantom booking would be a lie to every other system that
-- reads the calendar. It is a hold on *being told*, which is the thing the
-- studio actually controls.
create table if not exists public.waitlist_settings (
  id                    int primary key default 1 check (id = 1),
  auto_notify           boolean not null default true,
  batch_size            int not null default 1  check (batch_size between 1 and 50),
  claim_window_minutes  int not null default 120 check (claim_window_minutes between 5 and 10080),
  urgent_within_hours   int not null default 12  check (urgent_within_hours >= 0),
  max_offers_per_entry  int not null default 3   check (max_offers_per_entry between 1 and 20),
  default_expiry_days   int not null default 60  check (default_expiry_days between 1 and 365),
  -- Most a single urgent slot may be announced to at once, so "tell everyone"
  -- cannot turn into a hundred threads from one cancellation.
  urgent_max_recipients int not null default 25  check (urgent_max_recipients between 1 and 200),
  updated_at            timestamptz not null default now()
);

insert into public.waitlist_settings (id) values (1) on conflict do nothing;

drop trigger if exists waitlist_settings_touch on public.waitlist_settings;
create trigger waitlist_settings_touch before update on public.waitlist_settings
  for each row execute function public.touch_updated_at();

-- ── The entries ──────────────────────────────────────────────
--
-- Dates and times here are WALL-CLOCK in the location's zone, the same rule
-- `provider_schedules.start_time` and `availability_blocks.block_date` follow.
-- "Saturday mornings" is a thing a person means locally; it is not an instant.
-- The matcher converts the freed appointment's instant into that zone with
-- `at time zone` and compares there — one conversion, at the point of
-- comparison, never a stored offset.
create table if not exists public.waitlist_entries (
  id          uuid primary key default gen_random_uuid(),

  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),

  client_id   uuid not null references public.profiles(id) on delete cascade,
  -- Null means "anyone". A named provider narrows the match and is the common
  -- case in a studio where clients come back to the person, not the room.
  preferred_provider_id uuid references public.profiles(id) on delete set null,

  earliest_date date not null,
  latest_date   date not null,
  -- 0 = Sunday, matching provider_schedules.day_of_week. Empty = any day.
  days_of_week  int[] not null default '{}',
  earliest_time time,
  latest_time   time,

  note   text,
  status public.waitlist_status not null default 'waiting',

  created_at       timestamptz not null default now(),
  notified_at      timestamptz,
  -- Until this instant nobody else is told about the slot they were offered.
  claim_expires_at timestamptz,
  offers_sent      int not null default 0,
  last_offer_appointment_id uuid references public.appointments(id) on delete set null,
  expires_at       timestamptz,
  converted_appointment_id  uuid references public.appointments(id) on delete set null,
  updated_at       timestamptz not null default now(),

  constraint waitlist_date_range_valid check (latest_date >= earliest_date),
  constraint waitlist_time_range_valid check (
    earliest_time is null or latest_time is null or latest_time > earliest_time
  ),
  constraint waitlist_dow_valid check (days_of_week <@ array[0,1,2,3,4,5,6])
);

create index if not exists waitlist_open_idx
  on public.waitlist_entries (location_id, created_at)
  where status in ('waiting', 'notified');
create index if not exists waitlist_client_idx
  on public.waitlist_entries (client_id, created_at desc);
create index if not exists waitlist_claim_idx
  on public.waitlist_entries (claim_expires_at)
  where status = 'notified';

drop trigger if exists waitlist_entries_touch on public.waitlist_entries;
create trigger waitlist_entries_touch before update on public.waitlist_entries
  for each row execute function public.touch_updated_at();

-- Which services would do. A child table rather than an array so a retired
-- service takes its waitlist interest with it instead of leaving dangling ids.
create table if not exists public.waitlist_services (
  entry_id   uuid   not null references public.waitlist_entries(id) on delete cascade,
  service_id bigint not null references public.services(id) on delete cascade,
  primary key (entry_id, service_id)
);

create index if not exists waitlist_services_service_idx
  on public.waitlist_services (service_id);

-- ── Joining ──────────────────────────────────────────────────
--
-- One entry point, for the same reason booking has one: the row has to be valid
-- and it has to arrive with its services attached. Two inserts from a browser is
-- two chances to end up with an entry that matches nothing.
create or replace function public.join_waitlist(
  p_service_ids   bigint[],
  p_earliest_date date,
  p_latest_date   date,
  p_provider_id   uuid    default null,
  p_days_of_week  int[]   default '{}',
  p_earliest_time time    default null,
  p_latest_time   time    default null,
  p_note          text    default null,
  p_client_id     uuid    default null,
  p_location_id   bigint  default null
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  caller   uuid := auth.uid();
  target   uuid;
  loc      bigint := coalesce(p_location_id, public.default_location_id());
  today    date;
  valid    int;
  open_now int;
  entry    uuid;
begin
  -- Staff may add someone; everyone else may only add themselves. Passing
  -- another person's id without the role is not a mistake worth guessing at.
  if p_client_id is not null and p_client_id is distinct from caller then
    if not public.is_front_desk() then
      raise exception 'Only the front desk can add someone else to the waitlist'
        using errcode = '42501';
    end if;
    target := p_client_id;
  else
    target := caller;
  end if;

  if target is null then
    raise exception 'Sign in to join the waitlist' using errcode = '42501';
  end if;

  if coalesce(array_length(p_service_ids, 1), 0) = 0 then
    raise exception 'Choose at least one service' using errcode = '22023';
  end if;

  select count(*) into valid
  from public.services s
  where s.id = any(p_service_ids) and s.is_active and not s.requires_consultation;

  if valid <> cardinality(array(select distinct unnest(p_service_ids))) then
    raise exception 'One of those services cannot be booked online' using errcode = '22023';
  end if;

  select (now() at time zone l.timezone)::date into today
  from public.locations l where l.id = loc;

  if today is null then
    raise exception 'Unknown location' using errcode = '22023';
  end if;
  if p_latest_date < p_earliest_date then
    raise exception 'That date range runs backwards' using errcode = '22023';
  end if;
  if p_latest_date < today then
    raise exception 'That date range has already passed' using errcode = '22023';
  end if;
  if p_earliest_date > today + 365 then
    raise exception 'We only take waitlist requests up to a year out' using errcode = '22023';
  end if;

  if p_provider_id is not null and not exists (
    select 1 from public.profiles p
    where p.id = p_provider_id and p.role <> 'client' and p.suspended_at is null
  ) then
    raise exception 'That provider is not taking bookings' using errcode = '22023';
  end if;

  -- A waitlist is a queue, not a lottery ticket you buy in bulk. Five live
  -- requests is more than any one person needs and it stops a script from
  -- crowding out everyone behind it.
  select count(*) into open_now
  from public.waitlist_entries w
  where w.client_id = target and w.status in ('waiting', 'notified');

  if open_now >= 5 then
    raise exception 'You already have five open waitlist requests' using errcode = '22023';
  end if;

  insert into public.waitlist_entries (
    location_id, client_id, preferred_provider_id,
    earliest_date, latest_date, days_of_week, earliest_time, latest_time,
    note, expires_at
  ) values (
    loc, target, p_provider_id,
    greatest(p_earliest_date, today), p_latest_date,
    coalesce(p_days_of_week, '{}'), p_earliest_time, p_latest_time,
    nullif(trim(coalesce(p_note, '')), ''),
    now() + make_interval(days =>
      (select default_expiry_days from public.waitlist_settings where id = 1))
  )
  returning id into entry;

  insert into public.waitlist_services (entry_id, service_id)
  select entry, s.id from public.services s where s.id = any(p_service_ids);

  return entry;
end;
$$;

-- ── Matching ─────────────────────────────────────────────────
--
-- Who wanted the slot this cancellation just created? Everything is compared in
-- the location's wall clock, because that is what the client typed.
create or replace function public.waitlist_matches(p_appointment uuid)
returns table (
  entry_id    uuid,
  client_id   uuid,
  client_name text,
  waiting_since timestamptz,
  status      public.waitlist_status,
  offers_sent int
) language sql stable security definer set search_path = public as $$
  with appt as (
    select a.id, a.provider_id, a.client_id, a.starts_at,
           public.appointment_location_id(a.id) as location_id
    from public.appointments a
    where a.id = p_appointment
  ),
  loc as (
    select l.id, l.timezone
    from public.locations l join appt on appt.location_id = l.id
  ),
  local as (
    select (appt.starts_at at time zone loc.timezone)::date            as on_date,
           (appt.starts_at at time zone loc.timezone)::time            as at_time,
           extract(dow from (appt.starts_at at time zone loc.timezone))::int as dow
    from appt cross join loc
  ),
  freed as (
    select coalesce(array_agg(distinct aps.service_id), '{}') as service_ids
    from public.appointment_services aps
    where aps.appointment_id = p_appointment and aps.service_id is not null
  ),
  cfg as (select max_offers_per_entry from public.waitlist_settings where id = 1)
  select w.id,
         w.client_id,
         nullif(trim(concat_ws(' ', p.first_name, p.last_name)), ''),
         w.created_at,
         w.status,
         w.offers_sent
  from public.waitlist_entries w
  join public.profiles p on p.id = w.client_id
  cross join appt cross join loc cross join local cross join freed cross join cfg
  where w.location_id = loc.id
    and w.status in ('waiting', 'notified')
    -- A live claim on another slot is a promise already made. Do not re-offer
    -- until it lapses, or the claim window means nothing.
    and (w.status = 'waiting' or w.claim_expires_at is null or w.claim_expires_at <= now())
    and (w.expires_at is null or w.expires_at > now())
    and w.offers_sent < cfg.max_offers_per_entry
    -- Whoever just cancelled does not want their own slot back.
    and w.client_id is distinct from appt.client_id
    and (w.preferred_provider_id is null or w.preferred_provider_id = appt.provider_id)
    and local.on_date between w.earliest_date and w.latest_date
    and (cardinality(w.days_of_week) = 0 or local.dow = any(w.days_of_week))
    and (w.earliest_time is null or local.at_time >= w.earliest_time)
    and (w.latest_time  is null or local.at_time <= w.latest_time)
    and exists (
      select 1 from public.waitlist_services ws
      where ws.entry_id = w.id and ws.service_id = any(freed.service_ids)
    )
    and (public.is_staff() or auth.uid() is null)
  -- First come, first served. This ORDER BY is the fairness rule.
  order by w.created_at, w.id;
$$;

-- ── Releasing lapsed claims ──────────────────────────────────
--
-- A claim that ran out returns to 'waiting' rather than going to the back of the
-- queue: they have still waited longest, and the next slot is still theirs to
-- refuse first. `max_offers_per_entry` is what eventually retires someone who
-- never answers, which is a kinder rule than silently demoting them.
create or replace function public.waitlist_release_expired()
returns int language plpgsql security definer set search_path = public as $$
declare
  released int := 0;
  gone     int := 0;
  cfg      public.waitlist_settings%rowtype;
begin
  select * into cfg from public.waitlist_settings where id = 1;

  update public.waitlist_entries
     set status = 'waiting', claim_expires_at = null
   where status = 'notified'
     and claim_expires_at is not null
     and claim_expires_at <= now()
     and offers_sent < cfg.max_offers_per_entry;
  get diagnostics released = row_count;

  update public.waitlist_entries
     set status = 'expired', claim_expires_at = null
   where status in ('waiting', 'notified')
     and (
       (expires_at is not null and expires_at <= now())
       or offers_sent >= cfg.max_offers_per_entry
       or latest_date < (
            select (now() at time zone l.timezone)::date
            from public.locations l where l.id = location_id
          )
     );
  get diagnostics gone = row_count;

  return released + gone;
end;
$$;

-- ── Telling them ─────────────────────────────────────────────
--
-- There is no email provider in this project and inventing one here would be a
-- second delivery path nobody maintains. The inbox is the channel: a thread per
-- recipient, exactly as `send_broadcast` does it in 028, so a reply comes back
-- as an ordinary conversation attached to that client's record — which matters
-- more here than for a newsletter, because the reply is usually "yes please" or
-- "can you do half an hour later".
--
-- No notification row is written for the message. `messages_after_insert`
-- already raises one whenever staff post to a client thread; a second is two
-- pings for one event, which 028 learned the hard way. The waitlist_offer
-- notification below is the one that carries the booking link.
create or replace function public.waitlist_notify_for_appointment(
  p_appointment uuid,
  p_limit       int default null
) returns int language plpgsql security definer set search_path = public as $$
declare
  cfg       public.waitlist_settings%rowtype;
  appt      public.appointments%rowtype;
  tz        text;
  when_text text;
  provider  text;
  deep_link text;
  take      int;
  holding   int;
  claim_at  timestamptz;
  m         record;
  thread    uuid;
  sent      int := 0;
begin
  if auth.uid() is not null and not public.is_front_desk() then
    raise exception 'Only the front desk can send waitlist offers' using errcode = '42501';
  end if;

  select * into appt from public.appointments where id = p_appointment;
  if not found or appt.starts_at <= now() then
    return 0;
  end if;

  perform public.waitlist_release_expired();

  select * into cfg from public.waitlist_settings where id = 1;

  select l.timezone into tz
  from public.locations l where l.id = public.appointment_location_id(p_appointment);
  tz := coalesce(tz, 'America/Los_Angeles');

  -- How many to tell. Inside the urgent horizon the queue is abandoned on
  -- purpose: one person sitting on a two-hour claim for a slot three hours away
  -- is how a chair goes empty.
  if p_limit is not null then
    -- An explicit number is a person clicking "tell the next one" with the
    -- screen in front of them. That overrides the queue on purpose.
    take := greatest(1, p_limit);
  else
    if appt.starts_at <= now() + make_interval(hours => cfg.urgent_within_hours) then
      take := cfg.urgent_max_recipients;
    else
      take := cfg.batch_size;
    end if;

    -- Claims already live on THIS slot count against the batch. Without this the
    -- sweep would hand the same slot to the next person every time it ran, and
    -- the claim window — the entire fairness mechanism — would mean nothing
    -- after the first few minutes.
    select count(*) into holding
    from public.waitlist_entries w
    where w.last_offer_appointment_id = p_appointment
      and w.status = 'notified'
      and w.claim_expires_at > now();

    take := take - holding;
  end if;

  if take <= 0 then
    return 0;
  end if;

  -- Never past the slot itself: a claim that outlives the appointment is not a
  -- claim, and the booking engine's own lead time would refuse it anyway.
  claim_at := least(now() + make_interval(mins => cfg.claim_window_minutes), appt.starts_at);

  when_text := to_char(appt.starts_at at time zone tz, 'FMDay, FMMonth FMDD')
               || ' at ' || to_char(appt.starts_at at time zone tz, 'FMHH12:MI AM');

  select coalesce(nullif(trim(coalesce(p.display_name, p.first_name)), ''), 'your provider')
    into provider
  from public.profiles p where p.id = appt.provider_id;

  -- Send them to the service that actually freed up where we can, so the booking
  -- page opens on the right thing.
  select '/book?service=' || s.slug into deep_link
  from public.appointment_services aps
  join public.services s on s.id = aps.service_id
  where aps.appointment_id = p_appointment
  order by aps.sort_order
  limit 1;
  deep_link := coalesce(deep_link, '/book');

  for m in
    select * from public.waitlist_matches(p_appointment) limit take
  loop
    insert into public.message_threads (client_id, subject, status, staff_unread)
    values (m.client_id, 'A spot opened — ' || when_text, 'open', false)
    returning id into thread;

    insert into public.messages (thread_id, sender_id, sender_name, body, is_internal)
    values (
      thread,
      auth.uid(),
      '559 Flawless',
      'You asked to be told when something opened up. ' || provider || ' has '
      || when_text || ' free. It is held for you until '
      || to_char(claim_at at time zone tz, 'FMHH12:MI AM') || ' — book it at '
      || deep_link || ', or reply here and we will sort it out. '
      || 'If the timing no longer suits, tell us and we will leave you on the list.',
      false
    );

    insert into public.notifications (user_id, type, title, body, link, appointment_id, thread_id)
    values (
      m.client_id,
      'waitlist_offer',
      'A spot opened — ' || when_text,
      'Held for you until ' || to_char(claim_at at time zone tz, 'FMHH12:MI AM') || '.',
      deep_link,
      p_appointment,
      thread
    );

    update public.waitlist_entries
       set status = 'notified',
           notified_at = now(),
           claim_expires_at = claim_at,
           offers_sent = offers_sent + 1,
           last_offer_appointment_id = p_appointment
     where id = m.entry_id;

    sent := sent + 1;
  end loop;

  return sent;
end;
$$;

-- The cron / "check the waitlist" entry point: release what lapsed, then pass
-- each freed slot down the queue. Idempotent — running it twice in a minute
-- notifies nobody twice, because the claim windows it just wrote are still live.
create or replace function public.waitlist_sweep()
returns int language plpgsql security definer set search_path = public as $$
declare
  a    record;
  sent int := 0;
begin
  if auth.uid() is not null and not public.is_front_desk() then
    raise exception 'Only the front desk can run the waitlist sweep' using errcode = '42501';
  end if;

  perform public.waitlist_release_expired();

  for a in
    select distinct w.last_offer_appointment_id as id
    from public.waitlist_entries w
    where w.status = 'waiting'
      and w.last_offer_appointment_id is not null
    union
    select a2.id
    from public.appointments a2
    where a2.status = 'cancelled'
      and a2.starts_at > now()
      and a2.cancelled_at > now() - interval '7 days'
  loop
    sent := sent + public.waitlist_notify_for_appointment(a.id);
  end loop;

  return sent;
end;
$$;

-- ── Hooked to cancellation ───────────────────────────────────
--
-- 004 logs the transition and 006 notifies on it; this follows the same shape
-- rather than editing either, so each trigger keeps one job and the two applied
-- migrations stay applied. Trigger names sort after `appointments_notify`, so
-- the client learns their booking is cancelled before the list learns it is free.
create or replace function public.appointment_waitlist_on_cancel()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled'
     and old.status is distinct from 'cancelled'
     and new.starts_at > now()
     and coalesce((select auto_notify from public.waitlist_settings where id = 1), false)
  then
    perform public.waitlist_notify_for_appointment(new.id);
  end if;
  return null;
end;
$$;

drop trigger if exists appointments_waitlist on public.appointments;
create trigger appointments_waitlist
  after update of status on public.appointments
  for each row execute function public.appointment_waitlist_on_cancel();

-- The other end of the loop: someone on the list booked something that fits, so
-- they are off it. Called from the appointment_services trigger because the line
-- items are the first point at which the visit knows what it is for.
create or replace function public.waitlist_mark_converted(p_appointment uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  appt public.appointments%rowtype;
  tz   text;
  d    date;
begin
  select * into appt from public.appointments where id = p_appointment;
  if not found or appt.client_id is null or appt.status = 'cancelled' then
    return;
  end if;

  select l.timezone into tz
  from public.locations l where l.id = public.appointment_location_id(p_appointment);
  d := (appt.starts_at at time zone coalesce(tz, 'America/Los_Angeles'))::date;

  update public.waitlist_entries w
     set status = 'converted',
         converted_appointment_id = p_appointment,
         claim_expires_at = null
   where w.client_id = appt.client_id
     and w.status in ('waiting', 'notified')
     and d between w.earliest_date and w.latest_date
     and exists (
       select 1
       from public.waitlist_services ws
       join public.appointment_services aps on aps.service_id = ws.service_id
       where ws.entry_id = w.id and aps.appointment_id = p_appointment
     );
end;
$$;

-- Installed last, because it references waitlist_mark_converted.
drop trigger if exists appointment_services_resources on public.appointment_services;
create trigger appointment_services_resources
  after insert or update or delete on public.appointment_services
  for each row execute function public.appointment_services_sync_resources();

-- ── RLS ──────────────────────────────────────────────────────
alter table public.waitlist_settings enable row level security;
alter table public.waitlist_entries  enable row level security;
alter table public.waitlist_services enable row level security;

drop policy if exists "staff read waitlist settings" on public.waitlist_settings;
create policy "staff read waitlist settings" on public.waitlist_settings
  for select to authenticated using (public.is_staff());

-- How long a person is made to wait before the next one is told is booking
-- policy, and booking policy is admin-only everywhere else in this schema.
drop policy if exists "admin writes waitlist settings" on public.waitlist_settings;
create policy "admin writes waitlist settings" on public.waitlist_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "client reads own waitlist" on public.waitlist_entries;
create policy "client reads own waitlist" on public.waitlist_entries
  for select to authenticated using (client_id = auth.uid());

drop policy if exists "staff reads waitlist" on public.waitlist_entries;
create policy "staff reads waitlist" on public.waitlist_entries
  for select to authenticated using (
    public.is_front_desk() or preferred_provider_id = auth.uid()
  );

-- A client may withdraw, and that is all. Rewriting a date range would move them
-- in the queue without changing created_at, which is the one thing the fairness
-- rule rests on; they can withdraw and rejoin, honestly at the back.
drop policy if exists "client withdraws own waitlist" on public.waitlist_entries;
create policy "client withdraws own waitlist" on public.waitlist_entries
  for update to authenticated
  using (client_id = auth.uid() and status in ('waiting', 'notified'))
  with check (client_id = auth.uid() and status = 'cancelled');

drop policy if exists "front desk manages waitlist" on public.waitlist_entries;
create policy "front desk manages waitlist" on public.waitlist_entries
  for update to authenticated
  using (public.is_front_desk()) with check (public.is_front_desk());

drop policy if exists "front desk removes waitlist" on public.waitlist_entries;
create policy "front desk removes waitlist" on public.waitlist_entries
  for delete to authenticated using (public.is_front_desk());

-- No INSERT policy: entries arrive through join_waitlist, which is the only
-- thing that can guarantee an entry has services attached to it.

drop policy if exists "read waitlist services" on public.waitlist_services;
create policy "read waitlist services" on public.waitlist_services
  for select to authenticated using (
    public.is_front_desk() or exists (
      select 1 from public.waitlist_entries w
      where w.id = entry_id
        and (w.client_id = auth.uid() or w.preferred_provider_id = auth.uid())
    )
  );

revoke all on public.waitlist_settings from anon;
revoke all on public.waitlist_entries  from anon;
revoke all on public.waitlist_services from anon;
grant select, update on public.waitlist_settings to authenticated;
grant select, update, delete on public.waitlist_entries to authenticated;
grant select on public.waitlist_services to authenticated;
grant all on public.waitlist_settings to service_role;
grant all on public.waitlist_entries  to service_role;
grant all on public.waitlist_services to service_role;

revoke all on function public.join_waitlist(bigint[], date, date, uuid, int[], time, time, text, uuid, bigint) from anon;
grant execute on function public.join_waitlist(bigint[], date, date, uuid, int[], time, time, text, uuid, bigint)
  to authenticated, service_role;
revoke all on function public.waitlist_matches(uuid) from anon;
grant execute on function public.waitlist_matches(uuid) to authenticated, service_role;
revoke all on function public.waitlist_notify_for_appointment(uuid, int) from anon;
grant execute on function public.waitlist_notify_for_appointment(uuid, int) to authenticated, service_role;
revoke all on function public.waitlist_release_expired() from anon;
grant execute on function public.waitlist_release_expired() to authenticated, service_role;
revoke all on function public.waitlist_sweep() from anon;
grant execute on function public.waitlist_sweep() to authenticated, service_role;

-- ─────────────────────────────────────────────────────────────
-- 038_notification_schedules.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 038: client notifications the studio controls
--
-- 006 gave us notifications and a trigger that fires on booking, change and
-- cancellation, with the wording hard-coded in PL/pgSQL. `reminder_sent_at` and
-- `intake_reminder_sent_at` have existed since 004 and 023 and nothing has ever
-- set them: there was no reminder to send. This migration is the missing half.
--
-- Three tables and one dispatcher:
--
--   notification_templates  what it says       — the studio writes this
--   notification_schedules  when it goes       — the studio sets this
--   notification_queue      what actually went — the record, and the guard
--
-- Delivery today is in-app only: a `notifications` row, plus a message thread
-- when the client should be able to answer back. There is no email or SMS
-- provider on this deployment, so rather than pretend there is, every queue row
-- carries a `channel` and anything that is not `in_app` is left `pending` for a
-- sender to claim through `claim_notification_queue()`. Dropping in Resend or
-- Twilio later means writing that one worker and adding a template row — not
-- reshaping any of this.
--
-- Two rules do the real work:
--
--   * Idempotency is a unique index, not a flag. A cron that runs twice, or a
--     dispatcher that is invoked by hand while the scheduled one is mid-sweep,
--     collides on (recipient, kind, channel, subject, scheduled_for) and the
--     second insert is a no-op. Nothing anywhere has to remember what it did.
--
--   * Whether a message is transactional or marketing is a property of its
--     KIND, fixed in `notification_kind_category()` and forced onto every queue
--     row by a trigger. The studio can rewrite a rebooking nudge but cannot
--     relabel it as transactional to get around someone's opt-out, and cannot
--     accidentally suppress a genuine appointment reminder by treating it as
--     marketing. Both directions of that mistake are expensive.
--
-- Depends on 032 for `public.locations` and `public.default_location_id()`.
-- ============================================================

-- ── Enums ────────────────────────────────────────────────────
-- Wrapped in exception handlers rather than guarded with a catalog lookup so
-- the whole file is re-runnable: `create type` has no IF NOT EXISTS.

do $do$ begin
  create type public.notification_kind as enum (
    'booking_confirmation',
    'appointment_reminder',
    'appointment_changed',
    'appointment_cancelled',
    'waitlist_opening',
    'rebooking_nudge',
    'intake_outstanding',
    'patch_test_due'
  );
exception when duplicate_object then null; end $do$;

-- The delivery route. Only `in_app` is wired; the other two exist so the
-- schema, the queue and the templates do not have to change the day a provider
-- is added.
do $do$ begin
  create type public.notification_channel as enum ('in_app', 'email', 'sms');
exception when duplicate_object then null; end $do$;

-- The consent line. See `notification_kind_category()`.
do $do$ begin
  create type public.notification_category as enum ('transactional', 'marketing');
exception when duplicate_object then null; end $do$;

-- What an offset is measured from. Modelled explicitly because "24 hours
-- before" and "6 weeks after" are the same arithmetic against different clocks,
-- and collapsing them into a signed number alone loses which clock.
do $do$ begin
  create type public.notification_anchor as enum (
    'appointment_start',
    'appointment_end',
    'last_visit'
  );
exception when duplicate_object then null; end $do$;

-- What a queued item is about. Part of the idempotency key.
do $do$ begin
  create type public.notification_subject as enum ('appointment', 'client', 'waitlist_entry');
exception when duplicate_object then null; end $do$;

do $do$ begin
  create type public.notification_queue_status as enum ('pending', 'sent', 'skipped', 'failed');
exception when duplicate_object then null; end $do$;

-- ── Wall clock ↔ instant, the same way src/lib/time.ts does it ─
--
-- Postgres and `zonedTimeToUtc` disagree on one case, and it is the case that
-- matters. On the fall-back overlap — 2026-11-01 01:30 in America/Los_Angeles
-- happens twice — `timestamp '2026-11-01 01:30' at time zone 'America/Los_Angeles'`
-- returns 09:30Z, the SECOND occurrence (PST). src/lib/time.ts deliberately
-- resolves to the FIRST (PDT, 08:30Z). They agree on the spring-forward gap,
-- which both push forward.
--
-- A reminder that lands an hour out once a year is not a catastrophe, but two
-- pieces of the same system computing different instants from the same wall
-- clock is exactly the drift AGENTS.md warns about with the booking engine. So
-- the transliteration lives here and the app and the database stay in step.

/** Offset of `p_zone` from UTC at an instant. East of UTC is positive. */
create or replace function public.tz_offset_at(p_instant timestamptz, p_zone text)
returns interval language sql stable as $$
  select (p_instant at time zone p_zone) - (p_instant at time zone 'UTC');
$$;

/**
 * Wall clock in `p_zone` -> absolute instant, DST-safe.
 *
 * Line-for-line the same method as `zonedTimeToUtc`: guess with the offset at
 * the naive instant, re-resolve with the offset actually in force there, and
 * when the two disagree take the larger shift — which pushes a spring-forward
 * gap onto the far side of the transition and pins a fall-back overlap to its
 * first occurrence.
 */
create or replace function public.zoned_time_to_utc(p_date date, p_time time, p_zone text)
returns timestamptz language plpgsql stable as $$
declare
  naive timestamptz := (p_date + p_time) at time zone 'UTC';
  o1 interval;
  o2 interval;
  o3 interval;
begin
  o1 := public.tz_offset_at(naive, p_zone);
  o2 := public.tz_offset_at(naive - o1, p_zone);
  if o1 = o2 then return naive - o1; end if;

  o3 := public.tz_offset_at(naive - o2, p_zone);
  if o2 = o3 then return naive - o2; end if;

  return naive - least(o2, o3);
end;
$$;

/**
 * Move an instant to a given wall-clock time on the same local calendar day.
 *
 * This is what makes "nudge to rebook six weeks later" arrive at ten in the
 * morning instead of whenever the previous appointment happened to end. Pure
 * minute offsets stay exact durations — 1440 minutes is 1440 minutes, so a
 * 24-hour reminder for a Sunday-after-the-change appointment lands an hour off
 * the wall clock, which is correct for a duration and wrong for a habit. A
 * schedule that cares about the hour sets `send_at_local` and gets the hour.
 */
create or replace function public.snap_to_local_time(
  p_instant timestamptz,
  p_zone    text,
  p_time    time
) returns timestamptz language sql stable as $$
  select case
    when p_instant is null or p_time is null then p_instant
    else public.zoned_time_to_utc((p_instant at time zone p_zone)::date, p_time, p_zone)
  end;
$$;

-- ── The transactional / marketing line ───────────────────────

/**
 * Which side of consent law a kind falls on.
 *
 * Transactional: the client asked for the thing this is about. A reminder for
 * an appointment they booked, a form they must complete before being treated, a
 * patch test their treatment requires, a cancellation they need to know about,
 * and a waitlist opening they explicitly asked to be told about. None of these
 * are suppressed by `marketing_opt_in` — withholding them is a service failure,
 * and an opt-out of promotion is not an opt-out of being told your appointment
 * moved.
 *
 * Marketing: a rebooking nudge. Nobody asked for it, it exists to generate a
 * booking, and sending it to someone who opted out is a legal problem.
 *
 * IMMUTABLE and hard-coded on purpose. The studio owns the wording and the
 * timing; it does not own this.
 */
create or replace function public.notification_kind_category(p_kind public.notification_kind)
returns public.notification_category language sql immutable as $$
  select case p_kind
    when 'rebooking_nudge' then 'marketing'
    else 'transactional'
  end::public.notification_category;
$$;

/**
 * Map a template kind onto the `notification_type` the bell already renders.
 *
 * Mapping rather than extending the 006 enum: `waitlist_opening` and
 * `rebooking_nudge` have no equivalent there, and adding values would ripple
 * into `src/types/database.ts` and every switch on the union for no gain — the
 * bell groups by type, and both of those are genuinely "something the studio
 * sent you".
 */
create or replace function public.notification_kind_to_type(p_kind public.notification_kind)
returns public.notification_type language sql immutable as $$
  select case p_kind
    when 'booking_confirmation' then 'appointment_booked'
    when 'appointment_reminder' then 'appointment_reminder'
    when 'appointment_changed'  then 'appointment_changed'
    when 'appointment_cancelled' then 'appointment_cancelled'
    when 'intake_outstanding'   then 'consent_needed'
    when 'patch_test_due'       then 'consent_needed'
    else 'system'
  end::public.notification_type;
$$;

-- ── Placeholders ─────────────────────────────────────────────

/**
 * Substitute {{placeholders}} in a template.
 *
 * The exact supported set — nothing else is defined, and nothing else is
 * touched:
 *
 *   {{client_first_name}}   first name, or "there" when we only have a guest
 *   {{client_last_name}}    surname, or empty
 *   {{client_name}}         both, trimmed
 *   {{service}}             the services on the appointment, joined with " + "
 *   {{provider}}            who is treating them
 *   {{when}}                "Monday, March 9 at 9:00 AM", in the location's zone
 *   {{date}}                "Monday, March 9"
 *   {{time}}                "9:00 AM"
 *   {{last_visit}}          date of the visit being followed up
 *   {{location}}            the location's name
 *   {{location_address}}    street, city, state
 *   {{location_phone}}      the number to call
 *   {{cancellation_reason}} what was given, or empty
 *   {{appointment_link}}    the client's own page for that appointment
 *
 * An unknown placeholder is LEFT ALONE — `{{nonsense}}` renders as
 * `{{nonsense}}`, not as an error and not as an empty string. A template is
 * something a person types into a text box; a typo there must produce a
 * slightly odd message, never a failed send and never a booking that rolls back.
 *
 * `{{ spaced_out }}` is accepted and normalised first, so the substitution
 * itself can be a plain string replace. Doing it the other way round — one
 * regexp per key with the value in the replacement — would let a client whose
 * name contained `\1` or `&` rewrite the rest of the message.
 */
create or replace function public.render_notification_template(
  p_template text,
  p_vars     jsonb
) returns text language plpgsql immutable as $$
declare
  rendered text;
  k text;
  v text;
begin
  if p_template is null then return null; end if;

  rendered := regexp_replace(p_template, '\{\{\s*([a-zA-Z0-9_]+)\s*\}\}', '{{\1}}', 'g');

  for k, v in select key, value from jsonb_each_text(coalesce(p_vars, '{}'::jsonb)) loop
    rendered := replace(rendered, '{{' || k || '}}', coalesce(v, ''));
  end loop;

  return rendered;
end;
$$;

-- ── Which location an appointment belongs to ─────────────────

/**
 * The one seam between appointments and locations.
 *
 * `appointments` predates 032 and there is no guarantee about when it gains a
 * `location_id`, so the column is read through `to_jsonb` rather than named
 * directly: a direct reference would make this whole file fail to apply against
 * a database where the column has not landed yet, and a catalogue branch would
 * need dynamic SQL. An absent key is simply null and the primary location takes
 * over.
 *
 * Every schedule, template and queue row is location-scoped, so this is the
 * only place that has to know how an appointment finds its location. Migration
 * 037 grows a richer version of the same idea (`appointment_location_id`, which
 * also falls back through the room and its resources); if both are present this
 * can safely become a one-line delegation to it.
 */
create or replace function public.notification_location_for_appointment(p_appointment uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(to_jsonb(a) ->> 'location_id', '')::bigint
       from public.appointments a where a.id = p_appointment),
    public.default_location_id()
  );
$$;

-- ── Templates: what it says ──────────────────────────────────

create table if not exists public.notification_templates (
  id          bigserial primary key,
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),
  kind        public.notification_kind not null,
  channel     public.notification_channel not null default 'in_app',

  title_template text not null,
  body_template  text not null,
  -- Where the notification points. Rendered through the same substitution.
  link_template  text,

  -- Should the client be able to answer? Delivery then opens a thread in the
  -- studio inbox alongside the notification, so a reply lands on their record
  -- rather than in a void. Off for reminders — a reminder does not need a
  -- conversation and every one would be an unread thread.
  opens_thread boolean not null default false,

  is_active  boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_templates_unique unique (location_id, kind, channel)
);

create index if not exists notification_templates_lookup_idx
  on public.notification_templates (location_id, kind, channel) where is_active;

drop trigger if exists notification_templates_touch on public.notification_templates;
create trigger notification_templates_touch before update on public.notification_templates
  for each row execute function public.touch_updated_at();

-- ── Schedules: when it goes ──────────────────────────────────

create table if not exists public.notification_schedules (
  id          bigserial primary key,
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),
  kind        public.notification_kind not null,
  -- What the studio calls this line in Settings, e.g. "The day before".
  label       text not null,

  anchor         public.notification_anchor not null,
  -- Signed minutes from the anchor. Negative is before, positive is after.
  offset_minutes int not null,
  -- Optional wall-clock time in the location's zone. Null keeps the offset an
  -- exact duration; set, it moves the send to that hour on the same local day.
  send_at_local  time,

  -- Scope. Both null = every appointment. This is what "six weeks after a
  -- facial" is made of.
  service_id  bigint references public.services(id) on delete cascade,
  category_id bigint references public.service_categories(id) on delete cascade,

  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A rebooking nudge is measured from the last visit and nothing else is;
  -- anything anchored on an appointment is measured from that appointment.
  constraint notification_schedules_anchor_matches_kind check (
    (kind = 'rebooking_nudge' and anchor = 'last_visit' and offset_minutes > 0)
    or (kind <> 'rebooking_nudge' and anchor in ('appointment_start', 'appointment_end'))
  ),
  -- Scope by service or by category, not both — "a facial" is one question.
  constraint notification_schedules_scope_single check (
    service_id is null or category_id is null
  )
);

-- Two identical lines would mean two identical messages, and the idempotency
-- key would not catch it because the schedule id is not part of it.
create unique index if not exists notification_schedules_unique_idx
  on public.notification_schedules (
    location_id, kind, anchor, offset_minutes,
    coalesce(service_id, 0), coalesce(category_id, 0)
  );

create index if not exists notification_schedules_active_idx
  on public.notification_schedules (location_id, kind) where is_active;

drop trigger if exists notification_schedules_touch on public.notification_schedules;
create trigger notification_schedules_touch before update on public.notification_schedules
  for each row execute function public.touch_updated_at();

-- ── Queue: what actually went ────────────────────────────────

create table if not exists public.notification_queue (
  id          bigserial primary key,
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),
  schedule_id bigint references public.notification_schedules(id) on delete set null,
  template_id bigint references public.notification_templates(id) on delete set null,

  kind     public.notification_kind not null,
  -- Forced from the kind by trigger. Denormalised so the record shows what was
  -- decided at the time, not what the rule says today.
  category public.notification_category not null default 'transactional',
  channel  public.notification_channel not null default 'in_app',

  recipient_id uuid not null references public.profiles(id) on delete cascade,
  subject_type public.notification_subject not null,
  -- Text, not a uuid or a bigint: subjects come from three different tables and
  -- a waitlist entry is not an appointment. It is an identity, not a join key —
  -- `appointment_id` below is the real FK when there is one.
  subject_id   text not null,
  appointment_id uuid references public.appointments(id) on delete cascade,

  scheduled_for timestamptz not null,

  -- Rendered at materialisation, so the row is a record of what was actually
  -- said and the send path is dumb. Editing a template changes everything not
  -- yet due; it cannot rewrite something already queued.
  title text not null,
  body  text,
  link  text,

  status   public.notification_queue_status not null default 'pending',
  attempts int not null default 0,
  sent_at  timestamptz,
  notification_id bigint references public.notifications(id) on delete set null,
  thread_id       uuid references public.message_threads(id) on delete set null,
  skipped_reason  text,
  last_error      text,
  created_at timestamptz not null default now()
);

/**
 * The whole idempotency guarantee, in one index.
 *
 * Same person, same kind, same channel, same subject, same intended instant —
 * one row, forever. Run the dispatcher twice in a row, run it by hand while the
 * cron is mid-sweep, replay a week of missed runs: the second insert conflicts
 * and does nothing. `scheduled_for` is derived from the anchor, never from
 * now(), which is what makes it stable across runs — and what makes a genuinely
 * new obligation (a rescheduled appointment, a second reminder at a different
 * offset) a genuinely new row.
 *
 * `channel` is in the key so an email copy of the same reminder is a separate
 * row with its own send state, rather than the in-app one blocking it.
 */
create unique index if not exists notification_queue_idempotency_idx
  on public.notification_queue (recipient_id, kind, channel, subject_type, subject_id, scheduled_for);

create index if not exists notification_queue_due_idx
  on public.notification_queue (channel, scheduled_for) where status = 'pending';
create index if not exists notification_queue_recipient_idx
  on public.notification_queue (recipient_id, scheduled_for desc);
create index if not exists notification_queue_appointment_idx
  on public.notification_queue (appointment_id) where appointment_id is not null;

-- The category is not the caller's to choose.
create or replace function public.notification_queue_set_category()
returns trigger language plpgsql as $$
begin
  new.category := public.notification_kind_category(new.kind);
  return new;
end;
$$;

drop trigger if exists notification_queue_category on public.notification_queue;
create trigger notification_queue_category
  before insert or update on public.notification_queue
  for each row execute function public.notification_queue_set_category();

-- ── Variables ────────────────────────────────────────────────

/**
 * Everything a template can name, for one client and (optionally) one
 * appointment. See `render_notification_template` for the documented set.
 *
 * Dates and times are rendered in the LOCATION's zone — `locations.timezone`
 * is authoritative and nothing here hardcodes America/Los_Angeles.
 */
create or replace function public.notification_vars(
  p_client      uuid,
  p_appointment uuid,
  p_location    bigint
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  loc      public.locations%rowtype;
  appt     public.appointments%rowtype;
  client   public.profiles%rowtype;
  provider public.profiles%rowtype;
  zone     text;
  services text;
  first_name text;
  last_name  text;
begin
  select * into loc from public.locations
  where id = coalesce(p_location, public.default_location_id());
  zone := coalesce(loc.timezone, 'America/Los_Angeles');

  if p_appointment is not null then
    select * into appt from public.appointments where id = p_appointment;
    select string_agg(aps.name_snapshot, ' + ' order by aps.sort_order, aps.id)
    into services
    from public.appointment_services aps
    where aps.appointment_id = p_appointment and aps.service_id is not null;
  end if;

  select * into client from public.profiles where id = coalesce(p_client, appt.client_id);
  select * into provider from public.profiles where id = appt.provider_id;

  first_name := nullif(trim(coalesce(client.first_name, appt.guest_first_name, '')), '');
  last_name  := nullif(trim(coalesce(client.last_name, appt.guest_last_name, '')), '');

  return jsonb_build_object(
    -- "there" rather than an empty greeting: "Hi , your appointment" reads as a
    -- bug to the person receiving it.
    'client_first_name', coalesce(first_name, 'there'),
    'client_last_name',  coalesce(last_name, ''),
    'client_name',       coalesce(trim(concat_ws(' ', first_name, last_name)), ''),
    'service',           coalesce(services, ''),
    'provider',          coalesce(
                           nullif(trim(coalesce(provider.display_name, '')), ''),
                           nullif(trim(coalesce(provider.first_name, '')), ''),
                           ''),
    'when', case when appt.starts_at is null then '' else
      to_char(appt.starts_at at time zone zone, 'FMDay, FMMonth FMDD')
        || ' at ' || to_char(appt.starts_at at time zone zone, 'FMHH12:MI AM') end,
    'date', case when appt.starts_at is null then '' else
      to_char(appt.starts_at at time zone zone, 'FMDay, FMMonth FMDD') end,
    'time', case when appt.starts_at is null then '' else
      to_char(appt.starts_at at time zone zone, 'FMHH12:MI AM') end,
    'last_visit', case when appt.starts_at is null then '' else
      to_char(appt.starts_at at time zone zone, 'FMMonth FMDD') end,
    'location',         coalesce(loc.name, ''),
    'location_address', coalesce(
      trim(both ', ' from concat_ws(', ', loc.address_line1, loc.city, loc.state)), ''),
    'location_phone',   coalesce(loc.phone, ''),
    'cancellation_reason', coalesce(appt.cancellation_reason, ''),
    'appointment_link', case when appt.id is null then '/account/appointments'
                             else '/account/appointments/' || appt.id end
  );
end;
$$;

/** Plausible values for every placeholder, for the preview in Settings. */
create or replace function public.notification_sample_vars()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  loc public.locations%rowtype;
begin
  select * into loc from public.locations where id = public.default_location_id();

  return jsonb_build_object(
    'client_first_name', 'Marisol',
    'client_last_name',  'Reyes',
    'client_name',       'Marisol Reyes',
    'service',           'Signature Facial',
    'provider',          'Yesenia',
    'when',              'Monday, March 9 at 9:00 AM',
    'date',              'Monday, March 9',
    'time',              '9:00 AM',
    'last_visit',        'January 26',
    'location',          coalesce(loc.name, '559 Flawless'),
    'location_address',  coalesce(
      trim(both ', ' from concat_ws(', ', loc.address_line1, loc.city, loc.state)),
      '285 W Shaw Ave, Fresno, CA'),
    'location_phone',    coalesce(loc.phone, '(559) 477-2999'),
    'cancellation_reason', 'The studio had to close that day.',
    'appointment_link',  '/account/appointments'
  );
end;
$$;

/** Render a draft against sample values. Used by the preview in Settings. */
create or replace function public.preview_notification_template(
  p_title text,
  p_body  text,
  p_link  text default null,
  p_vars  jsonb default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  vars jsonb := coalesce(p_vars, public.notification_sample_vars());
begin
  if not public.is_staff() then
    raise exception 'Only staff can preview notification templates';
  end if;

  return jsonb_build_object(
    'title', public.render_notification_template(p_title, vars),
    'body',  public.render_notification_template(p_body, vars),
    'link',  public.render_notification_template(p_link, vars),
    'vars',  vars
  );
end;
$$;

-- ── Enqueue ──────────────────────────────────────────────────

/**
 * Put one obligation on the queue, once.
 *
 * Renders every active template for (location, kind) — one row per channel —
 * and returns the ids it created. A conflict on the idempotency index returns
 * nothing, which is the normal, expected outcome of the second dispatcher run.
 *
 * The opt-out check happens here AND again at delivery. Here so a marketing row
 * is never even written for someone who said no; again at delivery because
 * somebody can withdraw consent between the two, and the later answer is the
 * one that counts.
 *
 * No active template for the kind means nothing is sent. That is what the
 * on/off switch in Settings is: switching a kind off has to actually stop it.
 */
create or replace function public.enqueue_notification(
  p_kind         public.notification_kind,
  p_recipient    uuid,
  p_subject_type public.notification_subject,
  p_subject_id   text,
  p_scheduled_for timestamptz,
  p_location     bigint default null,
  p_appointment  uuid default null,
  p_schedule     bigint default null,
  p_vars         jsonb default '{}'::jsonb
) returns setof bigint language plpgsql security definer set search_path = public as $$
declare
  loc       bigint := coalesce(p_location, public.default_location_id());
  recipient public.profiles%rowtype;
  tpl       public.notification_templates%rowtype;
  vars      jsonb;
  queued    bigint;
  rendered_title text;
begin
  if p_recipient is null or p_subject_id is null or p_scheduled_for is null then
    return;
  end if;

  select * into recipient from public.profiles where id = p_recipient;
  if recipient.id is null or recipient.suspended_at is not null then
    return;
  end if;

  if public.notification_kind_category(p_kind) = 'marketing'
     and not coalesce(recipient.marketing_opt_in, false) then
    return;
  end if;

  vars := public.notification_vars(p_recipient, p_appointment, loc)
          || coalesce(p_vars, '{}'::jsonb);

  for tpl in
    select * from public.notification_templates
    where location_id = loc and kind = p_kind and is_active
    order by channel
  loop
    rendered_title := public.render_notification_template(tpl.title_template, vars);
    -- A template whose title renders to nothing would produce a notification
    -- with a blank line where the message should be; fall back to the raw
    -- title rather than send that.
    if coalesce(trim(rendered_title), '') = '' then
      rendered_title := tpl.title_template;
    end if;

    insert into public.notification_queue (
      location_id, schedule_id, template_id, kind, channel,
      recipient_id, subject_type, subject_id, appointment_id,
      scheduled_for, title, body, link
    ) values (
      loc, p_schedule, tpl.id, p_kind, tpl.channel,
      p_recipient, p_subject_type, p_subject_id, p_appointment,
      p_scheduled_for,
      rendered_title,
      public.render_notification_template(tpl.body_template, vars),
      public.render_notification_template(tpl.link_template, vars)
    )
    on conflict (recipient_id, kind, channel, subject_type, subject_id, scheduled_for)
    do nothing
    returning id into queued;

    if queued is not null then
      return next queued;
      queued := null;
    end if;
  end loop;
end;
$$;

-- ── Delivery ─────────────────────────────────────────────────

/**
 * Who a templated message comes from, when it opens a thread.
 *
 * `message_after_insert` decides which way to notify by looking up the sender's
 * role: a null sender reads as the CLIENT writing in, and would ping the front
 * desk about a message the studio itself sent. So there must be a staff sender,
 * and the appointment's own provider is the truthful one when there is an
 * appointment.
 */
create or replace function public.notification_sender(p_appointment uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select a.provider_id from public.appointments a where a.id = p_appointment),
    (select p.id from public.profiles p
      where p.role = 'admin' and p.suspended_at is null order by p.created_at limit 1),
    (select p.id from public.profiles p
      where p.role <> 'client' and p.suspended_at is null order by p.created_at limit 1)
  );
$$;

/**
 * Deliver one queued item in-app and close it out.
 *
 * Returns true when something went out. Everything else — opted out since,
 * appointment cancelled underneath us, the moment already passed — marks the
 * row `skipped` with a reason rather than deleting it, because "why did she not
 * get her reminder" is a question the studio will ask.
 */
create or replace function public.deliver_notification(p_queue_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  q         public.notification_queue%rowtype;
  tpl       public.notification_templates%rowtype;
  recipient public.profiles%rowtype;
  appt      public.appointments%rowtype;
  sender    uuid;
  sender_name text;
  new_thread uuid;
  new_notification bigint;
begin
  select * into q from public.notification_queue where id = p_queue_id for update;
  if q.id is null or q.status <> 'pending' then
    return false;
  end if;

  -- Anything not in-app belongs to a sender that does not exist yet. Left
  -- pending on purpose: a `skipped` row would hide the backlog.
  if q.channel <> 'in_app' then
    return false;
  end if;

  select * into recipient from public.profiles where id = q.recipient_id;
  if recipient.id is null or recipient.suspended_at is not null then
    update public.notification_queue
    set status = 'skipped', skipped_reason = 'recipient_unavailable', attempts = attempts + 1
    where id = q.id;
    return false;
  end if;

  -- Consent is re-read at the moment of sending. Someone who opted out after
  -- this was queued does not get it.
  if q.category = 'marketing' and not coalesce(recipient.marketing_opt_in, false) then
    update public.notification_queue
    set status = 'skipped', skipped_reason = 'marketing_opt_out', attempts = attempts + 1
    where id = q.id;
    return false;
  end if;

  if q.appointment_id is not null then
    select * into appt from public.appointments where id = q.appointment_id;

    if appt.id is null then
      update public.notification_queue
      set status = 'skipped', skipped_reason = 'appointment_gone', attempts = attempts + 1
      where id = q.id;
      return false;
    end if;

    -- Reminding someone about an appointment that was cancelled, or that has
    -- already started, is worse than saying nothing. The cancellation notice
    -- itself is obviously exempt.
    if q.kind in ('appointment_reminder', 'intake_outstanding', 'patch_test_due') then
      if appt.status = 'cancelled' then
        update public.notification_queue
        set status = 'skipped', skipped_reason = 'appointment_cancelled', attempts = attempts + 1
        where id = q.id;
        return false;
      end if;
      if appt.starts_at <= now() then
        update public.notification_queue
        set status = 'skipped', skipped_reason = 'appointment_started', attempts = attempts + 1
        where id = q.id;
        return false;
      end if;
    end if;
  end if;

  select * into tpl from public.notification_templates where id = q.template_id;

  if coalesce(tpl.opens_thread, false) then
    sender := public.notification_sender(q.appointment_id);

    if sender is not null then
      select trim(concat_ws(' ', p.first_name, p.last_name)) into sender_name
      from public.profiles p where p.id = sender;

      insert into public.message_threads (client_id, subject, status, appointment_id, staff_unread)
      values (q.recipient_id, q.title, 'open', q.appointment_id, false)
      returning id into new_thread;

      insert into public.messages (thread_id, sender_id, sender_name, body, is_internal)
      values (new_thread, sender, coalesce(nullif(sender_name, ''), '559 Flawless'),
              coalesce(q.body, q.title), false);

      -- `message_after_insert` has already written the client's ping — it is the
      -- single writer of that row, and inserting a second here is exactly the
      -- double-notification 028 had to go back and fix. Refine the one it made
      -- so the client sees the studio's own wording instead of "New reply".
      select id into new_notification
      from public.notifications
      where thread_id = new_thread and user_id = q.recipient_id
      order by id desc limit 1;

      if new_notification is not null then
        update public.notifications
        set type = public.notification_kind_to_type(q.kind),
            title = q.title,
            body  = q.body,
            link  = coalesce(q.link, '/account/messages/' || new_thread),
            appointment_id = coalesce(q.appointment_id, appointment_id)
        where id = new_notification;
      end if;
    end if;
  end if;

  -- No thread, or no staff account to send from: an ordinary notification.
  if new_notification is null then
    insert into public.notifications (user_id, type, title, body, link, appointment_id, thread_id)
    values (q.recipient_id, public.notification_kind_to_type(q.kind), q.title, q.body,
            coalesce(q.link, case when new_thread is not null
                                  then '/account/messages/' || new_thread end),
            q.appointment_id, new_thread)
    returning id into new_notification;
  end if;

  update public.notification_queue
  set status = 'sent',
      sent_at = now(),
      attempts = attempts + 1,
      notification_id = new_notification,
      thread_id = new_thread
  where id = q.id;

  -- The columns that have been sitting empty since 004 and 023. Set last, once
  -- the message is genuinely out, so a failure halfway never leaves the
  -- appointment claiming a reminder that nobody received.
  if q.appointment_id is not null then
    if q.kind = 'appointment_reminder' then
      update public.appointments set reminder_sent_at = now() where id = q.appointment_id;
    elsif q.kind = 'intake_outstanding' then
      update public.appointments set intake_reminder_sent_at = now() where id = q.appointment_id;
    end if;
  end if;

  return true;
end;
$$;

/** Enqueue and deliver in one step, for the event-driven kinds. */
create or replace function public.send_notification_now(
  p_kind         public.notification_kind,
  p_recipient    uuid,
  p_subject_type public.notification_subject,
  p_subject_id   text,
  p_location     bigint default null,
  p_appointment  uuid default null,
  p_scheduled_for timestamptz default null,
  p_vars         jsonb default '{}'::jsonb
) returns int language plpgsql security definer set search_path = public as $$
declare
  queued bigint;
  sent   int := 0;
begin
  for queued in
    select public.enqueue_notification(
      p_kind, p_recipient, p_subject_type, p_subject_id,
      coalesce(p_scheduled_for, now()), p_location, p_appointment, null, p_vars)
  loop
    if public.deliver_notification(queued) then sent := sent + 1; end if;
  end loop;

  return sent;
end;
$$;

-- ── The dispatcher ───────────────────────────────────────────

/**
 * Turn schedules into queue rows for everything that has come due.
 *
 * Only what is due — not the whole future. A queue row is therefore a record of
 * an obligation the studio is about to meet, which means an edit to a template
 * takes effect on everything that has not come due yet, and the wording of
 * something already queued stays what it was.
 *
 * `p_lookback_minutes` is the catch-up window and it is deliberately finite. A
 * dispatcher that has not run for a fortnight must not celebrate by sending a
 * fortnight of reminders; it sends what came due since roughly the last run and
 * lets the rest go.
 */
create or replace function public.materialise_due_notifications(
  p_now              timestamptz default now(),
  p_horizon_minutes  int default 60,
  p_lookback_minutes int default 2880
) returns int language plpgsql security definer set search_path = public as $$
declare
  win_lo timestamptz := p_now - make_interval(mins => greatest(p_lookback_minutes, 0));
  win_hi timestamptz := p_now + make_interval(mins => greatest(p_horizon_minutes, 0));
  sched  public.notification_schedules%rowtype;
  zone   text;
  row    record;
  queued bigint;
  -- Counts rows actually created, not candidates considered — so a second run
  -- reports 0 and the number in the log means what it looks like it means.
  made   int := 0;
begin
  for sched in
    select s.* from public.notification_schedules s
    join public.locations l on l.id = s.location_id
    where s.is_active and l.is_active
    order by s.id
  loop
    select coalesce(l.timezone, 'America/Los_Angeles') into zone
    from public.locations l where l.id = sched.location_id;

    if sched.anchor in ('appointment_start', 'appointment_end') then
      -- ── Appointment-anchored: reminders, forms, patch tests ──
      for row in
        select a.id, a.client_id,
               public.snap_to_local_time(
                 case when sched.anchor = 'appointment_start' then a.starts_at else a.ends_at end
                   + make_interval(mins => sched.offset_minutes),
                 zone, sched.send_at_local) as due_at
        from public.appointments a
        where a.client_id is not null
          and a.status in ('pending', 'confirmed', 'checked_in')
          -- Never remind about something that has already begun.
          and a.starts_at > p_now
          and public.notification_location_for_appointment(a.id) = sched.location_id
          and (
            sched.service_id is null or exists (
              select 1 from public.appointment_services aps
              where aps.appointment_id = a.id and aps.service_id = sched.service_id)
          )
          and (
            sched.category_id is null or exists (
              select 1 from public.appointment_services aps
              join public.services sv on sv.id = aps.service_id
              where aps.appointment_id = a.id and sv.category_id = sched.category_id)
          )
          and case sched.kind
            when 'intake_outstanding' then a.intake_completed_at is null
            when 'patch_test_due' then
              exists (
                select 1 from public.appointment_services aps
                join public.services sv on sv.id = aps.service_id
                where aps.appointment_id = a.id and sv.patch_test_hours > 0
              )
              and not exists (
                select 1 from public.patch_tests pt
                where pt.client_id = a.client_id and pt.result = 'pass'
                  and (pt.expires_at is null or pt.expires_at > a.starts_at)
              )
            else true
          end
      loop
        if row.due_at between win_lo and win_hi then
          for queued in
            select public.enqueue_notification(
              sched.kind, row.client_id, 'appointment', row.id::text,
              row.due_at, sched.location_id, row.id, sched.id)
          loop
            made := made + 1;
          end loop;
        end if;
      end loop;

    else
      -- ── last_visit: the rebooking nudge ─────────────────────
      --
      -- The guard is the whole difference between useful and annoying: a client
      -- who ALREADY has something on the books is never nudged, whatever they
      -- have booked and whichever schedule matched. Being told to come back for
      -- a facial by the same studio you are seeing on Thursday reads as a
      -- business that does not know who you are.
      --
      -- The subject is the completed appointment, so one visit earns one nudge
      -- per schedule line, permanently — not one per dispatcher run.
      for row in
        with scoped as (
          select distinct on (a.client_id) a.client_id, a.id, a.ends_at
          from public.appointments a
          where a.status = 'completed'
            and a.client_id is not null
            and public.notification_location_for_appointment(a.id) = sched.location_id
            and (
              sched.service_id is null or exists (
                select 1 from public.appointment_services aps
                where aps.appointment_id = a.id and aps.service_id = sched.service_id)
            )
            and (
              sched.category_id is null or exists (
                select 1 from public.appointment_services aps
                join public.services sv on sv.id = aps.service_id
                where aps.appointment_id = a.id and sv.category_id = sched.category_id)
            )
          order by a.client_id, a.ends_at desc
        )
        select s.client_id, s.id,
               public.snap_to_local_time(
                 s.ends_at + make_interval(mins => sched.offset_minutes),
                 zone, sched.send_at_local) as due_at
        from scoped s
        where not exists (
          select 1 from public.appointments f
          where f.client_id = s.client_id
            and f.status in ('pending', 'confirmed', 'checked_in')
            and f.starts_at > p_now
        )
      loop
        if row.due_at between win_lo and win_hi then
          for queued in
            select public.enqueue_notification(
              sched.kind, row.client_id, 'appointment', row.id::text,
              row.due_at, sched.location_id, row.id, sched.id)
          loop
            made := made + 1;
          end loop;
        end if;
      end loop;
    end if;
  end loop;

  return made;
end;
$$;

/**
 * Send everything in-app that is due, one row at a time.
 *
 * Each delivery gets its own subtransaction so a single bad row cannot take the
 * sweep down with it — it is marked `failed` with the error and the next one
 * carries on. `failed` rows are left alone rather than retried automatically:
 * something that threw once will usually throw again, and a queue that retries
 * on its own is a queue that sends forty copies at three in the morning.
 */
create or replace function public.deliver_due_notifications(
  p_now   timestamptz default now(),
  p_limit int default 200
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  item   record;
  sent   int := 0;
  skipped int := 0;
  failed int := 0;
begin
  for item in
    select id from public.notification_queue
    where status = 'pending' and channel = 'in_app' and scheduled_for <= p_now
    order by scheduled_for, id
    limit greatest(p_limit, 0)
  loop
    begin
      if public.deliver_notification(item.id) then
        sent := sent + 1;
      else
        skipped := skipped + 1;
      end if;
    exception when others then
      failed := failed + 1;
      update public.notification_queue
      set status = 'failed', last_error = sqlerrm, attempts = attempts + 1
      where id = item.id;
    end;
  end loop;

  return jsonb_build_object('sent', sent, 'skipped', skipped, 'failed', failed);
end;
$$;

/**
 * The scheduled sweep: materialise, then deliver. One call, safe to repeat.
 *
 * Running this twice back to back sends nothing the second time — not because
 * it remembers, but because every row it would create already exists.
 */
create or replace function public.dispatch_notifications(
  p_now              timestamptz default now(),
  p_horizon_minutes  int default 60,
  p_lookback_minutes int default 2880,
  p_limit            int default 200
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  made      int;
  delivered jsonb;
  waiting   int;
begin
  made := public.materialise_due_notifications(p_now, p_horizon_minutes, p_lookback_minutes);
  delivered := public.deliver_due_notifications(p_now, p_limit);

  select count(*) into waiting
  from public.notification_queue
  where status = 'pending' and channel <> 'in_app' and scheduled_for <= p_now;

  return jsonb_build_object(
    'materialised', made,
    'sent',    (delivered ->> 'sent')::int,
    'skipped', (delivered ->> 'skipped')::int,
    'failed',  (delivered ->> 'failed')::int,
    -- Rows queued for a channel this deployment cannot send yet. Not an error;
    -- a number that should be zero until an email or SMS worker exists.
    'awaiting_sender', waiting
  ) ;
end;
$$;

/**
 * The send-adapter seam.
 *
 * An email or SMS worker claims a batch through this, delivers it however it
 * likes, and calls `mark_notification_sent` per row. `for update skip locked`
 * means two workers can run at once without either waiting or double-sending.
 * Nothing calls it today; it is here so adding a provider is a worker and a
 * template row, not a redesign.
 */
create or replace function public.claim_notification_queue(
  p_channel public.notification_channel,
  p_limit   int default 50,
  p_now     timestamptz default now()
) returns setof public.notification_queue language sql security definer set search_path = public as $$
  select * from public.notification_queue
  where status = 'pending' and channel = p_channel and scheduled_for <= p_now
  order by scheduled_for, id
  limit greatest(p_limit, 0)
  for update skip locked;
$$;

/** Close out a row a sender delivered outside the database. */
create or replace function public.mark_notification_sent(
  p_queue_id bigint,
  p_error    text default null
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.notification_queue
  set status = case when p_error is null then 'sent' else 'failed' end,
      sent_at = case when p_error is null then now() else sent_at end,
      last_error = p_error,
      attempts = attempts + 1
  where id = p_queue_id and status = 'pending';

  return found;
end;
$$;

/**
 * A slot came free and someone asked to be told.
 *
 * There is no waitlist table in this schema yet — whoever builds one calls this
 * and gets templating, opt-out handling, the queue record and idempotency for
 * free. `p_opened_at` is the idempotency handle: pass the instant the slot
 * actually opened (the cancelled appointment's `cancelled_at`, say) rather than
 * letting it default, and a retried or double-fired waitlist sweep cannot send
 * the same person the same opening twice.
 *
 * Transactional, not marketing: being told about an opening is the fulfilment
 * of a request the client made, not a promotion. Someone who has opted out of
 * marketing and then joined a waitlist still hears about their slot.
 */
create or replace function public.notify_waitlist_opening(
  p_client    uuid,
  p_entry_id  text,
  p_starts_at timestamptz,
  p_service   text default null,
  p_location  bigint default null,
  p_opened_at timestamptz default now()
) returns int language plpgsql security definer set search_path = public as $$
declare
  loc  bigint := coalesce(p_location, public.default_location_id());
  zone text;
begin
  select coalesce(l.timezone, 'America/Los_Angeles') into zone
  from public.locations l where l.id = loc;

  return public.send_notification_now(
    'waitlist_opening', p_client, 'waitlist_entry', p_entry_id,
    loc, null, p_opened_at,
    jsonb_build_object(
      'service', coalesce(p_service, ''),
      'when', to_char(p_starts_at at time zone zone, 'FMDay, FMMonth FMDD')
                || ' at ' || to_char(p_starts_at at time zone zone, 'FMHH12:MI AM'),
      'date', to_char(p_starts_at at time zone zone, 'FMDay, FMMonth FMDD'),
      'time', to_char(p_starts_at at time zone zone, 'FMHH12:MI AM'),
      'appointment_link', '/booking'
    ));
end;
$$;

-- ── The appointment triggers, rewritten to use the templates ─
--
-- 006's version wrote the client's wording into PL/pgSQL, which meant the
-- studio could not change a word of the three messages clients see most. Staff
-- notifications are untouched — those are internal and nobody is editing them.

create or replace function public.appointment_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who text;
  loc bigint;
begin
  who := coalesce(
    (select trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))
     from public.profiles where id = new.client_id),
    trim(coalesce(new.guest_first_name,'') || ' ' || coalesce(new.guest_last_name,'')),
    'A client'
  );

  loc := public.notification_location_for_appointment(new.id);

  if tg_op = 'INSERT' then
    insert into public.notifications (user_id, type, title, body, link, appointment_id)
    values (new.provider_id, 'appointment_booked',
            'New booking — ' || who,
            to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
            '/dashboard/appointments/' || new.id, new.id);

    perform public.notify_roles(
      array['front_desk', 'manager', 'admin']::public.user_role[],
      'appointment_booked', 'New booking — ' || who,
      to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
      '/dashboard/appointments/' || new.id, new.id);

    -- The client's confirmation is NOT sent from here any more. At INSERT the
    -- appointment has no line items — booking.ts writes them in the next
    -- statement — so a confirmation written here could never name the service,
    -- and it went out even on the path where the line insert failed and the
    -- appointment was deleted a moment later. `appointment_services_confirm`
    -- sends it instead, once the booking is actually a booking.

  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    insert into public.notifications (user_id, type, title, body, link, appointment_id)
    values (new.provider_id, 'appointment_cancelled',
            'Cancelled — ' || who,
            to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
            '/dashboard/appointments/' || new.id, new.id);

    if new.client_id is not null and new.cancelled_by is distinct from new.client_id then
      begin
        perform public.send_notification_now(
          'appointment_cancelled', new.client_id, 'appointment', new.id::text,
          loc, new.id, now());
      exception when others then
        -- A notification must never be the reason a cancellation fails to
        -- commit. The slot has to be released either way.
        raise warning 'cancellation notice failed for %: %', new.id, sqlerrm;
      end;
    end if;

  elsif new.starts_at is distinct from old.starts_at then
    if new.client_id is not null then
      begin
        perform public.send_notification_now(
          'appointment_changed', new.client_id, 'appointment', new.id::text,
          loc, new.id, now());
      exception when others then
        raise warning 'reschedule notice failed for %: %', new.id, sqlerrm;
      end;
    end if;
  end if;

  return null;
end;
$$;

/**
 * Confirm a booking once it has services on it.
 *
 * Statement-level with a transition table, so one booking is one confirmation
 * however many lines went in. `scheduled_for` is the appointment's own
 * `created_at`, which makes the idempotency key permanent: adding an add-on
 * next week re-fires this trigger, collides, and sends nothing.
 */
create or replace function public.appointment_services_confirm()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a record;
begin
  for a in
    select distinct ap.id, ap.client_id, ap.created_at
    from inserted i
    join public.appointments ap on ap.id = i.appointment_id
    where ap.client_id is not null and ap.status <> 'cancelled'
  loop
    begin
      perform public.send_notification_now(
        'booking_confirmation', a.client_id, 'appointment', a.id::text,
        public.notification_location_for_appointment(a.id), a.id, a.created_at);
    exception when others then
      raise warning 'booking confirmation failed for %: %', a.id, sqlerrm;
    end;
  end loop;

  return null;
end;
$$;

drop trigger if exists appointment_services_confirm on public.appointment_services;
create trigger appointment_services_confirm
  after insert on public.appointment_services
  referencing new table as inserted
  for each statement execute function public.appointment_services_confirm();

-- ── Seeds ────────────────────────────────────────────────────
--
-- Written once per location. Guarded by `not exists` so a re-run never
-- overwrites what the studio has since rewritten — the whole point of putting
-- the wording in a table is that theirs wins.

insert into public.notification_templates
  (location_id, kind, channel, title_template, body_template, link_template, opens_thread)
select l.id, v.kind::public.notification_kind, 'in_app',
       v.title, v.body, v.link, v.opens_thread
from public.locations l
cross join (values
  ('booking_confirmation',
   'You are booked in',
   E'{{client_first_name}}, your {{service}} is confirmed for {{when}} at {{location}}.\n\n{{location_address}}. If you need to move it, call {{location_phone}} or cancel from your account.',
   '{{appointment_link}}', false),

  ('appointment_reminder',
   'Reminder — {{service}} {{when}}',
   E'See you {{when}}, {{client_first_name}}.\n\n{{location}}, {{location_address}}. Call {{location_phone}} if anything has changed.',
   '{{appointment_link}}', false),

  ('appointment_changed',
   'Your appointment has moved',
   E'{{client_first_name}}, your {{service}} is now {{when}} at {{location}}.\n\nIf that does not work, call {{location_phone}} and we will find another time.',
   '{{appointment_link}}', false),

  ('appointment_cancelled',
   'Your appointment was cancelled',
   E'{{client_first_name}}, your {{service}} on {{when}} has been cancelled.\n\n{{cancellation_reason}}\n\nYou can rebook whenever suits you, or reply here and we will sort it out.',
   '{{appointment_link}}', true),

  ('waitlist_opening',
   'A spot has opened up',
   E'{{client_first_name}}, {{service}} is free {{when}} at {{location}}.\n\nIt is first come, first served — book it from your account, or reply here and we will hold it while we talk.',
   '/booking', true),

  ('rebooking_nudge',
   'Ready for your next {{service}}?',
   E'{{client_first_name}}, it has been a while since your {{service}} on {{last_visit}}.\n\nBook whenever it suits you — or reply here and we will find you a time. If you would rather not hear from us about this, you can turn it off in your account settings.',
   '/booking', true),

  ('intake_outstanding',
   'Forms to finish before {{when}}',
   E'{{client_first_name}}, your {{service}} on {{when}} still needs its forms completed.\n\nThey take a couple of minutes and we cannot treat you without them, so it is worth doing now rather than in the doorway.',
   '/account/forms', false),

  ('patch_test_due',
   'Patch test needed before {{when}}',
   E'{{client_first_name}}, {{service}} on {{when}} needs a patch test first — it is how we check your skin will tolerate the product, and it takes five minutes.\n\nCall {{location_phone}} and we will get you in beforehand.',
   '/account/appointments', false)
) as v(kind, title, body, link, opens_thread)
where not exists (
  select 1 from public.notification_templates t
  where t.location_id = l.id and t.kind = v.kind::public.notification_kind
    and t.channel = 'in_app'
);

insert into public.notification_schedules
  (location_id, kind, label, anchor, offset_minutes, send_at_local, is_active)
select l.id, v.kind::public.notification_kind, v.label,
       v.anchor::public.notification_anchor, v.offset_minutes, v.send_at_local::time, v.is_active
from public.locations l
cross join (values
  -- The two everyone expects. Left as exact durations: a reminder is a
  -- countdown to a specific moment, and the hour it lands on does not matter.
  ('appointment_reminder', 'The day before',   'appointment_start', -1440, null, true),
  ('appointment_reminder', 'Two hours before', 'appointment_start', -120,  null, true),

  -- These do care about the hour — nobody wants a form chased at 4am — so they
  -- snap to a wall-clock time in the location's own zone.
  ('intake_outstanding', 'Three days before',  'appointment_start', -4320,  '10:00', true),
  ('patch_test_due',     'A week before',      'appointment_start', -10080, '10:00', true),

  -- Six weeks. Off by default: it is marketing, and the studio should choose to
  -- start sending it rather than discover it already went.
  ('rebooking_nudge', 'Six weeks after a visit', 'last_visit', 60480, '10:00', false)
) as v(kind, label, anchor, offset_minutes, send_at_local, is_active)
where not exists (
  select 1 from public.notification_schedules s
  where s.location_id = l.id
    and s.kind = v.kind::public.notification_kind
    and s.anchor = v.anchor::public.notification_anchor
    and s.offset_minutes = v.offset_minutes
    and s.service_id is null and s.category_id is null
);

-- ── RLS ──────────────────────────────────────────────────────
--
-- Templates and schedules are settings: staff read them, managers change them.
-- The queue is a record and nobody writes it by hand — there is no insert,
-- update or delete policy at all, so the only ways in are the SECURITY DEFINER
-- functions above and the service role. A client never reads the queue either;
-- what a client sees is the `notifications` row it produced.

alter table public.notification_templates enable row level security;
alter table public.notification_schedules enable row level security;
alter table public.notification_queue     enable row level security;

drop policy if exists "staff reads notification templates" on public.notification_templates;
create policy "staff reads notification templates" on public.notification_templates
  for select using (public.is_staff());

drop policy if exists "manager writes notification templates" on public.notification_templates;
create policy "manager writes notification templates" on public.notification_templates
  for all using (public.is_manager()) with check (public.is_manager());

drop policy if exists "staff reads notification schedules" on public.notification_schedules;
create policy "staff reads notification schedules" on public.notification_schedules
  for select using (public.is_staff());

drop policy if exists "manager writes notification schedules" on public.notification_schedules;
create policy "manager writes notification schedules" on public.notification_schedules
  for all using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager reads notification queue" on public.notification_queue;
create policy "manager reads notification queue" on public.notification_queue
  for select using (public.is_manager());

-- ── Grants ───────────────────────────────────────────────────

grant select, insert, update, delete on public.notification_templates to authenticated;
grant select, insert, update, delete on public.notification_schedules to authenticated;
grant select on public.notification_queue to authenticated;
grant usage, select on sequence public.notification_templates_id_seq to authenticated;
grant usage, select on sequence public.notification_schedules_id_seq to authenticated;

grant all on public.notification_templates to service_role;
grant all on public.notification_schedules to service_role;
grant all on public.notification_queue     to service_role;
grant usage, select on sequence public.notification_templates_id_seq to service_role;
grant usage, select on sequence public.notification_schedules_id_seq to service_role;
grant usage, select on sequence public.notification_queue_id_seq     to service_role;

grant execute on function public.render_notification_template(text, jsonb) to authenticated;
grant execute on function public.notification_sample_vars() to authenticated;
grant execute on function public.preview_notification_template(text, text, text, jsonb) to authenticated;
grant execute on function public.notification_kind_category(public.notification_kind) to authenticated;

-- The dispatcher is the service role's, called from the cron route after it has
-- checked its bearer token. Nothing signed in gets to run it directly.
grant execute on function public.dispatch_notifications(timestamptz, int, int, int) to service_role;
grant execute on function public.materialise_due_notifications(timestamptz, int, int) to service_role;
grant execute on function public.deliver_due_notifications(timestamptz, int) to service_role;
grant execute on function public.claim_notification_queue(public.notification_channel, int, timestamptz) to service_role;
grant execute on function public.mark_notification_sent(bigint, text) to service_role;
grant execute on function public.notify_waitlist_opening(uuid, text, timestamptz, text, bigint, timestamptz) to service_role;

comment on table public.notification_templates is
  'What each kind of client message says. One row per (location, kind, channel); '
  'the studio edits these in Settings. Placeholders are documented on '
  'render_notification_template().';
comment on table public.notification_schedules is
  'When each kind goes out, as a signed minute offset from an anchor. Negative '
  'is before, positive is after. send_at_local moves it to a wall-clock hour in '
  'the location''s own timezone.';
comment on table public.notification_queue is
  'Every message the studio owes or has sent. The unique index on (recipient, '
  'kind, channel, subject, scheduled_for) is what makes a dispatcher run '
  'repeatable.';

-- ─────────────────────────────────────────────────────────────
-- 039_client_profiles.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 039: the client record, in full
--
-- Three things the owner asked for, which turn out to share one idea: the
-- client file should be able to answer questions about a person without
-- anybody having to remember them.
--
--   1. Banning — sometimes the studio has to stop taking someone's bookings.
--   2. Before & after photographs — a prompt at the right moment, and never
--      a prompt where consent does not permit the photograph.
--   3. Depth — one chronological view of the whole relationship, plus the
--      numbers (lifetime value, cadence, no-show rate) that were already
--      being maintained and were not being shown.
--
-- Nothing here erases anything. A ban is a row, a lift is a column on that
-- row, and the visit history underneath is untouched by both.
-- ============================================================

-- ══════════════════════════════════════════════════════════════
-- 1. BANNING
-- ══════════════════════════════════════════════════════════════
--
-- Why this is NOT `profiles.suspended_at`.
--
-- `suspended_at` is the STAFF kill switch and is load-bearing as one:
-- `is_staff()`, `is_front_desk()`, `is_manager()`, `is_admin()` and
-- `is_provider()` all read it, and "public read bookable providers" hides a
-- suspended provider from the booking page. Setting it on a client would
-- overload a column five permission helpers already depend on, to say
-- something none of them are asking.
--
-- It also cannot carry the answer. A ban needs a reason somebody can review,
-- the name of whoever made the call, an expiry, and — per the multi-location
-- contract — a scope, because a second site may not share the problem. That is
-- a row, not a timestamp. And 001's guard trigger restricts `suspended_at` to
-- admins, which is right for "this employee is locked out" and wrong for
-- "she was abusive to me in the room": the person who needs to stop the next
-- booking is the person who was in the room.
--
-- So: a table. The client's account keeps working — they can still sign in,
-- read their own history, message the studio and buy a product. What stops is
-- the booking, which is the only thing the studio actually wants to stop.

create table if not exists public.client_bans (
  id          bigserial primary key,
  client_id   uuid not null references public.profiles(id) on delete cascade,

  -- Where the decision was made. Always a real site — a ban is issued by
  -- somebody standing somewhere, and recording that is useful even when the
  -- ban applies everywhere. Scope is the next column's job, not this one's.
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),

  -- Defaults to studio-wide, because the reasons that produce a ban — repeated
  -- no-shows, abuse, a safety issue — travel with the person and not with the
  -- building. Turning it off is the deliberate act.
  applies_studio_wide boolean not null default true,

  -- Staff-facing, and staff-facing only. The client is declined politely and
  -- pointed at the phone; they are never shown this text.
  reason      text not null,

  banned_by   uuid references public.profiles(id) on delete set null,
  banned_at   timestamptz not null default now(),
  -- Null = until somebody lifts it. A date = it stops on its own, which is
  -- what "banned for the rest of the season" actually means.
  expires_at  timestamptz,

  -- Lifting is an edit to this row rather than a delete, so "banned in March,
  -- back in June" stays answerable.
  lifted_at   timestamptz,
  lifted_by   uuid references public.profiles(id) on delete set null,
  lift_reason text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A ban nobody wrote a reason for cannot be reviewed, appealed, or
  -- explained to the person on the phone six months later.
  constraint client_bans_reason_present check (length(btrim(reason)) > 0),
  constraint client_bans_expiry_after_start
    check (expires_at is null or expires_at > banned_at),
  constraint client_bans_lift_after_start
    check (lifted_at is null or lifted_at >= banned_at)
);

comment on table public.client_bans is
  'Bookings the studio will not take, and why. Deliberately separate from '
  'profiles.suspended_at, which is the staff lock-out and is read by every '
  'role helper in 001.';
comment on column public.client_bans.applies_studio_wide is
  'True = every site. False = only location_id. There is no unique index '
  'stopping two live bans on one person: "barred from the Shaw Ave room until '
  'March, and barred everywhere permanently" is a coherent thing to record, '
  'and client_is_banned ORs them.';

create index if not exists client_bans_client_idx
  on public.client_bans (client_id, banned_at desc);
-- The lookup client_is_banned actually performs.
create index if not exists client_bans_live_idx
  on public.client_bans (client_id, location_id)
  where lifted_at is null;
create index if not exists client_bans_location_idx
  on public.client_bans (location_id, banned_at desc);

create or replace function public.client_bans_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_role public.user_role;
begin
  select role into target_role from public.profiles where id = new.client_id;

  if target_role is null then
    raise exception 'Unknown profile %', new.client_id;
  end if;

  -- The distinction this whole table exists to make. Locking out an employee
  -- is profiles.suspended_at and an admin's decision; refusing a client's
  -- booking is this.
  if target_role <> 'client' then
    raise exception 'Only a client can be banned — use suspended_at for staff accounts';
  end if;

  new.banned_by := coalesce(new.banned_by, auth.uid());
  return new;
end;
$$;

drop trigger if exists client_bans_before_insert on public.client_bans;
create trigger client_bans_before_insert
  before insert on public.client_bans
  for each row execute function public.client_bans_before_insert();

/**
 * A ban is append-only apart from being lifted.
 *
 * RLS can gate a whole UPDATE but not a column, so the column rule lives here.
 * Without it the "manager lifts a ban" policy would also let a manager rewrite
 * the reason, move the date, or re-point the row at somebody else — which is
 * the one thing a record like this must not allow.
 */
create or replace function public.client_bans_before_update()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.client_id is distinct from old.client_id
     or new.location_id is distinct from old.location_id
     or new.applies_studio_wide is distinct from old.applies_studio_wide
     or new.reason is distinct from old.reason
     or new.banned_by is distinct from old.banned_by
     or new.banned_at is distinct from old.banned_at
     or new.expires_at is distinct from old.expires_at
  then
    raise exception 'A ban cannot be edited — lift it and record a new one';
  end if;

  -- Un-lifting would quietly rewrite the history the lift columns exist to
  -- keep. Banning someone again is a new row.
  if old.lifted_at is not null and new.lifted_at is distinct from old.lifted_at then
    raise exception 'A lifted ban cannot be re-applied — record a new ban';
  end if;

  if new.lifted_at is not null and old.lifted_at is null then
    new.lifted_by := coalesce(new.lifted_by, auth.uid());
  end if;

  return new;
end;
$$;

drop trigger if exists client_bans_before_update on public.client_bans;
create trigger client_bans_before_update
  before update on public.client_bans
  for each row execute function public.client_bans_before_update();

drop trigger if exists client_bans_touch on public.client_bans;
create trigger client_bans_touch before update on public.client_bans
  for each row execute function public.touch_updated_at();

/**
 * Is this person barred from booking here, right now?
 *
 * The one predicate. `p_location_id` null means "anywhere" — the answer the
 * CRM wants when it renders a badge on a client's name. Pass a real location
 * and it answers for that site: a ban scoped to one room does not close the
 * other one.
 *
 * SECURITY INVOKER on purpose. It reads client_bans, whose SELECT policy is
 * staff-only, so a client asking about somebody else gets false rather than an
 * enumeration oracle. The two callers that need it regardless — the trigger
 * below and the service-role booking engine — reach it as a definer-owned
 * trigger and as service_role respectively.
 */
create or replace function public.client_is_banned(
  p_client_id  uuid,
  p_location_id bigint default null
) returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1
    from public.client_bans b
    where b.client_id = p_client_id
      and b.lifted_at is null
      and (b.expires_at is null or b.expires_at > now())
      and (b.applies_studio_wide
           or p_location_id is null
           or b.location_id = p_location_id)
  );
$$;

revoke all on function public.client_is_banned(uuid, bigint) from public;
grant execute on function public.client_is_banned(uuid, bigint) to service_role;

/**
 * The ban, enforced where it cannot be routed around.
 *
 * `src/lib/booking.ts` is the only public path into `appointments` and it is
 * not edited here; this is the same shape of guarantee as the GiST exclusion
 * constraint next to it. Application code checks so the UI can say something
 * sensible — this is what makes it true, for the public booking route, for a
 * staff booking, and for anything written later.
 *
 * SQLSTATE 23P02 is chosen to sit beside 23P01 (exclusion_violation, the
 * double-booking guard): same class, integrity constraint violation, and
 * undefined by PostgreSQL. `booking.ts` maps it exactly the way it already
 * maps 23P01 — see the integration note at the bottom of this file.
 *
 * THE TRIGGER NAME IS LOAD-BEARING: triggers of the same event and timing fire in
 * alphabetical order, and this must run AFTER `appointments_match_client`
 * (which resolves a guest booking's email to a profile) and before
 * `appointments_set_slot`. match < refuse < set_slot. Renaming it to sort
 * ahead of the matcher would let a banned client rebook as a guest with the
 * email already on their account.
 */
create or replace function public.appointment_refuse_banned_client()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.client_id is not null
     and public.client_is_banned(new.client_id, new.location_id) then
    raise exception using
      errcode = '23P02',
      message = 'This client cannot be booked',
      -- What booking.ts branches on if it prefers a string to the SQLSTATE.
      detail  = 'client_banned',
      hint    = 'Lift the ban on the client record first.';
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_refuse_banned_client on public.appointments;
create trigger appointments_refuse_banned_client
  before insert or update of client_id, starts_at, location_id
  on public.appointments
  for each row execute function public.appointment_refuse_banned_client();

-- Cancelling a banned client's existing appointment only touches `status`, so
-- staff can still clear the calendar after issuing a ban. Rescheduling one
-- cannot: moving a booking for somebody the studio has stopped taking is the
-- case this is here to refuse.

-- ── RLS ──────────────────────────────────────────────────────
alter table public.client_bans enable row level security;

-- No client policy of any kind. A client never reads this table: they are
-- declined at the point of booking and pointed at the phone, and the reason
-- somebody wrote about them is a staff note, not a notice.
drop policy if exists "staff reads client bans" on public.client_bans;
create policy "staff reads client bans" on public.client_bans
  for select using (public.is_staff());

-- Anyone on staff may stop the next booking. In a one-room studio the person
-- who needs this is the person who was in the room, and making her find a
-- manager first defeats the point.
drop policy if exists "staff records a ban" on public.client_bans;
create policy "staff records a ban" on public.client_bans
  for insert with check (public.is_staff() and banned_by = auth.uid());

-- Letting somebody back in is the heavier decision, so it sits a tier up.
drop policy if exists "manager lifts a ban" on public.client_bans;
create policy "manager lifts a ban" on public.client_bans
  for update using (public.is_manager()) with check (public.is_manager());

-- Deliberately no DELETE policy. A ban that can be deleted is a ban that can
-- be denied later.

-- ══════════════════════════════════════════════════════════════
-- 2. BEFORE & AFTER PHOTOGRAPHS
-- ══════════════════════════════════════════════════════════════
--
-- Which services are worth photographing is a property of the service, not
-- something to remember per visit. A peel series and a lightening protocol are
-- the whole point — the client cannot see six weeks of progress in a mirror.

alter table public.services
  add column if not exists photo_documentation boolean not null default false;

-- 0 = no follow-up. Otherwise: days after the visit at which a progress
-- photograph is worth asking for. Six weeks is the usual interval for a
-- lightening or peel series, which is why the reminder reads the way it does.
alter table public.services
  add column if not exists photo_followup_days int not null default 0
    check (photo_followup_days >= 0);

comment on column public.services.photo_documentation is
  'Opts a service into before/after documentation. The prompt still will not '
  'appear without the client photo release — see client_photo_consent_ok.';

-- Turn it on for the two categories that are a series by definition. Guarded
-- on "nothing is documented yet" rather than on the category, so a re-run
-- cannot switch back on something the owner has since switched off.
update public.services s
   set photo_documentation = true,
       photo_followup_days = 42
  from public.service_categories c
 where c.id = s.category_id
   and c.slug in ('chemical-peels', 'skin-lightening')
   and not exists (select 1 from public.services where photo_documentation);

-- ── The separate written consent §6 requires ─────────────────
--
-- 'photo-release' (seeded in 010) covers clinical before-and-afters. It does
-- not cover intimate areas, and the intimate-services consent the client signs
-- says so in as many words: "no photograph of any intimate area will be taken
-- unless I give separate written consent". This is that separate consent. It
-- is a second form rather than a checkbox because that sentence promised a
-- second decision, taken on its own.
insert into public.consent_forms
  (slug, version, title, body, category_ids, revalidate_after_days)
select 'intimate-photography', 1, 'Intimate Area Photography Consent',
$$This is a separate permission from the general photography release, and from consent to the treatment itself. Declining it changes nothing about the service I receive.

I consent to clinical photographs being taken of the intimate area being treated, for my own treatment record, so that my esthetician and I can see whether the protocol is working.

I understand that these photographs are stored in a private, encrypted location, that they are visible only to me and to the staff who treat me, and that they are never shown to anyone else.

I understand that my face will not appear in these photographs, that I will be draped and exposed only for the moment the photograph is taken, and that I may ask for the photograph to be deleted immediately after it is shown to me.

I understand that these photographs will never be used for marketing, teaching, or any other purpose, regardless of any other permission I have given.

I may withdraw this consent at any time, without giving a reason, and my photographs will be deleted when I do.$$,
  array(select id from public.service_categories where slug in ('skin-lightening', 'waxing')),
  180
on conflict (slug, version) do nothing;

/**
 * May we photograph this client at all?
 *
 * Two gates, and both have to be open:
 *
 *   • The blanket release on client_records. Read exactly the way
 *     src/app/account/settings/page.tsx reads it — set, and not revoked — so
 *     the reminder and the client's own settings page can never disagree about
 *     what she chose. 030's anonymisation stamps the revocation without
 *     clearing the grant, and this is why: a withdrawal is recorded, never
 *     erased, and it still closes the gate.
 *
 *   • For an intimate service, the separate written consent above, unexpired.
 *     `expires_at` is honoured when the signing flow set one; when it did not,
 *     the form's own revalidate_after_days is applied to signed_at, so a
 *     lapsed intimate consent closes the gate either way.
 *
 * SECURITY INVOKER. It reads client_records and consent_signatures under the
 * caller's own RLS, so it fails closed for anyone who has no business asking.
 */
create or replace function public.client_photo_consent_ok(
  p_client_id uuid,
  p_intimate  boolean default false
) returns boolean language sql stable set search_path = public as $$
  select
    exists (
      select 1 from public.client_records r
      where r.client_id = p_client_id
        and r.photo_release_at is not null
        and r.photo_release_revoked_at is null
    )
    and (
      not coalesce(p_intimate, false)
      or exists (
        select 1
        from public.consent_signatures s
        join public.consent_forms f on f.id = s.consent_form_id
        where s.client_id = p_client_id
          and f.slug = 'intimate-photography'
          and (
            case
              when s.expires_at is not null then s.expires_at > now()
              else s.signed_at > now() - make_interval(days => f.revalidate_after_days)
            end
          )
      )
    );
$$;

/**
 * What photograph, if any, is due on this appointment right now.
 *
 * `photo_due` is null unless every condition holds: a service on the visit is
 * documented, the client's consent covers it, and the photograph is not
 * already there. That is deliberate — the suppression lives in SQL, so a
 * second surface built later cannot forget it the way a component could.
 *
 * A revoked photograph (deletion_requested_at) does not count as taken. The
 * nightly purge has not run yet and the image is on its way out; asking for a
 * replacement is the right prompt, not "already done".
 */
drop view if exists public.client_photo_status;
drop view if exists public.appointment_photo_prompts;

create view public.appointment_photo_prompts
with (security_invoker = on) as
with documented as (
  select
    line.appointment_id,
    bool_or(s.photo_documentation)                                     as photo_documented,
    -- Either flag is enough: 002 carries is_intimate on the service AND on
    -- the category, and the stricter reading is the only safe one here.
    bool_or(s.is_intimate or c.is_intimate)                            as intimate,
    max(s.photo_followup_days) filter (where s.photo_documentation)    as followup_days,
    string_agg(distinct s.name, ', ') filter (where s.photo_documentation)
                                                                       as documented_services
  from public.appointment_services line
  join public.services s           on s.id = line.service_id
  join public.service_categories c on c.id = s.category_id
  group by line.appointment_id
)
select
  a.id                                   as appointment_id,
  a.client_id,
  a.provider_id,
  a.location_id,
  a.starts_at,
  a.status,
  coalesce(d.photo_documented, false)    as photo_documented,
  coalesce(d.intimate, false)            as intimate,
  d.documented_services,
  coalesce(d.followup_days, 0)           as followup_days,
  coalesce(shot.before_count, 0)         as before_count,
  coalesce(shot.after_count, 0)          as after_count,
  coalesce(shot.progress_count, 0)       as progress_count,
  coalesce(cons.ok, false)               as consent_ok,
  case
    when not coalesce(d.photo_documented, false) then null
    when not coalesce(cons.ok, false)            then null
    when a.status = 'checked_in' and coalesce(shot.before_count, 0) = 0 then 'before'
    when a.status = 'completed'  and coalesce(shot.after_count, 0)  = 0 then 'after'
    else null
  end                                    as photo_due
from public.appointments a
left join documented d on d.appointment_id = a.id
left join lateral (
  select
    count(*) filter (where t.phase = 'before')::int   as before_count,
    count(*) filter (where t.phase = 'after')::int    as after_count,
    count(*) filter (where t.phase = 'progress')::int as progress_count
  from public.treatment_photos t
  where t.appointment_id = a.id
    and t.deletion_requested_at is null
) shot on true
left join lateral (
  select public.client_photo_consent_ok(a.client_id, coalesce(d.intimate, false)) as ok
) cons on true
where a.client_id is not null;

comment on view public.appointment_photo_prompts is
  'Per-appointment photo prompt. photo_due is null whenever consent does not '
  'permit the photograph, so the gate is in SQL and not in a component.';

/**
 * The same question asked of a person rather than a visit: what has been
 * photographed, what the consent position is, and whether a progress
 * photograph is overdue.
 *
 * Built on the view above rather than repeating its joins, so "when may we
 * photograph this client" has exactly one answer in the schema.
 */
create view public.client_photo_status
with (security_invoker = on) as
select
  r.client_id,
  r.photo_release_at,
  r.photo_release_revoked_at,
  public.client_photo_consent_ok(r.client_id, false) as photo_release_ok,
  public.client_photo_consent_ok(r.client_id, true)  as intimate_consent_ok,

  coalesce(v.documented_visits, 0)   as documented_visits,
  coalesce(v.visits_with_photos, 0)  as visits_with_photos,

  coalesce(ph.photo_count, 0)        as photo_count,
  coalesce(ph.before_count, 0)       as before_count,
  coalesce(ph.after_count, 0)        as after_count,
  coalesce(ph.progress_count, 0)     as progress_count,
  ph.last_photo_at,

  f.followup_service,
  -- The visit being followed up, so the reminder can say "it has been six
  -- weeks since the peel" rather than quoting a due date at somebody.
  f.followup_visit_at,
  f.followup_due_at,
  -- Overdue means the interval has passed AND nothing has been taken since it
  -- came due — a photograph taken last week answers the reminder.
  (
    f.followup_due_at is not null
    and f.followup_due_at <= now()
    and (ph.last_photo_at is null or ph.last_photo_at < f.followup_due_at)
  )                                  as followup_overdue
from public.client_records r
left join lateral (
  select
    count(*) filter (
      where q.photo_documented and q.status = 'completed'
    )::int as documented_visits,
    count(*) filter (
      where q.photo_documented and q.status = 'completed'
        and q.before_count + q.after_count + q.progress_count > 0
    )::int as visits_with_photos
  from public.appointment_photo_prompts q
  where q.client_id = r.client_id
) v on true
left join lateral (
  -- The most recent documented visit that carries a follow-up interval. The
  -- consent gate is repeated here rather than inherited, because a client who
  -- has revoked must not be chased for a progress photograph either.
  select
    q.documented_services as followup_service,
    q.starts_at          as followup_visit_at,
    q.starts_at + make_interval(days => q.followup_days) as followup_due_at
  from public.appointment_photo_prompts q
  where q.client_id = r.client_id
    and q.status = 'completed'
    and q.photo_documented
    and q.followup_days > 0
    and q.consent_ok
  order by q.starts_at desc
  limit 1
) f on true
left join lateral (
  select
    count(*)::int                                     as photo_count,
    count(*) filter (where t.phase = 'before')::int   as before_count,
    count(*) filter (where t.phase = 'after')::int    as after_count,
    count(*) filter (where t.phase = 'progress')::int as progress_count,
    max(t.taken_at)                                   as last_photo_at
  from public.treatment_photos t
  where t.client_id = r.client_id
    and t.deletion_requested_at is null
) ph on true;

-- ══════════════════════════════════════════════════════════════
-- 3. DEPTH
-- ══════════════════════════════════════════════════════════════

-- ── Tags ─────────────────────────────────────────────────────
-- 005 created the table and nothing ever gave it a shape to render.
alter table public.client_tags add column if not exists description text;
alter table public.client_tags add column if not exists sort_order int not null default 0;
-- Some tags are a colour on a chip; some are the thing you must read before
-- you touch someone's skin. This is which.
alter table public.client_tags add column if not exists is_alert boolean not null default false;

insert into public.client_tags (name, color, description, is_alert, sort_order) values
  ('VIP',              'clay',   'Regular. Worth a call before a schedule change.',           false, 10),
  ('Sensitive skin',   'amber',  'Reacts easily. Patch test and step the strength down.',     true,  20),
  ('Keloid history',   'amber',  'Scars readily — no extractions or aggressive exfoliation.', true,  30),
  ('Photo study',      'sage',   'Documented series. Photographs matter to this protocol.',   false, 40),
  ('Payment plan',     'stone',  'Pays across visits. Check the balance at the counter.',     false, 50),
  ('Referred a friend','sage',   'Has sent someone else here.',                               false, 60)
on conflict (name) do nothing;

/**
 * The whole relationship, in order.
 *
 * One query instead of nine, and — because it is a UNION of tables that each
 * carry their own policies, read through security_invoker — one place where
 * "who may see what" is already answered. A client reading their own timeline
 * gets appointments, orders, payments, consent, intake and their own
 * photographs; the provider notes and the ban rows are simply not there,
 * because client_notes and client_bans do not let them be.
 *
 * `ref` is text because the ids being unioned are not the same type: an
 * appointment is a uuid, an order is a bigint. The consumer pairs it with
 * `kind` to build a link.
 *
 * `location_id` is null on rows that belong to the business rather than to a
 * building — 032 drew that line deliberately for the clinical and CRM side, and
 * this view honours it rather than inventing an address for a consent form.
 */
drop view if exists public.client_timeline;

create view public.client_timeline
with (security_invoker = on) as

  -- Visits.
  select
    a.client_id,
    a.starts_at                                   as occurred_at,
    'appointment'                                 as kind,
    a.id::text                                    as ref,
    coalesce(
      (select string_agg(l.name_snapshot, ' + ' order by l.sort_order)
         from public.appointment_services l where l.appointment_id = a.id),
      'Appointment'
    )                                             as title,
    null::text                                    as detail,
    a.total_cents::bigint                         as amount_cents,
    a.status::text                                as status,
    a.location_id
  from public.appointments a
  where a.client_id is not null

union all

  -- Retail, in the room and online. Unpaid carts are not history.
  select
    o.client_id,
    coalesce(o.paid_at, o.created_at),
    'purchase',
    o.id::text,
    coalesce(
      (select string_agg(
                i.name_snapshot || case when i.qty > 1 then ' ×' || i.qty else '' end,
                ', ' order by i.id)
         from public.order_items i where i.order_id = o.id),
      'Order'
    ),
    o.order_number,
    o.total_cents::bigint,
    o.status::text,
    o.location_id
  from public.orders o
  where o.client_id is not null
    and o.status in ('paid', 'fulfilling', 'ready_for_pickup', 'shipped', 'completed', 'refunded')

union all

  -- Money that actually moved. Deliberately separate from the two rows above:
  -- an appointment is what was billed, a payment is what was taken, and the
  -- gap between them is the balance somebody has to chase.
  select
    p.client_id,
    p.created_at,
    'payment',
    p.id::text,
    initcap(replace(p.kind, '_', ' ')) || ' · ' || replace(p.method, '_', ' '),
    p.note,
    p.amount_cents::bigint,
    p.status,
    null::bigint
  from public.payments p
  where p.client_id is not null
    and p.status = 'succeeded'

union all

  -- Clinical notes. Staff-only, by client_notes' own policies.
  select
    n.client_id,
    n.created_at,
    'note',
    n.id::text,
    n.body,
    nullif(
      concat_ws(
        ' · ',
        nullif('Products: ' || n.products_used, 'Products: '),
        nullif('Next: ' || n.next_visit_plan, 'Next: ')
      ),
      ''
    ),
    null::bigint,
    null::text,
    null::bigint
  from public.client_notes n

union all

  select
    s.client_id,
    s.signed_at,
    'consent',
    s.id::text,
    f.title,
    'Signed as ' || s.signed_name,
    null::bigint,
    case when s.expires_at is not null and s.expires_at <= now()
         then 'expired' else 'valid' end,
    null::bigint
  from public.consent_signatures s
  join public.consent_forms f on f.id = s.consent_form_id

union all

  select
    i.client_id,
    i.submitted_at,
    'intake',
    i.id::text,
    coalesce(f.title, 'Intake'),
    nullif(array_to_string(i.flags, ', '), ''),
    null::bigint,
    case when i.reviewed_at is null then 'unreviewed' else 'reviewed' end,
    null::bigint
  from public.intake_submissions i
  join public.intake_forms f on f.id = i.intake_form_id

union all

  select
    t.client_id,
    t.taken_at,
    'photo',
    t.id::text,
    initcap(t.phase) || coalesce(' · ' || t.body_area, ''),
    t.notes,
    null::bigint,
    case when t.deletion_requested_at is not null then 'deletion_requested' else 'held' end,
    null::bigint
  from public.treatment_photos t

union all

  select
    pt.client_id,
    pt.performed_at,
    'patch_test',
    pt.id::text,
    coalesce(sv.name, pt.product, 'Patch test'),
    pt.reaction_notes,
    null::bigint,
    pt.result,
    null::bigint
  from public.patch_tests pt
  left join public.services sv on sv.id = pt.service_id

union all

  -- The ban itself, and the lift, as two events — because that is how they
  -- read on a timeline and how somebody reconstructs what happened.
  select
    b.client_id,
    b.banned_at,
    'ban',
    b.id::text,
    b.reason,
    case
      when b.expires_at is not null
        then 'Until ' || to_char(b.expires_at, 'Mon FMDD, YYYY')
      else 'No end date'
    end,
    null::bigint,
    case when b.applies_studio_wide then 'studio_wide' else 'this_location' end,
    b.location_id
  from public.client_bans b

union all

  select
    b.client_id,
    b.lifted_at,
    'ban_lifted',
    b.id::text,
    coalesce(b.lift_reason, 'Ban lifted'),
    null::text,
    null::bigint,
    null::text,
    b.location_id
  from public.client_bans b
  where b.lifted_at is not null;

comment on view public.client_timeline is
  'Every dated fact about a client in one chronological feed. Reads through '
  'security_invoker, so each source table''s RLS decides what the caller sees '
  '— a client querying it simply does not get the clinical rows.';

-- ============================================================
-- INTEGRATION NOTE — src/lib/booking.ts (not edited here)
--
-- The trigger above already refuses the insert, so a banned client cannot be
-- booked today by any route. What booking.ts owes it is the polite decline:
-- one branch beside the existing 23P01 one, in BOTH createBooking and
-- createStaffBooking:
--
--   if (insertError.code === '23P02') return failure('client_banned', 403)
--
-- plus 'client_banned' on the BookingError union, and in
-- BOOKING_ERROR_MESSAGES — copy that declines and points at the phone,
-- never the word "banned":
--
--   client_banned:
--     'We are not able to book this one online. Please call the studio and
--      we will take it from there.'
--
-- (Exported as BANNED_BOOKING_MESSAGE in src/types/clientprofile.ts, so the
--  ban panel can show staff exactly what the client will be shown.)
--
-- The staff reason stays in client_bans, where only staff can read it.
-- ============================================================

-- ─────────────────────────────────────────────────────────────
-- 040_barcodes.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 040: the barcode that is already on the bottle
--
-- `sku` is the studio's own name for a product. It is chosen here, it is
-- unique here, and it means nothing to anyone else. A UPC/EAN is the opposite:
-- the manufacturer assigned it, it is printed on the packaging, and it is the
-- only string a £20 scanner will ever hand us. Rhonda Allison bottles carry
-- real ones, so the two are not interchangeable and one column cannot be both.
--
-- Nullable on purpose. Plenty of back-bar stock is decanted, relabelled, or
-- simply has no readable code, and a product without a barcode is a normal
-- product — it is just one you have to find by name.
-- ============================================================

alter table public.products add column if not exists barcode text;

comment on column public.products.barcode is
  'The GTIN printed on the packaging (UPC-A, EAN-13, EAN-8, ITF-14), digits '
  'only. Assigned by the manufacturer, not by the studio — that is `sku`. '
  'Null when the product has no scannable code.';

-- ── Normalise on the way in ──────────────────────────────────
--
-- A keyboard-wedge scanner types its digits and presses Enter, and depending on
-- how it is configured it may bracket them with spaces, a tab, or a stray
-- carriage return. Stripping that here rather than in the browser means the
-- column holds one canonical form no matter which client wrote it — the till,
-- the inventory page, a CSV import, or psql.
create or replace function public.product_normalize_barcode()
returns trigger language plpgsql as $$
begin
  new.barcode := nullif(regexp_replace(coalesce(new.barcode, ''), '[^0-9]', '', 'g'), '');
  return new;
end;
$$;

drop trigger if exists products_normalize_barcode on public.products;
create trigger products_normalize_barcode
  before insert or update of barcode on public.products
  for each row execute function public.product_normalize_barcode();

-- Every GTIN in circulation is 8, 12, 13 or 14 digits. The range is written as
-- 8–14 rather than an enumeration because scanners occasionally emit a
-- zero-padded variant of the same number, and refusing to store what the
-- hardware actually reports helps nobody.
alter table public.products drop constraint if exists products_barcode_format;
alter table public.products add constraint products_barcode_format
  check (barcode is null or barcode ~ '^[0-9]{8,14}$');

-- Unique WHERE NOT NULL: two products may both lack a barcode, but no two may
-- claim the same one — a scan has to resolve to exactly one thing on the shelf.
create unique index if not exists products_barcode_key
  on public.products (barcode)
  where barcode is not null;

/**
 * Resolve a scanned code to a product id.
 *
 * The app looks products up through its own RLS-protected query; this exists so
 * the same answer is available to SQL — an import script checking for a clash,
 * or a report reconciling a scan log — without every caller re-deriving which
 * zero-padded renderings of a GTIN count as the same number.
 *
 * A scanner set to emit UPC-A sends 12 digits; the same product read by a
 * scanner set to EAN-13 sends the same digits with a leading zero. Both are the
 * same GTIN, so both must find the same row.
 */
-- Deliberately NOT security definer: RLS is the security boundary, and the
-- products policy already says what each role may see. Running as the caller
-- means a client asking about a back-bar code gets nothing, which is the
-- correct answer rather than one this function has to remember to give.
create or replace function public.product_id_for_barcode(p_code text)
returns bigint language sql stable set search_path = public as $$
  select id from public.products
  where barcode is not null
    and ltrim(barcode, '0') = ltrim(regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g'), '0')
    and ltrim(regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g'), '0') <> ''
    and archived_at is null
  order by id
  limit 1;
$$;

revoke all on function public.product_id_for_barcode(text) from public;
grant execute on function public.product_id_for_barcode(text) to authenticated;

-- ─────────────────────────────────────────────────────────────
-- 041_team_profiles.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 041: team member profiles
--
-- `profiles` already carries display_name, slug, bio, avatar_url and
-- accepts_online_booking (001, 020). That is enough to render a name on the
-- booking step and nothing more. A profile — the thing a client reads before
-- deciding who is going to be alone in a room with them — needs specialities,
-- languages, training, a photograph and a considered biography. A studio also
-- needs the other half: what licence this person holds, when it expires, who to
-- call if something happens on the floor.
--
-- Those two halves have opposite audiences, and that is what shapes this
-- migration.
--
-- ── Why three tables and not one wide one ────────────────────
--
-- Row-level security is row-level. Once a policy lets a role SELECT a row, that
-- role reads every column of it. So "the internet may read the biography but
-- not the emergency contact" is not expressible as a policy on a single table —
-- it can only be expressed by the application remembering to name its columns,
-- and an application that must remember is an application that will one day
-- forget. One `select('*')` in a future team page, and a licence number and a
-- next-of-kin phone number are on the public internet.
--
-- A view will not save this either. A Postgres view runs as its OWNER unless
-- created `with (security_invoker = on)`, and migration 028 dropped exactly
-- such a view after it turned out to be handing every signed-in client the
-- whole user list. Read the comment at the top of 028 before reaching for one
-- here.
--
-- So the split is physical, and each table has exactly one rule:
--
--   staff_profiles     the page a client sees.   anon may read (when opted in).
--   staff_credentials  licensure.                the person + managers.
--   staff_employment   HR.                       managers only.
--
-- The public table is a *publication*, not a mirror: it carries its own
-- display_name and slug so the public team page never reads `profiles` at all.
-- Nothing about who else can see a staff member's email, phone or date of birth
-- changes as a result of this migration.
--
-- Table-level GRANTs back the policies up at the bottom of this file. `anon`
-- has no SELECT privilege whatsoever on the two private tables, so a mistake in
-- a policy is still not a leak.
-- ============================================================

-- ── Is this person still someone we would list? ──────────────
--
-- SECURITY DEFINER on purpose. A policy's subquery is itself subject to RLS, so
-- an inline `exists (select 1 from profiles …)` would be evaluated under the
-- caller's own restricted view of `profiles` — under which `anon` sees only
-- bookable providers. A front-desk lead who opted into the team page would then
-- silently vanish from it. Asking the question through a definer function makes
-- the answer the same for everyone; it returns a boolean and nothing else.
create or replace function public.is_listable_staff(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = p_profile_id
      and role <> 'client'
      and suspended_at is null
  );
$$;

comment on function public.is_listable_staff(uuid) is
  'Whether a profile is still staff and unsuspended. Used by the public team '
  'policy so that demoting or suspending someone removes them from the website '
  'immediately, without anyone having to remember to untick a box.';

-- ── 1. The public half ───────────────────────────────────────

create table if not exists public.staff_profiles (
  profile_id     uuid primary key references public.profiles(id) on delete cascade,

  -- The one deliberate act. Default false: nobody is published because a row
  -- appeared, only because they said yes.
  is_public      boolean not null default false,

  -- Identity is duplicated here rather than joined from `profiles`, so that the
  -- public team page reads this table and only this table. A denormalised name
  -- is a small price for a public surface with no path back to a row holding a
  -- date of birth.
  display_name   text not null,
  slug           text not null unique,

  headline       text,          -- one line under the name
  bio            text,          -- the long version; profiles.bio stays the booking blurb
  pronouns       text,          -- as they wish to be shown, independent of profiles.pronouns
  photo_url      text,

  -- Professional, and public: this is what a client is choosing on.
  specialities   text[] not null default '{}',
  certifications text[] not null default '{}',
  languages      text[] not null default '{}',
  years_experience int,

  instagram_url  text,
  tiktok_url     text,
  website_url    text,

  sort_order     int not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint staff_profiles_slug_shape
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 60),
  constraint staff_profiles_display_name_present
    check (length(trim(display_name)) between 1 and 80),
  constraint staff_profiles_headline_length check (headline is null or length(headline) <= 140),
  constraint staff_profiles_bio_length      check (bio is null or length(bio) <= 4000),
  constraint staff_profiles_pronouns_length check (pronouns is null or length(pronouns) <= 40),
  -- Years, not decades of them. A typo that says 300 years of experience is a
  -- typo that reaches the public site.
  constraint staff_profiles_years_sane
    check (years_experience is null or years_experience between 0 and 70),
  -- Lists, not essays. Keeps the cards on the team page comparable.
  constraint staff_profiles_specialities_bounded
    check (coalesce(array_length(specialities, 1), 0) <= 12),
  constraint staff_profiles_certifications_bounded
    check (coalesce(array_length(certifications, 1), 0) <= 12),
  constraint staff_profiles_languages_bounded
    check (coalesce(array_length(languages, 1), 0) <= 8),
  -- https only. These render as links on a page anyone can reach, and a
  -- javascript: or data: URL in a social field is a stored XSS.
  constraint staff_profiles_instagram_url
    check (instagram_url is null or (instagram_url ~ '^https://' and length(instagram_url) <= 300)),
  constraint staff_profiles_tiktok_url
    check (tiktok_url is null or (tiktok_url ~ '^https://' and length(tiktok_url) <= 300)),
  constraint staff_profiles_website_url
    check (website_url is null or (website_url ~ '^https://' and length(website_url) <= 300)),
  -- Either a remote asset over https, or something served from this app.
  constraint staff_profiles_photo_url
    check (photo_url is null or (photo_url ~ '^(https://|/)' and length(photo_url) <= 500))
);

create index if not exists staff_profiles_public_idx
  on public.staff_profiles (sort_order, display_name) where is_public;

drop trigger if exists staff_profiles_touch on public.staff_profiles;
create trigger staff_profiles_touch
  before update on public.staff_profiles
  for each row execute function public.touch_updated_at();

-- ── 2. Licensure ─────────────────────────────────────────────
--
-- Separate from HR because the audience is different: an esthetician must be
-- able to see her own licence and its expiry — she is the one who has to renew
-- it — but has no business reading her own personnel file.

create table if not exists public.staff_credentials (
  profile_id     uuid primary key references public.profiles(id) on delete cascade,

  licence_number text,
  licence_type   text,
  licence_state  text not null default 'CA',
  licence_issued_on  date,
  licence_expires_on date,

  -- Someone checked it against the state board. A date, not a boolean, because
  -- "verified in 2019" and "verified last week" are different facts.
  verified_at    timestamptz,
  verified_by    uuid references public.profiles(id) on delete set null,

  -- Bookkeeping for notify_expiring_licences(); see below. Not settings.
  expiry_reminder_stage int,
  expiry_reminded_at    timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint staff_credentials_number_length
    check (licence_number is null or length(trim(licence_number)) between 2 and 40),
  constraint staff_credentials_state_shape
    check (licence_state ~ '^[A-Z]{2}$'),
  constraint staff_credentials_type_known
    check (licence_type is null or licence_type in (
      'esthetician', 'cosmetologist', 'nail_technician',
      'barber', 'electrologist', 'instructor', 'other'
    )),
  constraint staff_credentials_dates_ordered
    check (licence_issued_on is null or licence_expires_on is null
           or licence_expires_on >= licence_issued_on)
);

-- The expiry sweep reads only rows that have a date, and orders by it.
create index if not exists staff_credentials_expiry_idx
  on public.staff_credentials (licence_expires_on)
  where licence_expires_on is not null;

drop trigger if exists staff_credentials_touch on public.staff_credentials;
create trigger staff_credentials_touch
  before update on public.staff_credentials
  for each row execute function public.touch_updated_at();

-- A renewed licence starts a clean reminder cycle. Without this, someone who
-- was warned at 14 days and then renewed for two years would never be warned
-- again — the stored stage would already be tighter than anything the new date
-- could produce.
create or replace function public.staff_credentials_reset_reminders()
returns trigger language plpgsql as $$
begin
  if new.licence_expires_on is distinct from old.licence_expires_on then
    new.expiry_reminder_stage := null;
    new.expiry_reminded_at    := null;
  end if;
  return new;
end;
$$;

drop trigger if exists staff_credentials_reset_reminders on public.staff_credentials;
create trigger staff_credentials_reset_reminders
  before update of licence_expires_on on public.staff_credentials
  for each row execute function public.staff_credentials_reset_reminders();

-- ── 3. HR ────────────────────────────────────────────────────
--
-- Managers only, including on your own row. An employment record is a record
-- the studio keeps ABOUT someone; letting the subject edit their own start
-- date, classification or the notes written about them would make it evidence
-- of nothing. The emergency contact sits here for the same reason it sits in a
-- personnel file: it is used by whoever is holding the room when its owner
-- cannot answer for themselves.

create table if not exists public.staff_employment (
  profile_id      uuid primary key references public.profiles(id) on delete cascade,

  started_on      date,
  ended_on        date,
  -- Booth renter matters in this trade specifically: a renter is not an
  -- employee, and the studio's obligations differ.
  employment_type text,

  emergency_contact_name         text,
  emergency_contact_phone        text,
  emergency_contact_relationship text,

  internal_notes  text,

  updated_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint staff_employment_type_known
    check (employment_type is null or employment_type in (
      'employee', 'independent_contractor', 'booth_renter', 'apprentice', 'owner'
    )),
  constraint staff_employment_dates_ordered
    check (started_on is null or ended_on is null or ended_on >= started_on),
  constraint staff_employment_contact_lengths
    check ((emergency_contact_name is null or length(emergency_contact_name) <= 120)
       and (emergency_contact_phone is null or length(emergency_contact_phone) <= 40)
       and (emergency_contact_relationship is null or length(emergency_contact_relationship) <= 60)),
  constraint staff_employment_notes_length
    check (internal_notes is null or length(internal_notes) <= 8000)
);

drop trigger if exists staff_employment_touch on public.staff_employment;
create trigger staff_employment_touch
  before update on public.staff_employment
  for each row execute function public.touch_updated_at();

-- ── Slugs ────────────────────────────────────────────────────
/**
 * A url-safe handle for /team/<slug>, unique across the table.
 *
 * Derived once, at the moment a staff row first appears, and never re-derived:
 * a published URL that changes because someone corrected the spelling of their
 * own name is a broken link and a lost search ranking. Renaming is possible —
 * the column is editable — it just is not automatic.
 */
create or replace function public.staff_profile_slug(p_name text, p_profile_id uuid)
returns text language plpgsql stable set search_path = public as $$
declare
  base      text;
  candidate text;
  n         int := 1;
begin
  base := lower(coalesce(nullif(trim(p_name), ''), ''));
  base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
  base := trim(both '-' from base);
  base := left(base, 50);

  -- Nothing usable in the name (initials only, non-latin script, empty). The
  -- uuid prefix is ugly but it is a working URL, and it can be edited.
  if base = '' or length(base) < 2 then
    base := 'team-' || left(replace(p_profile_id::text, '-', ''), 8);
  end if;

  candidate := base;
  while exists (
    select 1 from public.staff_profiles s
    where s.slug = candidate and s.profile_id <> p_profile_id
  ) loop
    n := n + 1;
    candidate := left(base, 55) || '-' || n;
  end loop;

  return candidate;
end;
$$;

/**
 * Every staff member gets a (private, unpublished) profile row the moment they
 * become staff, so the dashboard editor has something to open and the studio
 * can see at a glance who has filled theirs in. Publishing stays a decision.
 */
create or replace function public.ensure_staff_profile()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  name text;
begin
  if new.role = 'client' then
    return null;
  end if;

  name := coalesce(
    nullif(trim(coalesce(new.display_name, '')), ''),
    nullif(trim(coalesce(new.first_name, '') || ' ' || coalesce(new.last_name, '')), ''),
    'Team member'
  );

  insert into public.staff_profiles (profile_id, display_name, slug)
  values (new.id, name, public.staff_profile_slug(name, new.id))
  on conflict (profile_id) do nothing;

  return null;
end;
$$;

drop trigger if exists profiles_ensure_staff_profile on public.profiles;
create trigger profiles_ensure_staff_profile
  after insert or update of role on public.profiles
  for each row execute function public.ensure_staff_profile();

-- Backfill whoever is already staff. Idempotent by way of the conflict clause.
insert into public.staff_profiles (profile_id, display_name, slug)
select
  p.id,
  coalesce(
    nullif(trim(coalesce(p.display_name, '')), ''),
    nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
    'Team member'
  ),
  public.staff_profile_slug(
    coalesce(
      nullif(trim(coalesce(p.display_name, '')), ''),
      nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
      'Team member'
    ),
    p.id
  )
from public.profiles p
where p.role <> 'client'
on conflict (profile_id) do nothing;

-- ── RLS ──────────────────────────────────────────────────────

alter table public.staff_profiles    enable row level security;
alter table public.staff_credentials enable row level security;
alter table public.staff_employment  enable row level security;

-- staff_profiles: the only one of the three the internet can see, and then only
-- the rows that asked to be seen and still belong to unsuspended staff.
drop policy if exists "public reads listed team members" on public.staff_profiles;
create policy "public reads listed team members" on public.staff_profiles
  for select to anon, authenticated
  using (is_public and public.is_listable_staff(profile_id));

drop policy if exists "staff reads team profiles" on public.staff_profiles;
create policy "staff reads team profiles" on public.staff_profiles
  for select using (public.is_staff());

-- Your own page is yours, including whether it is published at all: a person
-- can always take their own photograph and biography off a public website.
drop policy if exists "staff writes own team profile" on public.staff_profiles;
create policy "staff writes own team profile" on public.staff_profiles
  for update
  using (profile_id = auth.uid() and public.is_staff())
  with check (profile_id = auth.uid() and public.is_staff());

drop policy if exists "manager writes any team profile" on public.staff_profiles;
create policy "manager writes any team profile" on public.staff_profiles
  for update using (public.is_manager()) with check (public.is_manager());

drop policy if exists "staff creates own team profile" on public.staff_profiles;
create policy "staff creates own team profile" on public.staff_profiles
  for insert with check (
    public.is_manager()
    or (profile_id = auth.uid() and public.is_staff())
  );

drop policy if exists "manager deletes team profile" on public.staff_profiles;
create policy "manager deletes team profile" on public.staff_profiles
  for delete using (public.is_manager());

-- staff_credentials: yours to read, a manager's to record. No `to anon` clause
-- exists anywhere on this table, and anon holds no privilege on it either.
drop policy if exists "staff reads own credentials" on public.staff_credentials;
create policy "staff reads own credentials" on public.staff_credentials
  for select using (profile_id = auth.uid() or public.is_manager());

drop policy if exists "manager writes credentials" on public.staff_credentials;
create policy "manager writes credentials" on public.staff_credentials
  for all using (public.is_manager()) with check (public.is_manager());

-- staff_employment: managers, full stop — including the subject's own row.
drop policy if exists "manager reads employment" on public.staff_employment;
create policy "manager reads employment" on public.staff_employment
  for select using (public.is_manager());

drop policy if exists "manager writes employment" on public.staff_employment;
create policy "manager writes employment" on public.staff_employment
  for all using (public.is_manager()) with check (public.is_manager());

-- ── Privileges ───────────────────────────────────────────────
--
-- Belt and braces. Supabase grants broadly to `anon` and `authenticated` by
-- default and leaves RLS to do the filtering; here the private tables are taken
-- away from `anon` at the privilege level as well, so a future policy written
-- in haste still cannot put a licence number or a next-of-kin phone number on
-- the public internet. There is no combination of `select` and `to anon` that
-- gets past a missing GRANT.

grant select on public.staff_profiles to anon;
grant select, insert, update on public.staff_profiles to authenticated;
grant all on public.staff_profiles to service_role;

revoke all on public.staff_credentials from anon;
grant select, insert, update, delete on public.staff_credentials to authenticated;
grant all on public.staff_credentials to service_role;

revoke all on public.staff_employment from anon;
grant select, insert, update, delete on public.staff_employment to authenticated;
grant all on public.staff_employment to service_role;

-- ── Licence expiry ───────────────────────────────────────────
--
-- An esthetician working on a lapsed licence is not a paperwork problem, it is
-- an unlicensed treatment: uninsured, and in California a citable offence for
-- the establishment as much as the individual. Nobody notices a date in a
-- database, so the database has to speak up.

/**
 * How a licence stands today, as a single word.
 *
 * `expired` | `expires_soon` (inside 60 days) | `valid` | `unknown` (no date on
 * file, which is its own kind of problem and is surfaced as such).
 */
create or replace function public.licence_status(p_expires_on date, p_soon_days int default 60)
returns text language sql immutable as $$
  select case
    when p_expires_on is null then 'unknown'
    when p_expires_on < current_date then 'expired'
    when p_expires_on <= current_date + greatest(p_soon_days, 0) then 'expires_soon'
    else 'valid'
  end;
$$;

/**
 * Warn about licences that are running out, once per threshold crossed.
 *
 * Thresholds are 60, 30, 14 and 7 days, then expiry itself. The tightest stage
 * already sent is stored on the row, so this is safe to run every day: a
 * licence 45 days out has already had its 60-day warning and gets nothing
 * further until it crosses 30. Renewing clears the record (see
 * staff_credentials_reset_reminders), so the next cycle starts fresh.
 *
 * Two audiences, deliberately. The holder is told because they are the only
 * person who can renew it; the managers are told because they are the ones who
 * have to stop putting that person on the book if it lapses.
 *
 * SECURITY DEFINER, so it checks its own caller rather than taking anyone's
 * word for it — the same shape as adjust_stock in 021. `auth.uid() is null`
 * means the service role, a scheduled job or the SQL editor, all of which are
 * already privileged.
 *
 * Returns the number of people notified.
 */
create or replace function public.notify_expiring_licences()
returns int language plpgsql security definer set search_path = public as $$
declare
  thresholds constant int[] := array[60, 30, 14, 7];
  cred       record;
  days_left  int;
  stage      int;
  holder     text;
  headline   text;
  detail     text;
  notified   int := 0;
begin
  if auth.uid() is not null and not public.is_manager() then
    raise exception 'Only a manager can run the licence expiry check';
  end if;

  for cred in
    select
      c.profile_id,
      c.licence_expires_on,
      c.expiry_reminder_stage,
      coalesce(
        nullif(trim(coalesce(p.display_name, '')), ''),
        nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
        'A team member'
      ) as name
    from public.staff_credentials c
    join public.profiles p on p.id = c.profile_id
    where c.licence_expires_on is not null
      and p.role <> 'client'
      and p.suspended_at is null
      -- Nothing to say while it is more than the widest threshold away.
      and c.licence_expires_on <= current_date + thresholds[1]
  loop
    days_left := cred.licence_expires_on - current_date;
    holder    := cred.name;

    -- -1 is "expired", and is tighter than every threshold, so the ordinary
    -- comparison below covers it without a special case.
    if days_left < 0 then
      stage := -1;
    else
      select min(t) into stage from unnest(thresholds) t where days_left <= t;
    end if;

    if stage is null then
      continue;
    end if;

    -- Already told them at this stage or a tighter one.
    if cred.expiry_reminder_stage is not null and stage >= cred.expiry_reminder_stage then
      continue;
    end if;

    if stage = -1 then
      headline := 'Licence expired — ' || holder;
      detail := holder || '''s licence expired on ' ||
                to_char(cred.licence_expires_on, 'FMMonth FMDD, YYYY') ||
                '. Treatments cannot be performed on a lapsed licence.';
    else
      headline := 'Licence expires in ' || days_left || ' day' ||
                  case when days_left = 1 then '' else 's' end || ' — ' || holder;
      detail := holder || '''s licence expires on ' ||
                to_char(cred.licence_expires_on, 'FMMonth FMDD, YYYY') || '.';
    end if;

    insert into public.notifications (user_id, type, title, body, link)
    select p.id, 'system', headline, detail, '/dashboard/settings/team'
    from public.profiles p
    where p.suspended_at is null
      and (p.role in ('manager', 'admin') or p.id = cred.profile_id);

    update public.staff_credentials
    set expiry_reminder_stage = stage,
        expiry_reminded_at    = now()
    where profile_id = cred.profile_id;

    notified := notified + 1;
  end loop;

  return notified;
end;
$$;

revoke all on function public.notify_expiring_licences() from public;
revoke all on function public.notify_expiring_licences() from anon;
grant execute on function public.notify_expiring_licences() to authenticated;
grant execute on function public.notify_expiring_licences() to service_role;

comment on function public.notify_expiring_licences() is
  'Run daily. Idempotent: each licence produces at most one notification per '
  'threshold crossed (60/30/14/7 days, then expiry). Schedule it with '
  'select cron.schedule(''licence-expiry'', ''0 15 * * *'', '
  '''select public.notify_expiring_licences()'') once pg_cron is enabled, or '
  'call the RPC from a scheduled job. A manager can also run it by hand from '
  'the team screen.';

-- `is_listable_staff` is called from a policy `anon` is subject to, so anon
-- must be able to execute it. It answers one boolean about staff-ness and
-- reads nothing back to the caller.
grant execute on function public.is_listable_staff(uuid) to anon, authenticated, service_role;
grant execute on function public.licence_status(date, int) to authenticated, service_role;
grant execute on function public.staff_profile_slug(text, uuid) to authenticated, service_role;

-- ── Headshots ────────────────────────────────────────────────
--
-- The `site` bucket is public and, since 011, manager-writable only. A provider
-- updating her own photograph is not a manager operation, so team photos get a
-- prefix of their own: site/team/<profile uuid>/<file>. The path segment is the
-- authorisation, exactly as it is for treatment photography.

drop policy if exists "staff writes own team photo" on storage.objects;
create policy "staff writes own team photo" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'site'
    and (storage.foldername(name))[1] = 'team'
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_manager())
  );

drop policy if exists "staff updates own team photo" on storage.objects;
create policy "staff updates own team photo" on storage.objects
  for update to authenticated using (
    bucket_id = 'site'
    and (storage.foldername(name))[1] = 'team'
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_manager())
  );

drop policy if exists "staff deletes own team photo" on storage.objects;
create policy "staff deletes own team photo" on storage.objects
  for delete to authenticated using (
    bucket_id = 'site'
    and (storage.foldername(name))[1] = 'team'
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_manager())
  );

-- ── Comments ─────────────────────────────────────────────────

comment on table public.staff_profiles is
  'The public half of a team member profile. Readable by anon when is_public. '
  'Carries its own display_name and slug so the public team page never needs '
  'to read profiles — see the header of 041 for why the split is physical.';
comment on column public.staff_profiles.is_public is
  'Opt-in, default false. Editable by the person themselves as well as a '
  'manager: taking your own face off a public website is not a request.';
comment on column public.staff_profiles.bio is
  'The long biography for /team/<slug>. profiles.bio stays the short blurb '
  'shown on the booking step.';

comment on table public.staff_credentials is
  'Licensure. Readable by the holder and by managers. Never by anon — there is '
  'no anon policy and no anon GRANT.';
comment on column public.staff_credentials.expiry_reminder_stage is
  'Tightest reminder threshold already sent (60/30/14/7, or -1 for expired). '
  'Bookkeeping for notify_expiring_licences(), cleared when the expiry date '
  'changes. Not a setting.';

comment on table public.staff_employment is
  'Personnel record. Managers only, including on your own row — an employment '
  'record the subject can edit is evidence of nothing.';
