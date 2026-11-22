-- ============================================================
-- 559 Flawless — 087: a perk that runs out
--
-- 086 gave a plan retail perks, and every one of them was unlimited: 15% off
-- every bottle, every day, as many as the member could carry. The studio
-- wants to say "one free cleanser a month" or "20% off one product per
-- visit", and nothing could express a perk that runs out.
--
-- Two independent knobs on membership_product_perks (section 1):
--
--   max_uses           how many orders this perk may win inside a window.
--                      Null is unlimited, as every 086 perk was.
--   uses_window        which window: 'period' is the member's current
--                      membership period (050's current_period_start), and
--                      'month' is the calendar month in the studio's zone,
--                      America/Los_Angeles.
--   max_units_per_use  how many eligible units one order may discount. Null
--                      is unlimited. percent_off takes the DEAREST N eligible
--                      units (member-friendly, the way an included session
--                      takes the dearest treatment); buy_get discounts at most
--                      N units, which is at most N groups.
--
-- One USE is one order in which this perk was the winning deal. Deals never
-- stack (068), so an order has at most one, and membership_perk_redemptions
-- (section 2) carries one row per order, unique on order_id.
--
-- Uses are counted from those rows joined to their orders, and only orders
-- that are, or may still become, a sale count: every status but 'cart' and
-- 'cancelled'. That is pending_payment and paid, and also the states a paid
-- online order moves through on its way out the door (fulfilling,
-- ready_for_pickup, shipped, completed); naming only pending_payment, paid
-- and completed would hand a use back the moment staff marked a bag ready.
-- A refunded order keeps its use: the bottle was in someone's hands.
--
-- perk_uses_so_far (section 3) is that count, in one place, for the routes
-- and for the browser previews alike.
--
-- claim_perk_use (section 4) is the only way a use is spent. The checkout
-- and the till call it the moment the order exists and before any money
-- moves; it takes an advisory lock on the perk and the membership, counts,
-- and writes the redemption row only if a use is left. Two checkouts racing
-- for the last use cannot both win it: the second waits on the lock, counts
-- the first one's row, and is told no, so its route reprices without that
-- perk. An abandoned online checkout leaves its row behind, which does no
-- harm: the session expires after half an hour, the webhook cancels the
-- order, and a cancelled order no longer counts. The use comes back by
-- itself.
--
-- The redemption row outlives its perk (perk_id goes null when a manager
-- deletes the perk) so the reports keep the order, the membership and what
-- came off. The membership editor updates perks in place rather than
-- replacing them, so an ordinary save never resets anyone's uses.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

-- ── 1. The limits ────────────────────────────────────────────

alter table public.membership_product_perks
  add column if not exists max_uses int
    check (max_uses between 1 and 99),
  add column if not exists uses_window text not null default 'period'
    check (uses_window in ('period', 'month')),
  add column if not exists max_units_per_use int
    check (max_units_per_use between 1 and 99);

comment on column public.membership_product_perks.max_uses is
  'How many orders this perk may win inside uses_window. Null is unlimited. One use is one '
  'order in which this perk was the winning deal; a cancelled order gives its use back.';

comment on column public.membership_product_perks.uses_window is
  'Where max_uses is counted: ''period'' is the member''s current membership period, '
  '''month'' is the calendar month in America/Los_Angeles. Ignored when max_uses is null.';

comment on column public.membership_product_perks.max_units_per_use is
  'The most eligible units one use may discount. Null is unlimited. percent_off takes the '
  'dearest N eligible units; buy_get discounts at most N units (N groups).';

-- ── 2. Every win, on paper ───────────────────────────────────

create table if not exists public.membership_perk_redemptions (
  id                   bigserial primary key,
  -- Null once the perk itself is deleted: the history stays, for the
  -- reports, and a deleted perk has no uses left to count anyway.
  perk_id              bigint
                         references public.membership_product_perks(id) on delete set null,
  client_membership_id bigint not null
                         references public.client_memberships(id) on delete cascade,
  client_id            uuid references public.profiles(id) on delete set null,
  -- One deal per order, so one row per order.
  order_id             bigint not null unique
                         references public.orders(id) on delete cascade,
  -- The deal's own cut, integer cents. A manager's manual discount is not in it.
  discount_cents       int not null check (discount_cents >= 0),
  -- How many units the perk discounted on this order.
  units                int not null default 0,
  created_at           timestamptz not null default now()
);

comment on table public.membership_perk_redemptions is
  'One row per order a membership product perk won: which perk, which membership, how much '
  'came off. Uses are counted from here, joined to orders that are not cancelled. Written only '
  'by claim_perk_use(), which the checkout and the till call with the service role. perk_id is '
  'null once the perk is deleted; the row stays for the reports.';

-- For a database that ran an earlier draft of this file, where perk_id was
-- not null and cascaded: the same shape as the create above. Both guarded.
alter table public.membership_perk_redemptions alter column perk_id drop not null;
alter table public.membership_perk_redemptions
  drop constraint if exists membership_perk_redemptions_perk_id_fkey;
alter table public.membership_perk_redemptions
  add constraint membership_perk_redemptions_perk_id_fkey
  foreign key (perk_id) references public.membership_product_perks(id) on delete set null;

create index if not exists membership_perk_redemptions_perk_idx
  on public.membership_perk_redemptions (perk_id, created_at);
create index if not exists membership_perk_redemptions_membership_idx
  on public.membership_perk_redemptions (client_membership_id, created_at);

alter table public.membership_perk_redemptions enable row level security;

drop policy if exists "client reads own perk history" on public.membership_perk_redemptions;
create policy "client reads own perk history" on public.membership_perk_redemptions
  for select using (client_id = auth.uid());
drop policy if exists "staff reads perk history" on public.membership_perk_redemptions;
create policy "staff reads perk history" on public.membership_perk_redemptions
  for select using (public.is_staff());
-- No insert/update/delete policies at all: the checkout and the till write
-- these with the service role, and history is history.

revoke all on public.membership_perk_redemptions from public, anon, authenticated;
grant select on public.membership_perk_redemptions to authenticated;

-- ── 3. How many uses are gone ────────────────────────────────

-- Counts the wins of one perk on one membership inside the window: since
-- p_period_start for 'period', since the first of this month in
-- America/Los_Angeles for 'month'. Only orders that are or may become a sale
-- count, so a checkout Stripe expired (and the webhook cancelled) gives its
-- use back. Security definer so the join to orders sees every order; it
-- returns a number and nothing else.
--
-- Who gets the real figure: the service role, staff, or the member whose
-- membership it is. Anyone else gets 0. The service role is tested by name,
-- not inferred from a missing auth.uid(): the service key's JWT carries no
-- `sub`, so auth.uid() is null for it, but auth.uid() is also null for any
-- caller with no usable JWT at all, and the guard must not rest on the anon
-- revoke below alone. auth.role() reads the JWT's `role` claim, which is
-- 'service_role' only for the service key.
create or replace function public.perk_uses_so_far(
  p_client_membership bigint,
  p_perk bigint,
  p_window text,
  p_period_start timestamptz
)
returns int language sql stable security definer set search_path = public as $$
  select count(*)::int
  from public.membership_perk_redemptions r
  join public.orders o on o.id = r.order_id
  where r.client_membership_id = p_client_membership
    and r.perk_id = p_perk
    and o.status not in ('cart', 'cancelled')
    and (
      auth.role() = 'service_role'
      or public.is_staff()
      or exists (
        select 1 from public.client_memberships cm
        where cm.id = p_client_membership and cm.client_id = auth.uid()
      )
    )
    and r.created_at >= case
      when p_window = 'month'
        then date_trunc('month', now() at time zone 'America/Los_Angeles')
               at time zone 'America/Los_Angeles'
      else p_period_start
    end;
$$;

comment on function public.perk_uses_so_far(bigint, bigint, text, timestamptz) is
  'Wins of one membership product perk on one membership inside its window (''period'' from '
  'p_period_start, ''month'' from the first of the month in America/Los_Angeles), counting '
  'every order not in cart or cancelled. Own membership or staff only (anyone else gets 0); '
  'the service role, tested by its JWT role claim, always.';

revoke all on function public.perk_uses_so_far(bigint, bigint, text, timestamptz) from public, anon;
grant execute on function public.perk_uses_so_far(bigint, bigint, text, timestamptz)
  to authenticated, service_role;

-- ── 4. Spending a use, atomically ────────────────────────────

-- Spend one use of p_perk on p_client_membership for order p_order, if one is
-- left. True means the order may carry the perk's discount and the row is
-- written; false means the perk is spent (or no longer belongs to this
-- membership's plan) and the caller must price the order without it.
--
--   * Service role only. Execute is revoked from public, anon and
--     authenticated, and the body checks auth.role() as well, so a grant
--     added by mistake later still cannot let a shopper spend or mint uses.
--     auth.role() reads the JWT's role claim (see perk_uses_so_far above);
--     a caller with no JWT at all reads null and is refused too.
--   * Serialised per perk and membership with a transaction-scoped advisory
--     lock. The two-key form takes two int4s, so the second key is a hash of
--     the perk and membership ids; a collision only makes two unrelated
--     claims wait on each other, never lets two claims on the same use race.
--     The lock is released when the rpc's transaction commits, by which time
--     the row is visible to the next claimant's count.
--   * Counted with perk_uses_so_far, the same number the previews show, plus
--     claims still in flight at the till: a counter sale is written as
--     'cart' and moved to 'completed' a moment later, and perk_uses_so_far
--     does not count carts. A cart younger than fifteen minutes with a claim
--     is a sale in progress; an older one is a sale that failed and is left
--     out, as perk_uses_so_far leaves it out.
--   * Idempotent on order_id: a row already written for this order returns
--     true without writing again, so a retried request cannot spend twice.
create or replace function public.claim_perk_use(
  p_perk bigint,
  p_client_membership bigint,
  p_client uuid,
  p_order bigint,
  p_discount_cents int,
  p_units int
)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  v_max int;
  v_window text;
  v_period_start timestamptz;
  v_used int;
  v_in_flight int;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'claim_perk_use is for the service role only' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(
    hashtext('perk_use'),
    hashtext(p_perk::text || ':' || p_client_membership::text)
  );

  if exists (select 1 from public.membership_perk_redemptions where order_id = p_order) then
    return true;
  end if;

  -- The perk must still exist and belong to the plan this membership holds.
  select pp.max_uses, pp.uses_window, cm.current_period_start
    into v_max, v_window, v_period_start
  from public.membership_product_perks pp
  join public.client_memberships cm on cm.membership_id = pp.membership_id
  where pp.id = p_perk and cm.id = p_client_membership;
  if not found then
    return false;
  end if;

  if v_max is not null then
    v_used := public.perk_uses_so_far(p_client_membership, p_perk, v_window, v_period_start);
    select count(*)::int into v_in_flight
    from public.membership_perk_redemptions r
    join public.orders o on o.id = r.order_id
    where r.client_membership_id = p_client_membership
      and r.perk_id = p_perk
      and o.status = 'cart'
      and r.created_at > now() - interval '15 minutes';
    if v_used + v_in_flight >= v_max then
      return false;
    end if;
  end if;

  insert into public.membership_perk_redemptions
    (perk_id, client_membership_id, client_id, order_id, discount_cents, units)
  values
    (p_perk, p_client_membership, p_client, p_order, greatest(p_discount_cents, 0), greatest(p_units, 0))
  on conflict (order_id) do nothing;
  return true;
end;
$$;

comment on function public.claim_perk_use(bigint, bigint, uuid, bigint, int, int) is
  'Spend one use of a membership product perk on an order, under an advisory lock on the perk '
  'and membership. True: the redemption row is written (or already was, for this order) and the '
  'order may carry the discount. False: no use left, or the perk is not on this membership''s '
  'plan. Service role only.';

revoke all on function public.claim_perk_use(bigint, bigint, uuid, bigint, int, int)
  from public, anon, authenticated;
grant execute on function public.claim_perk_use(bigint, bigint, uuid, bigint, int, int)
  to service_role;
