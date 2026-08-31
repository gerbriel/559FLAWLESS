-- ============================================================
-- 559 Flawless — 068: the deal board, and the friend code
--
-- The studio runs promotions the way it always has — on Instagram, for a
-- month at a time: "HELLO KITTY $175 reg $200", "second service half off",
-- "buy two products get the third half off", "20% off for new clients",
-- "$20 off when a friend comes in". None of that had anywhere to live in the
-- system, so the deals were applied by hand at the counter or not at all,
-- and nobody could say afterwards who used what.
--
-- Two things, then:
--
-- 1. `promotions` — one row per running deal, date-windowed, admin-CRUD'd.
--    Five kinds, because that is what the studio actually posts:
--
--      service_sale      named services at a flat sale price OR a percent off,
--                        shown crossed-out against the regular price
--      second_service    two or more services in one visit: the cheapest
--                        undiscounted one is percent_off cheaper
--      product_multibuy  every full group of min_items retail products,
--                        the cheapest is percent_off cheaper
--      new_client        percent_off a client's first visit
--      referral          the referral program's reward: what the REFERRER
--                        earns (flat cents or a percent of a visit) each time
--                        their code brings somebody new in
--
--    A deal is applied where prices are already decided — priceService() for
--    service lines, the booking engine for the visit, the till and checkout
--    for retail — never in the browser. Discounts never stack on one line:
--    the best single cut wins, which is also the only arithmetic a person at
--    the counter can verify in their head.
--
-- 2. Referral codes. Every client can hold one code; a new client types it
--    into their first booking. `referral_redemptions` is the tracking the
--    studio asked for — who referred whom, when, and what the referrer earned
--    — and UNIQUE(referred_client_id) is the "unique uses" rule: a person can
--    be referred into the studio exactly once, so a code's count is a count
--    of real new faces, not of repeat visits.
--
-- The visit-level money lands in a new `appointments.promo_discount_cents`,
-- subtracted by the same one-place total derivation 050 established. Line-
-- level money freezes into `appointment_services` like every other price.
-- `promotion_redemptions` records every application with a name snapshot, so
-- deleting a finished promo never erases the history of what it gave away.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

-- ── 1. The deal board ────────────────────────────────────────

