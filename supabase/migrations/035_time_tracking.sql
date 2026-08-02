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
