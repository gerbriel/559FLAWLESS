-- ============================================================
-- 559 Flawless — migrations 020 through 026
--
-- Paste the whole file into the Supabase SQL editor and run it once.
-- Safe to re-run: every statement is create-or-replace / if-not-exists.
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- 020_solo_operator_providers.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 020: let any staff member be bookable
--
-- The role enum treats 'provider' and 'admin' as separate people. That is right
-- for a studio with a front desk and several estheticians, and wrong for this
-- one: 559 Flawless is one person who both owns the business and performs the
-- treatments. Forcing her to choose meant either an owner who cannot be booked
-- or a provider who cannot reach Settings.
--
-- So "is this person bookable" stops being a question about their role and
-- becomes what it always should have been: `accepts_online_booking`, plus not
-- being a client and not being suspended. A role is about permissions; whether
-- someone takes appointments is a separate fact.
-- ============================================================

-- The public booking page needs to read whoever is bookable.
drop policy if exists "public read bookable providers" on public.profiles;
create policy "public read bookable providers"
  on public.profiles for select to anon, authenticated
  using (
    role <> 'client'
    and accepts_online_booking
    and suspended_at is null
  );

-- `is_provider()` answers "does this person treat clients", which an admin who
-- runs the room absolutely does. Permission checks use is_manager/is_admin and
-- are unaffected.
create or replace function public.is_provider()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role <> 'client'
      and accepts_online_booking
      and suspended_at is null
  );
$$;

comment on column public.profiles.accepts_online_booking is
  'Whether this staff member takes appointments. Independent of role, so a solo '
  'owner can be admin and bookable at the same time.';

-- ─────────────────────────────────────────────────────────────
-- 021_inventory_pos_announcements.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 021: direct stock control, in-store sales,
--                     announcement presentation, legal pages
--
-- Three changes the studio asked for, plus the schema an in-person sale needs.
-- ============================================================

-- ── 1. Stock is edited directly, not queued for approval ─────
--
-- The approval queue came from united-metal-components, where a warehouse and
-- an office are different people with different authority. Here it is one or
-- two people in one room, and making the owner approve her own count is pure
-- friction. Staff now write stock themselves and managers are told after the
-- fact.
--
-- inventory_change_requests is intentionally NOT dropped: existing rows are a
-- record of what was proposed and decided. It just stops being part of the flow.

drop policy if exists "manager writes products" on public.products;

-- Creating and deleting a product is still a manager decision — that is
-- catalogue shape, not day-to-day counting.
drop policy if exists "manager creates products" on public.products;
create policy "manager creates products" on public.products
  for insert with check (public.is_manager());
drop policy if exists "manager deletes products" on public.products;
create policy "manager deletes products" on public.products
  for delete using (public.is_manager());

-- Any staff member can maintain an existing product: stock, thresholds,
-- whether it is retail or back bar.
drop policy if exists "staff updates products" on public.products;
create policy "staff updates products" on public.products
  for update using (public.is_staff()) with check (public.is_staff());

/**
 * The single entry point for changing stock, now with an authorisation check of
 * its own (it is SECURITY DEFINER, so it must not take anyone's word for it)
 * and a notification to whoever runs the place.
 */
create or replace function public.adjust_stock(
  p_product_id bigint,
  p_change     numeric,
  p_reason     public.stock_reason,
  p_note       text default null,
  p_appointment uuid default null
) returns numeric language plpgsql security definer set search_path = public as $$
declare
  new_balance numeric;
  product_name text;
  product_unit text;
  actor_name  text;
  actor_role  public.user_role;
begin
  select role into actor_role from public.profiles where id = auth.uid();

  -- auth.uid() is null for the service role and the SQL editor, which are
  -- already privileged. An authenticated caller must be staff.
  if auth.uid() is not null and (actor_role is null or actor_role = 'client') then
    raise exception 'Only staff can adjust stock';
  end if;

  update public.products
  set stock_qty = stock_qty + p_change
  where id = p_product_id
  returning stock_qty, name, unit into new_balance, product_name, product_unit;

  if new_balance is null then
    raise exception 'Unknown product %', p_product_id;
  end if;

  insert into public.inventory_log
    (product_id, change_qty, balance_after, reason, note, appointment_id, changed_by)
  values (p_product_id, p_change, new_balance, p_reason, p_note, p_appointment, auth.uid());

  -- Tell the managers, but only about deliberate counts. 'sold' and 'consumed'
  -- fire automatically on every sale and every completed appointment; notifying
  -- on those would bury the ones that need a human eye.
  if p_reason not in ('sold', 'consumed') and auth.uid() is not null then
    select trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))
    into actor_name from public.profiles where id = auth.uid();

    insert into public.notifications (user_id, type, title, body, link)
    select p.id, 'system',
           'Stock updated — ' || product_name,
           coalesce(nullif(actor_name,''), 'Someone') || ' recorded ' ||
           (case when p_change >= 0 then '+' else '' end) || p_change || ' ' || product_unit ||
           ' (' || replace(p_reason::text, '_', ' ') || '). Now ' || new_balance || '.',
           '/dashboard/inventory'
    from public.profiles p
    where p.role in ('manager', 'admin')
      and p.suspended_at is null
      and p.id <> auth.uid();   -- no point telling you what you just did
  end if;

  return new_balance;
