-- ============================================================
-- 559 Flawless — 089: a visit written in by hand
--
-- Some members joined before the system did. They paid cash at the counter,
-- had a facial on a Tuesday the database never heard of, and took their free
-- cleanser home in a paper bag. Every count this schema keeps is built from
-- rows (050's "a counter and a list of what it counted drift"), so a visit
-- with no row is a visit the member gets twice: the panel says one facial
-- left when there is none.
--
-- The fix is to let staff write the row. Three things a manager can now do
-- from the dashboard, each one function, each one checked here rather than in
-- the browser:
--
--   enrol_membership()            enrol with the REAL start date, and mark
--                                 the first period paid in the same step
--                                 (cash, card, stripe or other). The 050
--                                 triggers still derive the period end and
--                                 the price snapshot and write the charge;
--                                 this only settles it.
--   record_membership_session()   spend an included session that happened
--                                 outside the system, on a named day inside
--                                 the current period. The 088 allowance
--                                 trigger is still the authority on whether
--                                 one is left; its refusal comes back as is.
--   record_membership_perk_use()  the same for a product perk with a limit,
--                                 under the same advisory lock 087's
--                                 claim_perk_use() takes, so a hand entry and
--                                 a till sale racing for the last use cannot
--                                 both win it.
--
-- What changes in the tables to make room:
--
--   membership_redemptions       appointment_id may be null (there was no
--                                visit row). used_on, note and recorded_by
--                                say when, why and who. The old unique key
--                                (membership, appointment, service) becomes a
--                                partial unique index over the rows that have
--                                an appointment, which is the only place it
--                                ever meant anything: it stops the benefit
--                                running twice over one visit. Two hand
--                                entries of the same treatment in one period
--                                are two facials, and the allowance trigger
--                                decides whether the plan had two.
--   membership_perk_redemptions  order_id may be null, with used_on, note and
--                                recorded_by. The unique on order_id stays;
--                                nulls never collide. perk_uses_so_far() and
--                                claim_perk_use() are re-created so a row with
--                                no order counts as a use (they inner-joined
--                                orders and would have skipped it). Rows with
--                                an order count exactly as before.
--
-- enrol_membership() accepts a start no later than now and no earlier than
-- one period ago: a start whose first period has already run out would enrol
-- somebody already lapsed. A hand perk use on a 'month' perk must also fall
-- in this calendar month (America/Los_Angeles), the window it is counted in.
--
-- Two older things are fixed while the file is open:
--   * 079's give_back_membership_session() is re-created unchanged except
--     for its not-found message, which a manager sees and which had a dash
--     in it.
--   * Price integrity (050). client_memberships.price_cents_snapshot and
--     membership_charges.amount_cents are what the member was promised and
--     what each period costs. The is_manager() write policies on both tables
--     let a manager PATCH them from the browser. A BEFORE UPDATE trigger on
--     each now refuses a change to either column unless the caller is the
--     service role (the Stripe webhook adopting an invoice's amount, 083).
--     Inserts are untouched, so the 050 enrol and first-charge triggers and
--     renew_membership() work as before. A fix from the SQL editor (no JWT,
--     so auth.role() is null) is refused too, on purpose; run it with
--     `set local request.jwt.claim.role = 'service_role'` in the same
--     transaction.
--
-- A hand-recorded perk use may be deleted by a manager (a typo, the wrong
-- client); a use that came from an order may not, because that one is the
-- till's record of a sale. A hand-recorded session is given back through
-- 079's give_back_membership_session(), which already falls through to a
-- plain delete when there is no visit to reprice.
--
-- Dates. used_on is a calendar day, the day the visit happened. It must sit
-- inside the current period: from the day the period started to today. Both
-- ends are read generously across the UTC and America/Los_Angeles calendars
-- (the earlier of the two start days, the later of the two todays), so an
-- evening entry at the studio is never refused because the database clock is
-- already on tomorrow, and a period that began on a Fresno evening still
-- accepts that evening.
--
-- Checked against what joins on appointment_id:
--   * 078 appointment_release_membership_sessions deletes where
--     appointment_id = the cancelled visit; a null never matches, so a
--     cancellation can never take a hand entry with it.
--   * 079 give_back_membership_session reads the appointment by a null id,
--     finds nothing, and deletes the row: 'returned' (re-created below only
--     for its message).
--   * 082's review notice counts "visit N of M" by joining appointments, so
--     hand entries are not in its N. It names the visit, it does not enforce
--     anything; left as it is.
--   * 083 re-anchors redemptions by period start, not by appointment; hand
--     entries move with the period like any other.
--
-- Every statement is guarded; running this twice changes nothing.
--
-- TYPES: src/types/memberships.ts MembershipRedemption and
-- MembershipPerkRedemption gain the new columns (database.ts reads those
-- types), and database.ts Functions gains the three new functions. Done in the
-- same change.
-- ============================================================

-- ── 1. A session with no visit ───────────────────────────────

alter table public.membership_redemptions
  alter column appointment_id drop not null;

alter table public.membership_redemptions
  add column if not exists used_on date,
  add column if not exists note text,
  add column if not exists recorded_by uuid references public.profiles(id) on delete set null;

comment on column public.membership_redemptions.appointment_id is
  'The visit the session was spent on. Null for a session recorded by hand '
  '(record_membership_session, 089): it happened, but not as a booking here.';
comment on column public.membership_redemptions.used_on is
  'The day a hand-recorded session happened. Null for sessions spent on an appointment.';
comment on column public.membership_redemptions.recorded_by is
  'The manager who recorded this session by hand. Null for sessions spent on an appointment.';

-- 050 declared the key inline, so Postgres named (and truncated) it. Find it
-- by its columns rather than by a name we would have to guess.
do $$
declare
  con text;
begin
  for con in
    select c.conname
    from pg_constraint c
    where c.conrelid = 'public.membership_redemptions'::regclass
      and c.contype = 'u'
      and (
        select array_agg(a.attname::text order by a.attname)
        from unnest(c.conkey) k
        join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k
      ) = array['appointment_id', 'client_membership_id', 'service_id']
  loop
    execute format('alter table public.membership_redemptions drop constraint %I', con);
  end loop;
end;
$$;

-- Idempotency for the booking path only: the benefit run twice over one
-- visit cannot spend the session twice.
create unique index if not exists membership_redemptions_visit_once_idx
  on public.membership_redemptions (client_membership_id, appointment_id, service_id)
  where appointment_id is not null;

-- ── 2. Recording a session by hand ───────────────────────────
create or replace function public.record_membership_session(
  p_client_membership bigint,
  p_service bigint,
  p_used_on date,
  p_note text default null
)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare
  cm        record;
  svc       record;
  own       int;
  has_row   boolean;
  any_scope boolean;
  new_id    bigint;
begin
  if not public.is_manager() then
    raise exception 'Only a manager can record a membership session' using errcode = '42501';
  end if;

  -- The same row lock the allowance trigger takes, taken first, so the
  -- checks below and the insert see one membership that cannot move.
  select c.id, c.status, c.current_period_start, c.current_period_end,
         c.membership_id, m.included_sessions_per_period as pool
    into cm
  from public.client_memberships c
  join public.memberships m on m.id = c.membership_id
  where c.id = p_client_membership
  for update of c;

  if cm.id is null or not public.membership_is_current(cm.status, cm.current_period_end) then
    raise exception 'That membership is not current' using errcode = '23514';
  end if;

  select s.id, s.price_cents, s.is_active into svc
  from public.services s where s.id = p_service;
  if svc.id is null or not svc.is_active then
    raise exception 'That treatment does not exist or is not offered any more'
      using errcode = '23514';
  end if;

  -- Coverage, the same rule the trigger and src/lib/memberships.ts use: a
  -- treatment with its own allowance spends that; otherwise the pool, when
  -- the plan has one and the treatment is in scope (or the plan has no scope
  -- at all, which 050 reads as any treatment).
  select ms.sessions_per_period, true into own, has_row
  from public.membership_services ms
  where ms.membership_id = cm.membership_id and ms.service_id = p_service;
  has_row := coalesce(has_row, false);

  select exists (
    select 1 from public.membership_services ms where ms.membership_id = cm.membership_id
  ) into any_scope;

  if own is null
     and not (cm.pool > 0 and (not any_scope or has_row)) then
    raise exception 'That treatment is not included in this membership' using errcode = '23514';
  end if;

  if p_used_on is null
     or p_used_on < least(cm.current_period_start::date,
                          (cm.current_period_start at time zone 'America/Los_Angeles')::date)
     or p_used_on > greatest(current_date,
                             (now() at time zone 'America/Los_Angeles')::date) then
    raise exception 'That date is outside the current period' using errcode = '23514';
  end if;

  -- The 088 trigger counts the allowance and raises its own 23514 when it is
  -- spent. That message names the treatment and the count; it is passed on
  -- unchanged.
  insert into public.membership_redemptions
    (client_membership_id, appointment_id, service_id, redeemed_for_period_start,
     sessions, value_cents, used_on, note, recorded_by)
  values
    (cm.id, null, p_service, cm.current_period_start,
     1, svc.price_cents, p_used_on, nullif(btrim(p_note), ''), auth.uid())
  returning id into new_id;

  return new_id;
end;
$$;

comment on function public.record_membership_session(bigint, bigint, date, text) is
  'Record an included session that happened outside the system, on p_used_on inside the '
  'current period. Manager only. Coverage follows 088; the allowance trigger refuses an '
  'overspend with its own message. Returns the new membership_redemptions id (089).';

revoke all on function public.record_membership_session(bigint, bigint, date, text) from public, anon;
grant execute on function public.record_membership_session(bigint, bigint, date, text) to authenticated;

-- ── 3. Enrolling with the real start date ────────────────────
create or replace function public.enrol_membership(
  p_client uuid,
  p_membership bigint,
  p_started_at timestamptz,
  p_note text default null,
  p_paid_method text default null,
  p_paid_at timestamptz default null
)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare
  plan   record;
  new_id bigint;
begin
  if not public.is_manager() then
    raise exception 'Only a manager can enrol a member' using errcode = '42501';
  end if;

  -- 050's enrol trigger says the same things; saying them here first keeps
  -- the message plain. Read first: the start-date rule needs period_months.
  select m.id, m.is_active, m.period_months into plan
  from public.memberships m where m.id = p_membership;
  if plan.id is null then
    raise exception 'That membership plan does not exist' using errcode = '23503';
  end if;
  if not plan.is_active then
    raise exception 'That membership plan is retired. Reactivate it before enrolling anyone'
      using errcode = '23514';
  end if;

  -- The start may be back-dated, but only inside one period: a start whose
  -- first period has already ended would enrol somebody who is lapsed on the
  -- day they join, with one charge and no record of the periods between.
  -- That member is renewed, not enrolled.
  if p_started_at is null then
    raise exception 'Pick a start date' using errcode = '23514';
  end if;
  if p_started_at > now() then
    raise exception 'The start date cannot be in the future' using errcode = '23514';
  end if;
  if p_started_at + make_interval(months => plan.period_months) <= now() then
    raise exception 'That start is more than one period ago, so the membership would already have run out'
      using errcode = '23514';
  end if;

  if p_paid_method is not null
     and p_paid_method not in ('card', 'cash', 'stripe', 'other') then
    raise exception 'Pick how it was paid: card, cash, stripe or other' using errcode = '22023';
  end if;
  if p_paid_at is not null and p_paid_at > now() + interval '1 day' then
    raise exception 'The paid date cannot be in the future' using errcode = '23514';
  end if;

  -- current_period_end is passed equal to the start on purpose: 050's
  -- trigger derives the end only when it is at or before the start, and the
  -- column default (now()) is AFTER a back-dated start, which would end the
  -- first period today. The trigger also discards any price and snapshots
  -- the plan's, then the after-insert trigger writes the first charge as
  -- 'due'. A second live membership for this client fails here on
  -- client_memberships_one_live_idx with 23505, passed on unchanged.
  insert into public.client_memberships
    (client_id, membership_id, started_at, current_period_start, current_period_end,
     note, created_by)
  values
    (p_client, p_membership, p_started_at, p_started_at, p_started_at,
     nullif(btrim(p_note), ''), auth.uid())
  returning id into new_id;

  -- Settle the first period directly rather than through
  -- mark_membership_charge_paid(), which stamps paid_at = now() and cannot
  -- take the day the cash actually changed hands. An update of status fires
  -- 081's membership_charges_sync_client_stats, the same as that function's
  -- update does, so lifetime value picks the dues up.
  if p_paid_method is not null then
    update public.membership_charges
    set status = 'paid',
        method = p_paid_method,
        paid_at = coalesce(p_paid_at, now()),
        recorded_by = auth.uid()
    where client_membership_id = new_id
      and period_start = p_started_at
      and status = 'due';
  end if;

  return new_id;
end;
$$;

comment on function public.enrol_membership(uuid, bigint, timestamptz, text, text, timestamptz) is
  'Enrol a client from a real start date (not in the future, and inside its first period). The 050 '
  'triggers derive the period end, snapshot the price and write the first charge; with '
  'p_paid_method that charge is marked paid at p_paid_at (default now). Manager only. Returns '
  'the client_memberships id (089).';

revoke all on function public.enrol_membership(uuid, bigint, timestamptz, text, text, timestamptz)
  from public, anon;
grant execute on function public.enrol_membership(uuid, bigint, timestamptz, text, text, timestamptz)
  to authenticated;

-- ── 4. A perk use with no order ──────────────────────────────

alter table public.membership_perk_redemptions
  alter column order_id drop not null;

alter table public.membership_perk_redemptions
  add column if not exists used_on date,
  add column if not exists note text,
  add column if not exists recorded_by uuid references public.profiles(id) on delete set null;

comment on column public.membership_perk_redemptions.order_id is
  'The order this perk won. Null for a use recorded by hand (record_membership_perk_use, '
  '089), which counts as a use like any order that is not in cart or cancelled.';
comment on column public.membership_perk_redemptions.used_on is
  'The day a hand-recorded perk use happened. Null for uses won by an order.';
comment on column public.membership_perk_redemptions.recorded_by is
  'The manager who recorded this use by hand. Null for uses won by an order.';

comment on table public.membership_perk_redemptions is
  'One row per order a membership product perk won, or per use recorded by hand (order_id '
  'null, 089): which perk, which membership, how much came off. Uses are counted from here; '
  'a row with an order counts while the order is not in cart or cancelled, a row without one '
  'always counts. Written by claim_perk_use() (service role) and record_membership_perk_use() '
  '(manager). perk_id is null once the perk is deleted; the row stays for the reports.';

-- 087's count, with a left join so a row with no order is a use. For the
-- 'month' window a hand row is placed by the day it happened (used_on) in
-- the studio's calendar, not by when somebody typed it in; an order row is
-- placed by created_at, exactly as before.
create or replace function public.perk_uses_so_far(
  p_client_membership bigint,
  p_perk bigint,
  p_window text,
  p_period_start timestamptz
)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int
  from public.membership_perk_redemptions r
  left join public.orders o on o.id = r.order_id
  where r.client_membership_id = p_client_membership
    and r.perk_id = p_perk
    and (o.id is null or o.status not in ('cart', 'cancelled'))
    -- An order row whose order is gone was cascaded away with it, so an
    -- unmatched join here is always a hand row; this says so anyway.
    and (r.order_id is null or o.id is not null)
    and (
      auth.role() = 'service_role'
      or public.is_staff()
      or exists (
        select 1 from public.client_memberships cm
        where cm.id = p_client_membership and cm.client_id = auth.uid()
      )
    )
    and case
      when p_window = 'month' and r.used_on is not null
        then r.used_on >= date_trunc('month', now() at time zone 'America/Los_Angeles')::date
      when p_window = 'month'
        then r.created_at >= date_trunc('month', now() at time zone 'America/Los_Angeles')
                               at time zone 'America/Los_Angeles'
      else r.created_at >= p_period_start
    end;
$$;

comment on function public.perk_uses_so_far(bigint, bigint, text, timestamptz) is
  'Uses of one membership product perk on one membership inside its window (''period'' from '
  'p_period_start, ''month'' from the first of the month in America/Los_Angeles): every order '
  'not in cart or cancelled, plus every use recorded by hand (089). Own membership or staff '
  'only (anyone else gets 0); the service role, tested by its JWT role claim, always.';

revoke all on function public.perk_uses_so_far(bigint, bigint, text, timestamptz) from public, anon;
grant execute on function public.perk_uses_so_far(bigint, bigint, text, timestamptz)
  to authenticated, service_role;

-- 087's claim, unchanged in behaviour for orders. The count now includes
-- hand rows through perk_uses_so_far; the in-flight term is about carts, so
-- it still joins orders and only ever sees rows that have one.
create or replace function public.claim_perk_use(
  p_perk bigint,
  p_client_membership bigint,
  p_client uuid,
  p_order bigint,
  p_discount_cents int,
  p_units int
)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  v_max int;
  v_window text;
  v_period_start timestamptz;
  v_used int;
  v_in_flight int;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'claim_perk_use is for the service role only' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('perk_use'),
    hashtext(p_perk::text || ':' || p_client_membership::text)
  );

  if exists (select 1 from public.membership_perk_redemptions where order_id = p_order) then
    return true;
  end if;

  -- The perk must still exist and belong to the plan this membership holds.
  select pp.max_uses, pp.uses_window, cm.current_period_start
    into v_max, v_window, v_period_start
  from public.membership_product_perks pp
  join public.client_memberships cm on cm.membership_id = pp.membership_id
  where pp.id = p_perk and cm.id = p_client_membership;
  if not found then
    return false;
  end if;

  if v_max is not null then
    v_used := public.perk_uses_so_far(p_client_membership, p_perk, v_window, v_period_start);
    select count(*)::int into v_in_flight
    from public.membership_perk_redemptions r
    join public.orders o on o.id = r.order_id
    where r.client_membership_id = p_client_membership
      and r.perk_id = p_perk
      and o.status = 'cart'
      and r.created_at > now() - interval '15 minutes';
    if v_used + v_in_flight >= v_max then
      return false;
    end if;
  end if;

  insert into public.membership_perk_redemptions
    (perk_id, client_membership_id, client_id, order_id, discount_cents, units)
  values
    (p_perk, p_client_membership, p_client, p_order, greatest(p_discount_cents, 0), greatest(p_units, 0))
  on conflict (order_id) do nothing;
  return true;
end;
$$;

comment on function public.claim_perk_use(bigint, bigint, uuid, bigint, int, int) is
  'Spend one use of a membership product perk on an order, under an advisory lock on the perk '
  'and membership. True: the redemption row is written (or already was, for this order) and the '
  'order may carry the discount. False: no use left (hand-recorded uses count, 089), or the '
  'perk is not on this membership''s plan. Service role only.';

revoke all on function public.claim_perk_use(bigint, bigint, uuid, bigint, int, int)
  from public, anon, authenticated;
grant execute on function public.claim_perk_use(bigint, bigint, uuid, bigint, int, int)
  to service_role;

-- Recording a perk use by hand. Same lock as claim_perk_use, same count
-- (perk_uses_so_far plus carts in flight), so the till and a manager cannot
-- both take the last use.
create or replace function public.record_membership_perk_use(
  p_perk bigint,
  p_client_membership bigint,
  p_used_on date,
  p_discount_cents int default 0,
  p_note text default null
)
returns bigint language plpgsql volatile security definer set search_path = public as $$
declare
  v record;
  v_used int;
  v_in_flight int;
  new_id bigint;
begin
  if not public.is_manager() then
    raise exception 'Only a manager can record a perk use' using errcode = '42501';
  end if;

  if coalesce(p_discount_cents, 0) < 0 then
    raise exception 'The discount cannot be negative' using errcode = '23514';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('perk_use'),
    hashtext(p_perk::text || ':' || p_client_membership::text)
  );

  select cm.id as cm_id, cm.client_id, cm.status, cm.current_period_start,
         cm.current_period_end, pp.id as perk_id, pp.max_uses, pp.uses_window
    into v
  from public.client_memberships cm
  left join public.membership_product_perks pp
    on pp.id = p_perk and pp.membership_id = cm.membership_id
  where cm.id = p_client_membership;

  if v.cm_id is null or not public.membership_is_current(v.status, v.current_period_end) then
    raise exception 'That membership is not current' using errcode = '23514';
  end if;
  if v.perk_id is null then
    raise exception 'That perk is not on this membership' using errcode = '23514';
  end if;

  if p_used_on is null
     or p_used_on < least(v.current_period_start::date,
                          (v.current_period_start at time zone 'America/Los_Angeles')::date)
     or p_used_on > greatest(current_date,
                             (now() at time zone 'America/Los_Angeles')::date) then
    raise exception 'That date is outside the current period' using errcode = '23514';
  end if;
  -- A 'month' perk is counted in the studio's calendar month. A use dated
  -- last month would be written into a month that may already have been
  -- full, and this month's count would never see it.
  if v.uses_window = 'month'
     and p_used_on < date_trunc('month', now() at time zone 'America/Los_Angeles')::date then
    raise exception 'That date is before this month started' using errcode = '23514';
  end if;

  if v.max_uses is not null then
    v_used := public.perk_uses_so_far(p_client_membership, p_perk, v.uses_window, v.current_period_start);
    select count(*)::int into v_in_flight
    from public.membership_perk_redemptions r
    join public.orders o on o.id = r.order_id
    where r.client_membership_id = p_client_membership
      and r.perk_id = p_perk
      and o.status = 'cart'
      and r.created_at > now() - interval '15 minutes';
    if v_used + v_in_flight >= v.max_uses then
      raise exception 'That perk has no uses left this period' using errcode = '23514';
    end if;
  end if;

  insert into public.membership_perk_redemptions
    (perk_id, client_membership_id, client_id, order_id, discount_cents, units,
     used_on, note, recorded_by)
  values
    (p_perk, p_client_membership, v.client_id, null, coalesce(p_discount_cents, 0), 1,
     p_used_on, nullif(btrim(p_note), ''), auth.uid())
  returning id into new_id;

  return new_id;
