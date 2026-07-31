-- ============================================================
-- 559 Flawless — 002: service catalog
-- Categories, services, add-ons, and treatment rooms.
-- ============================================================

create table public.service_categories (
  id          bigserial primary key,
  name        text not null,
  slug        text not null unique,
  description text,
  image_url   text,
  -- Intimate categories (Brazilian waxing, intimate lightening) are shown in
  -- plain clinical language and gated behind 18+ confirmation at booking.
  is_intimate boolean not null default false,
  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.services (
  id            bigserial primary key,
  category_id   bigint not null references public.service_categories(id) on delete restrict,
  name          text not null,
  slug          text not null unique,
  description   text,
  -- Longer clinical copy: what it treats, how it feels, what it is not.
  details       text,
  aftercare     text,
  image_url     text,

  price_cents        int not null check (price_cents >= 0),
  -- Set when the price varies (e.g. "from $85"); the UI renders "from".
  price_is_starting  boolean not null default false,
  duration_minutes   int not null check (duration_minutes between 5 and 480),
  -- Padding after the appointment for turnover/room reset. Blocks the
  -- provider's calendar but is not charged and is not shown to the client.
  buffer_minutes     int not null default 10 check (buffer_minutes >= 0),

  -- ── Booking gates ──────────────────────────────────────────
  is_intimate               boolean not null default false,
  requires_age_verification boolean not null default false,
  min_age                   int not null default 18,
  -- Consultation-only services can't be self-booked; client requests a call.
  requires_consultation     boolean not null default false,
  -- New clients must complete intake before this service can be booked.
  requires_intake           boolean not null default true,
  -- Patch test required N hours before (e.g. lightening peels). 0 = none.
  patch_test_hours          int not null default 0,

  -- ── Deposits ───────────────────────────────────────────────
  deposit_cents  int not null default 0 check (deposit_cents >= 0),
  -- Hours before start after which a cancellation forfeits the deposit.
  cancellation_window_hours int not null default 24,

  is_active     boolean not null default true,
  is_featured   boolean not null default false,
  sort_order    int not null default 0,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index services_category_idx on public.services (category_id) where is_active;
create index services_active_idx   on public.services (is_active, sort_order);

-- Add-ons attach to an appointment alongside a primary service
-- (LED therapy, dermaplaning, extractions, nail art, paraffin).
create table public.service_addons (
  id               bigserial primary key,
  name             text not null,
  slug             text not null unique,
  description      text,
  price_cents      int not null check (price_cents >= 0),
  duration_minutes int not null default 0 check (duration_minutes >= 0),
  is_active        boolean not null default true,
  sort_order       int not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- Which add-ons are offered with which service.
create table public.service_addon_links (
  service_id bigint not null references public.services(id) on delete cascade,
  addon_id   bigint not null references public.service_addons(id) on delete cascade,
  primary key (service_id, addon_id)
);

-- Treatment rooms. A studio with two rooms can run two providers at once but
-- not three; appointments optionally claim a room and the exclusion
-- constraint in 004 stops two appointments sharing one.
create table public.rooms (
  id         bigserial primary key,
  name       text not null,
  -- Rooms can be restricted to service types (e.g. only the wet room does
  -- body treatments). Empty array = any service.
  category_ids bigint[] not null default '{}',
  is_active  boolean not null default true,
  sort_order int not null default 0,
  created_at timestamptz not null default now()
);

-- ── updated_at ───────────────────────────────────────────────
create trigger service_categories_touch before update on public.service_categories
  for each row execute function public.touch_updated_at();
create trigger services_touch before update on public.services
  for each row execute function public.touch_updated_at();
create trigger service_addons_touch before update on public.service_addons
  for each row execute function public.touch_updated_at();

-- ── RLS: catalog is public to read, staff-managed to write ───
alter table public.service_categories enable row level security;
alter table public.services           enable row level security;
alter table public.service_addons     enable row level security;
alter table public.service_addon_links enable row level security;
alter table public.rooms              enable row level security;

create policy "public read active categories" on public.service_categories
  for select to anon, authenticated using (is_active or public.is_staff());
create policy "public read active services" on public.services
  for select to anon, authenticated using (is_active or public.is_staff());
create policy "public read active addons" on public.service_addons
  for select to anon, authenticated using (is_active or public.is_staff());
create policy "public read addon links" on public.service_addon_links
  for select to anon, authenticated using (true);
create policy "staff read rooms" on public.rooms
  for select using (public.is_staff());

-- Pricing and gating are admin-only: a front desk employee must not be able to
-- drop a deposit requirement or clear an age gate.
create policy "admin writes categories" on public.service_categories
  for all using (public.is_admin()) with check (public.is_admin());
create policy "admin writes services" on public.services
  for all using (public.is_admin()) with check (public.is_admin());
create policy "admin writes addons" on public.service_addons
  for all using (public.is_admin()) with check (public.is_admin());
create policy "admin writes addon links" on public.service_addon_links
  for all using (public.is_admin()) with check (public.is_admin());
create policy "admin writes rooms" on public.rooms
  for all using (public.is_admin()) with check (public.is_admin());
