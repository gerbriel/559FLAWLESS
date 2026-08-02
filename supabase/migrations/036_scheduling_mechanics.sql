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
