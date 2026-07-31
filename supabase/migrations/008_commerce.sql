-- ============================================================
-- 559 Flawless — 008: commerce
--
-- Covers three money paths that all settle through Stripe:
--   1. Appointment deposits (see appointments.deposit_*)
--   2. Retail product orders (shipping or in-store pickup)
--   3. Gift cards and prepaid service packages
--
-- Every amount is an integer number of cents. There is no float math anywhere
-- in this schema, and there must not be any in the app either.
-- ============================================================

create type public.order_status as enum (
  'cart', 'pending_payment', 'paid', 'fulfilling',
  'ready_for_pickup', 'shipped', 'completed', 'cancelled', 'refunded'
);

create type public.fulfillment_method as enum ('pickup', 'shipping');

create table public.orders (
  id            bigserial primary key,
  order_number  text unique,
  client_id     uuid references public.profiles(id) on delete set null,

  guest_email   text,
  guest_phone   text,
  guest_name    text,

  status        public.order_status not null default 'cart',
  fulfillment   public.fulfillment_method not null default 'pickup',

  subtotal_cents  int not null default 0,
  discount_cents  int not null default 0,
  tax_cents       int not null default 0,
  shipping_cents  int not null default 0,
  total_cents     int not null default 0,

  -- Applied gift card / promo, if any.
  gift_card_id    bigint,
  promo_code      text,

  ship_name     text,
  ship_line1    text,
  ship_line2    text,
  ship_city     text,
  ship_state    text,
  ship_postal   text,

  stripe_session_id        text unique,
  stripe_payment_intent_id text,
  paid_at       timestamptz,

  -- Set when a retail order was rung up in person rather than online.
  sold_by       uuid references public.profiles(id) on delete set null,
  -- Links a product sale to the visit it happened on, for attach-rate analytics.
  appointment_id uuid references public.appointments(id) on delete set null,

  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create index orders_client_idx  on public.orders (client_id, created_at desc);
create index orders_status_idx  on public.orders (status, created_at desc);

create table public.order_items (
  id         bigserial primary key,
  order_id   bigint not null references public.orders(id) on delete cascade,
  product_id bigint references public.products(id) on delete set null,
  -- Frozen at purchase so a later price change never rewrites an old receipt.
  name_snapshot  text not null,
  sku_snapshot   text,
  unit_price_cents int not null check (unit_price_cents >= 0),
  qty        int not null check (qty > 0),
  line_total_cents int not null default 0
);

create index order_items_order_idx on public.order_items (order_id);

-- Deferred FK from 007 — `orders` did not exist yet at that point.
alter table public.inventory_log
  add constraint inventory_log_order_fk
  foreign key (order_id) references public.orders(id) on delete set null;

-- ── Gift cards ───────────────────────────────────────────────
create table public.gift_cards (
  id             bigserial primary key,
  code           text not null unique,
  initial_cents  int not null check (initial_cents > 0),
  balance_cents  int not null check (balance_cents >= 0),
  purchased_by   uuid references public.profiles(id) on delete set null,
  recipient_name  text,
  recipient_email text,
  message        text,
  issued_at      timestamptz not null default now(),
  expires_at     timestamptz,
  is_active      boolean not null default true
);

create table public.gift_card_transactions (
  id           bigserial primary key,
  gift_card_id bigint not null references public.gift_cards(id) on delete cascade,
  amount_cents int not null,            -- negative = redemption
  balance_after int not null,
  order_id     bigint references public.orders(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  created_by   uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now()
);

alter table public.orders
  add constraint orders_gift_card_fk
  foreign key (gift_card_id) references public.gift_cards(id) on delete set null;

-- ── Prepaid service packages (buy 6 facials, use over time) ──
create table public.service_packages (
  id           bigserial primary key,
  name         text not null,
  slug         text not null unique,
  description  text,
  service_id   bigint references public.services(id) on delete set null,
  session_count int not null check (session_count > 0),
  price_cents  int not null check (price_cents >= 0),
  valid_days   int not null default 365,
  is_active    boolean not null default true,
  sort_order   int not null default 0
);

create table public.client_packages (
  id         bigserial primary key,
  client_id  uuid not null references public.profiles(id) on delete cascade,
  package_id bigint not null references public.service_packages(id) on delete restrict,
  sessions_total     int not null,
  sessions_remaining int not null check (sessions_remaining >= 0),
  purchased_at timestamptz not null default now(),
  expires_at   timestamptz,
  order_id     bigint references public.orders(id) on delete set null
);

create index client_packages_client_idx on public.client_packages (client_id)
  where sessions_remaining > 0;

-- Redeeming a package session against an appointment.
create table public.package_redemptions (
  id                bigserial primary key,
  client_package_id bigint not null references public.client_packages(id) on delete cascade,
  appointment_id    uuid not null references public.appointments(id) on delete cascade,
  redeemed_at       timestamptz not null default now(),
  unique (appointment_id, client_package_id)
);

-- ── Payments ledger ──────────────────────────────────────────
-- One row per money movement, whatever it was for. Reconciliation reads this,
-- not the individual order/appointment rows.
create table public.payments (
  id             bigserial primary key,
  amount_cents   int not null,          -- negative = refund
  method         text not null default 'card'
                   check (method in ('card', 'cash', 'gift_card', 'package', 'other')),
  kind           text not null
                   check (kind in ('deposit', 'service', 'product', 'gift_card', 'package', 'refund')),
  order_id       bigint references public.orders(id) on delete set null,
  appointment_id uuid   references public.appointments(id) on delete set null,
  client_id      uuid   references public.profiles(id) on delete set null,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  status         text not null default 'succeeded'
                   check (status in ('pending', 'succeeded', 'failed', 'refunded')),
  processed_by   uuid references public.profiles(id) on delete set null,
  note           text,
  created_at     timestamptz not null default now()
);

create index payments_client_idx on public.payments (client_id, created_at desc);
create index payments_appt_idx   on public.payments (appointment_id);
create index payments_order_idx  on public.payments (order_id);

-- ── Order maintenance ────────────────────────────────────────
create trigger orders_touch before update on public.orders
  for each row execute function public.touch_updated_at();

-- The line total is derived, so it is set BEFORE the row is written, on the row
-- itself. Doing it in the AFTER trigger below would mean that trigger updating
-- its own table, which re-fires it — straight to "stack depth limit exceeded".
create or replace function public.order_item_set_line_total()
returns trigger language plpgsql as $$
begin
  new.line_total_cents := new.unit_price_cents * new.qty;
  return new;
end;
$$;

create trigger order_items_set_line_total
  before insert or update of unit_price_cents, qty on public.order_items
  for each row execute function public.order_item_set_line_total();

-- Roll the lines up to the parent order. Touches `orders` only — never
-- `order_items` — so there is no recursion. Same TG_OP rule as
-- appointment_recalc_totals: NEW is unassigned on DELETE.
create or replace function public.order_item_recalc()
returns trigger language plpgsql security definer set search_path = public as $$
declare target bigint;
begin
  if tg_op = 'DELETE' then
    target := old.order_id;
  else
    target := new.order_id;
  end if;

  update public.orders o
  set subtotal_cents = coalesce(s.sum_cents, 0),
      total_cents = greatest(
        coalesce(s.sum_cents, 0) - o.discount_cents + o.tax_cents + o.shipping_cents, 0)
  from (
    select sum(unit_price_cents * qty) as sum_cents
    from public.order_items where order_id = target
  ) s
  where o.id = target;

  return null;
end;
$$;

create trigger order_items_recalc
  after insert or update or delete on public.order_items
  for each row execute function public.order_item_recalc();

-- Human-readable order number on first transition out of `cart`.
create or replace function public.order_assign_number()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.order_number is null and new.status <> 'cart' then
    new.order_number := 'FL-' || to_char(now(), 'YYMM') || '-' ||
                        lpad(new.id::text, 5, '0');
  end if;
  return new;
end;
$$;

create trigger orders_assign_number before insert or update of status on public.orders
  for each row execute function public.order_assign_number();

-- Decrement retail stock when an order is paid.
create or replace function public.order_decrement_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare item record;
begin
  if new.status = 'paid' and old.status is distinct from 'paid' then
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

create trigger orders_decrement_stock after update of status on public.orders
  for each row execute function public.order_decrement_stock();

-- ── RLS ──────────────────────────────────────────────────────
alter table public.orders             enable row level security;
alter table public.order_items        enable row level security;
alter table public.gift_cards         enable row level security;
alter table public.gift_card_transactions enable row level security;
alter table public.service_packages   enable row level security;
alter table public.client_packages    enable row level security;
alter table public.package_redemptions enable row level security;
alter table public.payments           enable row level security;

create policy "client reads own orders" on public.orders
  for select using (client_id = auth.uid());
create policy "staff reads orders" on public.orders
  for select using (public.is_front_desk());
create policy "client manages own cart" on public.orders
  for insert with check (client_id = auth.uid());
-- A client may edit their own order only while it is still a cart. Once it is
-- pending payment, totals and status belong to the Stripe webhook.
create policy "client updates own cart" on public.orders
  for update using (client_id = auth.uid() and status = 'cart')
  with check (client_id = auth.uid() and status in ('cart', 'pending_payment'));
create policy "staff writes orders" on public.orders
  for all using (public.is_front_desk()) with check (public.is_front_desk());

create policy "read own order items" on public.order_items
  for select using (exists (
    select 1 from public.orders o
    where o.id = order_id and (o.client_id = auth.uid() or public.is_front_desk())
  ));
create policy "client writes own cart items" on public.order_items
  for all using (exists (
    select 1 from public.orders o
    where o.id = order_id and o.client_id = auth.uid() and o.status = 'cart'
  )) with check (exists (
    select 1 from public.orders o
    where o.id = order_id and o.client_id = auth.uid() and o.status = 'cart'
  ));
create policy "staff writes order items" on public.order_items
  for all using (public.is_front_desk()) with check (public.is_front_desk());

-- Gift-card codes are never listed publicly; balance is checked through an
-- RPC that takes the exact code, so codes can't be enumerated.
create policy "staff manages gift cards" on public.gift_cards
  for all using (public.is_front_desk()) with check (public.is_front_desk());
create policy "client reads own gift cards" on public.gift_cards
  for select using (purchased_by = auth.uid());
create policy "staff reads gift transactions" on public.gift_card_transactions
  for select using (public.is_front_desk());

create policy "public reads packages" on public.service_packages
  for select to anon, authenticated using (is_active or public.is_staff());
create policy "admin writes packages" on public.service_packages
  for all using (public.is_admin()) with check (public.is_admin());
create policy "client reads own packages" on public.client_packages
  for select using (client_id = auth.uid());
create policy "staff manages client packages" on public.client_packages
  for all using (public.is_front_desk()) with check (public.is_front_desk());
create policy "staff manages redemptions" on public.package_redemptions
  for all using (public.is_front_desk()) with check (public.is_front_desk());

create policy "client reads own payments" on public.payments
  for select using (client_id = auth.uid());
create policy "staff reads payments" on public.payments
  for select using (public.is_front_desk());
create policy "manager writes payments" on public.payments
  for all using (public.is_manager()) with check (public.is_manager());

/** Check a gift card by exact code without exposing the table. */
create or replace function public.gift_card_balance(p_code text)
returns table (balance_cents int, is_active boolean, expires_at timestamptz)
language sql stable security definer set search_path = public as $$
  select g.balance_cents, g.is_active, g.expires_at
  from public.gift_cards g
  where g.code = upper(trim(p_code));
$$;