end;
$$;

-- ── 2. In-store sales ────────────────────────────────────────
--
-- `orders` already carries sold_by and appointment_id. What it lacked was a way
-- to say "this was rung up at the desk" rather than bought on the website, and
-- a place to record how it was paid when there is no Stripe session.

alter table public.orders
  add column if not exists channel text not null default 'online'
    check (channel in ('online', 'in_store')),
  -- Only meaningful for in_store: 'cash' | 'card' | 'other'. Card taken on the
  -- studio's own terminal, so there is no payment intent to store.
  add column if not exists payment_method text
    check (payment_method is null or payment_method in ('cash', 'card', 'other')),
  add column if not exists staff_notes text;

comment on column public.orders.channel is
  'online = bought on the website through Stripe; in_store = rung up at the desk';

create index if not exists orders_channel_idx on public.orders (channel, created_at desc);

-- An in-store sale is complete the moment it is rung up, so it needs to
-- decrement stock the same way a paid online order does.
create or replace function public.order_decrement_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare item record;
begin
  if new.status in ('paid', 'completed') and old.status is distinct from new.status then
    for item in
      select product_id, qty from public.order_items
      where order_id = new.id and product_id is not null
    loop
      perform public.adjust_stock(item.product_id, -item.qty, 'sold',
                                  'Order ' || coalesce(new.order_number, new.id::text));
    end loop;
  end if;
  return null;
end;
$$;

-- ── 3. Announcement presentation ─────────────────────────────
-- The three built-in variants (info/promo/urgent) stay as presets. These let
-- the studio depart from them without a deploy.
alter table public.announcements
  add column if not exists background_color text
    check (background_color is null or background_color ~ '^#[0-9a-fA-F]{6}$'),
  add column if not exists text_color text
    check (text_color is null or text_color ~ '^#[0-9a-fA-F]{6}$');

comment on column public.announcements.background_color is
  'Overrides the variant preset. #RRGGBB or null to use the preset.';

-- ── 4. Legal pages the studio can edit ───────────────────────
-- Stored as versioned site_settings rows so an old policy stays readable after
-- it is superseded — which is the whole point of versioning a policy.
insert into public.site_settings (key, type, version, text_value, label, description, effective_at, is_active)
select 'privacy_policy', 'policy', 1, null,
       'Privacy Policy',
       'Shown at /privacy. Editing creates a new version; the old one is kept.',
       now(), true
where not exists (select 1 from public.site_settings where key = 'privacy_policy');

insert into public.site_settings (key, type, version, text_value, label, description, effective_at, is_active)
select 'terms_of_service', 'policy', 1, null,
       'Terms of Service',
       'Shown at /terms. Editing creates a new version; the old one is kept.',
       now(), true
where not exists (select 1 from public.site_settings where key = 'terms_of_service');

-- ── 5. Newsletter ↔ client matching ──────────────────────────
/**
 * Attach a newsletter subscriber to a client profile by email.
 *
 * Someone can subscribe long before they ever book. Rather than lose that, the
 * subscription stands on its own and is linked the moment an account with the
 * same address appears — so the studio can see "this subscriber became a
 * client" instead of holding two unrelated records.
 */
create or replace function public.link_newsletter_to_profile(p_email text)
returns void language plpgsql security definer set search_path = public as $$
declare target uuid;
begin
  select id into target from public.profiles where lower(email) = lower(p_email) limit 1;
  if target is null then return; end if;

  update public.newsletter_subscriptions
  set profile_id = target
  where lower(email) = lower(p_email) and profile_id is null;

  update public.newsletter_subscribers
  set client_id = target
  where lower(email) = lower(p_email) and client_id is null;
