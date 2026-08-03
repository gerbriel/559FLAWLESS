-- ============================================================
-- 559 Flawless — 050: a membership is a promise to charge again
--
-- Everything this studio sells today is settled once. A booking takes a
-- deposit, a retail order takes a card, the till takes cash, and each of those
-- ends. `payments` is the record that it happened and nothing in the schema
-- expects to come back for more.
--
-- A membership is the first thing here that does. "$89 a month, one facial
-- included, ten per cent off everything else" is not a purchase, it is a
-- standing arrangement, and the hard part of it is not the discount — the
-- discount is arithmetic. The hard part is that in thirty days the studio has
-- to charge a card it is not holding, and if that charge fails somebody has to
-- know, and until somebody knows the member walks in and is treated as a
-- member. Recurring money fails quietly. That is its whole character.
--
-- So this migration builds the part that can be made true and refuses to
-- pretend about the part that cannot. What it installs:
--
--   memberships             what is sold — price per period, how long a period
--                           is, and what holding one grants
--   membership_services     which treatments an included session may be spent
--                           on (no rows = any treatment)
--   client_memberships      who holds one, since when, until when, in what state
--   membership_redemptions  an included session actually spent, on an
--                           appointment, inside a named period
--   membership_charges      one row per period billed — the invoice log
--
-- What it deliberately does NOT install is a Stripe subscription. There is no
-- subscription created here, no invoice webhook, no dunning, no proration. See
-- "What is not here" at the bottom, which says exactly what a follow-up has to
-- write and exactly which columns are already waiting for it. A membership that
-- the owner renews by hand at the counter is honest. One that silently fails to
-- charge and keeps granting the discount is not, and the difference between
-- those two is entirely in whether the schema forces someone to look.
--
-- ── The period end is the authority, not the status column ──
--
-- `client_memberships.status` can say 'active', 'past_due', 'cancelled' or
-- 'expired', and every one of those is a fact somebody has to write. Nothing in
-- this migration writes 'expired' on a schedule, because there is no scheduler
-- here that could, and a status column that is only correct while a cron job is
-- healthy is a status column that lies the first week it is not.
--
-- So the benefit test never asks the status alone. It asks
--
--     status = 'active' AND now() < current_period_end
--
-- and `public.membership_is_current()` is that sentence, once, in the database.
-- A membership nobody renewed stops granting anything on the day its period
-- runs out, whether or not any job ever ran. The status column narrows that —
-- cancelling stops the benefit immediately — but it can never widen it. That
-- ordering is the safe one: the failure mode of a missed job is a member who
-- has to be told "let me renew that for you", not a year of free facials.
--
-- ── What is snapshotted and what is read live ───────────────
--
-- `client_memberships.price_cents_snapshot` is frozen at enrolment, and a
-- trigger sets it from the plan so the client — or a form, or a stray PATCH —
-- never supplies it. That is rule 2 of AGENTS.md applied to a recurring charge:
-- the request names WHICH plan, never what it costs. Raising the price of the
-- Glow Club does not raise it for the people already in it, for the same reason
-- editing a consent template cannot rewrite `body_snapshot`.
--
-- The BENEFITS are read live from the plan instead. If the owner changes the
-- member discount from ten per cent to fifteen, every member has fifteen from
-- that moment. This asymmetry is deliberate and it is the way round a small
-- studio actually works: what a plan grants is the menu, and the menu changes;
-- what a member pays is a promise, and promises do not. The admin screen says
-- so in those words, because a rule nobody is told about is a trap.
--
-- ── Where the money lands ───────────────────────────────────
--
-- There is no parallel pricing path. `appointments.subtotal_cents` is still the
-- sum of `appointment_services.price_cents` and that trigger is untouched in
-- substance. Two new integer-cent columns sit beside it —
-- `membership_covered_cents` (what an included session paid for) and
-- `membership_discount_cents` (the percentage taken off the rest) — and
-- `total_cents` becomes the one derived number:
--
--     total_cents = greatest(subtotal - covered - discount, 0)
--
-- Both new columns are ordinary integer cents. There is no float anywhere near
-- them: the percentage is computed once, in `src/lib/memberships.ts`, as
-- `floor((cents * pct + 50) / 100)`, which is integer arithmetic that rounds a
-- half-cent up in the client's favour.
--
-- Deriving `total_cents` in a BEFORE trigger rather than leaving it to the line
-- recalculation is the change that makes this safe. `appointment_recalc_totals`
-- fires on `appointment_services` and knows nothing about a discount; setting
-- the discount on the appointment afterwards would have left `total_cents`
-- stale, and a stale total on an appointment is a wrong number on a receipt.
-- One derivation, on the row that owns the columns, firing on every write to
-- it. `appointment_recalc_totals` is reduced to what it is actually the
-- authority on — the subtotal.
--
-- This is a no-op for every appointment that already exists: both new columns
-- default to 0, so the derived total equals the old total exactly. No backfill.
--
-- ── Why the allowance is a trigger and not a counter ────────
--
-- "Two facials a month" could have been a `sessions_used_this_period` integer
-- on the membership, decremented at booking. It is not, because a counter and a
-- list of what it counted drift, and when they drift the counter is the one
-- that is wrong and the one everybody trusts.
--
-- Instead every spent session is a row in `membership_redemptions` carrying the
-- period it was spent in, and the allowance is enforced where the double
-- booking guard is enforced — in the database, on the insert, under a row lock
-- on the membership. Two bookings racing for the last included session both
-- pass whatever the application checked; exactly one row commits and the other
-- gets an exception. The caller treats a refused redemption as "not covered",
-- not as a failed booking: the appointment is already made and the client pays
-- the normal price for that line. Losing a race should cost a discount, never a
-- slot.
--
-- ── Charges are per period, keyed by the period ─────────────
--
-- `membership_charges` has `unique (client_membership_id, period_start)`, and
-- that constraint is the reason this table exists now rather than later. It is
-- precisely the idempotency key a Stripe `invoice.paid` webhook needs: Stripe
-- retries, and a retry has to find the period already settled and stop. Writing
-- it now means the follow-up plugs a webhook into a table that is already the
-- right shape, instead of inventing one under time pressure with a live card on
-- file.
--
-- `payments` is left alone. Its `kind` check does not list 'membership' and
-- `record_payment()` still insists on an appointment or an order, so membership
-- money does not appear in the ledger reports. That is a real gap and it is
-- stated rather than papered over: widening the ledger is a decision about the
-- ledger, and a migration about memberships is not the place to take it.
--
-- ── Re-runnable ─────────────────────────────────────────────
--
-- Every statement is guarded — create if not exists, drop policy/trigger if
-- exists, add column if not exists, constraints dropped before they are added.
-- Running this twice changes nothing the second time. The enum is created
-- inside a DO block that checks for it first, because CREATE TYPE has no
-- IF NOT EXISTS.
--
-- TYPES: src/types/database.ts gains memberships, membership_services,
-- client_memberships, membership_redemptions and membership_charges, plus the
-- three new columns on Appointment. Done in the same change as this file.
-- ============================================================

