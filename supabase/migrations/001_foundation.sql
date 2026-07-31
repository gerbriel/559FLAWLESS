-- ============================================================
-- 559 Flawless — 001: foundation
-- Roles, profiles, and the role-check helpers every other
-- migration's RLS policies are written against.
-- ============================================================

create extension if not exists "pgcrypto";
-- Required so an exclusion constraint can mix equality (uuid) with overlap
-- (tstzrange) in a single GiST index. Double-booking prevention depends on it.
create extension if not exists "btree_gist";

-- ── Roles ────────────────────────────────────────────────────
-- client       — books appointments, buys products
-- provider     — esthetician/nail tech: owns a calendar, treats clients
-- front_desk   — books on behalf of clients, handles messages, no settings
-- manager      — front_desk + inventory approvals + analytics
-- admin        — everything, including user management and pricing
create type public.user_role as enum (
  'client', 'provider', 'front_desk', 'manager', 'admin'
);

create table public.profiles (
  id            uuid primary key references auth.users(id) on delete cascade,
  role          public.user_role not null default 'client',

  first_name    text,
  last_name     text,
  email         text,
  phone         text,

  -- Client-facing details
  date_of_birth date,
  pronouns      text,
  -- Set once the client has confirmed 18+. Intimate services check this.
  age_verified_at timestamptz,
  marketing_opt_in boolean not null default false,
  sms_opt_in       boolean not null default false,

  -- Provider-facing details (null for clients)
  display_name  text,           -- "Yesenia R." shown on the booking page
  slug          text unique,    -- url-safe provider handle
  bio           text,
  avatar_url    text,
  timezone      text not null default 'America/Los_Angeles',
  accepts_online_booking boolean not null default false,

  -- Soft suspension: blocks login-gated actions without deleting history
  suspended_at  timestamptz,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index profiles_role_idx  on public.profiles (role);
create index profiles_email_idx on public.profiles (lower(email));
create index profiles_phone_idx on public.profiles (phone);

-- ── updated_at helper, reused by every table below ───────────
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch
  before update on public.profiles
  for each row execute function public.touch_updated_at();

-- ── Role helpers ─────────────────────────────────────────────
-- SECURITY DEFINER so a policy on `profiles` can read `profiles` without
-- recursing through its own RLS. search_path is pinned to defeat shadowing.

-- Named `current_user_role`, not `current_role` — the latter is a reserved
-- SQL keyword and cannot be called unquoted.
create or replace function public.current_user_role()
returns public.user_role language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid();
$$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role <> 'client'
      and suspended_at is null
  );
$$;

/** Front desk and up: client records, messages, bookings. */
create or replace function public.is_front_desk()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('front_desk', 'manager', 'admin')
      and suspended_at is null
  );
$$;

/** Manager and up: approvals, analytics, inventory writes. */
create or replace function public.is_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role in ('manager', 'admin')
      and suspended_at is null
  );
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and suspended_at is null
  );
$$;

create or replace function public.is_provider()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'provider' and suspended_at is null
  );
$$;

-- ── Profile RLS ──────────────────────────────────────────────
alter table public.profiles enable row level security;

create policy "read own profile"
  on public.profiles for select using (id = auth.uid());

create policy "staff read all profiles"
  on public.profiles for select using (public.is_staff());

-- Providers who take online bookings are public — the booking page lists them.
create policy "public read bookable providers"
  on public.profiles for select to anon, authenticated
  using (role = 'provider' and accepts_online_booking and suspended_at is null);

create policy "update own profile"
  on public.profiles for update using (id = auth.uid()) with check (id = auth.uid());

create policy "admin updates any profile"
  on public.profiles for update using (public.is_admin());

create policy "insert own profile"
  on public.profiles for insert with check (id = auth.uid());

-- Role escalation guard: only an admin may change a role or lift a suspension.
-- Without this, "update own profile" would let any client make themselves admin.
create or replace function public.guard_profile_privileges()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- No JWT on the connection means this is the SQL editor, a migration, or the
  -- service role — all of which are already privileged (service_role bypasses
  -- RLS entirely). An anonymous HTTP request can't reach this trigger at all:
  -- the "update own profile" policy needs id = auth.uid(), which matches no row
  -- when auth.uid() is null. Allowing it here is what makes bootstrapping the
  -- first admin possible without disabling the guard.
  if auth.uid() is null then
    return new;
  end if;

  if public.is_admin() then
    return new;
  end if;
  if new.role is distinct from old.role then
    raise exception 'Only an admin can change a role';
  end if;
  if new.suspended_at is distinct from old.suspended_at then
    raise exception 'Only an admin can change suspension';
  end if;
  return new;
end;
$$;

create trigger profiles_guard_privileges
  before update on public.profiles
  for each row execute function public.guard_profile_privileges();

-- ── New auth user → profile row ──────────────────────────────
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, first_name, last_name, phone)
  values (
    new.id,
    new.email,
    new.raw_user_meta_data ->> 'first_name',
    new.raw_user_meta_data ->> 'last_name',
    new.raw_user_meta_data ->> 'phone'
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