end;
$$;

-- A new account claims any subscription already sitting under its address.
create or replace function public.profile_claim_newsletter()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.email is not null then
    perform public.link_newsletter_to_profile(new.email);
  end if;
  return null;
end;
$$;

drop trigger if exists profiles_claim_newsletter on public.profiles;
create trigger profiles_claim_newsletter
  after insert or update of email on public.profiles
  for each row execute function public.profile_claim_newsletter();

-- And a subscription taken out by someone who already has an account links
-- straight away.
create or replace function public.newsletter_claim_profile()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.link_newsletter_to_profile(new.email);
  return null;
end;
$$;

drop trigger if exists newsletter_subscriptions_claim on public.newsletter_subscriptions;
create trigger newsletter_subscriptions_claim
  after insert on public.newsletter_subscriptions
  for each row execute function public.newsletter_claim_profile();

-- Backfill anything already sitting unlinked.
do $$
declare r record;
begin
  for r in select distinct email from public.newsletter_subscriptions where profile_id is null loop
    perform public.link_newsletter_to_profile(r.email);
  end loop;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 022_services_admin_and_newsletter.sql
-- ─────────────────────────────────────────────────────────────

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

-- ─────────────────────────────────────────────────────────────
-- 023_oauth_accounts_and_intake.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 023: Google sign-in, account completion,
--                     intake after booking
-- ============================================================

-- ── 1. A profile that survives Google sign-in ────────────────
--
-- `handle_new_user` read `first_name` and `last_name` from the user metadata,
-- which is what our own sign-up form writes. Google writes `given_name`,
-- `family_name`, `full_name` and `name` instead, so a Google account arrived
-- with a nameless profile — and a nameless profile is a client the studio
-- cannot identify on the day.
--
-- Roles are deliberately NOT taken from metadata. Anyone can put
-- {"role":"admin"} in an OAuth payload; self-signup is always a client, and
-- staff are promoted afterwards by an existing admin.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta      jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  full_name text;
  first     text;
  last      text;
begin
  first := nullif(trim(coalesce(meta ->> 'first_name', meta ->> 'given_name', '')), '');
  last  := nullif(trim(coalesce(meta ->> 'last_name',  meta ->> 'family_name', '')), '');

  -- Google always sends a display name even when it withholds the parts.
  full_name := nullif(trim(coalesce(meta ->> 'full_name', meta ->> 'name', '')), '');

  if first is null and full_name is not null then
    first := split_part(full_name, ' ', 1);
    -- Everything after the first space, so "Ana Maria Ruiz" keeps "Maria Ruiz"
    -- rather than losing the middle name.
    last  := nullif(trim(substr(full_name, length(split_part(full_name, ' ', 1)) + 1)), '');
  end if;

  insert into public.profiles (id, email, first_name, last_name, phone, avatar_url, role)
  values (
    new.id,
    new.email,
    first,
    last,
    nullif(trim(coalesce(meta ->> 'phone', new.phone, '')), ''),
    nullif(trim(coalesce(meta ->> 'avatar_url', meta ->> 'picture', '')), ''),
    'client'
  )
  on conflict (id) do update
    -- A returning OAuth user should not lose a name they already have, but an
    -- empty profile should gain one.
    set email      = coalesce(public.profiles.email, excluded.email),
        first_name = coalesce(public.profiles.first_name, excluded.first_name),
        last_name  = coalesce(public.profiles.last_name, excluded.last_name),
        avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url);

  return new;
end;
$$;

-- OAuth updates the metadata on every sign-in; catch a name that arrives late.
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of raw_user_meta_data on auth.users
  for each row execute function public.handle_new_user();

-- ── 2. Knowing when an account still needs details ───────────
--
-- Google gives a name, an email and a picture. It does not give a phone number
-- or a date of birth, and the studio needs both: one to reach someone when a
-- slot moves, the other because several services have an age minimum.

alter table public.profiles
  add column if not exists profile_completed_at timestamptz;

comment on column public.profiles.profile_completed_at is
  'Set when the client has supplied the details sign-in cannot provide (phone, '
  'date of birth). Null means the "finish your profile" step is still owed.';

/**
 * Does this account still owe us the details a booking needs?
 *
 * Derived rather than trusted: a client who clears their phone number is
 * incomplete again, whatever the timestamp says.
 */