create table if not exists public.promotions (
  id                bigserial primary key,
  name              text not null,
  kind              text not null check (kind in
                      ('service_sale', 'second_service', 'product_multibuy',
                       'new_client', 'referral')),

  -- Which of these matter depends on the kind; the engine reads what its
  -- kind needs and ignores the rest, and the admin form only offers the
  -- fields that mean something.
  percent_off       int check (percent_off between 1 and 100),
  amount_cents      int check (amount_cents > 0),
  sale_price_cents  int check (sale_price_cents >= 0),
  min_items         int check (min_items between 2 and 20),
  -- service_sale: the services on sale. Empty means none — a sale names its
  -- services. (second_service deliberately has no scope: "mix and match".)
  service_ids       bigint[] not null default '{}',

  -- The run. Null = no bound on that side.
  starts_at         timestamptz,
  ends_at           timestamptz,
  is_active         boolean not null default true,

  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.promotions is
  'Date-windowed deals, admin-managed. Applied server-side where prices are decided; every application lands in promotion_redemptions.';

drop trigger if exists promotions_touch on public.promotions;
create trigger promotions_touch before update on public.promotions
  for each row execute function public.touch_updated_at();

alter table public.promotions enable row level security;

-- The storefront and booking flow show live deals to anyone; staff see the
-- whole board including paused and finished runs.
drop policy if exists "public reads live promotions" on public.promotions;
create policy "public reads live promotions" on public.promotions
  for select using (is_active or public.is_staff());

-- Pricing is an admin decision, same as the menu.
drop policy if exists "admin writes promotions" on public.promotions;
create policy "admin writes promotions" on public.promotions
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.promotions from public, anon, authenticated;
grant select on public.promotions to anon, authenticated;
grant insert, update, delete on public.promotions to authenticated;
grant usage on sequence public.promotions_id_seq to authenticated;

-- ── 2. What each deal actually gave away ─────────────────────

create table if not exists public.promotion_redemptions (
  id              bigserial primary key,
  promotion_id    bigint references public.promotions(id) on delete set null,
  -- Snapshot, so a deleted promo's history still reads as itself.
  promotion_name  text not null,
  client_id       uuid references public.profiles(id) on delete set null,
  appointment_id  uuid references public.appointments(id) on delete set null,
  order_id        bigint references public.orders(id) on delete set null,
  discount_cents  int not null check (discount_cents >= 0),
  created_at      timestamptz not null default now()
);

comment on table public.promotion_redemptions is
  'One row per applied deal — who, where, and how much came off. The client profile and the deal board both read their tallies from here.';

create index if not exists promotion_redemptions_promo_idx
  on public.promotion_redemptions (promotion_id, created_at desc);
create index if not exists promotion_redemptions_client_idx
  on public.promotion_redemptions (client_id, created_at desc);

alter table public.promotion_redemptions enable row level security;

drop policy if exists "client reads own promo history" on public.promotion_redemptions;
create policy "client reads own promo history" on public.promotion_redemptions
  for select using (client_id = auth.uid());
drop policy if exists "staff reads promo history" on public.promotion_redemptions;
create policy "staff reads promo history" on public.promotion_redemptions
  for select using (public.is_staff());
-- No insert/update/delete policies at all — the booking engine and the till
-- write these with the service role, and history is history.

revoke all on public.promotion_redemptions from public, anon, authenticated;
grant select on public.promotion_redemptions to authenticated;

-- ── 3. The visit-level discount, in the one total derivation ─

alter table public.appointments
  add column if not exists promo_discount_cents int not null default 0
    check (promo_discount_cents >= 0);

comment on column public.appointments.promo_discount_cents is
  'Visit-level promotion money: new-client percent, an applied referral reward. Line-level deals live on the lines. Subtracted by appointment_derive_total.';

-- Third edition of the derivation: 004 summed, 050 subtracted memberships,
-- 068 subtracts promotions. Still one function, on the row that owns every
-- input, still floored at zero — a discount never becomes money owed.
create or replace function public.appointment_derive_total()
returns trigger language plpgsql set search_path = public as $$
begin
  new.total_cents := greatest(
    new.subtotal_cents
      - new.membership_covered_cents
      - new.membership_discount_cents
      - new.promo_discount_cents,
    0
  );
  return new;
end;
$$;

-- The line-level stamp, parallel to pair_discount_id (067).
alter table public.appointment_services
  add column if not exists promotion_id bigint references public.promotions(id) on delete set null;

-- ── 4. The friend code ───────────────────────────────────────

create table if not exists public.referral_codes (
  code       text primary key check (code ~ '^[A-Z0-9][A-Z0-9-]{3,19}$'),
  client_id  uuid not null unique references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.referral_redemptions (
  id                     bigserial primary key,
  code                   text not null references public.referral_codes(code) on delete cascade,
  -- Denormalised from the code on purpose: the reward belongs to the person,
  -- and every screen that shows it starts from a person, not a code.
  referrer_id            uuid not null references public.profiles(id) on delete cascade,
  referred_client_id     uuid not null references public.profiles(id) on delete cascade,
  -- The referred client's first booking — what earned the reward.
  appointment_id         uuid references public.appointments(id) on delete set null,
  -- What the referrer earns, snapshotted from the referral promo at the time.
  reward_cents           int check (reward_cents > 0),
  reward_percent         int check (reward_percent between 1 and 100),
  reward_status          text not null default 'earned'
                           check (reward_status in ('earned', 'applied', 'void')),
  -- The referrer's visit the reward came off, once it has.
  applied_appointment_id uuid references public.appointments(id) on delete set null,
  created_at             timestamptz not null default now(),
  applied_at             timestamptz,

  -- The whole "unique uses" rule: a person is referred into the studio once.
  unique (referred_client_id),
  check (referrer_id <> referred_client_id)
);

comment on table public.referral_redemptions is
  'One row per person a code brought in. The referrer''s reward rides the row: earned when the friend books, applied when the front desk takes it off a visit.';

create index if not exists referral_redemptions_referrer_idx
  on public.referral_redemptions (referrer_id, created_at desc);

alter table public.referral_codes       enable row level security;
alter table public.referral_redemptions enable row level security;

drop policy if exists "client reads own code" on public.referral_codes;
create policy "client reads own code" on public.referral_codes
  for select using (client_id = auth.uid());
drop policy if exists "staff reads codes" on public.referral_codes;
create policy "staff reads codes" on public.referral_codes
  for select using (public.is_staff());
-- Codes are minted only by get_or_create_referral_code below.

drop policy if exists "client reads own referrals" on public.referral_redemptions;
create policy "client reads own referrals" on public.referral_redemptions
  for select using (referrer_id = auth.uid() or referred_client_id = auth.uid());
drop policy if exists "staff reads referrals" on public.referral_redemptions;
create policy "staff reads referrals" on public.referral_redemptions
  for select using (public.is_staff());
-- Applying a reward changes status and stamps the visit; the desk does that.
drop policy if exists "front desk applies referral rewards" on public.referral_redemptions;
create policy "front desk applies referral rewards" on public.referral_redemptions
  for update using (public.is_front_desk()) with check (public.is_front_desk());

revoke all on public.referral_codes from public, anon, authenticated;
grant select on public.referral_codes to authenticated;
revoke all on public.referral_redemptions from public, anon, authenticated;
grant select, update on public.referral_redemptions to authenticated;

/**
 * A client's referral code, minted on first ask.
 *
 * SECURITY DEFINER because no insert policy exists on referral_codes — this
 * function is the only mint, so a code's shape and its one-per-client rule
 * cannot be worked around. A client may mint their own; staff may mint for
 * anyone (the front desk reading it out loud is a normal path).
 */
create or replace function public.get_or_create_referral_code(p_client uuid)
returns text language plpgsql volatile security definer set search_path = public as $$
declare
  found text;
  attempt int := 0;
begin
  if auth.uid() is not null and auth.uid() <> p_client and not public.is_staff() then
    raise exception 'not allowed';
  end if;

  select code into found from public.referral_codes where client_id = p_client;
  if found is not null then return found; end if;

  loop
    attempt := attempt + 1;
    begin
      insert into public.referral_codes (code, client_id)
      values ('FLW-' || upper(substr(md5(gen_random_uuid()::text), 1, 5)), p_client)
      returning code into found;
      return found;
    exception when unique_violation then
      -- Either the code collided (try another) or the client raced themselves
      -- (their row now exists — return it).
      select code into found from public.referral_codes where client_id = p_client;
      if found is not null then return found; end if;
      if attempt >= 10 then raise; end if;
    end;
  end loop;
end;
$$;

revoke all on function public.get_or_create_referral_code(uuid) from public;
grant execute on function public.get_or_create_referral_code(uuid) to authenticated, service_role;

-- ============================================================
-- Deliberately left alone:
--
-- * The pair deal (067). It is its own mechanism with its own admin screen,
--   and folding it into `promotions` would have re-keyed live rows for
--   tidiness. The no-stacking rule treats the two as one family: best single
--   cut per line.
-- * `orders.promo_code` — still a dead text column. Retail deals here are
--   automatic (multibuy needs no code), and referral codes are their own
--   table with their own rules.
-- * Loyalty (067). Points still accrue from payments — which means a
--   discounted visit simply earns fewer points, with no extra wiring.
-- ============================================================
