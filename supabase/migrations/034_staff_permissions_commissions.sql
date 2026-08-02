-- ============================================================
-- 559 Flawless — 034: what a person may do, and what they earn
--
-- Two things the owner asked for that turn out to be the same shape: the
-- studio's rules are per-person now, not per-tier, and they have to keep being
-- true about the past.
--
-- ── Part 1: permissions ─────────────────────────────────────
--
-- Authorisation today is the five-value `user_role` enum and the four helpers
-- in 001, and thirty-odd migrations of RLS are written against them. Nothing
-- here changes that. The role stays the baseline and grants sit on top of it:
--
--     permissions        the catalogue — what a permission even is
--     role_permissions   what each role holds by default
--     staff_permissions  per-person overrides, either direction
--     has_permission()   override first, then the role default, then no
--
-- Every existing policy keeps working untouched because none of them are
-- touched. New policies — including the commission tables below — can be as
-- fine-grained as they like. Migrating the existing thirty-one migrations onto
-- has_permission() in one pass would be a very good way to take the studio's
-- security boundary apart on a Tuesday, so it is not attempted here.
--
-- Being precise about what this is: has_permission() gates exactly what is
-- written against it and nothing else. Until a policy adopts it, a permission
-- describes intent and drives the UI. The commission tables in Part 2 are
-- written against it from the start, so the mechanism is load-bearing today,
-- not decorative.
--
-- The dangerous part is the grant path. 001 installs a trigger that refuses any
-- change to `profiles.role` from a non-admin, precisely so the otherwise
-- sensible "update own profile" policy cannot be used to self-promote. A table
-- of per-person permissions is that same hole cut a second time unless the
-- write path is guarded at least as well, so it is:
--
--   * You cannot grant yourself anything. Not a permission you lack, and not
--     one you already hold — an explicit grant outlives the role that
--     justified it, so "grant myself what I already have" is a real escalation
--     with a delay on it.
--   * You cannot grant what you do not hold. The set of permissions in
--     circulation can spread between people, but nobody can conjure one that
--     nobody had. Only an admin can introduce one.
--   * manage_permissions and manage_staff are admin-only to grant, flagged
--     is_sensitive in the catalogue, so the ability to spread anything at all
--     is admin-conferred.
--   * The check reads the role of `granted_by` — a stored NOT NULL column —
--     rather than auth.uid(), the way 031 checks `invited_by`. Triggers fire
--     for the service role too, so "only an admin granted this" is a property
--     of the row and not of whichever route handler wrote it.
--   * An admin cannot be overridden at all. is_admin() short-circuits every
--     policy in the database; a revoked permission on an admin would hide a
--     button while the SQL still said yes, which is the UI-as-security mistake
--     AGENTS.md warns about.
--
-- ── Part 2: commissions ─────────────────────────────────────
--
-- A plan is a rate card. An assignment binds a person to a plan, at a site,
-- between two dates — so a report for March reads March's plan and not
-- today's. That is the part people get wrong, and it is why the assignment
-- carries the dates rather than the plan carrying "current rate".
--
-- Commission is on money TAKEN. `payments` (025) is the ledger, refunds are
-- negative rows in it, and a no-show nobody paid for earns nothing. Billed
-- totals never enter the calculation.
--
-- Everything is integer cents and integer basis points — 4000 is 40.00%. The
-- arithmetic accumulates a numerator over a common denominator and divides
-- exactly once, so there is one truncation per figure and no float anywhere.
-- ============================================================

-- ════════════════════════════════════════════════════════════
--  PART 1 — PERMISSIONS
-- ════════════════════════════════════════════════════════════

-- ── The catalogue ────────────────────────────────────────────
create table if not exists public.permissions (
  key          text primary key,
  label        text not null,
  description  text not null,
  -- Groups the matrix in the dashboard. Free text rather than an enum so
  -- adding one is an insert, not a migration.
  category     text not null,
  -- Granting one of these is the power to grant everything else, so it stays
  -- admin-only however the studio configures the rest.
  is_sensitive boolean not null default false,
  sort_order   int not null default 0
);

comment on table public.permissions is
  'Every permission the studio can grant. The role enum is still the baseline; '
  'these sit on top of it.';

-- ── What each role holds without anyone deciding anything ────
--
-- Seeded to match what the roles can already do, so installing this migration
-- changes nobody''s access on the day it runs. `admin` has no rows on purpose:
-- an admin holds everything by definition and has_permission() says so
-- directly, which keeps the two statements from drifting apart.
create table if not exists public.role_permissions (
  role       public.user_role not null,
  permission text not null references public.permissions(key) on delete cascade,
  primary key (role, permission)
);

-- ── Per-person overrides ─────────────────────────────────────
create table if not exists public.staff_permissions (
  id         bigserial primary key,
  profile_id uuid not null references public.profiles(id) on delete cascade,
  permission text not null references public.permissions(key) on delete cascade,
  -- true grants what the role does not give; false takes away what it does.
  granted    boolean not null,
  reason     text,

  -- Who did this. NOT NULL is enforced in the guard trigger rather than the
  -- column, so that deleting the account of someone who once granted a
  -- permission does not take everyone else's permissions with it — the row
  -- keeps working, it just stops naming a granter. On the way in it is
  -- mandatory, and it is what the tier check is read from.
  granted_by uuid references public.profiles(id) on delete set null,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  unique (profile_id, permission)
);

create index if not exists staff_permissions_profile_idx
  on public.staff_permissions (profile_id);

comment on table public.staff_permissions is
  'Per-person grants and revocations. One row beats the role default in either '
  'direction; no row means the role default applies.';

comment on column public.staff_permissions.granted_by is
  'The staff member who made this override. The self-grant guard reads this '
  'column, not auth.uid(), so the service role cannot attribute a grant to '
  'someone who could not have made it.';

