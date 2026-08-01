-- ============================================================
-- 559 Flawless — 025: one ledger for money in
--
-- `payments` has been the right shape since 008 — amount, method, kind, and a
-- link to either an appointment or an order. What was missing is anything that
-- writes to it outside the Stripe webhook. A deposit taken online was recorded;
-- the balance handed over in cash at the end of the appointment was not, so an
-- appointment could be completed and fully paid and still read as owing money.
--
-- This adds the two things needed to close that: a balance anyone can ask for,
-- and a way for staff to record a payment they just took.
-- ============================================================

-- ── 1. A product name that came out of a scrape ──────────────
-- 017 lifted names from the marketplace's HTML without decoding entities, so
-- '"A" Renew +' was stored — and rendered — as '&quot;A&quot; Renew +'.
update public.products
set name = replace(
             replace(
               replace(
                 replace(replace(name, '&quot;', '"'), '&amp;', '&'),
               '&#39;', ''''),
             '&rsquo;', '’'),
           '&nbsp;', ' ')
where name like '%&%;%';

-- Descriptions came from the same scrape.
update public.products
set description = replace(
                    replace(
                      replace(
                        replace(replace(description, '&quot;', '"'), '&amp;', '&'),
                      '&#39;', ''''),
                    '&rsquo;', '’'),
                  '&nbsp;', ' ')
where description like '%&%;%';

-- ── 2. What is still owed ────────────────────────────────────
/**
 * The balance outstanding on an appointment, in cents.
 *
 * Derived from `payments` rather than stored, because a stored figure and the
 * payments behind it drift the moment anything is refunded — and the payments
 * are the evidence. Refunds are negative amounts, so they fall out of the sum
 * naturally.
 *
 * A cancelled or no-show appointment owes nothing beyond a forfeited deposit,
 * which has already been taken; billing someone for a treatment they did not
 * receive is not a thing the studio does.
 */
create or replace function public.appointment_balance_cents(p_appointment uuid)
returns int language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce(a.total_cents, 0) - coalesce((
      select sum(p.amount_cents)
      from public.payments p
      where p.appointment_id = a.id
        and p.status = 'succeeded'
    ), 0),
    0
  )::int
  from public.appointments a
  where a.id = p_appointment
    and a.status not in ('cancelled', 'no_show');
$$;

/** The same question for a product order. */
create or replace function public.order_balance_cents(p_order bigint)
returns int language sql stable security definer set search_path = public as $$
  select greatest(
    coalesce(o.total_cents, 0) - coalesce((
      select sum(p.amount_cents)
      from public.payments p
      where p.order_id = o.id
        and p.status = 'succeeded'
    ), 0),
    0
  )::int
  from public.orders o
  where o.id = p_order
    and o.status not in ('cart', 'cancelled', 'refunded');
$$;

-- ── 3. Recording money taken in the room ─────────────────────
/**
 * Record a payment against an appointment or an order.
 *
 * This is the counter-side counterpart to the Stripe webhook: cash, a card on
 * the studio's own terminal, a gift card. Staff-only, and it writes the same
 * `payments` row the webhook does so both ends of the ledger agree.
 *
 * Paying a deposit through here also moves `deposit_status`, because that flag
 * is what the booking flow and the reminders read. Letting the two disagree is
 * how a client gets chased for a deposit they already handed over.
 */
create or replace function public.record_payment(
  p_amount_cents int,
  p_kind         text,
  p_method       text default 'cash',
  p_appointment  uuid default null,
  p_order        bigint default null,
  p_note         text default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  actor_role public.user_role;
  target_client uuid;
  payment_id bigint;
begin
  select role into actor_role from public.profiles where id = auth.uid();

  if auth.uid() is not null and (actor_role is null or actor_role = 'client') then
    raise exception 'Only staff can record a payment';
  end if;

  if p_appointment is null and p_order is null then
    raise exception 'A payment has to be against an appointment or an order';
  end if;
  if p_appointment is not null and p_order is not null then
    raise exception 'A payment belongs to one appointment or one order, not both';
  end if;
  -- Zero is meaningless and negative is a refund, which has its own kind.
  if p_amount_cents = 0 then
    raise exception 'A payment cannot be zero';
  end if;
  if p_amount_cents < 0 and p_kind <> 'refund' then
    raise exception 'A negative amount must be recorded as a refund';
  end if;

  if p_appointment is not null then
    select client_id into target_client from public.appointments where id = p_appointment;
  else
    select client_id into target_client from public.orders where id = p_order;
  end if;

  insert into public.payments
    (amount_cents, method, kind, appointment_id, order_id, client_id, status, processed_by, note)
  values
    (p_amount_cents, p_method, p_kind, p_appointment, p_order, target_client,
     'succeeded', auth.uid(), p_note)
  returning id into payment_id;

  -- Keep the deposit flag in step with the money.
  if p_appointment is not null and p_kind = 'deposit' then
    update public.appointments
    set deposit_status = 'paid'
    where id = p_appointment and deposit_status <> 'paid';
  end if;

  return payment_id;
end;
$$;

-- ── 4. An in-store sale is not work waiting to be done ───────
--
-- The till wrote `paid`, and the Orders page treats `paid` as "to fulfil". But
-- a counter sale is handed over as it is rung up — there is nothing to pack or
-- post. Every till transaction was landing in the fulfilment queue as
-- outstanding work, and the queue is meant to be the online orders only.
--
-- Existing in-store rows are moved to `completed`. Stock has already been
-- decremented for these (the trigger fires on both statuses), and the trigger
-- only acts on a *change* into paid/completed, so this does not double-count.

update public.orders
set status = 'completed'
where channel = 'in_store'
  and status = 'paid';

-- ── 5. Backfill the payment rows the till never wrote ────────
-- Sales taken before this migration recorded the order but not the money, so
-- they would show as fully outstanding on the new ledger.
insert into public.payments
  (amount_cents, method, kind, order_id, client_id, status, processed_by, note, created_at)
select
  o.total_cents,
  coalesce(o.payment_method, 'other'),
  'product',
  o.id,
  o.client_id,
  'succeeded',
  o.sold_by,
  'Backfilled from the in-store sale record',
  coalesce(o.paid_at, o.created_at)
from public.orders o
where o.channel = 'in_store'
  and o.total_cents > 0
  and not exists (
    select 1 from public.payments p where p.order_id = o.id
  );
