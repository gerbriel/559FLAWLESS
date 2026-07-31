-- ============================================================
-- 559 Flawless — 004: appointments
--
-- The double-booking guard lives here and nowhere else. Application code
-- checks availability to render a nice UI; the GiST exclusion constraint is
-- what actually makes it true. Two clients who pass every check and race into
-- the same slot both reach the insert — exactly one commits, the other gets
-- SQLSTATE 23P01 and the edge function turns that into a 409.
-- ============================================================

create type public.appointment_status as enum (
  'pending',      -- awaiting staff confirmation (auto_confirm = false)
  'confirmed',
  'checked_in',
  'completed',
  'cancelled',
  'no_show'
);

create type public.deposit_status as enum (
  'none', 'pending', 'paid', 'forfeited', 'refunded'
);

create type public.booking_source as enum ('online', 'staff', 'walk_in', 'phone');

create table public.appointments (
  id           uuid primary key default gen_random_uuid(),
  provider_id  uuid not null references public.profiles(id) on delete restrict,
  room_id      bigint references public.rooms(id) on delete set null,

  -- Null for a guest booking that never matched an account. The
  -- `appointment_match_client` trigger backfills it when an email/phone
  -- matches an existing profile, which is what keeps the CRM whole.
  client_id    uuid references public.profiles(id) on delete set null,
  guest_first_name text,
  guest_last_name  text,
  guest_email      text,
  guest_phone      text,

  starts_at    timestamptz not null,
  ends_at      timestamptz not null,
  -- Turnover padding. Blocks the calendar past ends_at; never shown to clients.
  buffer_minutes int not null default 0 check (buffer_minutes >= 0),
  -- [starts_at, ends_at + buffer). Maintained by a trigger, not a generated
  -- column: `timestamptz + interval` is STABLE, not IMMUTABLE, so Postgres
  -- rejects it in a GENERATED expression.
  slot         tstzrange not null,

  status       public.appointment_status not null default 'confirmed',
  source       public.booking_source not null default 'online',

  -- Denormalized totals, recomputed from appointment_services by trigger.
  subtotal_cents int not null default 0,
  total_cents    int not null default 0,

  deposit_cents      int not null default 0 check (deposit_cents >= 0),
  deposit_status     public.deposit_status not null default 'none',
  stripe_payment_intent_id text,
  stripe_session_id        text,

  client_notes text,   -- what the client typed when booking
  staff_notes  text,   -- internal; never returned to a client
  cancellation_reason text,
  cancelled_at timestamptz,
  cancelled_by uuid references public.profiles(id) on delete set null,
  checked_in_at timestamptz,
  completed_at  timestamptz,

  -- 18+ attestation captured at booking for intimate services.
  age_attested_at timestamptz,
  -- Set once every required consent form for this appointment is signed.
  consent_complete_at timestamptz,

  google_event_id text,
  reminder_sent_at timestamptz,

  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint appointment_window_valid check (ends_at > starts_at),
  -- A booking must identify the client somehow.
  constraint appointment_has_contact check (
    client_id is not null or guest_email is not null or guest_phone is not null
  )
);

-- ── The double-booking guard ─────────────────────────────────
-- A cancelled appointment releases its slot; everything else holds it,
-- including no_show (that time was genuinely consumed).
alter table public.appointments
  add constraint appointments_no_overlap
  exclude using gist (provider_id with =, slot with &&)
  where (status <> 'cancelled');

-- Same guarantee for rooms, when a room is assigned.
alter table public.appointments
  add constraint appointments_room_no_overlap
  exclude using gist (room_id with =, slot with &&)
  where (status <> 'cancelled' and room_id is not null);

create index appointments_provider_start_idx on public.appointments (provider_id, starts_at desc);
create index appointments_client_idx         on public.appointments (client_id, starts_at desc);
create index appointments_status_idx         on public.appointments (status, starts_at);
create index appointments_guest_email_idx    on public.appointments (lower(guest_email));
create index appointments_upcoming_idx       on public.appointments (starts_at)
  where status in ('pending', 'confirmed');

-- ── Line items ───────────────────────────────────────────────
create table public.appointment_services (
  id             bigserial primary key,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  service_id     bigint references public.services(id) on delete set null,
  addon_id       bigint references public.service_addons(id) on delete set null,
  -- Frozen at booking time so a later price change never rewrites history.
  name_snapshot  text not null,
  price_cents    int not null check (price_cents >= 0),
  duration_minutes int not null default 0,
  sort_order     int not null default 0,
  constraint line_is_service_or_addon check (
    (service_id is not null and addon_id is null) or
    (service_id is null and addon_id is not null)
  )
);

create index appointment_services_appt_idx on public.appointment_services (appointment_id);

-- Immutable audit trail of status changes — who moved this booking and when.
create table public.appointment_events (
  id             bigserial primary key,
  appointment_id uuid not null references public.appointments(id) on delete cascade,
  event          text not null,
  from_status    public.appointment_status,
  to_status      public.appointment_status,
  actor_id       uuid references public.profiles(id) on delete set null,
  detail         text,
  created_at     timestamptz not null default now()
);

create index appointment_events_appt_idx on public.appointment_events (appointment_id, created_at desc);

-- ── Triggers ─────────────────────────────────────────────────

