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
