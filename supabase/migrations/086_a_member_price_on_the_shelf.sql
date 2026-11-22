-- ============================================================
-- 559 Flawless — 086: a member price on the shelf
--
-- 078 gave a membership a price on one service. Members also buy bottles,
-- and the studio wants to say "members get 15% off every product" or "buy a
-- cleanser, get the second one free" without hand-typing a discount at the
-- till every time. Nothing could express that, so it lived in staff memory.
--
-- `membership_product_perks` is one row per perk on a plan. Two kinds:
--
--   percent_off  percent_off% off every eligible retail unit, each unit
--                rounded half-up in integer cents (pairDiscountCents).
--   buy_get      buy buy_qty eligible units, get the next one percent_off
--                cheaper (100 = free, 50 = half off). Generalised exactly
--                like the multibuy deal (068): for every FULL group of
--                buy_qty + 1 eligible units in the basket, the cheapest
--                eligible units get percent_off. Six units on a buy-1-get-1
--                free perk make the three cheapest free.
--
-- Scope is product_id (one product), category_id (a product category), or
-- neither (every retail product). Never both: a CHECK says so, because "this
-- product, but only in that category" is a question with no useful answer.
--
-- The policy is 068's, extended by one competitor. Each perk is priced over
-- the whole basket on its own and the single best perk wins; that figure
-- then competes with the running multibuy deal and any promo code, and the
-- best single cut wins. Nothing stacks. A manager's hand-typed discount at
-- the till is not a deal and still rides on top, as it always has.
-- src/lib/member-product-perks.ts is the arithmetic; the checkout and the
-- till are where it is applied, server-side, never in the browser.
--
-- 050's memberships_grant_something is dropped (section 2): a plan may now
-- grant only member prices or product perks, which a row CHECK cannot see.
--
-- `orders` learns which deal supplied discount_cents (discount_source),
-- when a membership did, which one (client_membership_id), and how much of
-- discount_cents was the deal's own cut (deal_discount_cents) as against a
-- manager's hand-typed discount at the till, so a report can say what the
-- perk actually gave away (section 3). A CHECK keeps client_membership_id to
-- membership wins (section 4).
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

-- ── 1. The perks ─────────────────────────────────────────────

create table if not exists public.membership_product_perks (
  id            bigserial primary key,
  membership_id bigint not null references public.memberships(id) on delete cascade,
  kind          text not null check (kind in ('percent_off', 'buy_get')),
  percent_off   int not null check (percent_off between 1 and 100),
  -- buy_get only: how many eligible units buy the discounted one.
  buy_qty       int check (buy_qty between 1 and 10),
  -- Scope. Both null means every retail product.
  product_id    bigint references public.products(id) on delete cascade,
  category_id   bigint references public.product_categories(id) on delete cascade,
  -- Optional wording for the public card; the app writes its own otherwise.
  label         text,
  sort_order    int not null default 0,
  created_at    timestamptz default now(),

  constraint membership_product_perks_buy_qty_check_kind
    check (kind <> 'buy_get' or buy_qty is not null),
  constraint membership_product_perks_one_scope
    check (product_id is null or category_id is null)
);

comment on table public.membership_product_perks is
  'Retail perks a membership grants while current: a percent off, or buy N get one cheaper. '
  'Each perk is priced over the whole basket on its own, the best perk wins, and it then '
  'competes with the multibuy deal and any promo code. Best single cut wins; nothing stacks.';

comment on column public.membership_product_perks.buy_qty is
  'buy_get only. For every full group of buy_qty + 1 eligible units, the cheapest unit gets '
  'percent_off (100 = free). Cheapest first, like the multibuy deal in 068.';

comment on column public.membership_product_perks.product_id is
  'Scope: one product. Never set together with category_id. Both null means every retail product.';

comment on column public.membership_product_perks.category_id is
  'Scope: a product category. Never set together with product_id.';

create index if not exists membership_product_perks_membership_idx
  on public.membership_product_perks (membership_id);

alter table public.membership_product_perks enable row level security;

-- Perks are a price list, like member prices (078): anyone may read the
-- perks of an active plan, staff read every plan's. Not narrowed to
-- sell_online, because a member enrolled at the counter on a plan that is
-- not sold online still needs to see their perks in the bag, which reads
-- them with the browser client. Mirrors membership_member_prices_select.
drop policy if exists "membership_product_perks_select" on public.membership_product_perks;
create policy "membership_product_perks_select" on public.membership_product_perks
  for select to anon, authenticated
  using (
    public.is_staff()
    or exists (select 1 from public.memberships m where m.id = membership_id and m.is_active)
  );

drop policy if exists "membership_product_perks_write" on public.membership_product_perks;
create policy "membership_product_perks_write" on public.membership_product_perks
  for all to authenticated
  using (public.is_manager())
  with check (public.is_manager());

-- ── 2. A plan may grant only perks ───────────────────────────

-- 050's memberships_grant_something required a service discount or included
-- sessions. Member prices (078) and product perks (above) are grants too, and
-- a retail club with 15% off products and nothing else is a real plan. A
-- CHECK sees only its own row, never the perk or member-price tables, so it
-- cannot tell that plan from an empty one. "Grants something" is now enforced
-- by the editor (src/components/shared/MembershipEditor.tsx).
alter table public.memberships drop constraint if exists memberships_grant_something;

-- ── 3. Which deal the order's discount came from, and how much

alter table public.orders
  add column if not exists client_membership_id bigint
    references public.client_memberships(id) on delete set null,
  add column if not exists discount_source text
    check (discount_source in ('multibuy', 'coupon', 'membership'));

comment on column public.orders.discount_source is
  'Which deal supplied discount_cents: the multibuy promotion, a promo code, or a membership '
  'product perk. One source, because deals never stack. A manager''s manual discount at the '
  'till is not a source and rides on top. Null when no deal won.';

comment on column public.orders.client_membership_id is
  'The membership whose product perk supplied the discount, set only when discount_source is '
  '''membership''.';

alter table public.orders
  add column if not exists deal_discount_cents int not null default 0
    check (deal_discount_cents >= 0);

comment on column public.orders.deal_discount_cents is
  'The part of discount_cents that a deal supplied (the multibuy promotion, a promo code, or a '
  'member perk, named by discount_source). The rest of discount_cents is a manager''s '
  'hand-typed discount at the till. Zero when no deal won.';

-- ── 4. A membership id only on a membership win ──────────────

-- client_membership_id is stamped only when a membership perk won. On delete
-- set null may later clear it, which this allows; the reverse (an id on a
-- multibuy or coupon order) is never right.
alter table public.orders drop constraint if exists orders_membership_source_check;
alter table public.orders
  add constraint orders_membership_source_check
    check (client_membership_id is null or discount_source = 'membership');
