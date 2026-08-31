-- ============================================================
-- 559 Flawless — 067: a point for every dollar, and a pair deal
--
-- Two things the studio asked for, both of which are rewards for money that
-- actually moved, and neither of which existed in any form:
--
-- 1. Loyalty points. A client earns one point per whole dollar they pay —
--    services and retail alike. There is no stored balance to drift: like the
--    money it mirrors, the balance is the sum of a ledger. `payments` (008/025)
--    is already the one record of money in, so points hang off it with a
--    trigger — the Stripe webhook, the counter, and the till all pass through
--    that table, which means none of them need to know points exist.
--
--    What deliberately does NOT earn points: rows whose method is `package` or
--    `gift_card`. Those are credit being SPENT, not money arriving — the money
--    arrived when the package or gift card was bought, and that purchase
--    already earned its points. Counting the spend too would pay the same
--    dollar twice.
--
--    Refunds claw points back. `record_payment` refunds land as negative
--    amounts with status `succeeded`; the Stripe webhook's refund rows carry
--    status `refunded` (an asymmetry that is live in the balance math today,
--    see 025). The trigger accepts both, so a refund reverses its points no
--    matter which door it came through.
--
--    Redemption is deliberately absent. Points build now; spending them is a
--    later migration, once the studio has watched the numbers for a while.
--    Nothing here needs to change for that — a redemption is one more ledger
--    row with negative points.
--
-- 2. The pair deal: book a facial, and a Brazilian in the same visit is half
--    off. `service_pair_discounts` says which service, booked alongside which
--    other service, is discounted by what percentage. The discount is applied
--    server-side by `priceService()` and frozen into the
--    `appointment_services` line the way every price already is — the new
--    `full_price_cents` records what the line would have cost, and
--    `pair_discount_id` records why it didn't. `added_by`/`added_at` mark a
--    line the provider added in the chair after booking (the upsell), as
--    opposed to one that came with the booking — which is the split the
--    studio wants to see in reporting.
--
--    Considered and rejected: modelling the discounted Brazilian as a
--    `service_addons` row (the shape 010 used for the lightening pairing).
--    Add-ons carry no `requires_age_verification`, no deposit, and no intimate
--    flag — a Brazilian booked through an add-on would skip the 18+ gate
--    entirely. The pair deal keeps the Brazilian a real service line, so every
--    gate it carries keeps firing.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

-- ── 1. The pair deal: which pairings exist ───────────────────

