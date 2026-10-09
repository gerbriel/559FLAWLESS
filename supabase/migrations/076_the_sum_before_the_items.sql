-- ============================================================
-- 559 Flawless — 076: the sum before the items
--
-- At the counter the money is often settled before anyone has listed what it
-- was for: "that's $85 for today", the card goes through, and the bottles and
-- the add-on get sorted out afterwards. The till could only sell things it
-- could price itself, so the desk either made the client wait or rang up
-- something approximate.
--
-- Two pieces:
--
--   1. `order_items.kind` — a line is a product off the shelf, a custom amount
--      the desk typed in, or a service the money is being put against. Until
--      now a line with no product meant "the product was deleted" (or a
--      package), and the retail report flagged it as such; a typed amount needs
--      to be able to say what it is.
--
--   2. `itemize_order()` — assign products and services to a custom amount
--      after the fact. Prices are read from the catalogue here, never from the
--      caller (rule 2). The order total does NOT move: the client paid what
--      they paid. The custom line shrinks by what is assigned; if what is
--      assigned is worth more than what is left, the difference is recorded as
--      discount, so the receipt still adds up and the gap is visible.
--
--      Assigned products come off the shelf here, at the order's own site. The
--      status trigger that normally does it (021) only fires on the move out
--      of `cart`, which happened when the money was taken.
--
-- The custom amount itself is written by /api/pos/sale, front desk and up —
-- the same people who can already run the till.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

alter table public.order_items
  add column if not exists kind text not null default 'product',
  add column if not exists service_id bigint references public.services(id) on delete set null;

alter table public.order_items
  drop constraint if exists order_items_kind_check;
alter table public.order_items
  add constraint order_items_kind_check check (
    kind in ('product', 'custom', 'service')
    -- Only a product line points at a product; only a service line at a service.
    and (kind = 'product' or product_id is null)
    and (kind = 'service' or service_id is null)
  );

comment on column public.order_items.kind is
  'product: off the shelf. custom: an amount typed in at the till, not yet '
  '(or never) itemised. service: a treatment the money was put against after '
  'the fact by itemize_order(). Defaults to product so every existing writer '
  'is unchanged.';

-- At most one open amount per order: itemize_order() shrinks "the" custom line.
create unique index if not exists order_items_one_custom_per_order
  on public.order_items (order_id) where kind = 'custom';

/**
 * Put products and services against the custom amount on a counter sale.
 *
 * p_lines: [{"product_id": 12, "qty": 2}, {"service_id": 3, "qty": 1}, ...]
 *
 * Returns the assigned value, what is still unassigned, and any amount that
 * went beyond the open balance and was recorded as discount.
 */
create or replace function public.itemize_order(p_order bigint, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  ord          record;
  open_line    record;
  el           jsonb;
  prod         record;
  svc          record;
  qty          int;
  on_shelf     numeric;
  added        int := 0;
  over         int := 0;
  remaining    int;
  pending      jsonb := '[]'::jsonb;
begin
  if not public.is_front_desk() then
    raise exception 'Only front desk and up can itemise a sale';
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Nothing to assign';
  end if;
  if jsonb_array_length(p_lines) > 50 then
    raise exception 'Too many lines at once';
  end if;

  select id, order_number, channel, status, location_id
  into ord
  from public.orders where id = p_order
  for update;

  if ord.id is null then
    raise exception 'Unknown order';
  end if;
  if ord.channel <> 'in_store' or ord.status <> 'completed' then
    raise exception 'Only a completed counter sale can be itemised';
  end if;

  select id, unit_price_cents into open_line
  from public.order_items
  where order_id = p_order and kind = 'custom'
  for update;

  if open_line.id is null then
    raise exception 'Nothing left to assign on this order';
  end if;

  -- Price and validate every line before writing any of them.
  for el in select * from jsonb_array_elements(p_lines) loop
    qty := coalesce((el->>'qty')::int, 1);
    if qty < 1 or qty > 999 then
      raise exception 'Quantity must be between 1 and 999';
    end if;

    if el ? 'product_id' then
      select id, name, sku, price_cents, is_active, is_retail into prod
      from public.products where id = (el->>'product_id')::bigint;

      if prod.id is null then
        raise exception 'Unknown product';
      end if;
      if not prod.is_active or not prod.is_retail then
        raise exception '% is not sold to clients', prod.name;
      end if;
      if prod.price_cents <= 0 then
        raise exception '% has no price yet', prod.name;
      end if;

      select coalesce(sum(ps.qty), 0) into on_shelf
      from public.product_stock ps
      where ps.product_id = prod.id and ps.location_id = ord.location_id;
      if on_shelf < qty then
        raise exception 'Only % of % on the shelf', on_shelf, prod.name;
      end if;

      pending := pending || jsonb_build_object(
        'kind', 'product', 'product_id', prod.id, 'name', prod.name,
        'sku', prod.sku, 'price', prod.price_cents, 'qty', qty);
      added := added + prod.price_cents * qty;

    elsif el ? 'service_id' then
      select id, name, price_cents, is_active into svc
      from public.services where id = (el->>'service_id')::bigint;

      if svc.id is null or not svc.is_active then
        raise exception 'Unknown service';
      end if;

      pending := pending || jsonb_build_object(
        'kind', 'service', 'service_id', svc.id, 'name', svc.name,
        'price', svc.price_cents, 'qty', qty);
      added := added + svc.price_cents * qty;

    else
      raise exception 'Each line needs a product_id or a service_id';
    end if;
  end loop;

  remaining := open_line.unit_price_cents - added;
  if remaining < 0 then
    over := -remaining;
    remaining := 0;
  end if;

  -- Discount first: the line triggers below recompute the total from it.
  if over > 0 then
    update public.orders set discount_cents = discount_cents + over where id = p_order;
  end if;

  for el in select * from jsonb_array_elements(pending) loop
    insert into public.order_items
      (order_id, kind, product_id, service_id, name_snapshot, sku_snapshot, unit_price_cents, qty)
    values
      (p_order, el->>'kind',
       (el->>'product_id')::bigint, (el->>'service_id')::bigint,
       el->>'name', el->>'sku', (el->>'price')::int, (el->>'qty')::int);

    if el->>'kind' = 'product' then
      perform public.adjust_stock(
        (el->>'product_id')::bigint, -((el->>'qty')::int), 'sold',
        'Order ' || coalesce(ord.order_number, ord.id::text) || ' (itemised)',
        null, ord.location_id);
    end if;
  end loop;

  if remaining = 0 then
    delete from public.order_items where id = open_line.id;
  else
    update public.order_items set unit_price_cents = remaining where id = open_line.id;
  end if;

  -- Belt and braces: the row triggers have already rolled this up, but the
  -- total is the one figure that must not drift, so say it once more.
  update public.orders o
  set total_cents = greatest(o.subtotal_cents - o.discount_cents + o.tax_cents + o.shipping_cents, 0)
  where o.id = p_order;

  return jsonb_build_object(
    'assigned_cents', added,
    'unassigned_cents', remaining,
    'over_cents', over
  );
end;
$$;

revoke all on function public.itemize_order(bigint, jsonb) from public, anon;
grant execute on function public.itemize_order(bigint, jsonb) to authenticated;
