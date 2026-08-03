-- ============================================================
-- 559 Flawless — 054: the shelf the low-stock alert never watched
--
-- 007 wrote the low-stock alert to skip anything with an `external_url`, and
-- said why: "the marketplace holds that stock, so a zero here means nothing and
-- would alert constantly." That was correct when it was written. The same
-- migration carried
--
--     constraint products_external_has_no_stock check (
--       external_url is null or stock_qty = 0 )
--
-- so a linked product was pinned at zero by the schema. Every one of them sat
-- permanently at or below its threshold, and without the exclusion the studio
-- would have been told about all of them, forever.
--
-- 024 dropped that CHECK, and its header explains at length that the premise
-- was wrong: the studio DOES keep these on the shelf and sell them in person,
-- and the link is the fallback for when she runs out. So linked products have
-- held real stock for thirty migrations, and the one mechanism whose entire job
-- is to say "you are running out" has been ignoring them the whole time.
--
-- The screen was corrected already. This is the database catching up, and the
-- two are deliberately not corrected to the same rule.
--
-- ── Why the list and the alert want different tests ─────────
--
-- They answer different questions, and the difference is state versus event.
--
-- The Low-stock LIST is a standing question: what should I reorder today. A
-- linked product resting at zero is not an answer to it — the studio does not
-- stock that one, the marketplace fulfils it, and it would sit on the list
-- forever crowding out things that can actually be reordered. So the screen
-- skips a linked product only when it holds nothing, which is 007's instinct
-- kept and narrowed rather than thrown away.
--
-- The ALERT is a question about a moment: something just crossed the line. It
-- already fires only on the crossing —
--
--     new.stock_qty <= new.low_stock_threshold
--     and old.stock_qty > old.low_stock_threshold
--
-- — so a product that sits at zero cannot alert twice, and could never have
-- alerted "constantly" once that guard existed. The `external_url is null`
-- clause was belt and braces for a constraint that no longer exists, and it is
-- now the only reason the studio is not told when the linked serum she actually
-- sells drops from four to one.
--
-- It goes entirely, rather than gaining the screen's `stock_qty > 0` narrowing.
-- Four to zero in one sale is the single most useful alert this trigger can
-- send, and the narrowing would suppress exactly that one: a run to zero is the
-- moment the shelf is empty and the client is being sent to the marketplace
-- instead. The list may ignore a resting zero; the alert must not ignore the
-- fall that produced it.
--
-- ── The index has to follow, or the change is theatre ───────
--
-- `products_low_stock_idx` is partial on the same three clauses. A partial
-- index only answers queries whose predicate it implies, so the low-stock read
-- would stop using it the moment the screen's rule widened — silently
-- degrading to a scan rather than erroring. Recreated to match what is now
-- asked of it.
--
-- Nothing here changes a table's shape and `src/types/database.ts` does not need
-- regenerating. Every statement is guarded; running this twice does nothing the
-- second time.
-- ============================================================

create or replace function public.product_low_stock_alert()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- No external_url test. A linked product holds real stock (024), and the
  -- crossing guard on the last line is what stops this firing more than once
  -- per fall — which was always the actual protection against noise.
  if new.is_active
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

comment on function public.product_low_stock_alert() is
  'Tells the managers when a product crosses below its threshold, once per '
  'fall. Linked products are included: 024 dropped the CHECK that pinned them '
  'at zero, so they hold real stock and running out of one is exactly what the '
  'studio needs to hear.';

-- Recreate the trigger so this file stands alone if it is ever dropped. Same
-- timing and same column as 007.
drop trigger if exists products_low_stock on public.products;
create trigger products_low_stock after update of stock_qty on public.products
  for each row execute function public.product_low_stock_alert();

-- The index the screen's query needs now. Kept partial — `is_active` and the
-- threshold comparison are still in every low-stock read, and a full index on
-- stock_qty would be larger and less useful.
drop index if exists public.products_low_stock_idx;
create index if not exists products_low_stock_idx
  on public.products (stock_qty)
  where is_active and stock_qty <= low_stock_threshold;
