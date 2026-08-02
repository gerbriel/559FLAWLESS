-- ============================================================
-- 559 Flawless — 043: what the studio actually paid for what it sold
--
-- `order_items` snapshots the price a product SOLD for, so a later price change
-- can never rewrite an old receipt. It does not snapshot the cost, so margin
-- has to be derived from `products.cost_cents` as it stands today — which is
-- accurate right up until a wholesale price changes, and then quietly restates
-- every historical margin figure the studio has ever looked at.
--
-- 033's profit_summary() documents this limitation in its own comment. This
-- closes it: cost is captured at the moment of sale, the same way price is.
-- ============================================================

alter table public.order_items
  add column if not exists cost_snapshot_cents int;

comment on column public.order_items.cost_snapshot_cents is
  'What this unit cost the studio, captured at sale. Null on rows written '
  'before 043 — report code must fall back to products.cost_cents for those '
  'and say that it did.';

/**
 * Capture the cost alongside the price.
 *
 * A BEFORE trigger rather than application code, because there are two ways a
 * sale is written — the till and the Stripe checkout — and a rule enforced in
 * one of them is a rule that holds half the time.
 *
 * Only fills a NULL: an explicit cost passed in wins, which lets a correction
 * be recorded without the trigger overwriting it.
 */
create or replace function public.order_item_capture_cost()
returns trigger language plpgsql as $$
begin
  if new.cost_snapshot_cents is null and new.product_id is not null then
    select cost_cents into new.cost_snapshot_cents
    from public.products where id = new.product_id;
  end if;
  return new;
end;
$$;

drop trigger if exists order_items_capture_cost on public.order_items;
create trigger order_items_capture_cost
  before insert on public.order_items
  for each row execute function public.order_item_capture_cost();

-- Backfill what is already on file. This is the best available answer for
-- historical rows — today's cost — and is exactly the approximation the column
-- exists to stop making from here on. Doing it once, now, at least freezes the
-- figure so it stops drifting with every future price change.
update public.order_items oi
set cost_snapshot_cents = p.cost_cents
from public.products p
where oi.product_id = p.id
  and oi.cost_snapshot_cents is null;