create table if not exists public.service_pair_discounts (
  id                     bigserial primary key,
  -- Booking THIS service…
  trigger_service_id     bigint not null references public.services(id) on delete cascade,
  -- …makes THIS one cheaper in the same visit.
  discounted_service_id  bigint not null references public.services(id) on delete cascade,
  -- A percentage, not a flat figure, so the deal follows the menu price. The
  -- studio said "half off", and half of whatever the Brazilian costs that day
  -- is what half off means.
  percent_off            int not null check (percent_off between 1 and 90),
  -- Client-facing copy for the service card ("Half off when booked with any
  -- facial"). Stored, not derived, so it reads like a person wrote it.
  label                  text not null,
  is_active              boolean not null default true,
  created_at             timestamptz not null default now(),
  unique (trigger_service_id, discounted_service_id),
  check (trigger_service_id <> discounted_service_id)
);

comment on table public.service_pair_discounts is
  'Book the trigger service and the discounted service in one visit, and the discounted one is percent_off cheaper. Applied server-side in priceService(); frozen into appointment_services.';

alter table public.service_pair_discounts enable row level security;

-- The storefront shows the deal before anyone signs in, exactly like the
-- services it references.
drop policy if exists "public reads active pair deals" on public.service_pair_discounts;
create policy "public reads active pair deals" on public.service_pair_discounts
  for select using (is_active or public.is_staff());

-- Pricing is an admin decision (see the roles table in AGENTS.md), same as the
-- price on the service itself. No update/delete for anyone else — deliberately.
drop policy if exists "admin writes pair deals" on public.service_pair_discounts;
create policy "admin writes pair deals" on public.service_pair_discounts
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

revoke all on public.service_pair_discounts from public, anon, authenticated;
grant select on public.service_pair_discounts to anon, authenticated;
grant insert, update, delete on public.service_pair_discounts to authenticated;
grant usage on sequence public.service_pair_discounts_id_seq to authenticated;

-- Seed the one deal the studio described: every active facial pairs with the
-- Full Brazilian at half off. New facial services need their own row — which
-- is a decision, not an omission: not every future facial has to carry it.
insert into public.service_pair_discounts
    (trigger_service_id, discounted_service_id, percent_off, label)
select s.id, b.id, 50, 'Half off when booked with any facial'
from public.services s
join public.service_categories c on c.id = s.category_id and c.slug = 'facials'
cross join (select id from public.services where slug = 'full-brazilian') b
where s.is_active
on conflict (trigger_service_id, discounted_service_id) do nothing;

-- ── 2. The receipt remembers the deal ────────────────────────
-- `appointment_services` already freezes name and price at booking. These
-- record what the price WOULD have been and why it wasn't, plus who added the
-- line when it did not come with the booking.

alter table public.appointment_services
  add column if not exists full_price_cents int check (full_price_cents >= 0),
  add column if not exists pair_discount_id bigint references public.service_pair_discounts(id) on delete set null,
  add column if not exists added_by uuid references public.profiles(id) on delete set null,
  add column if not exists added_at timestamptz;

comment on column public.appointment_services.full_price_cents is
  'List price before a pair discount, integer cents. Null on an undiscounted line.';
comment on column public.appointment_services.added_by is
  'Staff member who added this line to an existing appointment (the in-chair upsell). Null = the line came with the booking.';
comment on column public.appointment_services.added_at is
  'When a line was added after booking. Null = it came with the booking.';

-- The redemptions report walks discounted lines; without this it walks
-- every line item the studio has ever sold.
create index if not exists appointment_services_pair_idx
  on public.appointment_services (pair_discount_id)
  where pair_discount_id is not null;

-- 004 lets front desk and up write line items. The in-chair upsell is the
-- provider adding a service to an appointment they are standing in — their own
-- appointment, insert only. Rescheduling and deleting lines stay front desk.
drop policy if exists "provider adds lines to own appointment" on public.appointment_services;
create policy "provider adds lines to own appointment" on public.appointment_services
  for insert with check (
    exists (
      select 1 from public.appointments a
      where a.id = appointment_id and a.provider_id = auth.uid()
    )
  );

-- ── 3. The points ledger ─────────────────────────────────────

create table if not exists public.loyalty_ledger (
  id          bigserial primary key,
  client_id   uuid not null references public.profiles(id) on delete cascade,
  -- Positive = earned, negative = clawed back or (later) spent. Never zero —
  -- a row that moves nothing is noise pretending to be history.
  points      int not null check (points <> 0),
  kind        text not null check (kind in ('earned', 'reversal', 'adjustment')),
  -- The payment this row mirrors. Unique where present: one payment, one
  -- points entry, no matter how many times a webhook retries.
  payment_id  bigint references public.payments(id) on delete set null,
  -- Adjustments carry who and why; earned rows need neither.
  note        text,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now()
);

comment on table public.loyalty_ledger is
  'Loyalty points, one row per movement. The balance is the sum — never stored, so it can never drift from the rows behind it. Earned rows mirror payments 1:1 via the trigger below.';

create unique index if not exists loyalty_ledger_payment_idx
  on public.loyalty_ledger (payment_id) where payment_id is not null;
create index if not exists loyalty_ledger_client_idx
  on public.loyalty_ledger (client_id, created_at desc);

alter table public.loyalty_ledger enable row level security;

drop policy if exists "client reads own points" on public.loyalty_ledger;
create policy "client reads own points" on public.loyalty_ledger
  for select using (client_id = auth.uid());
drop policy if exists "staff reads points" on public.loyalty_ledger;
create policy "staff reads points" on public.loyalty_ledger
  for select using (public.is_staff());

-- Goodwill grants ("sorry we ran late") and corrections. Managers only, always
-- as an adjustment, always signed. Earned/reversal rows come from the trigger
-- alone — no policy grants them, and that is the point: application code and
-- people cannot mint earned points.
--
-- No update or delete for anyone, deliberately: a ledger is append-only, and a
-- wrong entry is corrected by a counter-entry that says so.
drop policy if exists "manager adjusts points" on public.loyalty_ledger;
create policy "manager adjusts points" on public.loyalty_ledger
  for insert to authenticated
  with check (
    public.is_manager()
    and kind = 'adjustment'
    and payment_id is null
    and created_by = auth.uid()
  );

revoke all on public.loyalty_ledger from public, anon, authenticated;
grant select, insert on public.loyalty_ledger to authenticated;
grant usage on sequence public.loyalty_ledger_id_seq to authenticated;

/**
 * The balance, derived. SECURITY INVOKER on purpose: RLS decides whose rows
 * the caller can sum, so a client asking about someone else gets zero rather
 * than a number they had no business seeing.
 */
create or replace function public.loyalty_balance(p_client uuid)
returns int language sql stable set search_path = public as $$
  select coalesce(sum(points), 0)::int
  from public.loyalty_ledger
  where client_id = p_client
$$;

revoke all on function public.loyalty_balance(uuid) from public;
grant execute on function public.loyalty_balance(uuid) to authenticated;

-- ── 4. Points follow the money ───────────────────────────────

/**
 * One point per whole dollar, on every payment row that represents real money
 * moving. Integer division truncates toward zero in both directions, so a
 * $25.50 payment earns 25 and its refund reverses 25.
 *
 * Guest payments (client_id null) earn nothing — there is no account to credit,
 * and 004's appointment_match_client backfills the appointment, not history.
 *
 * The whole body is wrapped: a failure to award points must never block the
 * recording of a payment. Same posture as appointment_notify_review (048).
 */
create or replace function public.loyalty_accrue_from_payment()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  pts int;
begin
  begin
    if new.client_id is null then return null; end if;
    -- Credit being spent, not money arriving. See the header.
    if new.method in ('package', 'gift_card') then return null; end if;
    -- Succeeded rows, plus the webhook's `refunded` refund rows (025's live
    -- asymmetry) — so a Stripe refund still claws its points back.
    if not (new.status = 'succeeded'
            or (new.kind = 'refund' and new.status = 'refunded')) then
      return null;
    end if;

    pts := new.amount_cents / 100;
    if pts = 0 then return null; end if;

    insert into public.loyalty_ledger (client_id, points, kind, payment_id)
    values (
      new.client_id,
      pts,
      case when pts > 0 then 'earned' else 'reversal' end,
      new.id
    )
    on conflict (payment_id) where payment_id is not null do nothing;
  exception when others then
    -- Points are a nicety; the payment record is not. Swallow and move on.
    null;
  end;
  return null;
