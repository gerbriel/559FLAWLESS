-- ============================================================
-- 559 Flawless — 003: scheduling
-- What a provider offers, when they work, and when they don't.
-- Every time here is LOCAL to the provider's timezone (see profiles.timezone);
-- only `appointments` stores absolute instants.
-- ============================================================

-- Which services a provider performs, and any per-provider override of the
-- catalog price/duration (a senior esthetician may charge more for the same facial).
create table public.provider_services (
  provider_id      uuid   not null references public.profiles(id) on delete cascade,
  service_id       bigint not null references public.services(id) on delete cascade,
  price_cents      int check (price_cents >= 0),      -- null = use catalog price
  duration_minutes int check (duration_minutes > 0),  -- null = use catalog duration
  is_active        boolean not null default true,
  primary key (provider_id, service_id)
);

create index provider_services_service_idx on public.provider_services (service_id) where is_active;

-- Recurring weekly working hours.
create table public.provider_schedules (
  id          bigserial primary key,
  provider_id uuid not null references public.profiles(id) on delete cascade,
  day_of_week int  not null check (day_of_week between 0 and 6),  -- 0 = Sunday
  start_time  time not null,
  end_time    time not null,
  -- Granularity of offered start times. 15 lets a 45-min service start :15.
  slot_interval_minutes int not null default 15 check (slot_interval_minutes between 5 and 60),
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  constraint schedule_window_valid check (end_time > start_time)
);

create index provider_schedules_lookup_idx
  on public.provider_schedules (provider_id, day_of_week) where is_active;

-- Date-specific unavailability: vacation, a dentist appointment, a long lunch.
-- Null start/end = the entire day.
create table public.availability_blocks (
  id          bigserial primary key,
  provider_id uuid not null references public.profiles(id) on delete cascade,
  block_date  date not null,
  start_time  time,
  end_time    time,
  reason      text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint block_window_valid check (
    (start_time is null and end_time is null) or
    (start_time is not null and end_time is not null and end_time > start_time)
  )
);

create index availability_blocks_lookup_idx
  on public.availability_blocks (provider_id, block_date);

-- Studio-wide closures (holidays). Applies to every provider.
create table public.closures (
  id          bigserial primary key,
  closure_date date not null unique,
  reason      text not null,
  created_at  timestamptz not null default now()
);

-- Cached Google Calendar busy intervals so a provider's personal calendar
-- blocks the booking page without a live API call on every page view.
-- Refreshed by the `calendar-sync` edge function.
create table public.calendar_busy (
  id          bigserial primary key,
  provider_id uuid not null references public.profiles(id) on delete cascade,
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  source      text not null default 'google',
  synced_at   timestamptz not null default now(),
  constraint busy_window_valid check (ends_at > starts_at)
);

create index calendar_busy_lookup_idx on public.calendar_busy (provider_id, starts_at);

-- Encrypted Google OAuth tokens, one row per connected provider. Tokens are
-- encrypted at the edge before insert; nothing in the app can read them.
create table public.calendar_connections (
  provider_id       uuid primary key references public.profiles(id) on delete cascade,
  google_email      text,
  calendar_id       text not null default 'primary',
  access_token_enc  text,
  refresh_token_enc text,
  expires_at        timestamptz,
  -- Set when Google reports the grant was revoked; UI prompts a reconnect.
  revoked_at        timestamptz,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create trigger calendar_connections_touch before update on public.calendar_connections
  for each row execute function public.touch_updated_at();

-- ── Booking policy (single-row settings) ─────────────────────
create table public.booking_settings (
  id                    int primary key default 1 check (id = 1),
  -- Minimum notice before a bookable slot.
  min_lead_minutes      int not null default 120,
  -- How far out the calendar opens.
  max_advance_days      int not null default 90,
  timezone              text not null default 'America/Los_Angeles',
  -- Auto-confirm or hold every booking for staff review.
  auto_confirm          boolean not null default true,
  -- Global default when a service sets no deposit of its own.
  default_deposit_cents int not null default 0,
  cancellation_policy   text,
  late_policy           text,
  updated_at            timestamptz not null default now()
);

insert into public.booking_settings (id) values (1) on conflict do nothing;

create trigger booking_settings_touch before update on public.booking_settings
  for each row execute function public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────
alter table public.provider_services    enable row level security;
alter table public.provider_schedules   enable row level security;
alter table public.availability_blocks  enable row level security;
alter table public.closures             enable row level security;
alter table public.calendar_busy        enable row level security;
alter table public.calendar_connections enable row level security;
alter table public.booking_settings     enable row level security;

-- The booking page is public, so availability data must be publicly readable.
-- Note what is NOT exposed: `availability_blocks.reason` is readable, so never
-- put medical or personal detail there — the UI only ever renders "unavailable".
create policy "public read provider services" on public.provider_services
  for select to anon, authenticated using (is_active);
create policy "public read schedules" on public.provider_schedules
  for select to anon, authenticated using (is_active);
create policy "public read blocks" on public.availability_blocks
  for select to anon, authenticated using (true);
create policy "public read closures" on public.closures
  for select to anon, authenticated using (true);
create policy "public read busy" on public.calendar_busy
  for select to anon, authenticated using (true);
create policy "public read booking settings" on public.booking_settings
  for select to anon, authenticated using (true);

-- Providers manage their own calendar; managers manage anyone's.
create policy "provider manages own services" on public.provider_services
  for all using (provider_id = auth.uid() or public.is_manager())
  with check (provider_id = auth.uid() or public.is_manager());
create policy "provider manages own schedule" on public.provider_schedules
  for all using (provider_id = auth.uid() or public.is_manager())
  with check (provider_id = auth.uid() or public.is_manager());
create policy "provider manages own blocks" on public.availability_blocks
  for all using (provider_id = auth.uid() or public.is_front_desk())
  with check (provider_id = auth.uid() or public.is_front_desk());
create policy "admin manages closures" on public.closures
  for all using (public.is_manager()) with check (public.is_manager());
create policy "admin manages booking settings" on public.booking_settings
  for all using (public.is_admin()) with check (public.is_admin());

-- Tokens: readable only by their owner, and only ever written by the edge
-- function running with the service role (which bypasses RLS entirely).
create policy "provider reads own calendar connection" on public.calendar_connections
  for select using (provider_id = auth.uid());
create policy "provider disconnects own calendar" on public.calendar_connections
  for delete using (provider_id = auth.uid() or public.is_admin());