create or replace function public.profile_needs_completion(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = p_id
      and role = 'client'
      and (
        first_name is null or trim(first_name) = ''
        or phone is null or trim(phone) = ''
        or date_of_birth is null
      )
  );
$$;

-- Backfill: anyone who already has the details is complete.
update public.profiles
set profile_completed_at = coalesce(profile_completed_at, now())
where role = 'client'
  and profile_completed_at is null
  and first_name is not null and trim(first_name) <> ''
  and phone is not null and trim(phone) <> ''
  and date_of_birth is not null;

-- ── 3. Intake belongs after the booking, not in front of it ──
--
-- Requiring two clinical forms before the "Confirm" button means a client who
-- came to reserve a slot leaves without one. The slot is the commitment; the
-- paperwork is a condition of being treated, which is a different deadline.
--
-- So the appointment records what it is waiting for, and the studio can see at
-- a glance who has not filled anything in yet.

alter table public.appointments
  add column if not exists intake_completed_at timestamptz,
  add column if not exists intake_reminder_sent_at timestamptz;

comment on column public.appointments.intake_completed_at is
  'When every form this appointment requires was submitted. Null while any are '
  'outstanding — the client is prompted after booking and reminded before the visit.';

create index if not exists appointments_intake_pending_idx
  on public.appointments (starts_at)
  where intake_completed_at is null and status in ('pending', 'confirmed');

/**
 * The forms an appointment still needs.
 *
 * A form attaches to services two ways: the `service_ids`/`category_ids` arrays
 * on the template itself, and an explicit row in `service_form_requirements`.
 * Both are honoured, because both are in use.
 *
 * A signature counts only while it is unexpired — a health attestation from two
 * years ago is not evidence of anything current, which is the whole reason
 * consent_forms carries `revalidate_after_days`.
 */
create or replace function public.appointment_outstanding_forms(p_appointment uuid)
returns table (kind text, form_id bigint, slug text, title text, is_required boolean)
language sql stable security definer set search_path = public as $$
  with appt as (
    select id, client_id from public.appointments where id = p_appointment
  ),
  booked as (
    select distinct s.id as service_id, s.category_id
    from public.appointment_services aps
    join public.services s on s.id = aps.service_id
    where aps.appointment_id = p_appointment
  ),
  -- Consent forms this appointment pulls in, from either attachment route.
  needed_consent as (
    select distinct cf.id, cf.slug, cf.title, true as is_required
    from public.consent_forms cf
    where cf.is_active
      and (
        exists (select 1 from booked b where b.service_id = any (cf.service_ids))
        or exists (select 1 from booked b where b.category_id = any (cf.category_ids))
        or exists (
          select 1 from public.service_form_requirements r
          join booked b on b.service_id = r.service_id
          where r.consent_form_id = cf.id
        )
      )
  ),
  needed_intake as (
    select distinct f.id, f.slug, f.title,
           coalesce(bool_or(r.is_required), true) as is_required
    from public.intake_forms f
    left join public.service_form_requirements r on r.intake_form_id = f.id
      and r.service_id in (select service_id from booked)
    where f.is_active
      and (
        exists (select 1 from booked b where b.service_id = any (f.service_ids))
        or exists (select 1 from booked b where b.category_id = any (f.category_ids))
        or exists (
          select 1 from public.service_form_requirements r2
          join booked b on b.service_id = r2.service_id
          where r2.intake_form_id = f.id
        )
      )
    group by f.id, f.slug, f.title
  )
  select 'consent'::text, c.id, c.slug, c.title, c.is_required
  from needed_consent c
  where not exists (
    select 1 from public.consent_signatures sig
    where sig.client_id = (select client_id from appt)
      and sig.consent_form_id = c.id
      and (sig.expires_at is null or sig.expires_at > now())
  )
  union all
  select 'intake'::text, i.id, i.slug, i.title, i.is_required
  from needed_intake i
  where not exists (
    select 1 from public.intake_submissions sub
    where sub.client_id = (select client_id from appt)
      and sub.intake_form_id = i.id
      -- Re-ask each visit rather than reuse an old answer: skin, medication and
      -- pregnancy status all change, and that is exactly what the form asks about.
      and sub.appointment_id = p_appointment
  );
$$;

/**
 * Recompute `intake_completed_at` for an appointment.
 * Called after a form is submitted, so the flag never drifts from the forms.
 */
