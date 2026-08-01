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
