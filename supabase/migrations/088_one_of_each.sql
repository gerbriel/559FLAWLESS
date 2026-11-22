-- ============================================================
-- 559 Flawless — 088: one of each
--
-- Until now a plan's included sessions were one shared pool. "2 included:
-- Custom Corrective Facial or Full Brazilian" is 050's model exactly:
-- `included_sessions_per_period` is how many, and `membership_services` is
-- which treatments they may be spent on. The word that matters is OR. A
-- member may spend both on facials and never have the Brazilian, and the
-- database is right to let them.
--
-- The studio also wants to sell AND: "1 Custom Corrective Facial and 1 Full
-- Brazilian each month". Two facials is not that plan, and no pool size says
-- otherwise. So a scope row may now carry its own allowance:
--
--   membership_services.sessions_per_period   null = this treatment draws
--                                             from the plan's shared pool, as
--                                             every row did before; set = this
--                                             treatment has N of its own each
--                                             period, independent of the pool
--
-- The editor keeps a plan in one mode or the other (every row set and the
-- pool at 0, or every row null), but the database does not rely on that. For
-- a plan that mixes the two, the rules are:
--
--   * a treatment with its own allowance NEVER draws from the pool, even when
--     its own allowance is spent;
--   * the pool counts only redemptions on treatments WITHOUT their own
--     allowance, plus legacy rows whose service_id is null (the service was
--     deleted, 050's `on delete set null`), which were always pool spending.
--
-- Enforcement stays where 050 put it: membership_redemption_within_allowance()
-- on the insert, under the same FOR UPDATE on the membership row, so two
-- bookings racing for the last facial still serialise and exactly one wins.
-- Only what is counted changes. src/lib/memberships.ts asks, and believes the
-- answer, as before.
--
-- Moving a service into or out of its own allowance mid-period moves its past redemptions between the pool count and the per-treatment count, by design, and the trigger and includedAllowances agree.
--
-- The editor replaces a plan's scope through replace_membership_scope()
-- (below): the delete and the insert run in one transaction, so a booking
-- between them never sees a plan with no scope (which would read as "any
-- treatment").
--
-- No backfill: the column defaults to null, so every existing plan is a pool
-- plan and the trigger counts exactly what it counted yesterday.
--
-- Every statement is guarded; running this twice changes nothing.
--
-- TYPES: src/types/memberships.ts MembershipService gains
-- sessions_per_period (database.ts reads that type), and database.ts
-- Functions gains replace_membership_scope. Done in the same change.
-- ============================================================

alter table public.membership_services
  add column if not exists sessions_per_period int;

alter table public.membership_services
  drop constraint if exists membership_services_sessions_per_period_range;
alter table public.membership_services
  add constraint membership_services_sessions_per_period_range
  check (sessions_per_period is null or sessions_per_period between 1 and 31);

comment on column public.membership_services.sessions_per_period is
  'Null: this treatment may be paid for from the plan''s shared pool '
  '(included_sessions_per_period), as before 088. Set: this treatment has its '
  'own allowance of N per period, counted only against redemptions on this '
  'treatment, and it never draws from the pool. See migration 088.';

-- ── The allowance, counted per treatment or from the pool ─────
create or replace function public.membership_redemption_within_allowance()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  plan_id    bigint;
  pool       int;
  own        int;
  allowance  int;
  spent      int;
  live       boolean;
  svc_name   text;
begin
  -- FOR UPDATE on the membership row is what serialises two bookings racing
  -- for the last included session, per treatment or from the pool alike.
  select public.membership_is_current(cm.status, cm.current_period_end),
         m.id, m.included_sessions_per_period
    into live, plan_id, pool
  from public.client_memberships cm
  join public.memberships m on m.id = cm.membership_id
  where cm.id = new.client_membership_id
  for update of cm;

  if pool is null then
    raise exception 'That membership does not exist' using errcode = '23503';
  end if;
  if not live then
    raise exception 'That membership is not current, so there is no session to spend'
      using errcode = '23514';
  end if;

  -- A legacy row with no service is pool spending, as it always was.
  if new.service_id is not null then
    select ms.sessions_per_period into own
    from public.membership_services ms
    where ms.membership_id = plan_id
      and ms.service_id = new.service_id;
  end if;

  if own is not null then
    allowance := own;

    select coalesce(sum(r.sessions), 0) into spent
    from public.membership_redemptions r
    where r.client_membership_id = new.client_membership_id
      and r.redeemed_for_period_start = new.redeemed_for_period_start
      and r.service_id = new.service_id;

    if spent + new.sessions > allowance then
      select s.name into svc_name from public.services s where s.id = new.service_id;
      raise exception
        'That membership has % % this period and % already spent',
        allowance, coalesce(svc_name, 'of this treatment'), spent
        using errcode = '23514';
    end if;
  else
    allowance := pool;

    select coalesce(sum(r.sessions), 0) into spent
    from public.membership_redemptions r
    where r.client_membership_id = new.client_membership_id
      and r.redeemed_for_period_start = new.redeemed_for_period_start
      and (
        r.service_id is null
        or not exists (
          select 1 from public.membership_services ms
          where ms.membership_id = plan_id
            and ms.service_id = r.service_id
            and ms.sessions_per_period is not null
        )
      );

    if spent + new.sessions > allowance then
      raise exception
        'That membership has % included session(s) this period and % already spent',
        allowance, spent
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists membership_redemptions_allowance on public.membership_redemptions;
create trigger membership_redemptions_allowance
  before insert on public.membership_redemptions
  for each row execute function public.membership_redemption_within_allowance();

-- ── Replacing a plan's scope in one transaction ───────────────
-- The editor used to delete every membership_services row and then insert the
-- new list as two requests. A booking landing between the two saw a plan with
-- no scope, which 050 reads as "any treatment". This does both inside one
-- function call, so readers see the old list or the new one and nothing in
-- between.
--
--   p_rows   [{"service_id": 1, "sessions_per_period": 1 | null}, ...]
--            an empty array clears the scope
--
-- SECURITY DEFINER so the two statements run as one unit whatever the
-- caller's policies, which is why is_manager() is checked here first: the
-- RLS write policy on membership_services is is_manager(), and this function
-- grants nothing that policy does not.
create or replace function public.replace_membership_scope(p_membership bigint, p_rows jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  r        jsonb;
  svc      bigint;
  per      int;
  seen     bigint[] := '{}';
begin
  if not public.is_manager() then
    raise exception 'Only a manager can change what a membership includes'
      using errcode = '42501';
  end if;

  if p_rows is null or jsonb_typeof(p_rows) <> 'array' then
    raise exception 'The included treatments must be a list' using errcode = '22023';
  end if;

  -- Locks the plan so two editors saving at once apply one after the other.
  perform 1 from public.memberships m where m.id = p_membership for update;
  if not found then
    raise exception 'That membership does not exist' using errcode = '23503';
  end if;

  for r in select value from jsonb_array_elements(p_rows) loop
    if jsonb_typeof(r) <> 'object'
       or jsonb_typeof(r -> 'service_id') is distinct from 'number' then
      raise exception 'Each included treatment needs a service_id' using errcode = '22023';
    end if;
    svc := (r ->> 'service_id')::bigint;

    if not exists (select 1 from public.services s where s.id = svc) then
      raise exception 'Service % does not exist', svc using errcode = '23503';
    end if;
    if svc = any(seen) then
      raise exception 'Service % is listed twice', svc using errcode = '23505';
    end if;
    seen := seen || svc;

    if r -> 'sessions_per_period' is null
       or jsonb_typeof(r -> 'sessions_per_period') = 'null' then
      per := null;
    elsif jsonb_typeof(r -> 'sessions_per_period') <> 'number' then
      raise exception 'sessions_per_period must be a number or null' using errcode = '22023';
    else
      per := (r ->> 'sessions_per_period')::numeric;
      if per::numeric <> (r ->> 'sessions_per_period')::numeric or per not between 1 and 31 then
        raise exception 'sessions_per_period must be a whole number from 1 to 31'
          using errcode = '23514';
      end if;
    end if;
  end loop;

  delete from public.membership_services where membership_id = p_membership;

  insert into public.membership_services (membership_id, service_id, sessions_per_period)
  select p_membership,
         (e ->> 'service_id')::bigint,
         case when jsonb_typeof(e -> 'sessions_per_period') = 'number'
              then (e ->> 'sessions_per_period')::int end
  from jsonb_array_elements(p_rows) as t(e);
end;
$$;

revoke all on function public.replace_membership_scope(bigint, jsonb) from public, anon;
grant execute on function public.replace_membership_scope(bigint, jsonb) to authenticated;