create or replace function public.refresh_appointment_intake(p_appointment uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.appointments
  set intake_completed_at = case
    when exists (
      select 1 from public.appointment_outstanding_forms(p_appointment)
      where is_required
    ) then null
    else coalesce(intake_completed_at, now())
  end
  where id = p_appointment;
end;
$$;

-- Submitting either kind of form re-checks the appointment it belongs to.
create or replace function public.form_submission_refresh_intake()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.appointment_id is not null then
    perform public.refresh_appointment_intake(new.appointment_id);
  end if;
  return null;
end;
$$;

drop trigger if exists intake_submissions_refresh on public.intake_submissions;
create trigger intake_submissions_refresh
  after insert on public.intake_submissions
  for each row execute function public.form_submission_refresh_intake();

drop trigger if exists consent_signatures_refresh on public.consent_signatures;
create trigger consent_signatures_refresh
  after insert on public.consent_signatures
  for each row execute function public.form_submission_refresh_intake();

-- ── 4. Sales tax the studio can set ──────────────────────────
insert into public.site_settings (key, type, version, text_value, label, description, is_active)
select 'sales_tax_rate', 'config', 1, '0.0835',
       'Sales tax rate',
       'Applied to in-store product sales. Fresno County is 0.0835 (8.35%). '
       'Enter it as a decimal, not a percentage.',
       true
where not exists (select 1 from public.site_settings where key = 'sales_tax_rate');

-- ─────────────────────────────────────────────────────────────
-- 024_stock_on_external_products.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 024: the studio holds stock of what it links to
--
-- 007 asserted that an externally fulfilled product "must not pretend to hold
-- stock", and 012/017 seeded all 42 Rhonda Allison products with external_url
-- set, price 0 and stock 0. That was a reasonable reading of "the marketplace
-- takes payment and ships" — but it is not how the studio actually works.
--
-- She keeps these products on a shelf in the room and sells them in person.
-- The marketplace link is what happens when she runs OUT: the client orders it
-- there and it ships to them. So external_url is a fallback, not a declaration
-- that no stock is ever held — and the CHECK made the real behaviour illegal.
-- Adjusting stock on any of the 42 failed with
-- `products_external_has_no_stock`.
-- ============================================================

alter table public.products
  drop constraint if exists products_external_has_no_stock;

comment on column public.products.external_url is
  'Where a client is sent when the studio has none left — the brand''s own '
  'storefront, which takes payment and ships. Independent of stock: the studio '
  'may hold plenty, some, or none of a product it can also link to.';

comment on column public.products.stock_qty is
  'What is physically on the shelf. Sold at the counter through the till; when '
  'it reaches zero the shop offers external_url instead.';

-- ── Price has to be the studio's own ─────────────────────────
--
-- 017 stored price_cents = 0 on purpose, reasoning that the marketplace owns
-- the price and a stale copy is worse than none. That holds for the *shipped*
-- price — which is still true, and still not stored. It does not hold for the
-- counter: a till cannot ring up a product with no price, and hers need not
-- match the marketplace's anyway.
--
-- Nothing is invented here. The prices are the studio's to set, so the columns
-- stay 0 and the dashboard flags every unpriced product until she fills them
-- in. A guessed price on a real receipt would be worse than an empty field.

comment on column public.products.price_cents is
  'What the studio charges at the counter, in cents. 0 means "not priced yet" — '
  'the till refuses to sell it and the shop shows no figure. Deliberately NOT '
  'the marketplace price, which belongs to the marketplace.';

/**
 * Is this product sellable in the room right now?
 *
 * Both halves matter and they fail differently: no stock sends the client to
 * the marketplace, no price is a gap in the catalogue for staff to close.
 */
create or replace function public.product_is_sellable(p_product_id bigint)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.products
    where id = p_product_id
      and is_active
      and is_retail
      and archived_at is null
      and price_cents > 0
      and stock_qty > 0
  );
$$;

-- ── Re-running 017 must not wipe her work ────────────────────
--
-- 017's ON CONFLICT clause reset price_cents and stock_qty to 0 on every run,
-- while its own header promised it only "refreshes name, description, image,
-- link and category". Once she has priced and counted 42 products, one re-run
-- to refresh a photo would have silently zeroed the lot. 017 is corrected in
-- place to match the contract it already advertised; this is the belt to that
-- braces, for any database where the old version ran last.
--
-- No-op on a fresh install: nothing has a price to protect yet.

do $$
begin
  if exists (
    select 1 from public.products
    where external_url is not null and (price_cents > 0 or stock_qty > 0)
  ) then
    raise notice
      'Studio-set prices/stock found on externally-linked products — leaving them alone.';
  end if;