end;
$$;

drop trigger if exists payments_accrue_loyalty on public.payments;
create trigger payments_accrue_loyalty
  after insert on public.payments
  for each row execute function public.loyalty_accrue_from_payment();

-- ── 5. Existing clients start with their history, not at zero ─
-- The studio was explicit: this is for everyone, not just new customers. The
-- same rules as the trigger, applied once over the payments that already
-- exist, keeping each payment's own date so the ledger reads as history rather
-- than a lump sum on migration day. Idempotent via the same unique index.

insert into public.loyalty_ledger (client_id, points, kind, payment_id, created_at)
select
  p.client_id,
  p.amount_cents / 100,
  case when p.amount_cents > 0 then 'earned' else 'reversal' end,
  p.id,
  p.created_at
from public.payments p
where p.client_id is not null
  and p.method not in ('package', 'gift_card')
  and (p.status = 'succeeded' or (p.kind = 'refund' and p.status = 'refunded'))
  and p.amount_cents / 100 <> 0
on conflict (payment_id) where payment_id is not null do nothing;

-- ============================================================
-- Deliberately left alone:
--
-- * `payments` itself — no new columns. Points are derived FROM payments;
--   payments never know about points.
-- * Redemption. Spending points is one more ledger row with negative points
--   and a policy or function to authorise it — a later migration, after the
--   studio has watched what accrues.
-- * `orders.promo_code` / `orders.discount_cents` — still dead, still not
--   this. The pair deal lives on appointment lines, where the price already
--   freezes.
-- * The membership benefit (050). It stacks on top of a pair-discounted
--   subtotal exactly as it stacks on any other subtotal; nothing here touches
--   its math.
-- ============================================================
