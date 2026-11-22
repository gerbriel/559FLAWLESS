-- ============================================================
-- 559 Flawless — 091: one customer at Stripe
--
-- Until now every Stripe Checkout Session carried only an email. Stripe saw a
-- new "guest customer" on each payment, so a client's deposit, balance, bag
-- and membership showed up as four strangers, no card could be saved, and a
-- promotion code locked to a customer or limited to a first purchase could
-- never be redeemed. The only customer object anyone had was the one Stripe
-- made for a renewing membership (083), kept on client_memberships.
--
-- From here a signed-in client has ONE Stripe customer, made the first time
-- they pay anything (src/lib/stripe-customer.ts) and reused on every later
-- session. It lives on the profile:
--
--   profiles.stripe_customer_id   null until the first payment; unique where
--                                 set, so two people can never share one
--
-- Guests (no account) are unchanged: email only.
--
-- Who may write it. The "update own profile" and "insert own profile"
-- policies (001) would otherwise let a client point their own profile at
-- someone else's customer, and with it that person's saved cards and
-- payment history at Checkout. So a trigger refuses any insert that sets it,
-- or update that changes it, unless the caller is the service role
-- (auth.role() = 'service_role'), or there is no login at all and the
-- connection is not one of the API roles (a migration, the SQL editor).
-- The second clause is 001's "no JWT means privileged" reading, but with the
-- check 085 showed it needs: a request with the anon key has no auth.uid()
-- either, and runs as anon, so it is refused here. The function is NOT
-- security definer on purpose: current_user must be the caller's role.
-- Raises 42501.
--
-- Backfill: a profile with none takes the most recent customer id from its
-- own client_memberships rows, when that id belongs to that one client only.
-- client_memberships.stripe_customer_id stays as it is; the webhook still
-- writes it there for a renewing membership.
--
-- Idempotent: safe to run twice.
-- ============================================================

alter table public.profiles
  add column if not exists stripe_customer_id text;

create unique index if not exists profiles_stripe_customer_id_key
  on public.profiles (stripe_customer_id)
  where stripe_customer_id is not null;

-- ── Only the service role sets it ────────────────────────────
create or replace function public.guard_profile_stripe_customer()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    if new.stripe_customer_id is null then
      return new;
    end if;
  elsif new.stripe_customer_id is not distinct from old.stripe_customer_id then
    return new;
  end if;

  if auth.role() = 'service_role' then
    return new;
  end if;
  if auth.uid() is null and current_user not in ('anon', 'authenticated') then
    return new;
  end if;

  raise exception 'Only the service role can set a Stripe customer'
    using errcode = '42501';
end;
$$;

revoke all on function public.guard_profile_stripe_customer() from public, anon, authenticated;

-- ── Backfill from memberships ────────────────────────────────
-- Runs before the trigger exists on a first apply; on a second apply it runs
-- as the migration role, which the trigger lets through.
with latest as (
  select distinct on (m.client_id) m.client_id, m.stripe_customer_id
  from public.client_memberships m
  where m.stripe_customer_id is not null
  order by m.client_id, m.created_at desc, m.id desc
),
sole as (
  select l.client_id, l.stripe_customer_id
  from latest l
  where not exists (
    select 1 from public.client_memberships o
    where o.stripe_customer_id = l.stripe_customer_id
      and o.client_id is distinct from l.client_id
  )
)
update public.profiles p
set stripe_customer_id = s.stripe_customer_id
from sole s
where p.id = s.client_id
  and p.stripe_customer_id is null
  and not exists (
    select 1 from public.profiles q where q.stripe_customer_id = s.stripe_customer_id
  );

drop trigger if exists profiles_guard_stripe_customer on public.profiles;
create trigger profiles_guard_stripe_customer
  before insert or update of stripe_customer_id on public.profiles
  for each row execute function public.guard_profile_stripe_customer();

comment on column public.profiles.stripe_customer_id is
  'The client''s one Stripe customer (091). Set by the service role only.';
