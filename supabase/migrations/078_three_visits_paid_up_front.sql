-- ============================================================
-- 559 Flawless — 078: three visits, paid up front
--
-- The studio's first membership: $300 for three months, covering three
-- corrective facials, with a Brazilian at $25 for members on any visit. Paid
-- online through Stripe or at the counter; every visit is still booked and
-- approved like any other (online bookings are held while auto_confirm is
-- off — this changes nothing about that).
--
-- Two things 050 could not express:
--
--   1. A MEMBER PRICE for one service. 050's only discount is a percentage off
--      the whole visit, and "$65 → $25 on the Brazilian, nothing else" is not
--      a percentage of anything. `membership_member_prices` names the service
--      and the price a member pays for it. It is deliberately NOT a row in
--      `membership_services`: that table scopes INCLUDED sessions, and putting
--      the Brazilian there would let a member spend a facial on it.
--
--      The member price is a ceiling, not a further cut: a line already
--      cheaper (the half-off-with-a-facial pair deal is $32.50) comes down to
--      $25, never below it. src/lib/memberships.ts applies it.
--
--   2. SELLING ONLINE. `memberships.sell_online` puts a plan on /memberships,
--      where a signed-in client pays through Stripe Checkout and the webhook
--      enrols them. The price is read from the plan on the server, never the
--      request (rule 2), and the enrol trigger snapshots it as before.
--
-- The public page needs anon to read live plans, so the 050 select policies on
-- memberships and membership_services are widened here — deliberately, which
-- is what 050's comment asked for.
--
-- Membership money still does not land in `payments` (050's stated gap); the
-- online sale is recorded on `membership_charges` as paid by Stripe.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

alter table public.memberships
  add column if not exists sell_online boolean not null default false;

comment on column public.memberships.sell_online is
  'Offer this plan on the public /memberships page, paid through Stripe. Off '
  'means staff can still enrol people at the counter.';

create table if not exists public.membership_member_prices (
  membership_id bigint not null references public.memberships(id) on delete cascade,
  service_id    bigint not null references public.services(id) on delete cascade,
  price_cents   int not null check (price_cents >= 0),
  primary key (membership_id, service_id)
);

comment on table public.membership_member_prices is
  'What a member pays for one service while their membership is current — a '
  'ceiling, applied after every other deal. Separate from membership_services, '
  'which scopes included sessions.';

alter table public.membership_member_prices enable row level security;

-- ── Public read for the membership page ───────────────────────
drop policy if exists "memberships_select" on public.memberships;
create policy "memberships_select" on public.memberships
  for select to anon, authenticated
  using (public.is_staff() or is_active);

drop policy if exists "membership_services_select" on public.membership_services;
create policy "membership_services_select" on public.membership_services
  for select to anon, authenticated
  using (
    public.is_staff()
    or exists (select 1 from public.memberships m where m.id = membership_id and m.is_active)
  );

drop policy if exists "membership_member_prices_select" on public.membership_member_prices;
create policy "membership_member_prices_select" on public.membership_member_prices
  for select to anon, authenticated
  using (
    public.is_staff()
    or exists (select 1 from public.memberships m where m.id = membership_id and m.is_active)
  );

drop policy if exists "membership_member_prices_write" on public.membership_member_prices;
create policy "membership_member_prices_write" on public.membership_member_prices
  for all to authenticated
  using (public.is_manager())
  with check (public.is_manager());

-- ── The plan ──────────────────────────────────────────────────
insert into public.memberships
  (name, slug, description, price_cents, period_months,
   service_discount_pct, included_sessions_per_period, sell_online, is_active, sort_order)
select
  'The Glow Season', 'glow-season',
  'Three corrective facials over three months, paid up front. Add a Brazilian to any visit for $25.',
  30000, 3, 0, 3, true, true, 0
where not exists (select 1 from public.memberships where slug = 'glow-season');

insert into public.membership_services (membership_id, service_id)
select m.id, s.id
from public.memberships m
join public.services s on s.slug in ('custom-corrective-facial', 'back-neck-chest-corrective-facial')
where m.slug = 'glow-season'
on conflict do nothing;

insert into public.membership_member_prices (membership_id, service_id, price_cents)
select m.id, s.id, 2500
from public.memberships m
join public.services s on s.slug = 'full-brazilian'
where m.slug = 'glow-season'
on conflict do nothing;

-- ── A cancelled visit gives its facial back ───────────────────
--
-- An included session is claimed when the booking is made — which, with every
-- online booking held for approval, is before the studio has said yes. 050
-- never released one, so declining a member's request (or either side
-- cancelling) quietly cost them a facial. Now a move INTO `cancelled` deletes
-- that appointment's redemptions; the period has the session back.
--
-- A no-show is deliberately left alone: the slot was held and not used, the
-- same reasoning that keeps a forfeited deposit forfeited.
create or replace function public.appointment_release_membership_sessions()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'cancelled' and old.status is distinct from 'cancelled' then
    delete from public.membership_redemptions where appointment_id = new.id;
  end if;
  return null;
end;
$$;

drop trigger if exists appointments_release_membership_sessions on public.appointments;
create trigger appointments_release_membership_sessions
  after update of status on public.appointments
  for each row execute function public.appointment_release_membership_sessions();
