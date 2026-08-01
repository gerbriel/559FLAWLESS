-- ============================================================
-- 559 Flawless — 022: staff-editable services, one newsletter list
-- ============================================================

-- ── 1. Managers maintain the menu; admins own the safety gates ──
--
-- Previously the whole services table was admin-only, which meant nobody could
-- correct a price without the owner's login. But the original reason for that
-- lock is still sound: an age gate or a deposit rule is not a pricing decision,
-- and a front desk employee should not be able to quietly clear one.
--
-- So the split is by column, not by table. RLS cannot express that, so the
-- policy opens the table to managers and a trigger guards the specific columns.

drop policy if exists "admin writes services" on public.services;
drop policy if exists "admin writes categories" on public.service_categories;
drop policy if exists "admin writes addons" on public.service_addons;

drop policy if exists "manager writes services" on public.services;
create policy "manager writes services" on public.services
  for all using (public.is_manager()) with check (public.is_manager());
drop policy if exists "manager writes categories" on public.service_categories;
create policy "manager writes categories" on public.service_categories
  for all using (public.is_manager()) with check (public.is_manager());
drop policy if exists "manager writes addons" on public.service_addons;
create policy "manager writes addons" on public.service_addons
  for all using (public.is_manager()) with check (public.is_manager());

/**
 * Refuse changes to the booking gates from anyone but an admin.
 *
 * These are the fields that decide whether a minor can book an intimate
 * service, and whether a no-show costs anything. They are deliberately harder
 * to change than a price.
 */
create or replace function public.services_guard_gates()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- The service role and the SQL editor are already privileged.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.is_intimate or new.requires_age_verification or new.deposit_cents > 0
       or new.patch_test_hours > 0 then
      raise exception 'Only an admin can create a service with an age gate, a patch test, or a deposit';
    end if;
    return new;
  end if;

  if new.is_intimate               is distinct from old.is_intimate
   or new.requires_age_verification is distinct from old.requires_age_verification
   or new.min_age                   is distinct from old.min_age
   or new.requires_consultation     is distinct from old.requires_consultation
   or new.patch_test_hours          is distinct from old.patch_test_hours
   or new.deposit_cents             is distinct from old.deposit_cents
   or new.cancellation_window_hours is distinct from old.cancellation_window_hours then
    raise exception 'Only an admin can change age gates, patch tests, or deposit rules';
  end if;

  return new;
end;
$$;

drop trigger if exists services_guard_gates on public.services;
create trigger services_guard_gates
  before insert or update on public.services
  for each row execute function public.services_guard_gates();

-- Deleting a service that has already been booked would orphan history.
-- Archiving via is_active is the intended route; this makes the accident loud.
create or replace function public.services_block_booked_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.appointment_services where service_id = old.id) then
    raise exception 'This service appears in past appointments. Switch it off instead of deleting it.';
  end if;
  return old;
end;
$$;

drop trigger if exists services_block_booked_delete on public.services;
create trigger services_block_booked_delete
  before delete on public.services
  for each row execute function public.services_block_booked_delete();

-- ── 2. One newsletter list ───────────────────────────────────
--
-- There were two: `newsletter_subscribers` (what the public form actually
-- writes to) and `newsletter_subscriptions` (read by one dashboard page). A
-- signup landing in one and the studio looking at the other is precisely why
-- submissions appeared to go nowhere.
--
-- `newsletter_subscribers` wins: it is where the real data is, its email is
-- unique, and it already carries the unsubscribe token. Anything sitting in the
-- other table is folded in rather than lost.

insert into public.newsletter_subscribers (email, status, source, client_id, subscribed_at, unsubscribed_at)
select
  lower(s.email),
  case when s.is_subscribed then 'active'::public.subscriber_status
       else 'unsubscribed'::public.subscriber_status end,
  'imported',
  s.profile_id,
  s.subscribed_at,
  s.unsubscribed_at
from public.newsletter_subscriptions s
on conflict (email) do nothing;

comment on table public.newsletter_subscriptions is
  'Superseded by newsletter_subscribers. Retained for the consent evidence '
  '(IP and user agent) it holds; nothing reads it for day-to-day work.';

-- Match on email so the studio can see which subscribers became clients.
create or replace function public.link_newsletter_to_profile(p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  select id into target from public.profiles
  where lower(email) = lower(p_email) and role = 'client' limit 1;
  if target is null then return; end if;

  update public.newsletter_subscribers
  set client_id = target
  where lower(email) = lower(p_email) and client_id is null;

  update public.newsletter_subscriptions
  set profile_id = target
  where lower(email) = lower(p_email) and profile_id is null;
end;
$$;

-- The trigger from 021 pointed at newsletter_subscriptions only; repoint it.
create or replace function public.newsletter_claim_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.link_newsletter_to_profile(new.email);
  return null;
end;
$$;

drop trigger if exists newsletter_subscribers_claim on public.newsletter_subscribers;
create trigger newsletter_subscribers_claim
  after insert on public.newsletter_subscribers
  for each row execute function public.newsletter_claim_profile();

-- Staff need to read the list to work it.
drop policy if exists "staff reads subscribers" on public.newsletter_subscribers;
create policy "staff reads subscribers" on public.newsletter_subscribers
  for select using (public.is_staff());
drop policy if exists "staff writes subscribers" on public.newsletter_subscribers;
create policy "staff writes subscribers" on public.newsletter_subscribers
  for all using (public.is_front_desk()) with check (public.is_front_desk());

-- Backfill both directions for what is already there.
do $$
declare r record;
begin
  for r in select distinct email from public.newsletter_subscribers where client_id is null loop
    perform public.link_newsletter_to_profile(r.email);
  end loop;
end $$;