-- An override is a statement about a person, not about a site. Every RLS
-- policy that will ever call has_permission() asks one question — "may this
-- caller do this?" — and a per-location answer would have to resolve a grant
-- at one site against a revocation at another before it could reply. A
-- security helper that returns "it depends" is a security helper nobody can
-- reason about, so this table is deliberately not location-scoped. Commission,
-- where the per-site answer is the whole point, is.

drop trigger if exists staff_permissions_touch on public.staff_permissions;
create trigger staff_permissions_touch
  before update on public.staff_permissions
  for each row execute function public.touch_updated_at();

-- ── The helper everything else is written against ────────────
--
-- SECURITY DEFINER for the same reason the 001 helpers are: a policy on
-- staff_permissions has to be able to read staff_permissions without
-- recursing through its own RLS. search_path is pinned to defeat shadowing.

/**
 * Does this profile hold this permission?
 *
 * Override first, then the role default, then no. Unknown permission names
 * return false rather than raising — a typo in a policy should deny, not throw
 * a 500 at whoever tripped over it. The foreign keys on both mapping tables
 * mean a typo cannot get stored in the first place.
 */
create or replace function public.profile_has_permission(
  p_profile    uuid,
  p_permission text
) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.profiles p
    where p.id = p_profile
      and p.suspended_at is null
      and (
        -- An admin passes every check in the database already. Saying anything
        -- else here would be a UI-deep fiction.
        p.role = 'admin'
        or coalesce(
             (select sp.granted
                from public.staff_permissions sp
               where sp.profile_id = p.id
                 and sp.permission = p_permission),
             (select true
                from public.role_permissions rp
               where rp.role = p.role
                 and rp.permission = p_permission),
             false
           )
      )
  );
$$;

/** The same question about whoever is making this request. */
create or replace function public.has_permission(p_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.profile_has_permission(auth.uid(), p_permission);
$$;

comment on function public.has_permission(text) is
  'Per-person permission check: the override wins, then the role default. '
  'Returns false for the service role (auth.uid() is null), which is correct — '
  'the service role bypasses RLS and never needs to ask.';

/**
 * May this person hand this permission to somebody else?
 *
 * Two rules, and the second one is the interesting one: you must already hold
 * what you are handing over. That makes the set of permissions in circulation
 * closed under everything a non-admin can do — it can spread between people
 * but it cannot grow. Only an admin introduces a permission nobody had.
 */
create or replace function public.can_grant_permission(
  p_actor      uuid,
  p_permission text
) returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_actor
      and p.suspended_at is null
      and p.role <> 'client'
  )
  and (
    (select p.role = 'admin' from public.profiles p where p.id = p_actor)
    or (
      -- coalesce to true: a permission that is not in the catalogue is treated
      -- as sensitive, so an unknown name fails closed rather than open.
      not coalesce(
        (select pm.is_sensitive from public.permissions pm where pm.key = p_permission),
        true)
      and public.profile_has_permission(p_actor, 'manage_permissions')
      and public.profile_has_permission(p_actor, p_permission)
    )
  );
$$;

/**
 * Everything a person effectively holds, and why.
 *
 * `source` is 'role' or 'override' — the matrix in Settings needs to show the
 * difference, because "she can do this because she is a manager" and "she can
 * do this because you ticked it in March" are different facts.
 */
create or replace function public.effective_permissions(p_profile uuid)
returns table (
  permission  text,
  label       text,
  category    text,
  granted     boolean,
  source      text,
  sort_order  int
) language sql stable security definer set search_path = public as $$
  select
    pm.key,
    pm.label,
    pm.category,
    public.profile_has_permission(p_profile, pm.key),
    case
      when (select p.role from public.profiles p where p.id = p_profile) = 'admin'
        then 'role'
      when exists (
        select 1 from public.staff_permissions sp
        where sp.profile_id = p_profile and sp.permission = pm.key
      ) then 'override'
      else 'role'
    end,
    pm.sort_order
  from public.permissions pm
  where auth.uid() is null
     or p_profile = auth.uid()
     or public.is_admin()
     or public.has_permission('manage_permissions')
  order by pm.sort_order, pm.key;
$$;

-- ── The guard ────────────────────────────────────────────────
--
-- This is the trigger the whole feature stands on. RLS below says the same
-- things, but RLS only binds callers who are subject to it and
-- createAdminClient() is not one of them. Putting the rules here makes them
-- true for psql, for the service role, and for a route handler written in a
-- hurry at eleven at night.

create or replace function public.staff_permissions_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  actor       uuid;
  target_role public.user_role;
begin
  if tg_op = 'DELETE' then
    -- Clearing an override restores the role default, which is a privilege
    -- change in whichever direction the row was pointing.
    actor := auth.uid();

    -- No JWT means a migration, psql, or the service role — all already
    -- privileged, exactly as 001 documents for the profiles guard.
    if actor is null or public.is_admin() then
      return old;
    end if;

    if old.profile_id = actor and old.granted = false then
      raise exception
        'You cannot clear a restriction on your own account — an admin has to.';
    end if;

    if not public.can_grant_permission(actor, old.permission) then
      raise exception 'You cannot change % for anyone.', old.permission;
    end if;

    return old;
  end if;

  if new.granted_by is null then
    raise exception 'A permission override has to record who made it';
  end if;

  actor := new.granted_by;

  -- You act as yourself. Combined with the checks below — which all read the
  -- role of exactly this column — impersonating someone more senior buys
  -- nothing, because the row would then have to survive their tier check.
  if auth.uid() is not null and actor is distinct from auth.uid() then
    raise exception 'A permission override is recorded against whoever made it';
  end if;

  select role into target_role from public.profiles where id = new.profile_id;
  if target_role is null then
    raise exception 'There is no such profile to give a permission to';
  end if;
  if target_role = 'client' then
    raise exception
      'Permissions are for staff. Give them a staff role first.';
  end if;
  if target_role = 'admin' then
    raise exception
      'An admin already passes every check in the database — an override here '
      'would hide a button without stopping anything. Change the role instead.';
  end if;

  -- The hole 001 was written to close, cut a second time. Note that this
  -- refuses a self-grant of something you ALREADY hold, which looks harmless
  -- and is not: the override outlives the role that justified it, so it is a
  -- promotion with a delay on it.
  if new.profile_id = actor and new.granted then
    raise exception 'You cannot grant yourself a permission.';
  end if;

  if not public.can_grant_permission(actor, new.permission) then
    raise exception 'You cannot grant or revoke %.', new.permission;
  end if;

  return new;
