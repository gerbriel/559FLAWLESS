-- ============================================================
-- 559 Flawless — 092: no login is not anon
--
-- 091's guard on profiles.stripe_customer_id let a caller through when there
-- was no login (auth.uid() null) and current_user was not anon or
-- authenticated, reading that as "a migration or the SQL editor". current_user
-- is not a safe witness: inside any SECURITY DEFINER function it is the
-- function's owner, so a definer function that updates profiles, called with
-- the public anon key and no session, would run with auth.uid() null and
-- current_user = postgres, and pass.
--
-- The no-login clause is now about the request itself: no JWT role AND no
-- user. A request made through the API always carries a role claim (anon,
-- authenticated or service_role), so only a direct database connection (a
-- migration, the SQL editor) has neither. Same message, same errcode.
--
-- Idempotent: create or replace; the 091 trigger already points at it.
-- ============================================================

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
  if auth.role() is null and auth.uid() is null then
    return new;
  end if;

  raise exception 'Only the service role can set a Stripe customer'
    using errcode = '42501';
end;
$$;

revoke all on function public.guard_profile_stripe_customer() from public, anon, authenticated;