end $$;

-- ─────────────────────────────────────────────────────────────
-- 025_ledger_and_balances.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 025: one ledger for money in
--
-- `payments` has been the right shape since 008 — amount, method, kind, and a
-- link to either an appointment or an order. What was missing is anything that
-- writes to it outside the Stripe webhook. A deposit taken online was recorded;
-- the balance handed over in cash at the end of the appointment was not, so an
-- appointment could be completed and fully paid and still read as owing money.
--
-- This adds the two things needed to close that: a balance anyone can ask for,
-- and a way for staff to record a payment they just took.
-- ============================================================

-- ── 1. A product name that came out of a scrape ──────────────
-- 017 lifted names from the marketplace's HTML without decoding entities, so
-- '"A" Renew +' was stored — and rendered — as '&quot;A&quot; Renew +'.
update public.products
set name = replace(
             replace(
               replace(
                 replace(replace(name, '&quot;', '"'), '&amp;', '&'),
               '&#39;', ''''),
             '&rsquo;', '’'),
           '&nbsp;', ' ')
where name like '%&%;%';

-- Descriptions came from the same scrape.
update public.products
set description = replace(
                    replace(
                      replace(
                        replace(replace(description, '&quot;', '"'), '&amp;', '&'),
                      '&#39;', ''''),
                    '&rsquo;', '’'),
                  '&nbsp;', ' ')
where description like '%&%;%';

-- ── 2. What is still owed ────────────────────────────────────
/**
 * The balance outstanding on an appointment, in cents.
 *
 * Derived from `payments` rather than stored, because a stored figure and the
 * payments behind it drift the moment anything is refunded — and the payments
 * are the evidence. Refunds are negative amounts, so they fall out of the sum
 * naturally.
 *
 * A cancelled or no-show appointment owes nothing beyond a forfeited deposit,
 * which has already been taken; billing someone for a treatment they did not
 * receive is not a thing the studio does.
 */
create or replace function public.appointment_balance_cents(p_appointment uuid)
returns int language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce(a.total_cents, 0) - coalesce((
      select sum(p.amount_cents)
      from public.payments p
      where p.appointment_id = a.id
        and p.status = 'succeeded'
    ), 0),
    0
  )::int
  from public.appointments a
  where a.id = p_appointment
    and a.status not in ('cancelled', 'no_show');
$$;

/** The same question for a product order. */
create or replace function public.order_balance_cents(p_order bigint)
returns int language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce(o.total_cents, 0) - coalesce((
      select sum(p.amount_cents)
      from public.payments p
      where p.order_id = o.id
        and p.status = 'succeeded'
    ), 0),
    0
  )::int
  from public.orders o
  where o.id = p_order
    and o.status not in ('cart', 'cancelled', 'refunded');
$$;

-- ── 3. Recording money taken in the room ─────────────────────
/**
 * Record a payment against an appointment or an order.
 *
 * This is the counter-side counterpart to the Stripe webhook: cash, a card on
 * the studio's own terminal, a gift card. Staff-only, and it writes the same
 * `payments` row the webhook does so both ends of the ledger agree.
 *
 * Paying a deposit through here also moves `deposit_status`, because that flag
 * is what the booking flow and the reminders read. Letting the two disagree is
 * how a client gets chased for a deposit they already handed over.
 */