end;
$$;

drop trigger if exists staff_permissions_guard on public.staff_permissions;
create trigger staff_permissions_guard
  before insert or update or delete on public.staff_permissions
  for each row execute function public.staff_permissions_guard();

/** The default map is the shape of the roles themselves. Admin only. */
create or replace function public.role_permissions_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can change what a role holds by default';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists role_permissions_guard on public.role_permissions;
create trigger role_permissions_guard
  before insert or update or delete on public.role_permissions
  for each row execute function public.role_permissions_guard();

-- ── A role change restates what someone may do ───────────────
--
-- Overrides do not survive it. A front desk employee who was granted
-- view_financial_reports and is then moved to provider should not keep it by
-- inertia; the person doing the demotion is deciding what this person may do,
-- and inherited exceptions are how "why can she see that?" happens six months
-- later. Re-granting is two clicks in the matrix.
--
-- This delete can never be refused by the guard above: changing a role
-- requires an admin (001), and the guard's DELETE branch lets an admin — and
-- the service role, which is how redeem_invitation promotes an invitee —
-- through unconditionally.
create or replace function public.clear_permission_overrides_on_role_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role then
    delete from public.staff_permissions where profile_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists profiles_clear_permission_overrides on public.profiles;
create trigger profiles_clear_permission_overrides
  after update of role on public.profiles
  for each row execute function public.clear_permission_overrides_on_role_change();

-- ── Setting one, from the dashboard ──────────────────────────
/**
 * Grant, revoke, or clear one permission for one person.
 *
 * p_granted true grants, false revokes, null clears the override so the role
 * default applies again. Returns what the person effectively holds afterwards.
 *
 * SECURITY DEFINER on purpose. The guard trigger is the authority either way —
 * it fires for definer calls exactly as it does for anyone else — and coming
 * through here means a refusal arrives as a sentence somebody can act on
 * rather than as "new row violates row-level security policy".
 */