-- ── The state a membership can be in ─────────────────────────
do $$
begin
  if not exists (select 1 from pg_type where typname = 'membership_status') then
    create type public.membership_status as enum
      ('active', 'past_due', 'cancelled', 'expired');
  end if;
end $$;

comment on type public.membership_status is
  'active = current and granting benefits (subject to current_period_end). '
  'past_due = a charge failed; written by whoever discovers it, not by a job. '
  'cancelled = ended by the studio or the member. expired = a period ran out '
  'and nobody renewed. Nothing sets expired automatically — the benefit test '
  'reads current_period_end, so an unrenewed membership stops granting on time '
  'whether or not the label was ever corrected.';

-- ── What is sold ─────────────────────────────────────────────
create table if not exists public.memberships (
  id            bigserial primary key,
  name          text not null,
  slug          text not null unique,
  description   text,

  /**
   * What a member pays each period, in integer cents. Never read from a
   * request: client_memberships snapshots this at enrolment by trigger.
   */
  price_cents   int not null default 0,
  /**
   * How long a period is. Months rather than days so a renewal lands on the
   * same date each time — `+ interval '1 month'` is calendar arithmetic and
   * knows what the 31st of January means; 30 days does not.
   */
  period_months int not null default 1,

  /**
   * The two benefits, either or both. A percentage off everything on the
   * visit that an included session did not already cover, and some number of
   * treatments included in the price of the membership itself.
   */
  service_discount_pct        int not null default 0,
  included_sessions_per_period int not null default 0,

  /** Where the Stripe Price for this plan will go. Unused until a follow-up
   *  builds the subscription; see the header. */
  stripe_price_id text,

  is_active   boolean not null default true,
  sort_order  int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.memberships is
  'A membership plan: what it costs per period, how long a period is, and what '
  'holding it grants. The benefits here are read live — changing them changes '
  'them for existing members. The price is not: client_memberships snapshots it.';

alter table public.memberships drop constraint if exists memberships_name_not_blank;
alter table public.memberships
  add constraint memberships_name_not_blank
  check (length(btrim(name)) between 1 and 120);

alter table public.memberships drop constraint if exists memberships_price_non_negative;
alter table public.memberships
  add constraint memberships_price_non_negative check (price_cents >= 0);

alter table public.memberships drop constraint if exists memberships_period_sane;
alter table public.memberships
  add constraint memberships_period_sane check (period_months between 1 and 24);

-- 100% off every service is not a membership, it is a gift, and it is far more
-- likely to be a typo for 10.
alter table public.memberships drop constraint if exists memberships_discount_is_a_percentage;
alter table public.memberships
  add constraint memberships_discount_is_a_percentage
  check (service_discount_pct between 0 and 90);

alter table public.memberships drop constraint if exists memberships_sessions_non_negative;
alter table public.memberships
  add constraint memberships_sessions_non_negative
  check (included_sessions_per_period between 0 and 31);

-- A plan that grants nothing is a subscription to nothing. Refuse it here
-- rather than let someone sell it and find out.
alter table public.memberships drop constraint if exists memberships_grant_something;
alter table public.memberships
  add constraint memberships_grant_something
  check (service_discount_pct > 0 or included_sessions_per_period > 0);

create index if not exists memberships_active_idx
  on public.memberships (sort_order, id) where is_active;

-- ── Which treatments an included session may be spent on ─────
create table if not exists public.membership_services (
  membership_id bigint not null references public.memberships(id) on delete cascade,
  service_id    bigint not null references public.services(id) on delete cascade,
  primary key (membership_id, service_id)
);

comment on table public.membership_services is
  'The treatments an included session may be redeemed against. NO ROWS FOR A '
  'PLAN MEANS ANY TREATMENT — an empty list is "unrestricted", not "nothing", '
  'because a plan with sessions and no list is far more likely to be one the '
  'owner has not narrowed yet than one that grants sessions usable nowhere. '
  'The percentage discount is not scoped by this table: it applies to the whole '
  'visit.';

create index if not exists membership_services_service_idx
  on public.membership_services (service_id);

-- ── Who holds one ────────────────────────────────────────────
create table if not exists public.client_memberships (
  id            bigserial primary key,
  client_id     uuid   not null references public.profiles(id) on delete cascade,
  membership_id bigint not null references public.memberships(id) on delete restrict,

  status public.membership_status not null default 'active',

  /**
   * What THIS member pays, frozen at enrolment. Set by trigger from the plan —
   * whatever the insert supplied is discarded. See the header.
   */
  price_cents_snapshot int not null default 0,

  started_at            timestamptz not null default now(),
  current_period_start  timestamptz not null default now(),
  /** Filled by trigger from the plan's period_months when not supplied. The
   *  benefit test reads this, not the status column. */
  current_period_end    timestamptz not null default now(),

  /** Set when the member has asked to stop but has paid for the period they
   *  are in. `renew_membership` reads it and ends the membership instead of
   *  rolling it forward. */
  cancel_at_period_end boolean not null default false,
  cancelled_at timestamptz,
  ended_at     timestamptz,

  /** Where the Stripe subscription lands when a follow-up builds one. Unique
   *  so a webhook can find the membership from the event and never match two. */
  stripe_subscription_id text unique,
  stripe_customer_id     text,

  note       text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.client_memberships is
  'One person holding one membership. Benefits are granted only while '
  'public.membership_is_current() is true — status active AND the period has '
  'not run out. Nothing renews this automatically; see migration 050''s header.';

alter table public.client_memberships drop constraint if exists client_memberships_period_valid;
alter table public.client_memberships
  add constraint client_memberships_period_valid
  check (current_period_end > current_period_start);

alter table public.client_memberships drop constraint if exists client_memberships_price_non_negative;
alter table public.client_memberships
  add constraint client_memberships_price_non_negative
  check (price_cents_snapshot >= 0);

-- One live membership per person. A second plan on top of the first would make
-- "which discount applies" a question with two answers, and every screen that
-- asked would be entitled to a different one. Partial, so the history of every
-- membership somebody has held and ended stays on the record.
create unique index if not exists client_memberships_one_live_idx
  on public.client_memberships (client_id)
  where status in ('active', 'past_due');

create index if not exists client_memberships_client_idx
  on public.client_memberships (client_id, started_at desc);
create index if not exists client_memberships_renewal_idx
  on public.client_memberships (current_period_end)
  where status in ('active', 'past_due');

-- ── An included session, actually spent ──────────────────────
create table if not exists public.membership_redemptions (
  id                   bigserial primary key,
  client_membership_id bigint not null
                         references public.client_memberships(id) on delete cascade,
  appointment_id       uuid not null references public.appointments(id) on delete cascade,
  service_id           bigint references public.services(id) on delete set null,

  /**
   * The period this was spent in, copied from the membership at redemption.
   * The allowance is counted against this rather than against a date range, so
   * moving a period boundary later can never retroactively overspend one.
   */
  redeemed_for_period_start timestamptz not null,
  /** How many of the allowance this consumed. One, unless a future treatment
   *  is worth two. */
  sessions    int not null default 1,
  /** What the covered line was worth at list price, in integer cents. This is
   *  what the studio gave away, and it is the number a report wants. */
  value_cents int not null default 0,
  created_at  timestamptz not null default now(),

  -- Idempotency: running the benefit twice over one appointment cannot spend
  -- the session twice.
  unique (client_membership_id, appointment_id, service_id)
);

alter table public.membership_redemptions drop constraint if exists membership_redemptions_sessions_positive;
alter table public.membership_redemptions
  add constraint membership_redemptions_sessions_positive
  check (sessions between 1 and 10);

alter table public.membership_redemptions drop constraint if exists membership_redemptions_value_non_negative;
alter table public.membership_redemptions
  add constraint membership_redemptions_value_non_negative
  check (value_cents >= 0);

create index if not exists membership_redemptions_period_idx
  on public.membership_redemptions (client_membership_id, redeemed_for_period_start);
create index if not exists membership_redemptions_appointment_idx
  on public.membership_redemptions (appointment_id);

-- ── One row per period billed ────────────────────────────────
create table if not exists public.membership_charges (
  id                   bigserial primary key,
  client_membership_id bigint not null
                         references public.client_memberships(id) on delete cascade,
  period_start timestamptz not null,
  period_end   timestamptz not null,
  amount_cents int not null default 0,

  status text not null default 'due',
  method text not null default 'other',
  paid_at timestamptz,

  stripe_invoice_id        text unique,
  stripe_payment_intent_id text,

  recorded_by uuid references public.profiles(id) on delete set null,
  note        text,
  created_at  timestamptz not null default now(),

  -- The idempotency key. A retried webhook, a double-clicked button and a
  -- second run of a renewal all find the period already billed.
  unique (client_membership_id, period_start)
);

comment on table public.membership_charges is
  'The invoice log: one row per membership period, whether or not the money '
  'has arrived. A period with a `due` row and a past end date is a member who '
  'has not paid — which is the whole point of writing the row before the money '
  'rather than after it.';

alter table public.membership_charges drop constraint if exists membership_charges_status_known;
alter table public.membership_charges
  add constraint membership_charges_status_known
  check (status in ('due', 'paid', 'failed', 'refunded', 'void'));

alter table public.membership_charges drop constraint if exists membership_charges_method_known;
alter table public.membership_charges
  add constraint membership_charges_method_known
  check (method in ('card', 'cash', 'stripe', 'other'));

alter table public.membership_charges drop constraint if exists membership_charges_amount_non_negative;
alter table public.membership_charges
  add constraint membership_charges_amount_non_negative
  check (amount_cents >= 0);

alter table public.membership_charges drop constraint if exists membership_charges_period_valid;
alter table public.membership_charges
  add constraint membership_charges_period_valid
  check (period_end > period_start);

create index if not exists membership_charges_outstanding_idx
  on public.membership_charges (period_end) where status = 'due';
create index if not exists membership_charges_membership_idx
  on public.membership_charges (client_membership_id, period_start desc);

-- ── Is this membership granting anything right now? ──────────
-- One sentence, in one place. Every benefit decision in the app and every
-- policy below reads it, so "current" cannot come to mean two things.
-- STABLE, not IMMUTABLE: it reads the clock. Marking a function that calls
-- now() immutable is how a plan gets cached against a timestamp from an hour
-- ago, and this is the one function in the schema that must never be wrong
-- about what time it is.
create or replace function public.membership_is_current(
  p_status public.membership_status,
  p_period_end timestamptz
) returns boolean language sql stable as $$
  select p_status = 'active' and p_period_end > now();
$$;

comment on function public.membership_is_current(public.membership_status, timestamptz) is
  'The benefit test. Status narrows it; the period end is what actually expires '
  'it, so a membership nobody renewed stops granting on the day it runs out '
  'even if no scheduled job ever corrects the label.';

-- ── Enrolment fills in what the client must not supply ───────
create or replace function public.client_membership_on_enrol()
returns trigger language plpgsql security definer set search_path = public as $$
declare plan record;
begin
  select price_cents, period_months, is_active
    into plan
  from public.memberships where id = new.membership_id;

  if not found then
    raise exception 'That membership plan does not exist';
  end if;
  if not plan.is_active then
    raise exception 'That membership plan is retired — reactivate it before enrolling anyone';
  end if;

  -- Rule 2 of AGENTS.md, applied to a recurring charge: the request names WHICH
  -- plan and never what it costs. Whatever came in is discarded.
  new.price_cents_snapshot := plan.price_cents;

  if new.current_period_start is null then
    new.current_period_start := now();
  end if;
  -- A caller may set the period end deliberately (an import, a comped month).
  -- Only derive it when it was left at or before the start, which is the
  -- default column value and never a period anyone meant.
  if new.current_period_end is null
     or new.current_period_end <= new.current_period_start then
    new.current_period_end :=
      new.current_period_start + make_interval(months => plan.period_months);
  end if;

  return new;
end;
$$;

drop trigger if exists client_memberships_on_enrol on public.client_memberships;
create trigger client_memberships_on_enrol
  before insert on public.client_memberships
  for each row execute function public.client_membership_on_enrol();

-- The first period is billed the moment somebody is enrolled, as `due`. The
-- studio marks it paid when the money arrives. Writing it after the fact would
-- mean the only record of an unpaid first month is that nothing exists.
create or replace function public.client_membership_first_charge()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.membership_charges
    (client_membership_id, period_start, period_end, amount_cents, status)
  values
    (new.id, new.current_period_start, new.current_period_end,
     new.price_cents_snapshot, 'due')
  on conflict (client_membership_id, period_start) do nothing;
  return null;
end;
$$;

drop trigger if exists client_memberships_first_charge on public.client_memberships;
create trigger client_memberships_first_charge
  after insert on public.client_memberships
  for each row execute function public.client_membership_first_charge();

drop trigger if exists memberships_touch on public.memberships;
create trigger memberships_touch before update on public.memberships
  for each row execute function public.touch_updated_at();

drop trigger if exists client_memberships_touch on public.client_memberships;
create trigger client_memberships_touch before update on public.client_memberships
  for each row execute function public.touch_updated_at();

-- ── The allowance is enforced on the insert ──────────────────
create or replace function public.membership_redemption_within_allowance()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  allowance int;
  spent     int;
  live      boolean;
begin
  -- FOR UPDATE on the membership row is what serialises two bookings racing
  -- for the last included session. Without it both count the same "used" and
  -- both commit, which is exactly the failure the appointments exclusion
  -- constraint exists to prevent one table over.
  select public.membership_is_current(cm.status, cm.current_period_end),
         m.included_sessions_per_period
    into live, allowance
  from public.client_memberships cm
  join public.memberships m on m.id = cm.membership_id
  where cm.id = new.client_membership_id
  for update of cm;

  if allowance is null then
    raise exception 'That membership does not exist' using errcode = '23503';
  end if;
  if not live then
    raise exception 'That membership is not current — no session to spend'
      using errcode = '23514';
  end if;

  select coalesce(sum(sessions), 0) into spent
  from public.membership_redemptions
  where client_membership_id = new.client_membership_id
    and redeemed_for_period_start = new.redeemed_for_period_start;

  if spent + new.sessions > allowance then
    raise exception
      'That membership has % included session(s) this period and % already spent',
      allowance, spent
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists membership_redemptions_allowance on public.membership_redemptions;
create trigger membership_redemptions_allowance
  before insert on public.membership_redemptions
  for each row execute function public.membership_redemption_within_allowance();

-- ── Where the benefit lands on an appointment ────────────────
alter table public.appointments
  add column if not exists client_membership_id bigint
    references public.client_memberships(id) on delete set null;
alter table public.appointments
  add column if not exists membership_covered_cents int not null default 0;
alter table public.appointments
  add column if not exists membership_discount_cents int not null default 0;

comment on column public.appointments.membership_covered_cents is
  'List value of the lines paid for by an included session, in integer cents. '
  'Recorded separately from the percentage discount because the two are '
  'different giveaways: this one was prepaid by the membership fee.';
comment on column public.appointments.membership_discount_cents is
  'The member percentage taken off whatever an included session did not cover, '
  'in integer cents. Computed once in src/lib/memberships.ts as '
  'floor((cents * pct + 50) / 100) — integer arithmetic, no float.';

alter table public.appointments drop constraint if exists appointments_membership_amounts_non_negative;
alter table public.appointments
  add constraint appointments_membership_amounts_non_negative
  check (membership_covered_cents >= 0 and membership_discount_cents >= 0);

create index if not exists appointments_membership_idx
  on public.appointments (client_membership_id)
  where client_membership_id is not null;

-- `appointment_recalc_totals` (004) set subtotal AND total from the lines. It
-- is the authority on the subtotal and it always was; it is not the authority
-- on the total any more, because the total now depends on two columns that
-- live on the appointment and that this trigger cannot see. Reduced to what it
-- knows. The derivation below runs on the very UPDATE this issues.
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
  set subtotal_cents = sum_cents
  where id = target;

  return null;
end;
$$;

-- One derivation of total_cents, on the row that owns every input to it, firing
-- on every write to that row. Nothing in the application writes total_cents
-- directly — it is read in a dozen places and set in none — so making it a
-- derived column here takes nothing away.
--
-- greatest(..., 0) because a discount can never turn into money owed to the
-- client. If the numbers ever say otherwise the answer is zero, not negative.
create or replace function public.appointment_derive_total()
returns trigger language plpgsql set search_path = public as $$
begin
  new.total_cents := greatest(
    new.subtotal_cents - new.membership_covered_cents - new.membership_discount_cents,
    0
  );
  return new;
end;
$$;

drop trigger if exists appointments_derive_total on public.appointments;
create trigger appointments_derive_total
  before insert or update on public.appointments
  for each row execute function public.appointment_derive_total();

-- ── Recording that a period was paid for ─────────────────────
create or replace function public.mark_membership_charge_paid(
  p_charge bigint,
  p_method text default 'other',
  p_note   text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  target record;
begin
  -- auth.uid() is null for the service role, the SQL editor and a scheduled
  -- job — all already privileged, the same path 045 documents.
  if auth.uid() is not null and not public.is_manager() then
    raise exception 'Only a manager can record a membership payment';
  end if;

  select c.*, cm.current_period_start
    into target
  from public.membership_charges c
  join public.client_memberships cm on cm.id = c.client_membership_id
  where c.id = p_charge
  for update of c;

  if not found then
    raise exception 'No such membership charge';
  end if;

  -- Idempotent: a second press of the button, or a retried webhook, finds it
  -- settled and changes nothing.
  if target.status = 'paid' then
    return target.id;
  end if;

  update public.membership_charges
  set status = 'paid',
      method = p_method,
      paid_at = now(),
      recorded_by = auth.uid(),
      note = coalesce(p_note, note)
  where id = p_charge;

  -- Paying the charge for the period the member is actually in is what clears
  -- past_due. Settling an old period does not, because it says nothing about
  -- the one that failed.
  if target.period_start = target.current_period_start then
    update public.client_memberships
    set status = 'active'
    where id = target.client_membership_id and status = 'past_due';
  end if;

  return target.id;
end;
$$;

comment on function public.mark_membership_charge_paid(bigint, text, text) is
  'Settle one membership period. Idempotent — this is the function a Stripe '
  'invoice.paid webhook should call when one is built, and Stripe retries.';

-- ── Rolling a membership into its next period ────────────────
create or replace function public.renew_membership(p_client_membership bigint)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  cm     record;
  months int;
  price  int;
  new_start timestamptz;
  new_end   timestamptz;
begin
  if auth.uid() is not null and not public.is_manager() then
    raise exception 'Only a manager can renew a membership';
  end if;

  select cm2.*, m.period_months
    into cm
  from public.client_memberships cm2
  join public.memberships m on m.id = cm2.membership_id
  where cm2.id = p_client_membership
  for update of cm2;

  if not found then
    raise exception 'No such membership';
  end if;
  -- 'expired' is renewable: it means a period ran out, which is precisely the
  -- thing a renewal fixes. 'cancelled' is not — somebody decided, and undoing
  -- a decision is an enrolment, not a renewal.
  if cm.status = 'cancelled' then
    raise exception 'That membership was cancelled — enrol them again rather than renewing it';
  end if;

  -- Somebody who asked to stop has paid for the period they are in and gets it.
  -- Renewal is where that request is honoured, because renewal is the only
  -- moment the studio would otherwise charge them again.
  if cm.cancel_at_period_end then
    update public.client_memberships
    set status = 'cancelled',
        ended_at = cm.current_period_end,
        cancelled_at = coalesce(cm.cancelled_at, now())
    where id = p_client_membership;
    return cm.current_period_end;
  end if;

  months := cm.period_months;
  price  := cm.price_cents_snapshot;

  -- A renewal taken BEFORE the period runs out continues from where it ends,
  -- so paying early never shortens what was already paid for. A renewal taken
  -- after it has run out starts today instead of back-dating to a period end
  -- that may be months gone — otherwise renewing a long-lapsed membership would
  -- hand out a period that was already over, which reads as "renewed" on every
  -- screen and grants nothing. The studio loses the days it lapsed for. That is
  -- the right way round: the member did not have the benefit during them.
  new_start := case
                 when cm.current_period_end > now() then cm.current_period_end
                 else now()
               end;
  new_end   := new_start + make_interval(months => months);

  update public.client_memberships
  set current_period_start = new_start,
      current_period_end   = new_end,
      status = case when status = 'expired' then 'active' else status end
  where id = p_client_membership;

  insert into public.membership_charges
    (client_membership_id, period_start, period_end, amount_cents, status)
  values
    (p_client_membership, new_start, new_end, price, 'due')
  on conflict (client_membership_id, period_start) do nothing;

  return new_end;
end;
$$;

comment on function public.renew_membership(bigint) is
  'Advance a membership one period and raise the charge for it, as `due`. Does '
  'not take money — nothing in this schema can. Honours cancel_at_period_end by '
  'ending the membership instead of rolling it forward.';

-- ── RLS ──────────────────────────────────────────────────────
alter table public.memberships            enable row level security;
alter table public.membership_services    enable row level security;
alter table public.client_memberships     enable row level security;
alter table public.membership_redemptions enable row level security;
alter table public.membership_charges     enable row level security;

-- A plan is a price list. Staff see every plan including retired ones; a
-- signed-in client sees the live ones, because a member has to be able to read
-- what they are paying for. `anon` sees nothing: there is no public membership
-- page yet, and when one is built THIS is the policy that has to be widened
-- deliberately rather than a gap somebody discovers.
drop policy if exists "memberships_select" on public.memberships;
create policy "memberships_select" on public.memberships
  for select to authenticated
  using (public.is_staff() or is_active);

drop policy if exists "memberships_write" on public.memberships;
create policy "memberships_write" on public.memberships
  for all to authenticated
  using (public.is_manager())
  with check (public.is_manager());

drop policy if exists "membership_services_select" on public.membership_services;
create policy "membership_services_select" on public.membership_services
  for select to authenticated
  using (
    public.is_staff()
    or exists (
      select 1 from public.memberships m
      where m.id = membership_id and m.is_active
    )
  );

drop policy if exists "membership_services_write" on public.membership_services;
create policy "membership_services_write" on public.membership_services
  for all to authenticated
  using (public.is_manager())
  with check (public.is_manager());

-- A client reads their own membership and edits nothing about it. There is no
-- client INSERT, UPDATE or DELETE policy on this table at all — self-enrolment
-- would mean choosing your own price, and self-update would mean choosing your
-- own period end, which is the same thing one step removed.
drop policy if exists "client_memberships_select" on public.client_memberships;
create policy "client_memberships_select" on public.client_memberships
  for select to authenticated
  using (public.is_staff() or client_id = auth.uid());

drop policy if exists "client_memberships_write" on public.client_memberships;
create policy "client_memberships_write" on public.client_memberships
  for all to authenticated
  using (public.is_manager())
  with check (public.is_manager());

drop policy if exists "membership_redemptions_select" on public.membership_redemptions;
create policy "membership_redemptions_select" on public.membership_redemptions
  for select to authenticated
  using (
    public.is_staff()
    or exists (
      select 1 from public.client_memberships cm
      where cm.id = client_membership_id and cm.client_id = auth.uid()
    )
  );

drop policy if exists "membership_redemptions_write" on public.membership_redemptions;
create policy "membership_redemptions_write" on public.membership_redemptions
  for all to authenticated
  using (public.is_manager())
  with check (public.is_manager());

drop policy if exists "membership_charges_select" on public.membership_charges;
create policy "membership_charges_select" on public.membership_charges
  for select to authenticated
  using (
    public.is_staff()
    or exists (
      select 1 from public.client_memberships cm
      where cm.id = client_membership_id and cm.client_id = auth.uid()
    )
  );

drop policy if exists "membership_charges_write" on public.membership_charges;
create policy "membership_charges_write" on public.membership_charges
  for all to authenticated
  using (public.is_manager())
  with check (public.is_manager());

grant select, insert, update, delete on public.memberships            to authenticated;
grant select, insert, update, delete on public.membership_services    to authenticated;
grant select, insert, update, delete on public.client_memberships     to authenticated;
grant select, insert, update, delete on public.membership_redemptions to authenticated;
grant select, insert, update, delete on public.membership_charges     to authenticated;

grant usage, select on sequence public.memberships_id_seq            to authenticated;
grant usage, select on sequence public.client_memberships_id_seq     to authenticated;
grant usage, select on sequence public.membership_redemptions_id_seq to authenticated;
grant usage, select on sequence public.membership_charges_id_seq     to authenticated;

grant execute on function public.membership_is_current(public.membership_status, timestamptz)
  to authenticated;
grant execute on function public.mark_membership_charge_paid(bigint, text, text)
  to authenticated, service_role;
grant execute on function public.renew_membership(bigint)
  to authenticated, service_role;

-- ============================================================
-- What is not here, and what a follow-up has to write
--
-- 1. THE SUBSCRIPTION ITSELF. Nothing creates a Stripe subscription, so no card
--    is charged a second time by anything. `memberships.stripe_price_id`,
--    `client_memberships.stripe_subscription_id` and `.stripe_customer_id` are
--    empty columns waiting for it. A follow-up needs: a Checkout session in
--    `mode: 'subscription'`; the customer id stored on first enrolment so a
--    second plan does not mint a second customer; and the subscription id
--    written back from the session, not from the browser.
--
-- 2. THE WEBHOOK. src/app/api/stripe/webhook/route.ts handles
--    checkout.session.completed, .expired and charge.refunded. It needs four
--    more, and all four already have somewhere to land:
--      invoice.paid                  → mark_membership_charge_paid(), which is
--                                      idempotent because Stripe retries
--      invoice.payment_failed        → status = 'past_due', charge = 'failed'
--      customer.subscription.updated → current_period_start/end from the event,
--                                      NOT from renew_membership() — Stripe's
--                                      period is the real one once it owns the
--                                      billing
--      customer.subscription.deleted → status = 'cancelled', ended_at
--    The unique key (client_membership_id, period_start) is what makes the
--    first of those safe to retry, and it is already on the table.
--
-- 3. DUNNING. Nothing tells anybody a card failed. `past_due` is a state this
--    schema can hold and nothing sets it. Until a webhook does, the honest
--    reading of an unpaid membership is a `due` charge whose period_end has
--    passed, which `membership_charges_outstanding_idx` exists to find.
--
-- 4. PRORATION. Changing plan mid-period, or cancelling with a refund, is not
--    modelled at all. Cancelling immediately stops the benefit and refunds
--    nothing; cancel_at_period_end lets the period run out. Those are the only
--    two endings this schema knows, and both are ones a person chose.
--
-- 5. THE LEDGER. `payments` does not know about memberships, so membership
--    revenue is absent from every money report. Adding it means widening the
--    `payments_kind_check` constraint AND `record_payment()`'s "an appointment
--    or an order" rule together — one without the other leaves a function that
--    cannot write the kind its table now accepts.
-- ============================================================