create or replace function public.record_payment(
  p_amount_cents int,
  p_kind         text,
  p_method       text default 'cash',
  p_appointment  uuid default null,
  p_order        bigint default null,
  p_note         text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  actor_role public.user_role;
  target_client uuid;
  payment_id bigint;
begin
  select role into actor_role from public.profiles where id = auth.uid();

  if auth.uid() is not null and (actor_role is null or actor_role = 'client') then
    raise exception 'Only staff can record a payment';
  end if;

  if p_appointment is null and p_order is null then
    raise exception 'A payment has to be against an appointment or an order';
  end if;
  if p_appointment is not null and p_order is not null then
    raise exception 'A payment belongs to one appointment or one order, not both';
  end if;
  -- Zero is meaningless and negative is a refund, which has its own kind.
  if p_amount_cents = 0 then
    raise exception 'A payment cannot be zero';
  end if;
  if p_amount_cents < 0 and p_kind <> 'refund' then
    raise exception 'A negative amount must be recorded as a refund';
  end if;

  if p_appointment is not null then
    select client_id into target_client from public.appointments where id = p_appointment;
  else
    select client_id into target_client from public.orders where id = p_order;
  end if;

  insert into public.payments
    (amount_cents, method, kind, appointment_id, order_id, client_id, status, processed_by, note)
  values
    (p_amount_cents, p_method, p_kind, p_appointment, p_order, target_client,
     'succeeded', auth.uid(), p_note)
  returning id into payment_id;

  -- Keep the deposit flag in step with the money.
  if p_appointment is not null and p_kind = 'deposit' then
    update public.appointments
    set deposit_status = 'paid'
    where id = p_appointment and deposit_status <> 'paid';
  end if;

  return payment_id;
end;
$$;

-- ── 4. An in-store sale is not work waiting to be done ───────
--
-- The till wrote `paid`, and the Orders page treats `paid` as "to fulfil". But
-- a counter sale is handed over as it is rung up — there is nothing to pack or
-- post. Every till transaction was landing in the fulfilment queue as
-- outstanding work, and the queue is meant to be the online orders only.
--
-- Existing in-store rows are moved to `completed`. Stock has already been
-- decremented for these (the trigger fires on both statuses), and the trigger
-- only acts on a *change* into paid/completed, so this does not double-count.

update public.orders
set status = 'completed'
where channel = 'in_store'
  and status = 'paid';

-- ── 5. Backfill the payment rows the till never wrote ────────
-- Sales taken before this migration recorded the order but not the money, so
-- they would show as fully outstanding on the new ledger.
insert into public.payments
  (amount_cents, method, kind, order_id, client_id, status, processed_by, note, created_at)
select
  o.total_cents,
  coalesce(o.payment_method, 'other'),
  'product',
  o.id,
  o.client_id,
  'succeeded',
  o.sold_by,
  'Backfilled from the in-store sale record',
  coalesce(o.paid_at, o.created_at)
from public.orders o
where o.channel = 'in_store'
  and o.total_cents > 0
  and not exists (
    select 1 from public.payments p where p.order_id = o.id
  );

-- ─────────────────────────────────────────────────────────────
-- 026_forms_and_tax_for_staff.sql
-- ─────────────────────────────────────────────────────────────

-- ============================================================
-- 559 Flawless — 026: staff maintain the forms and the tax rate
--
-- Both were admin-only, which in a one-or-two-person studio means the owner is
-- the bottleneck on her own paperwork. Opening them up, with the one guard that
-- actually matters kept intact.
-- ============================================================

-- ── 1. Consent and intake forms ──────────────────────────────
--
-- The invariant from the start has been that editing a template can never
-- rewrite what somebody already agreed to. `consent_signatures.body_snapshot`
-- holds a verbatim copy of the text that was on screen, so history is safe
-- whatever happens here — but a live form whose wording silently changes under
-- an unchanged version number makes the archive impossible to read back.
--
-- So: a form nobody has signed can be edited freely. A form with signatures is
-- versioned instead — a new row, a new version number, the old one retired and
-- still pointed at by the signatures that used it.

drop policy if exists "admin writes consent forms" on public.consent_forms;
drop policy if exists "admin writes intake forms" on public.intake_forms;

drop policy if exists "manager writes consent forms" on public.consent_forms;
create policy "manager writes consent forms" on public.consent_forms
  for all using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager writes intake forms" on public.intake_forms;
create policy "manager writes intake forms" on public.intake_forms
  for all using (public.is_manager()) with check (public.is_manager());

/**
 * Refuse a change to the wording of a form that has already been signed.
 *
 * Not because history would be lost — body_snapshot covers that — but because
 * "version 2" has to mean one specific piece of text. Two clients signing
 * different wording under the same version number is exactly the ambiguity the
 * version number exists to remove. The UI calls publish_consent_version()
 * instead, which supersedes rather than mutates.
 */
create or replace function public.consent_form_guard_signed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.body is distinct from old.body and exists (
    select 1 from public.consent_signatures where consent_form_id = old.id
  ) then
    raise exception
      'This form has been signed. Publish a new version rather than editing the wording.';
  end if;
  return new;
end;
$$;

drop trigger if exists consent_forms_guard_signed on public.consent_forms;
create trigger consent_forms_guard_signed
  before update on public.consent_forms
  for each row execute function public.consent_form_guard_signed();

-- A signed form must not be deleted out from under its signatures either.
create or replace function public.consent_form_block_signed_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.consent_signatures where consent_form_id = old.id) then
    raise exception
      'Clients have signed this form. Switch it off instead of deleting it.';
  end if;
  return old;