create or replace function public.set_staff_permission(
  p_profile    uuid,
  p_permission text,
  p_granted    boolean,
  p_reason     text default null
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  actor uuid := auth.uid();
begin
  if actor is null then
    raise exception 'Sign in before changing permissions';
  end if;
  if not exists (select 1 from public.permissions where key = p_permission) then
    raise exception 'There is no permission called %', p_permission;
  end if;

  if p_granted is null then
    delete from public.staff_permissions
    where profile_id = p_profile and permission = p_permission;
  else
    insert into public.staff_permissions
      (profile_id, permission, granted, reason, granted_by)
    values (p_profile, p_permission, p_granted, p_reason, actor)
    on conflict (profile_id, permission) do update
      set granted    = excluded.granted,
          reason     = excluded.reason,
          granted_by = excluded.granted_by;
  end if;

  perform public.log_user_activity(
    p_profile,
    'permission_changed',
    jsonb_build_object(
      'permission', p_permission,
      'granted',    p_granted,
      'reason',     p_reason
    ),
    actor
  );

  return public.profile_has_permission(p_profile, p_permission);
end;
$$;

-- ── RLS ──────────────────────────────────────────────────────
alter table public.permissions       enable row level security;
alter table public.role_permissions  enable row level security;
alter table public.staff_permissions enable row level security;

-- The catalogue and the default map are labels and shape, not secrets — staff
-- need them to render anything at all. No anon policy on any of the three.
drop policy if exists "staff reads permissions" on public.permissions;
create policy "staff reads permissions" on public.permissions
  for select to authenticated using (public.is_staff());

drop policy if exists "admin writes permissions" on public.permissions;
create policy "admin writes permissions" on public.permissions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "staff reads role defaults" on public.role_permissions;
create policy "staff reads role defaults" on public.role_permissions
  for select to authenticated using (public.is_staff());

drop policy if exists "admin writes role defaults" on public.role_permissions;
create policy "admin writes role defaults" on public.role_permissions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- You may always see what you yourself hold. Being told what you can do is not
-- a privilege; being able to change it is.
drop policy if exists "read own permission overrides" on public.staff_permissions;
create policy "read own permission overrides" on public.staff_permissions
  for select to authenticated
  using (profile_id = auth.uid() or public.has_permission('manage_permissions'));

drop policy if exists "manage permission overrides" on public.staff_permissions;
create policy "manage permission overrides" on public.staff_permissions
  for all to authenticated
  using (public.has_permission('manage_permissions'))
  with check (public.has_permission('manage_permissions'));

grant select on public.permissions      to authenticated;
grant select on public.role_permissions to authenticated;
grant select, insert, update, delete on public.staff_permissions to authenticated;
grant usage, select on sequence public.staff_permissions_id_seq to authenticated;
grant all on public.permissions       to service_role;
grant all on public.role_permissions  to service_role;
grant all on public.staff_permissions to service_role;
grant usage, select on sequence public.staff_permissions_id_seq to service_role;
revoke all on public.permissions       from anon;
revoke all on public.role_permissions  from anon;
revoke all on public.staff_permissions from anon;

grant execute on function public.has_permission(text)                       to authenticated;
grant execute on function public.profile_has_permission(uuid, text)         to authenticated;
grant execute on function public.can_grant_permission(uuid, text)           to authenticated;
grant execute on function public.effective_permissions(uuid)                to authenticated;
grant execute on function public.set_staff_permission(uuid, text, boolean, text)
  to authenticated;
revoke all on function public.set_staff_permission(uuid, text, boolean, text) from anon;

-- ── Seed: the catalogue ──────────────────────────────────────
insert into public.permissions (key, label, description, category, is_sensitive, sort_order) values
  ('view_own_calendar', 'See their own calendar',
   'Their own appointments and hours.', 'Calendar', false, 10),
  ('view_calendar_all', 'See everyone''s calendar',
   'The whole studio''s day, not just their own column.', 'Calendar', false, 20),

  ('manage_clients', 'Manage clients',
   'The full client list: contact details, history, and adding someone new.',
   'Clients', false, 30),
  ('view_client_clinical', 'See clinical records',
   'Intake answers, treatment notes, patch tests, consent, and photos. Health '
   'information — grant it to the people who treat clients.', 'Clients', false, 40),

  ('manage_services', 'Edit the service menu',
   'Add, retire, and reword services and add-ons, including the age and '
   'consent gates.', 'Catalogue', false, 50),
  ('view_pricing', 'See cost and margin',
   'What products cost the studio and what each service actually earns. Not '
   'the same as the menu price, which is public.', 'Catalogue', false, 60),
  ('manage_pricing', 'Change prices',
   'Set service and product prices, deposits, and per-provider overrides.',
   'Catalogue', false, 70),

  ('manage_inventory', 'Manage inventory',
   'Add and retire products, set reorder levels, and run the back bar.',
   'Inventory', false, 80),
  ('adjust_stock', 'Count stock',
   'Record a delivery, a breakage, or a recount. Whoever is holding the bottle '
   'knows the number.', 'Inventory', false, 90),

  ('view_reports', 'See reports',
   'Bookings, retention, service mix, and how busy the room is.',
   'Reports', false, 100),
  ('view_financial_reports', 'See money reports',
   'Revenue, payouts, and commission — for the studio, not just for them.',
   'Reports', false, 110),
  ('manage_expenses', 'Record expenses',
   'Enter what the studio spent and on what.', 'Reports', false, 120),

  ('sell_retail', 'Ring up a sale',
   'Take payment at the counter and handle product orders.', 'Retail', false, 130),

  ('manage_staff', 'Manage staff',
   'Add and edit staff records, hours, and commission plans. Admin-only to '
   'grant.', 'Staff', true, 140),
  ('manage_permissions', 'Manage permissions',
   'Change what other people may do. Admin-only to grant, because it is the '
   'power to grant everything else.', 'Staff', true, 150),

  ('send_marketing', 'Send marketing',
   'Newsletters, campaigns, and broadcast messages.', 'Marketing', false, 160),
  ('manage_settings', 'Change studio settings',
   'Booking policy, opening hours, tax, and the public pages.',
   'Settings', false, 170)
on conflict (key) do update
  set label        = excluded.label,
      description  = excluded.description,
      category     = excluded.category,
      is_sensitive = excluded.is_sensitive,
      sort_order   = excluded.sort_order;

-- ── Seed: the defaults, matching what the roles can already do ──
--
-- `admin` is absent deliberately — see the comment on role_permissions.
-- `client` is absent because a client holds no staff permission at all.
insert into public.role_permissions (role, permission) values
  ('provider',   'view_own_calendar'),
  ('provider',   'view_client_clinical'),
  ('provider',   'adjust_stock'),

  ('front_desk', 'view_own_calendar'),
  ('front_desk', 'view_calendar_all'),
  ('front_desk', 'manage_clients'),
  ('front_desk', 'view_client_clinical'),
  ('front_desk', 'adjust_stock'),
  ('front_desk', 'sell_retail'),

  ('manager',    'view_own_calendar'),
  ('manager',    'view_calendar_all'),
  ('manager',    'manage_clients'),
  ('manager',    'view_client_clinical'),
  ('manager',    'view_pricing'),
  ('manager',    'manage_inventory'),
  ('manager',    'adjust_stock'),
  ('manager',    'view_reports'),
  ('manager',    'manage_expenses'),
  ('manager',    'sell_retail'),
  ('manager',    'send_marketing')
on conflict do nothing;

-- ════════════════════════════════════════════════════════════
--  PART 2 — COMMISSIONS
-- ════════════════════════════════════════════════════════════

-- ── The rate card ────────────────────────────────────────────
--
-- Rates are basis points. 4000 is 40.00%, and the whole calculation stays in
-- integers from the ledger to the payout.
create table if not exists public.commission_plans (
  id          bigserial primary key,
  name        text not null,
  description text,

  service_rate_bp int not null default 0
    check (service_rate_bp between 0 and 10000),
  retail_rate_bp  int not null default 0
    check (retail_rate_bp between 0 and 10000),
  -- Paid on top of the percentage, once per service performed. A studio that
  -- pays "35% plus $5 a facial" needs both.
  service_flat_cents int not null default 0 check (service_flat_cents >= 0),

  is_active  boolean not null default true,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists commission_plans_name_key
  on public.commission_plans (lower(name));

-- A plan is a catalogue entry, not a place: the same "Provider standard" card
-- can be handed out at two sites. The location lives on the assignment, which
-- is where "she earns more at the Clovis room" actually means something.

/** Per-category rates, e.g. 45% on peels and 30% on everything else. */
create table if not exists public.commission_category_rates (
  plan_id     bigint not null references public.commission_plans(id) on delete cascade,
  category_id bigint not null references public.service_categories(id) on delete cascade,
  rate_bp     int check (rate_bp is null or rate_bp between 0 and 10000),
  flat_cents  int check (flat_cents is null or flat_cents >= 0),
  primary key (plan_id, category_id),
  constraint commission_category_rate_says_something
    check (rate_bp is not null or flat_cents is not null)
);

/** One service that pays differently from its category. The most specific
    statement available, so it wins over everything else. */
create table if not exists public.commission_service_rates (
  plan_id    bigint not null references public.commission_plans(id) on delete cascade,
  service_id bigint not null references public.services(id) on delete cascade,
  rate_bp    int check (rate_bp is null or rate_bp between 0 and 10000),
  flat_cents int check (flat_cents is null or flat_cents >= 0),
  primary key (plan_id, service_id),
  constraint commission_service_rate_says_something
    check (rate_bp is not null or flat_cents is not null)
);

/**
 * Tiers: the rate improves once the month passes a number.
 *
 * The band is read from what the provider has actually collected in the
 * calendar month the appointment falls in, at that site, in that site's
 * wall-clock. So a figure asked for mid-month moves as the month fills and
 * settles when the month closes, which is what a percentage-of-monthly-revenue
 * arrangement means.
 */
create table if not exists public.commission_tiers (
  id               bigserial primary key,
  plan_id          bigint not null references public.commission_plans(id) on delete cascade,
  applies_to       text not null check (applies_to in ('service', 'retail')),
  min_period_cents int not null check (min_period_cents >= 0),
  rate_bp          int not null check (rate_bp between 0 and 10000),
  unique (plan_id, applies_to, min_period_cents)
);

-- ── Who is on what, and since when ───────────────────────────
create table if not exists public.staff_commission_plans (
  id          bigserial primary key,
  profile_id  uuid   not null references public.profiles(id) on delete cascade,
  plan_id     bigint not null references public.commission_plans(id) on delete restrict,
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),

  -- Wall-clock dates in the location's zone, not instants. "She moved to the
  -- new plan on the first of March" is a statement about a calendar.
  effective_from date not null,
  effective_to   date,

  note       text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint staff_commission_plan_window
    check (effective_to is null or effective_to >= effective_from)
);

create index if not exists staff_commission_plans_lookup_idx
  on public.staff_commission_plans (profile_id, location_id, effective_from desc);

-- Two plans in force for one person at one site on one day is not a policy
-- decision anyone can make, so it is not representable. Same instinct as the
-- double-booking guard in 004: the application can render whatever it likes,
-- the constraint is what makes it true. btree_gist comes from 001.
alter table public.staff_commission_plans
  drop constraint if exists staff_commission_plans_no_overlap;
alter table public.staff_commission_plans
  add constraint staff_commission_plans_no_overlap
  exclude using gist (
    profile_id  with =,
    location_id with =,
    daterange(effective_from, effective_to, '[]') with &&
  );

comment on table public.staff_commission_plans is
  'Which plan a person is on, at which site, between which dates. A report for '
  'March has to read March''s row — that is what the dates are for.';

drop trigger if exists commission_plans_touch on public.commission_plans;
create trigger commission_plans_touch
  before update on public.commission_plans
  for each row execute function public.touch_updated_at();

drop trigger if exists staff_commission_plans_touch on public.staff_commission_plans;
create trigger staff_commission_plans_touch
  before update on public.staff_commission_plans
  for each row execute function public.touch_updated_at();

-- ── A rate that has been in force is frozen ──────────────────
--
-- Otherwise every historical figure is a lie waiting to happen: edit "Provider
-- standard" from 40% to 45% and last March silently repays itself. The
-- remedy is the one the assignment table already exists for — make a new plan
-- and assign it from a date.
--
-- Renaming, describing and deactivating stay open, because none of those
-- change a number. Assignments themselves stay editable by an admin: getting
-- an assignment wrong has to be fixable, and moving somebody's dates is a
-- visible act on a five-row table, where quietly editing a rate under an
-- unchanged plan name is not. Freeze the change nobody can see.
create or replace function public.commission_plan_freeze_rates()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (new.service_rate_bp    is distinct from old.service_rate_bp
      or new.retail_rate_bp  is distinct from old.retail_rate_bp
      or new.service_flat_cents is distinct from old.service_flat_cents)
     and exists (
       select 1 from public.staff_commission_plans scp
       where scp.plan_id = old.id
         and scp.effective_from <= current_date
     ) then
    raise exception
      'This plan has already been in force. Create a new plan and assign it '
      'from a date rather than changing what someone was owed.';
  end if;
  return new;
end;
$$;

drop trigger if exists commission_plans_freeze_rates on public.commission_plans;
create trigger commission_plans_freeze_rates
  before update on public.commission_plans
  for each row execute function public.commission_plan_freeze_rates();

/** The same argument, for the rate tables hanging off the plan. */
create or replace function public.commission_rate_row_freeze()
returns trigger language plpgsql security definer set search_path = public as $$
declare target bigint;
begin
  target := case when tg_op = 'DELETE' then old.plan_id else new.plan_id end;
  if exists (
    select 1 from public.staff_commission_plans scp
    where scp.plan_id = target and scp.effective_from <= current_date
  ) then
    raise exception
      'This plan has already been in force. Create a new plan rather than '
      'changing what someone was owed.';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;

drop trigger if exists commission_category_rates_freeze on public.commission_category_rates;
create trigger commission_category_rates_freeze
  before insert or update or delete on public.commission_category_rates
  for each row execute function public.commission_rate_row_freeze();

drop trigger if exists commission_service_rates_freeze on public.commission_service_rates;
create trigger commission_service_rates_freeze
  before insert or update or delete on public.commission_service_rates
  for each row execute function public.commission_rate_row_freeze();

drop trigger if exists commission_tiers_freeze on public.commission_tiers;
create trigger commission_tiers_freeze
  before insert or update or delete on public.commission_tiers
  for each row execute function public.commission_rate_row_freeze();

-- ── Nobody puts themselves on a plan ─────────────────────────
create or replace function public.staff_commission_plans_guard()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  row_profile uuid;
  row_out     public.staff_commission_plans;
begin
  if tg_op = 'DELETE' then
    row_profile := old.profile_id;
    row_out     := old;
  else
    row_profile := new.profile_id;
    row_out     := new;
  end if;

  -- Migration, psql, or the service role — already privileged, as in 001.
  if auth.uid() is null or public.is_admin() then
    return row_out;
  end if;

  if row_profile = auth.uid() then
    raise exception 'You cannot put yourself on a commission plan.';
  end if;

  if not public.has_permission('manage_staff') then
    raise exception 'You cannot change commission plans.';
  end if;

  return row_out;
end;
$$;

drop trigger if exists staff_commission_plans_guard on public.staff_commission_plans;
create trigger staff_commission_plans_guard
  before insert or update or delete on public.staff_commission_plans
  for each row execute function public.staff_commission_plans_guard();

-- ── Resolving a plan for a date ──────────────────────────────

/**
 * The site's wall-clock date for an instant.
 *
 * `locations.timezone` is authoritative and there is no fallback: an unknown
 * location returns null and every figure downstream returns zero, which is the
 * right answer for "I cannot tell you where this happened".
 */
create or replace function public.commission_service_date(
  p_instant  timestamptz,
  p_location bigint
) returns date language sql stable security definer set search_path = public as $$
  select (p_instant at time zone l.timezone)::date
  from public.locations l
  where l.id = p_location;
$$;

-- Where the work happened comes from `appointments.location_id` and
-- `orders.location_id`, both added in 032. Nothing below infers a site, which
-- is what makes "she earns more at the second room" mean something the moment
-- there is a second room.

/**
 * The plan in force for this person, at this site, on this date.
 *
 * Deliberately does not care whether the plan is still active: a retired plan
 * still governs the months it was in force, and a report for those months has
 * to say what was actually owed.
 */
create or replace function public.commission_plan_on(
  p_profile  uuid,
  p_location bigint,
  p_on       date
) returns bigint language sql stable security definer set search_path = public as $$
  select scp.plan_id
  from public.staff_commission_plans scp
  where scp.profile_id  = p_profile
    and scp.location_id = p_location
    and scp.effective_from <= p_on
    and (scp.effective_to is null or scp.effective_to >= p_on)
  order by scp.effective_from desc
  limit 1;
$$;

/** Money actually taken on this person's services in a window, at a site. */
create or replace function public.commission_collected_service_cents(
  p_profile  uuid,
  p_location bigint,
  p_from     date,
  p_to       date
) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(pay.amount_cents), 0)::bigint
  from public.payments pay
  join public.appointments a on a.id = pay.appointment_id
  where a.provider_id = p_profile
    and a.location_id = p_location
    and pay.status = 'succeeded'
    and public.commission_service_date(a.starts_at, p_location) between p_from and p_to;
