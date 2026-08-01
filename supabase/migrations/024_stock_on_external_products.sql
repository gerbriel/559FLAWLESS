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