end;
$$;

comment on function public.record_membership_perk_use(bigint, bigint, date, int, text) is
  'Record a product perk use that happened outside the system, on p_used_on inside the '
  'current period. Manager only. Refused when the perk is not on the plan or its max_uses '
  'are spent in its window. Returns the new membership_perk_redemptions id (089).';

revoke all on function public.record_membership_perk_use(bigint, bigint, date, int, text)
  from public, anon;
grant execute on function public.record_membership_perk_use(bigint, bigint, date, int, text)
  to authenticated;

-- A manager may take back a use they typed in. A use an order won is the
-- till's record of a sale and stays; the order's own cancellation is what
-- gives that one back.
drop policy if exists "manager deletes hand-recorded perk use" on public.membership_perk_redemptions;
create policy "manager deletes hand-recorded perk use" on public.membership_perk_redemptions
  for delete to authenticated
  using (public.is_manager() and order_id is null);

grant delete on public.membership_perk_redemptions to authenticated;

-- ── 5. Giving a session back (079), message reworded ─────────
-- Same body and grants as 079. Only the not-found text changes.
create or replace function public.give_back_membership_session(p_redemption bigint)
returns text language plpgsql security definer set search_path = public as $$
declare
  r     record;
  appt  record;
begin
  if not public.is_manager() then
    raise exception 'Only a manager can give a membership session back';
  end if;

  select id, appointment_id, value_cents into r
  from public.membership_redemptions where id = p_redemption
  for update;
  if r.id is null then
    raise exception 'That session was not found. It may already have been given back';
  end if;

  -- A hand-recorded session (089) has no appointment; this finds nothing and
  -- the row is simply deleted below.
  select id, status into appt from public.appointments where id = r.appointment_id for update;

  if appt.id is not null and appt.status in ('pending', 'confirmed', 'checked_in') then
    update public.appointments
    set membership_covered_cents = greatest(membership_covered_cents - r.value_cents, 0)
    where id = appt.id;
    delete from public.membership_redemptions where id = r.id;
    return 'repriced';
  end if;

  delete from public.membership_redemptions where id = r.id;
  return 'returned';
