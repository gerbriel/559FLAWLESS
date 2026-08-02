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