$$;

/** The same for retail rung up by this person. */
create or replace function public.commission_collected_retail_cents(
  p_profile  uuid,
  p_location bigint,
  p_from     date,
  p_to       date
) returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(pay.amount_cents), 0)::bigint
  from public.payments pay
  join public.orders o on o.id = pay.order_id
  where o.sold_by = p_profile
    and o.location_id = p_location
    and pay.status = 'succeeded'
    and public.commission_service_date(
          coalesce(o.paid_at, o.created_at), p_location) between p_from and p_to;
$$;

/** The best tier the period's takings reach, or null for "use the plan rate". */
create or replace function public.commission_tier_rate(
  p_plan         bigint,
  p_kind         text,
  p_period_cents bigint
) returns int language sql stable security definer set search_path = public as $$
  select t.rate_bp
  from public.commission_tiers t
  where t.plan_id = p_plan
    and t.applies_to = p_kind
    and t.min_period_cents <= greatest(p_period_cents, 0)
  order by t.min_period_cents desc
  limit 1;
$$;

/**
 * May this person be told what that person earned?
 *
 * Yourself always; otherwise it is a money report.
 */
create or replace function public.can_read_commission(p_profile uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is null
      or auth.uid() = p_profile
      or public.is_admin()
      or public.has_permission('view_financial_reports')
      or public.has_permission('manage_staff');
$$;

-- ── The calculation ──────────────────────────────────────────

/**
 * What this appointment earned its provider, in cents.
 *
 * Reads the plan that was in force on the day of the appointment, in the
 * site's wall-clock — not today's plan. Pays on money taken, so an appointment
 * nobody paid for is worth nothing however it is marked, and a forfeited
 * deposit on a no-show is worth the deposit, because that money did arrive.
 * Refunds are negative rows in `payments` and net themselves out.
 *
 * Rate precedence, most specific first: the service, then its category, then
 * the tier the month has reached, then the plan's own rate.
 *
 * The arithmetic: every line contributes to one numerator over the common
 * denominator (line value × 10000), and there is exactly one integer division
 * at the end. No float, one truncation, and partial payment is honoured pro
 * rata rather than by paying on what was merely billed.
 *
 * p_location is a filter, not an override — the appointment knows where it
 * happened, and asking about a site it did not happen at is answered with zero
 * rather than with that site's rates applied to somebody else's work.
 */
create or replace function public.commission_for_appointment(
  p_appointment uuid,
  p_location    bigint default null
) returns int language plpgsql stable security definer set search_path = public as $$
declare
  a            public.appointments%rowtype;
  loc          bigint;
  svc_date     date;
  plan         bigint;
  collected    bigint;
  line_value   bigint;
  period_cents bigint;
  tier_bp      int;
  plan_rate    int;
  plan_flat    int;
  numerator    bigint;
begin
  select * into a from public.appointments where id = p_appointment;
  if not found then
    return 0;
  end if;

  if not public.can_read_commission(a.provider_id) then
    raise exception 'You cannot read commission figures for someone else';
  end if;

  loc := a.location_id;
  if p_location is not null and p_location <> loc then
    return 0;
  end if;

  svc_date := public.commission_service_date(a.starts_at, loc);
  if svc_date is null then
    return 0;
  end if;

  -- No plan in force at that site on that day is not an error, it is zero.
  -- Falling back to a plan from a different site would quietly pay the wrong
  -- rate, which is worse than paying nothing and being asked about it.
  plan := public.commission_plan_on(a.provider_id, loc, svc_date);
  if plan is null then
    return 0;
  end if;

  select coalesce(sum(pay.amount_cents), 0) into collected
  from public.payments pay
  where pay.appointment_id = a.id and pay.status = 'succeeded';

  if collected <= 0 then
    return 0;
  end if;

  select coalesce(sum(price_cents), 0) into line_value
  from public.appointment_services where appointment_id = a.id;

  if line_value <= 0 then
    return 0;
  end if;

  -- A tip or an overpayment is not service revenue.
  collected := least(collected, line_value);

  select cp.service_rate_bp, cp.service_flat_cents
    into plan_rate, plan_flat
  from public.commission_plans cp where cp.id = plan;

  period_cents := public.commission_collected_service_cents(
    a.provider_id, loc,
    date_trunc('month', svc_date)::date,
    (date_trunc('month', svc_date) + interval '1 month - 1 day')::date
  );
  tier_bp := public.commission_tier_rate(plan, 'service', period_cents);

  select coalesce(sum(
           collected * line.price_cents * coalesce(line.rate_bp, tier_bp, plan_rate)
           -- Flat is per service performed, so add-on lines do not attract it.
           + case when line.service_id is not null
                  then collected * coalesce(line.flat_cents, plan_flat) * 10000
                  else 0 end
         ), 0)
    into numerator
  from (
    select
      s.service_id,
      s.price_cents::bigint as price_cents,
      coalesce(sr.rate_bp, cr.rate_bp)       as rate_bp,
      coalesce(sr.flat_cents, cr.flat_cents) as flat_cents
    from public.appointment_services s
    left join public.services svc on svc.id = s.service_id
    left join public.commission_service_rates sr
      on sr.plan_id = plan and sr.service_id = s.service_id
    left join public.commission_category_rates cr
      on cr.plan_id = plan and cr.category_id = svc.category_id
    where s.appointment_id = a.id
  ) line;

  -- Truncating rather than rounding costs under a cent per line and keeps the
  -- figure reproducible from the ledger without a rounding convention to argue
  -- about.
  return (numerator / (line_value * 10000))::int;
end;
$$;

/**
 * What this retail order earned whoever rang it up, in cents.
 *
 * An online order has no `sold_by` and earns nobody anything — no one stood at
 * a counter. Commission is on the goods, not on the sales tax or the postage,
 * so the base is subtotal less discount while the collection ratio is measured
 * against the total the client actually owed.
 */
create or replace function public.commission_for_order(
  p_order    bigint,
  p_location bigint default null
) returns int language plpgsql stable security definer set search_path = public as $$
declare
  o            public.orders%rowtype;
  loc          bigint;
  sale_date    date;
  plan         bigint;
  collected    bigint;
  base         bigint;
  period_cents bigint;
  rate_bp      int;
begin
  select * into o from public.orders where id = p_order;
  if not found or o.sold_by is null then
    return 0;
  end if;

  if not public.can_read_commission(o.sold_by) then
    raise exception 'You cannot read commission figures for someone else';
  end if;

  loc := o.location_id;
  if p_location is not null and p_location <> loc then
    return 0;
  end if;

  sale_date := public.commission_service_date(coalesce(o.paid_at, o.created_at), loc);
  if sale_date is null then
    return 0;
  end if;

  plan := public.commission_plan_on(o.sold_by, loc, sale_date);
  if plan is null then
    return 0;
  end if;

  select coalesce(sum(pay.amount_cents), 0) into collected
  from public.payments pay
  where pay.order_id = o.id and pay.status = 'succeeded';

  if collected <= 0 or o.total_cents <= 0 then
    return 0;
  end if;
  collected := least(collected, o.total_cents::bigint);

  base := greatest(o.subtotal_cents - o.discount_cents, 0)::bigint;
  if base <= 0 then
    return 0;
  end if;

  period_cents := public.commission_collected_retail_cents(
    o.sold_by, loc,
    date_trunc('month', sale_date)::date,
    (date_trunc('month', sale_date) + interval '1 month - 1 day')::date
  );

  rate_bp := coalesce(
    public.commission_tier_rate(plan, 'retail', period_cents),
    (select cp.retail_rate_bp from public.commission_plans cp where cp.id = plan)
  );

  return ((collected * base * rate_bp) / (o.total_cents::bigint * 10000))::int;
end;
$$;

/**
 * What one person earned over a window, at one site or across all of them.
 *
 * p_location null means every site, which is the figure the studio pays out;
 * naming a site is how "what did the Clovis room cost me" gets answered. Each
 * appointment and order is priced by the plan in force on its own date, so a
 * window that straddles a plan change comes out right without anyone having to
 * split it by hand.
 */
create or replace function public.commission_for_period(
  p_profile  uuid,
  p_from     date,
  p_to       date,
  p_location bigint default null
) returns table (
  service_cents bigint,
  retail_cents  bigint,
  total_cents   bigint
) language plpgsql stable security definer set search_path = public as $$
declare
  loc      bigint;
  svc_sum  bigint := 0;
  ret_sum  bigint := 0;
  r        record;
begin
  if not public.can_read_commission(p_profile) then
    raise exception 'You cannot read commission figures for someone else';
  end if;

  for loc in
    select l.id from public.locations l
    where p_location is null or l.id = p_location
  loop
    for r in
      select a.id
      from public.appointments a
      where a.provider_id = p_profile
        and a.location_id = loc
        and public.commission_service_date(a.starts_at, loc) between p_from and p_to
    loop
      svc_sum := svc_sum + public.commission_for_appointment(r.id, loc);
    end loop;

    for r in
      select o.id
      from public.orders o
      where o.sold_by = p_profile
        and o.location_id = loc
        and public.commission_service_date(
              coalesce(o.paid_at, o.created_at), loc) between p_from and p_to
    loop
      ret_sum := ret_sum + public.commission_for_order(r.id, loc);
    end loop;
  end loop;

  service_cents := svc_sum;
  retail_cents  := ret_sum;
  total_cents   := svc_sum + ret_sum;
  return next;
end;
$$;

-- ── RLS ──────────────────────────────────────────────────────
alter table public.commission_plans          enable row level security;
alter table public.commission_category_rates enable row level security;
alter table public.commission_service_rates  enable row level security;
alter table public.commission_tiers          enable row level security;
alter table public.staff_commission_plans    enable row level security;

-- What you are paid is not a secret from you. Everyone else needs a reason.
drop policy if exists "read commission plans" on public.commission_plans;
create policy "read commission plans" on public.commission_plans
  for select to authenticated
  using (
    public.has_permission('view_financial_reports')
    or public.has_permission('manage_staff')
    or exists (
      -- Qualified: staff_commission_plans has an `id` of its own, and an
      -- unqualified one here binds to the inner table, not to the plan.
      select 1 from public.staff_commission_plans scp
      where scp.plan_id = commission_plans.id and scp.profile_id = auth.uid()
    )
  );

drop policy if exists "manage commission plans" on public.commission_plans;
create policy "manage commission plans" on public.commission_plans
  for all to authenticated
  using (public.has_permission('manage_staff'))
  with check (public.has_permission('manage_staff'));

drop policy if exists "read category rates" on public.commission_category_rates;
create policy "read category rates" on public.commission_category_rates
  for select to authenticated
  using (
    public.has_permission('view_financial_reports')
    or public.has_permission('manage_staff')
    or exists (
      select 1 from public.staff_commission_plans scp
      where scp.plan_id = commission_category_rates.plan_id
        and scp.profile_id = auth.uid()
    )
  );

drop policy if exists "manage category rates" on public.commission_category_rates;
create policy "manage category rates" on public.commission_category_rates
  for all to authenticated
  using (public.has_permission('manage_staff'))
  with check (public.has_permission('manage_staff'));

drop policy if exists "read service rates" on public.commission_service_rates;
create policy "read service rates" on public.commission_service_rates
  for select to authenticated
  using (
    public.has_permission('view_financial_reports')
    or public.has_permission('manage_staff')
    or exists (
      select 1 from public.staff_commission_plans scp
      where scp.plan_id = commission_service_rates.plan_id
        and scp.profile_id = auth.uid()
    )
  );

drop policy if exists "manage service rates" on public.commission_service_rates;
create policy "manage service rates" on public.commission_service_rates
  for all to authenticated
  using (public.has_permission('manage_staff'))
  with check (public.has_permission('manage_staff'));

drop policy if exists "read commission tiers" on public.commission_tiers;
create policy "read commission tiers" on public.commission_tiers
  for select to authenticated
  using (
    public.has_permission('view_financial_reports')
    or public.has_permission('manage_staff')
    or exists (
      select 1 from public.staff_commission_plans scp
      where scp.plan_id = commission_tiers.plan_id
        and scp.profile_id = auth.uid()
    )
  );

drop policy if exists "manage commission tiers" on public.commission_tiers;
create policy "manage commission tiers" on public.commission_tiers
  for all to authenticated
  using (public.has_permission('manage_staff'))
  with check (public.has_permission('manage_staff'));

drop policy if exists "read own commission assignment" on public.staff_commission_plans;
create policy "read own commission assignment" on public.staff_commission_plans
  for select to authenticated
  using (
    profile_id = auth.uid()
    or public.has_permission('view_financial_reports')
    or public.has_permission('manage_staff')
  );

drop policy if exists "manage commission assignments" on public.staff_commission_plans;
create policy "manage commission assignments" on public.staff_commission_plans
  for all to authenticated
  using (public.has_permission('manage_staff'))
  with check (public.has_permission('manage_staff'));

grant select, insert, update, delete on public.commission_plans          to authenticated;
grant select, insert, update, delete on public.commission_category_rates to authenticated;
grant select, insert, update, delete on public.commission_service_rates  to authenticated;
grant select, insert, update, delete on public.commission_tiers          to authenticated;
grant select, insert, update, delete on public.staff_commission_plans    to authenticated;
grant usage, select on sequence public.commission_plans_id_seq       to authenticated;
grant usage, select on sequence public.commission_tiers_id_seq       to authenticated;
grant usage, select on sequence public.staff_commission_plans_id_seq to authenticated;

grant all on public.commission_plans          to service_role;
grant all on public.commission_category_rates to service_role;
grant all on public.commission_service_rates  to service_role;
grant all on public.commission_tiers          to service_role;
grant all on public.staff_commission_plans    to service_role;
grant usage, select on sequence public.commission_plans_id_seq       to service_role;
grant usage, select on sequence public.commission_tiers_id_seq       to service_role;
grant usage, select on sequence public.staff_commission_plans_id_seq to service_role;

revoke all on public.commission_plans          from anon;
revoke all on public.commission_category_rates from anon;
revoke all on public.commission_service_rates  from anon;
revoke all on public.commission_tiers          from anon;
revoke all on public.staff_commission_plans    from anon;

grant execute on function public.commission_for_appointment(uuid, bigint)       to authenticated;
grant execute on function public.commission_for_order(bigint, bigint)           to authenticated;
grant execute on function public.commission_for_period(uuid, date, date, bigint) to authenticated;
grant execute on function public.commission_plan_on(uuid, bigint, date)         to authenticated;
grant execute on function public.can_read_commission(uuid)                      to authenticated;
revoke all on function public.commission_for_appointment(uuid, bigint)          from anon;
revoke all on function public.commission_for_order(bigint, bigint)              from anon;
revoke all on function public.commission_for_period(uuid, date, date, bigint)   from anon;

-- ── Seed: something to assign ────────────────────────────────
-- One plan, at the rates the studio quoted. Nobody is assigned to it — who is
-- on what is a decision, and the dashboard is where it gets made.
insert into public.commission_plans (name, description, service_rate_bp, retail_rate_bp)
select 'Provider standard',
       'The default rate card: 40% of service revenue collected, 10% of retail.',
       4000, 1000
where not exists (
  select 1 from public.commission_plans where lower(name) = 'provider standard'
);
