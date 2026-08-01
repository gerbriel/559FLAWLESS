-- ============================================================
-- 559 Flawless — migrations 020 through 023
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