-- Keep `slot` in sync with the window + buffer on every write.
create or replace function public.appointment_set_slot()
returns trigger language plpgsql as $$
begin
  new.slot := tstzrange(
    new.starts_at,
    new.ends_at + make_interval(mins => new.buffer_minutes),
    '[)'
  );
  return new;
end;
$$;

create trigger appointments_set_slot
  before insert or update of starts_at, ends_at, buffer_minutes
  on public.appointments
  for each row execute function public.appointment_set_slot();

create trigger appointments_touch before update on public.appointments
  for each row execute function public.touch_updated_at();

-- Attach a guest booking to an existing client profile: email first, then
-- phone. Runs SECURITY DEFINER so an anonymous booking can still resolve to a
-- client record without the app holding a service-role key.
create or replace function public.appointment_match_client()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  matched uuid;
begin
  if new.client_id is not null then
    return new;
  end if;

  if new.guest_email is not null then
    select id into matched from public.profiles
    where lower(email) = lower(new.guest_email) and role = 'client'
    limit 1;
  end if;

  if matched is null and new.guest_phone is not null then
    select id into matched from public.profiles
    where regexp_replace(coalesce(phone, ''), '\D', '', 'g')
        = regexp_replace(new.guest_phone, '\D', '', 'g')
      and length(regexp_replace(new.guest_phone, '\D', '', 'g')) >= 10
      and role = 'client'
    limit 1;
  end if;

  new.client_id := matched;
  return new;
end;
$$;

create trigger appointments_match_client
  before insert on public.appointments
  for each row execute function public.appointment_match_client();

-- Recompute totals whenever line items change.
--
-- NB: pick the row by TG_OP, not `coalesce(new.x, old.x)`. In PL/pgSQL NEW is
-- *unassigned* during DELETE (and OLD during INSERT) — referencing a field of
-- an unassigned record raises "record is not assigned yet" rather than
-- returning NULL, so the coalesce shorthand fails on the very case it looks
-- like it handles.
create or replace function public.appointment_recalc_totals()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target uuid;
  sum_cents int;
begin
  if tg_op = 'DELETE' then
    target := old.appointment_id;
  else
    target := new.appointment_id;
  end if;

  select coalesce(sum(price_cents), 0) into sum_cents
  from public.appointment_services where appointment_id = target;

  update public.appointments
  set subtotal_cents = sum_cents,
      total_cents    = sum_cents
  where id = target;

  return null;
end;
$$;

create trigger appointment_services_recalc
  after insert or update or delete on public.appointment_services
  for each row execute function public.appointment_recalc_totals();

-- Record every status transition.
create or replace function public.appointment_log_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    insert into public.appointment_events (appointment_id, event, to_status, actor_id)
    values (new.id, 'created', new.status, auth.uid());
  elsif new.status is distinct from old.status then
    insert into public.appointment_events
      (appointment_id, event, from_status, to_status, actor_id, detail)
    values (new.id, 'status_changed', old.status, new.status, auth.uid(),
            new.cancellation_reason);
  end if;
  return null;
end;
$$;

create trigger appointments_log_status
  after insert or update on public.appointments
  for each row execute function public.appointment_log_status();

-- ── RLS ──────────────────────────────────────────────────────
alter table public.appointments         enable row level security;
alter table public.appointment_services enable row level security;
alter table public.appointment_events   enable row level security;

-- Clients see only their own bookings. Providers see their own calendar.
-- Front desk and up see everything.
create policy "client reads own appointments" on public.appointments
  for select using (client_id = auth.uid());
create policy "provider reads own appointments" on public.appointments
  for select using (provider_id = auth.uid());
create policy "front desk reads all appointments" on public.appointments
  for select using (public.is_front_desk());

-- Clients may cancel (and only cancel) their own upcoming booking. Everything
-- else — rescheduling, status changes, price edits — goes through staff or the
-- booking edge function, so the availability rules can't be bypassed.
create policy "client cancels own appointment" on public.appointments
  for update using (client_id = auth.uid())
  with check (client_id = auth.uid() and status = 'cancelled');

create policy "provider updates own appointments" on public.appointments
  for update using (provider_id = auth.uid()) with check (provider_id = auth.uid());
create policy "front desk updates appointments" on public.appointments
  for update using (public.is_front_desk()) with check (public.is_front_desk());
create policy "front desk creates appointments" on public.appointments
  for insert with check (public.is_front_desk() or provider_id = auth.uid());
create policy "admin deletes appointments" on public.appointments
  for delete using (public.is_admin());

-- NOTE: there is deliberately no anon INSERT policy. Public bookings go
-- through the `booking-create` edge function, which re-derives the slot
-- server-side. An open insert policy here would let anyone POST an arbitrary
-- time straight past the availability rules.

create policy "read own appointment lines" on public.appointment_services
  for select using (
    exists (
      select 1 from public.appointments a
      where a.id = appointment_id
        and (a.client_id = auth.uid() or a.provider_id = auth.uid() or public.is_front_desk())
    )
  );
create policy "staff writes appointment lines" on public.appointment_services
  for all using (public.is_front_desk()) with check (public.is_front_desk());

create policy "staff reads appointment events" on public.appointment_events
  for select using (public.is_front_desk() or exists (
    select 1 from public.appointments a
    where a.id = appointment_id and a.provider_id = auth.uid()
  ));