end;
$$;

revoke all on function public.give_back_membership_session(bigint) from public, anon;
grant execute on function public.give_back_membership_session(bigint) to authenticated;

-- ── 6. A price nobody edits by hand ──────────────────────────
-- See the header. auth.role() reads the JWT's role claim: 'service_role' only
-- for the service key, null with no JWT at all. IS DISTINCT FROM, so a
-- change to or from null is a change too.
create or replace function public.client_membership_price_locked()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.price_cents_snapshot is distinct from old.price_cents_snapshot
     and auth.role() is distinct from 'service_role' then
    raise exception 'The price on a membership cannot be edited by hand' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists client_memberships_price_locked on public.client_memberships;
create trigger client_memberships_price_locked
  before update on public.client_memberships
  for each row execute function public.client_membership_price_locked();

create or replace function public.membership_charge_amount_locked()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.amount_cents is distinct from old.amount_cents
     and auth.role() is distinct from 'service_role' then
    raise exception 'The price on a membership cannot be edited by hand' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists membership_charges_amount_locked on public.membership_charges;
create trigger membership_charges_amount_locked
  before update on public.membership_charges
  for each row execute function public.membership_charge_amount_locked();

revoke all on function public.client_membership_price_locked() from public, anon, authenticated;
revoke all on function public.membership_charge_amount_locked() from public, anon, authenticated;
