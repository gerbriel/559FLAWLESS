-- ============================================================
-- 559 Flawless — 007: products + inventory
--
-- One `products` table covers both sides of the business:
--   is_retail       — sold to clients through the shop
--   is_professional — back-bar stock consumed during a service (wax, gloves,
--                     serums). Never listed publicly.
-- A product can be both (a serum sold retail and used in treatment).
--
-- Stock is never edited directly. Every change lands in `inventory_log`, and
-- non-manager staff propose changes into `inventory_change_requests` for a
-- manager to apply — the approval-queue pattern from united-metal-components.
-- ============================================================

create table public.product_categories (
  id         bigserial primary key,
  name       text not null,
  slug       text not null unique,
  description text,
  image_url  text,
  sort_order int not null default 0,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.brands (
  id         bigserial primary key,
  name       text not null unique,
  slug       text not null unique,
  logo_url   text,
  is_active  boolean not null default true
);

create table public.products (
  id          bigserial primary key,
  sku         text not null unique,
  name        text not null,
  slug        text not null unique,
  category_id bigint references public.product_categories(id) on delete set null,
  brand_id    bigint references public.brands(id) on delete set null,

  description text,
  ingredients text,
  how_to_use  text,
  image_url   text,
  gallery     jsonb not null default '[]'::jsonb,

  price_cents int not null default 0 check (price_cents >= 0),
  -- Wholesale cost, staff-only. The public read policy excludes nothing at the
  -- row level, so cost is stripped by selecting explicit columns in the
  -- storefront queries — see lib/products.ts PUBLIC_PRODUCT_COLUMNS.
  cost_cents  int not null default 0 check (cost_cents >= 0),
  taxable     boolean not null default true,

  is_retail       boolean not null default true,
  is_professional boolean not null default false,

  -- ── Fulfilled elsewhere ────────────────────────────────────
  -- Most retail here is sold through the studio's authorized Rhonda Allison
  -- marketplace storefront, which takes the payment and ships the order. Those
  -- products are listed on the site for discovery but link out rather than
  -- entering the cart, and their stock/price columns are not authoritative —
  -- the marketplace owns both.
  --
  -- external_url IS NULL  -> stocked in the salon, checks out through Stripe
  -- external_url IS SET   -> "Shop on Rhonda Allison", no cart, no stock
  external_url text,

  -- Unit the back bar counts in ("bottle", "case", "lb").
  unit        text not null default 'each',
  stock_qty   numeric(12,2) not null default 0,
  low_stock_threshold numeric(12,2) not null default 3,
  -- Professional stock only: how much one service draws down.
  reorder_qty numeric(12,2) not null default 0,

  is_active   boolean not null default true,
  is_featured boolean not null default false,
  sort_order  int not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- An externally fulfilled product must not pretend to hold stock.
  constraint products_external_has_no_stock check (
    external_url is null or stock_qty = 0
  )
);

create index products_category_idx on public.products (category_id) where is_active;
create index products_retail_idx   on public.products (is_active, sort_order) where is_retail;
-- Low stock is only meaningful for what the salon physically holds.
create index products_low_stock_idx on public.products (stock_qty)
  where is_active and external_url is null and stock_qty <= low_stock_threshold;

create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- Back-bar draw-down: completing a service decrements these automatically.
create table public.service_consumables (
  service_id bigint not null references public.services(id) on delete cascade,
  product_id bigint not null references public.products(id) on delete cascade,
  qty        numeric(12,2) not null check (qty > 0),
  primary key (service_id, product_id)
);

-- ── Movement log: the only source of truth for stock history ─
create type public.stock_reason as enum (
  'received', 'sold', 'consumed', 'adjustment', 'damaged',
  'expired', 'returned', 'count_correction'
);

create table public.inventory_log (
  id         bigserial primary key,
  product_id bigint not null references public.products(id) on delete cascade,
  change_qty numeric(12,2) not null,      -- signed: +received, -sold
  balance_after numeric(12,2),
  reason     public.stock_reason not null,
  note       text,
  appointment_id uuid references public.appointments(id) on delete set null,
  order_id   bigint,   -- FK added in 008, after `orders` exists
  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);

create index inventory_log_product_idx on public.inventory_log (product_id, created_at desc);

/**
 * The single entry point for changing stock. Writes the log row and moves
 * products.stock_qty in one statement so the two can never drift.
 */
create or replace function public.adjust_stock(
  p_product_id bigint,
  p_change     numeric,
  p_reason     public.stock_reason,
  p_note       text default null,
  p_appointment uuid default null
) returns numeric language plpgsql security definer set search_path = public as $$
declare new_balance numeric;
begin
  update public.products
  set stock_qty = stock_qty + p_change
  where id = p_product_id
  returning stock_qty into new_balance;

  if new_balance is null then
    raise exception 'Unknown product %', p_product_id;
  end if;

  insert into public.inventory_log
    (product_id, change_qty, balance_after, reason, note, appointment_id, changed_by)
  values (p_product_id, p_change, new_balance, p_reason, p_note, p_appointment, auth.uid());

  return new_balance;
end;
$$;

-- Low-stock alert, fired once on the crossing rather than on every decrement.
-- Externally fulfilled products are skipped: the marketplace holds that stock,
-- so a zero here means nothing and would alert constantly.
create or replace function public.product_low_stock_alert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.is_active
     and new.external_url is null
     and new.stock_qty <= new.low_stock_threshold
     and old.stock_qty > old.low_stock_threshold then
    perform public.notify_roles(
      array['manager', 'admin']::public.user_role[],
      'inventory_low',
      'Low stock — ' || new.name,
      new.stock_qty || ' ' || new.unit || ' remaining',
      '/dashboard/inventory');
  end if;
  return null;
end;
$$;

create trigger products_low_stock after update of stock_qty on public.products
  for each row execute function public.product_low_stock_alert();

-- Draw down back-bar stock when an appointment is completed.
create or replace function public.appointment_consume_stock()
returns trigger language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    for c in
      select sc.product_id, sc.qty
      from public.appointment_services aps
      join public.service_consumables sc on sc.service_id = aps.service_id
      where aps.appointment_id = new.id
    loop
      perform public.adjust_stock(
        c.product_id, -c.qty, 'consumed', 'Service completion', new.id);
    end loop;
  end if;
  return null;
end;
$$;

create trigger appointments_consume_stock after update of status on public.appointments
  for each row execute function public.appointment_consume_stock();

-- ── Approval queue ───────────────────────────────────────────
-- Providers and front desk can propose inventory changes; a manager applies
-- them. Numeric entries carry old/new values; `record` entries carry a JSON
-- payload so a proposed *new* product fits the same queue.
create table public.inventory_change_requests (
  id           bigserial primary key,
  entry_type   text not null check (entry_type in ('stock_qty', 'price', 'record')),
  target_table text check (target_table in ('products', 'product_categories', 'brands')),
  operation    text check (operation in ('create', 'update', 'archive', 'restore')),
  target_id    bigint,
  old_value    numeric,
  new_value    numeric,
  payload      jsonb,
  summary      text not null,
  reason       text,

  status       text not null default 'pending'
                 check (status in ('pending', 'approved', 'rejected')),
  requested_by uuid references public.profiles(id) on delete set null,
  reviewed_by  uuid references public.profiles(id) on delete set null,
  reviewed_at  timestamptz,
  review_note  text,
  created_at   timestamptz not null default now(),

  -- A record entry must say what it targets; non-create ops need a target row.
  constraint change_request_shape check (
    entry_type <> 'record'
    or (target_table is not null and operation is not null
        and (operation = 'create' or target_id is not null))
  )
);

create index inventory_requests_pending_idx on public.inventory_change_requests (created_at desc)
  where status = 'pending';

create or replace function public.inventory_request_notify()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.notify_roles(
    array['manager', 'admin']::public.user_role[],
    'inventory_approval', 'Inventory change awaiting approval', new.summary,
    '/dashboard/inventory/approvals');
  return null;
end;
$$;

create trigger inventory_requests_notify after insert on public.inventory_change_requests
  for each row execute function public.inventory_request_notify();

-- ── Vendors + purchase orders ────────────────────────────────
create table public.vendors (
  id           bigserial primary key,
  name         text not null,
  contact_name text,
  email        text,
  phone        text,
  website      text,
  account_number text,
  notes        text,
  is_active    boolean not null default true,
  created_at   timestamptz not null default now()
);

create table public.purchase_orders (
  id          bigserial primary key,
  po_number   text not null unique,
  vendor_id   bigint references public.vendors(id) on delete restrict,
  status      text not null default 'draft'
                check (status in ('draft', 'ordered', 'partial', 'received', 'cancelled')),
  ordered_at  timestamptz,
  expected_at date,
  received_at timestamptz,
  subtotal_cents int not null default 0,
  shipping_cents int not null default 0,
  tax_cents      int not null default 0,
  total_cents    int not null default 0,
  notes       text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.purchase_order_items (
  id         bigserial primary key,
  po_id      bigint not null references public.purchase_orders(id) on delete cascade,
  product_id bigint references public.products(id) on delete set null,
  name_snapshot text not null,
  qty_ordered  numeric(12,2) not null check (qty_ordered > 0),
  qty_received numeric(12,2) not null default 0,
  unit_cost_cents int not null default 0
);

create index po_items_po_idx on public.purchase_order_items (po_id);

create trigger purchase_orders_touch before update on public.purchase_orders
  for each row execute function public.touch_updated_at();

-- ── RLS ──────────────────────────────────────────────────────
alter table public.product_categories enable row level security;
alter table public.brands             enable row level security;
alter table public.products           enable row level security;
alter table public.service_consumables enable row level security;
alter table public.inventory_log      enable row level security;
alter table public.inventory_change_requests enable row level security;
alter table public.vendors            enable row level security;
alter table public.purchase_orders    enable row level security;
alter table public.purchase_order_items enable row level security;

create policy "public reads product categories" on public.product_categories
  for select to anon, authenticated using (is_active or public.is_staff());
create policy "public reads brands" on public.brands
  for select to anon, authenticated using (is_active or public.is_staff());

-- Only retail products are public. Back-bar-only stock stays internal.
create policy "public reads retail products" on public.products
  for select to anon, authenticated
  using ((is_active and is_retail and archived_at is null) or public.is_staff());

create policy "staff reads consumables" on public.service_consumables
  for select using (public.is_staff());
create policy "manager writes consumables" on public.service_consumables
  for all using (public.is_manager()) with check (public.is_manager());

-- Stock writes are manager-and-up. Everyone else files a change request.
create policy "manager writes products" on public.products
  for all using (public.is_manager()) with check (public.is_manager());

create policy "staff reads inventory log" on public.inventory_log
  for select using (public.is_staff());
create policy "manager writes inventory log" on public.inventory_log
  for insert with check (public.is_manager());

create policy "staff reads own requests" on public.inventory_change_requests
  for select using (public.is_staff());
create policy "staff files requests" on public.inventory_change_requests
  for insert with check (public.is_staff() and requested_by = auth.uid());
create policy "manager reviews requests" on public.inventory_change_requests
  for update using (public.is_manager()) with check (public.is_manager());

create policy "staff reads vendors" on public.vendors
  for select using (public.is_staff());
create policy "manager writes vendors" on public.vendors
  for all using (public.is_manager()) with check (public.is_manager());
create policy "staff reads purchase orders" on public.purchase_orders
  for select using (public.is_staff());
create policy "manager writes purchase orders" on public.purchase_orders
  for all using (public.is_manager()) with check (public.is_manager());
create policy "staff reads po items" on public.purchase_order_items
  for select using (public.is_staff());
create policy "manager writes po items" on public.purchase_order_items
  for all using (public.is_manager()) with check (public.is_manager());