end;
$$;

drop trigger if exists consent_forms_block_signed_delete on public.consent_forms;
create trigger consent_forms_block_signed_delete
  before delete on public.consent_forms
  for each row execute function public.consent_form_block_signed_delete();

/**
 * Publish a new version of a consent form.
 *
 * The old row stays exactly as it was and stays linked to every signature that
 * used it — which is what makes "what did this person actually agree to?"
 * answerable years later. The new row inherits which services it applies to
 * unless told otherwise, and becomes the one clients are asked to sign.
 */
create or replace function public.publish_consent_version(
  p_form_id     bigint,
  p_title       text,
  p_body        text,
  p_service_ids bigint[] default null,
  p_category_ids bigint[] default null,
  p_revalidate_after_days int default null,
  p_requires_initials boolean default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  old_form public.consent_forms;
  new_id   bigint;
  next_version int;
begin
  if not public.is_manager() and auth.uid() is not null then
    raise exception 'Only a manager can publish a consent form';
  end if;

  select * into old_form from public.consent_forms where id = p_form_id;
  if old_form is null then
    raise exception 'No such consent form';
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.consent_forms where slug = old_form.slug;

  insert into public.consent_forms
    (slug, version, title, body, service_ids, category_ids,
     requires_initials, revalidate_after_days, is_active)
  values
    (old_form.slug, next_version, p_title, p_body,
     coalesce(p_service_ids, old_form.service_ids),
     coalesce(p_category_ids, old_form.category_ids),
     coalesce(p_requires_initials, old_form.requires_initials),
     coalesce(p_revalidate_after_days, old_form.revalidate_after_days),
     true)
  returning id into new_id;

  -- Retire the previous version. It keeps its signatures and stays readable.
  update public.consent_forms set is_active = false where id = p_form_id;

  return new_id;
end;
$$;

-- ── 2. The sales tax rate ────────────────────────────────────
--
-- site_settings is admin-only, and rightly so — it also carries the analytics
-- script injection slots, where a write is effectively arbitrary JavaScript on
-- every page. The tax rate is not that, so it gets its own narrow door rather
-- than the whole table being opened.

/**
 * Read the studio's sales tax rate as a fraction. Falls back to Fresno County's
 * combined 8.35% if it has never been set or the stored value is nonsense.
 */
create or replace function public.sales_tax_rate()
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(
    (
      select case
        when s.text_value ~ '^0?\.[0-9]+$' and s.text_value::numeric < 1
          then s.text_value::numeric
        else null
      end
      from public.site_settings s
      where s.key = 'sales_tax_rate' and s.is_active
      order by s.version desc
      limit 1
    ),
    0.0835
  );
$$;

/**
 * Set the sales tax rate. Manager and above.
 *
 * Takes a fraction, not a percentage — 0.0835, not 8.35 — and refuses anything
 * outside a sane band. A fat-fingered 8.35 would put 835% tax on every receipt,
 * which is the kind of mistake worth making impossible rather than merely
 * unlikely.
 */
create or replace function public.set_sales_tax_rate(p_rate numeric)
returns numeric language plpgsql security definer set search_path = public as $$
begin
  if not public.is_manager() and auth.uid() is not null then
    raise exception 'Only a manager can change the tax rate';
  end if;

  if p_rate is null or p_rate < 0 or p_rate >= 0.30 then
    raise exception
      'Enter the rate as a decimal between 0 and 0.30 — 0.0835 for 8.35%%, not 8.35';
  end if;

  update public.site_settings
  set text_value = trim(to_char(p_rate, 'FM0.999999')),
      updated_at = now()
  where key = 'sales_tax_rate' and is_active;

  if not found then
    insert into public.site_settings
      (key, type, version, text_value, label, description, is_active)
    values
      ('sales_tax_rate', 'config', 1, trim(to_char(p_rate, 'FM0.999999')),
       'Sales tax rate',
       'Applied to in-store product sales. Enter as a decimal, not a percentage.',
       true);
  end if;

  return p_rate;
end;
$$;

-- Staff need to read config settings to price a sale; they still cannot write
-- the table directly, and the script-injection rows stay admin-only on read.
drop policy if exists "staff reads config settings" on public.site_settings;
create policy "staff reads config settings" on public.site_settings
  for select using (public.is_staff() and type in ('config', 'policy', 'content'));
