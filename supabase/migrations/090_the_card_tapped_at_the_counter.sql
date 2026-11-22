-- ============================================================
-- 559 Flawless — 090: the card tapped at the counter
--
-- The studio takes cards with no terminal of its own. Two ways, both from the
-- till (Sales → Sell):
--
--   phone_link   the client pays on their own phone. The till shows a QR code
--                for a Stripe Checkout Session (card, Apple Pay, Google Pay)
--                and can email the link. checkout.session.completed settles
--                the sale; checkout.session.expired lets it go.
--   stripe_app   staff charge the amount with Tap to Pay in the Stripe
--                Dashboard iPhone app. That app makes its own PaymentIntent
--                from a typed amount and carries none of our ids, so the
--                webhook sees a card_present payment_intent.succeeded and
--                matches it by amount to the one awaiting till ticket, or
--                parks it here for a person to match with one tap.
--
-- Either way the sale is written exactly as a cash sale is (the visit
-- completed, the order with its lines and perk claim) EXCEPT that no payments
-- row is written and the order stops at 'pending_payment' instead of
-- 'completed'. Stock is NOT taken at that point: order_decrement_stock (021)
-- fires only on a change INTO 'paid' or 'completed', and pending_payment is
-- neither. A till_tickets row records what the sale is waiting for.
--
-- When Stripe says the money moved, settle_till_ticket() writes the ledger:
--   * the visit: kind 'service', method 'card', for what that visit still
--     owes at that moment (total minus succeeded payments, the arithmetic of
--     /api/stripe/balance and the Orders page), capped at what Stripe took
--     less the order's part, so the ledger never says more came in than did.
--     Nothing when nothing is owed. If the visit was paid some other way
--     while the ticket waited, the difference is parked in
--     stripe_unmatched_payments as 'overpaid', for staff to refund.
--   * the order: kind 'product', method 'card', for its total, and the order
--     goes pending_payment → 'completed'. Completed, not paid, for the reason
--     071 gives: a counter sale is handed over, it is not work waiting to be
--     packed. That one transition is the only one that takes stock, so stock
--     is taken exactly once. (Going 'paid' and then 'completed' would take it
--     twice: 021's trigger fires on both.)
-- Both rows carry the Stripe intent and charge ids. A multibuy deal the sale
-- won is written to promotion_redemptions here too, not when the sale was
-- rung up: a sale that is never paid never used the deal. A ticket already
-- paid returns false and writes nothing, so a retried webhook is harmless.
--
-- Stock is not held while a ticket waits. Two sales can sell the last
-- bottle; the second to be paid drives the shelf negative, and the ticket's
-- note says which products were short when it was paid.
--
-- A ticket nobody paid for: expire_till_ticket() (the webhook, on
-- checkout.session.expired, or the ticket route once a stripe_app ticket is
-- past its time) and cancel_till_ticket() (staff) both move it out of
-- 'awaiting' and cancel its pending order. A cancelled order's perk
-- redemption already stops counting (087). The visit is left as it is,
-- completed with its balance owing, so it shows on the till under "Pay off
-- first" and on Orders → Owed.
--
-- Money that arrives for an expired ticket still settles it: Stripe is the
-- authority that the client paid, so the sale happened. The order comes back
-- from 'cancelled' to 'completed' (taking stock then, once). Only an EXPIRED
-- ticket's order is revived; an awaiting ticket whose order is cancelled
-- (the route's undo path) never is. Money for a CANCELLED ticket does not
-- settle it (staff said that sale is off); the webhook parks it in
-- stripe_unmatched_payments for a refund or a match.
--
-- settle_till_ticket, expire_till_ticket, match_unmatched_payment and
-- expire_overdue_till_tickets check auth.role() themselves (087's
-- precedent), so the grant is not the only thing standing in the way.
--
-- payments gains stripe_refund_id: charge.refunded is keyed on the refund,
-- not the charge, so a second partial refund of one charge is recorded.
--
-- Writes are service role only (route handlers after auth, and the webhook),
-- except the two staff functions, which check the role themselves.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

-- ── 1. Tickets ───────────────────────────────────────────────
create table if not exists public.till_tickets (
  id                        bigserial primary key,
  order_id                  bigint references public.orders(id) on delete set null,
  appointment_id            uuid references public.appointments(id) on delete set null,
  client_id                 uuid references public.profiles(id) on delete set null,
  guest_name                text,
  amount_cents              int not null check (amount_cents >= 0),
  method                    text not null check (method in ('phone_link', 'stripe_app')),
  status                    text not null default 'awaiting'
                              check (status in ('awaiting', 'paid', 'cancelled', 'expired')),
  stripe_session_id         text unique,
  stripe_checkout_url       text,
  stripe_payment_intent_id  text unique,
  stripe_charge_id          text,
  -- The multibuy deal the order won, written to promotion_redemptions only
  -- when the ticket is paid.
  multibuy_promotion_id     bigint references public.promotions(id) on delete set null,
  multibuy_promotion_name   text,
  multibuy_discount_cents   int not null default 0 check (multibuy_discount_cents >= 0),
  created_by                uuid references public.profiles(id) on delete set null,
  created_at                timestamptz not null default now(),
  expires_at                timestamptz not null,
  paid_at                   timestamptz,
  note                      text
);

alter table public.till_tickets add column if not exists stripe_checkout_url text;
alter table public.till_tickets
  add column if not exists multibuy_promotion_id bigint references public.promotions(id) on delete set null;
alter table public.till_tickets add column if not exists multibuy_promotion_name text;
alter table public.till_tickets add column if not exists multibuy_discount_cents int not null default 0;

comment on table public.till_tickets is
  'A till sale waiting for a card payment taken through Stripe (a phone link or the Stripe app). '
  'The visit and order are written; the money is recorded by settle_till_ticket() when Stripe says so.';

create index if not exists till_tickets_match_idx
  on public.till_tickets (status, amount_cents, created_at);
create index if not exists till_tickets_order_idx on public.till_tickets (order_id);
create index if not exists till_tickets_appointment_idx on public.till_tickets (appointment_id);

alter table public.till_tickets enable row level security;

drop policy if exists "front desk reads till tickets" on public.till_tickets;
create policy "front desk reads till tickets" on public.till_tickets
  for select to authenticated using (public.is_front_desk());

-- No insert/update/delete policies: the service role writes, and staff act
-- through cancel_till_ticket().
revoke insert, update, delete on public.till_tickets from anon, authenticated;

-- ── 2. Card payments nobody could match ──────────────────────
-- kind 'payment' is a whole Stripe payment that is not on any sale. kind
-- 'overpaid' is the part of a settled sale's payment that nothing was owed
-- for (the visit was paid another way meanwhile). One of each per intent.
create table if not exists public.stripe_unmatched_payments (
  id                        bigserial primary key,
  stripe_payment_intent_id  text not null,
  kind                      text not null default 'payment' check (kind in ('payment', 'overpaid')),
  stripe_charge_id          text,
  amount_cents              int not null,
  description               text,
  paid_at                   timestamptz not null,
  reason                    text not null default 'no_ticket'
                              check (reason in ('no_ticket', 'several_tickets', 'ticket_cancelled',
                                                'ticket_expired', 'ticket_paid', 'overpaid')),
  matched_ticket_id         bigint references public.till_tickets(id) on delete set null,
  matched_at                timestamptz,
  dismissed_at              timestamptz,
  dismissed_by              uuid references public.profiles(id) on delete set null,
  dismissed_note            text,
  created_at                timestamptz not null default now(),
  constraint stripe_unmatched_payments_intent_kind_key unique (stripe_payment_intent_id, kind)
);

comment on table public.stripe_unmatched_payments is
  'Stripe money no till sale could take: a card-present payment (Tap to Pay in the Stripe app) the '
  'webhook could not tie to exactly one awaiting ticket, a payment for a sale already closed, or the '
  'overpaid part of a settled sale. Staff match a payment, or a manager dismisses it.';

create index if not exists stripe_unmatched_open_idx
  on public.stripe_unmatched_payments (amount_cents, paid_at)
  where matched_ticket_id is null and dismissed_at is null;

alter table public.stripe_unmatched_payments enable row level security;

drop policy if exists "front desk reads unmatched payments" on public.stripe_unmatched_payments;
create policy "front desk reads unmatched payments" on public.stripe_unmatched_payments
  for select to authenticated using (public.is_front_desk());

revoke insert, update, delete on public.stripe_unmatched_payments from anon, authenticated;

-- ── 3. Refunds keyed on the refund ───────────────────────────
alter table public.payments add column if not exists stripe_refund_id text;
create unique index if not exists payments_stripe_refund_idx
  on public.payments (stripe_refund_id) where stripe_refund_id is not null;

-- ── 4. Settle ────────────────────────────────────────────────
create or replace function public.settle_till_ticket(
  p_ticket         bigint,
  p_payment_intent text,
  p_charge         text,
  p_paid_at        timestamptz
) returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  t          public.till_tickets%rowtype;
  appt       record;
  ord        record;
  owed       int := 0;
  order_due  int := 0;
  recorded   int := 0;
  revive     boolean := false;
  short      text;
  note_parts text[] := '{}';
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'settle_till_ticket is for the service role only' using errcode = '42501';
  end if;

  select * into t from public.till_tickets where id = p_ticket for update;
  if not found then
    return false;
  end if;
  -- Paid already (a retry), or called off by staff.
  if t.status not in ('awaiting', 'expired') then
    return false;
  end if;

  -- The order first, so the visit's share is what is left of the payment.
  -- pending_payment is the waiting sale; cancelled comes back only for an
  -- expired ticket (never the undo path, where the ticket is awaiting).
  if t.order_id is not null then
    select o.id, o.client_id, o.total_cents, o.status
      into ord
      from public.orders o
     where o.id = t.order_id
     for update;
    if found and (ord.status = 'pending_payment' or (ord.status = 'cancelled' and t.status = 'expired')) then
      revive := true;
      order_due := ord.total_cents;
    end if;
  end if;

  -- The visit: what it still owes now, the balance route's arithmetic,
  -- capped at what Stripe took less the order's share.
  if t.appointment_id is not null then
    select a.id, a.client_id, a.total_cents, a.status
      into appt
      from public.appointments a
     where a.id = t.appointment_id
     for update;
    if found and appt.status not in ('cancelled', 'no_show') then
      select greatest(appt.total_cents - coalesce(sum(p.amount_cents), 0), 0)::int
        into owed
        from public.payments p
       where p.appointment_id = appt.id
         and p.status = 'succeeded';
      owed := least(owed, greatest(t.amount_cents - order_due, 0));
      if owed > 0 then
        insert into public.payments
          (amount_cents, method, kind, appointment_id, client_id, status,
           stripe_payment_intent_id, stripe_charge_id, processed_by, note)
        values
          (owed, 'card', 'service', appt.id, appt.client_id, 'succeeded',
           p_payment_intent, p_charge, t.created_by, 'Paid by card through Stripe at the till');
        recorded := recorded + owed;
      end if;
    end if;
  end if;

  if revive then
    -- Stock is not held while a ticket waits; say which bottles were short.
    select string_agg(format('%s (%s wanted, %s on the shelf)', i.name_snapshot, i.qty,
                             public.stock_on_hand(i.product_id)), ', ')
      into short
      from public.order_items i
     where i.order_id = ord.id
       and i.product_id is not null
       and public.stock_on_hand(i.product_id) < i.qty;
    if short is not null then
      note_parts := note_parts || ('Stock short when paid: ' || short || '.');
    end if;

    -- Only this transition takes stock (021), so it happens once.
    update public.orders
       set status = 'completed',
           paid_at = coalesce(p_paid_at, now()),
           payment_method = 'card',
           stripe_payment_intent_id = p_payment_intent
     where id = ord.id;
    if order_due > 0 then
      insert into public.payments
        (amount_cents, method, kind, order_id, client_id, status,
         stripe_payment_intent_id, stripe_charge_id, processed_by, note)
      values
        (order_due, 'card', 'product', ord.id, ord.client_id, 'succeeded',
         p_payment_intent, p_charge, t.created_by, 'Paid by card through Stripe at the till');
      recorded := recorded + order_due;
    end if;

    -- The deal is used now that the sale is paid, not when it was rung up.
    if t.multibuy_discount_cents > 0 then
      insert into public.promotion_redemptions
        (promotion_id, promotion_name, client_id, order_id, discount_cents)
      values
        (t.multibuy_promotion_id, coalesce(t.multibuy_promotion_name, 'Promotion'), ord.client_id,
         ord.id, t.multibuy_discount_cents);
    end if;
  end if;

  -- More came in than anything was owed for: park the difference where
  -- staff see it, for a refund.
  if recorded < t.amount_cents then
    note_parts := note_parts || ('Recorded ' || recorded || ' of ' || t.amount_cents ||
                                 ' cents; the rest was already paid another way.');
    insert into public.stripe_unmatched_payments
      (stripe_payment_intent_id, kind, stripe_charge_id, amount_cents, description, paid_at, reason)
    values
      (p_payment_intent, 'overpaid', p_charge, t.amount_cents - recorded,
       'Sale #' || t.id || ' was paid more than it owed. Refund the difference in Stripe.',
       coalesce(p_paid_at, now()), 'overpaid')
    on conflict (stripe_payment_intent_id, kind) do nothing;
  end if;

  update public.till_tickets
     set status = 'paid',
         stripe_payment_intent_id = p_payment_intent,
         stripe_charge_id = p_charge,
         paid_at = coalesce(p_paid_at, now()),
         note = case
                  when cardinality(note_parts) > 0
                    then concat_ws(' ', t.note, array_to_string(note_parts, ' '))
                  else t.note
                end
   where id = t.id;

  return true;
end;
$$;

revoke all on function public.settle_till_ticket(bigint, text, text, timestamptz)
  from public, anon, authenticated;
grant execute on function public.settle_till_ticket(bigint, text, text, timestamptz) to service_role;

-- ── 5. Let one go ────────────────────────────────────────────
-- The shared half of expire and cancel. Internal: no grant to anyone, called
-- only from the SECURITY DEFINER functions below, which run as owner.
create or replace function public.close_till_ticket(p_ticket bigint, p_status text)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  t public.till_tickets%rowtype;
begin
  if p_status not in ('expired', 'cancelled') then
    raise exception 'A till ticket closes as expired or cancelled, not %', p_status;
  end if;

  select * into t from public.till_tickets where id = p_ticket for update;
  if not found or t.status <> 'awaiting' then
    return false;
  end if;

  update public.till_tickets set status = p_status where id = t.id;

  -- The products were never handed over as sold: the order goes, stock was
  -- never taken, and its perk claim stops counting (087). The visit stays
  -- completed with its balance owing.
  if t.order_id is not null then
    update public.orders
       set status = 'cancelled'
     where id = t.order_id
       and status = 'pending_payment';
  end if;

  return true;
end;
$$;

revoke all on function public.close_till_ticket(bigint, text) from public, anon, authenticated;

create or replace function public.expire_till_ticket(p_ticket bigint)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'expire_till_ticket is for the service role only' using errcode = '42501';
  end if;
  return public.close_till_ticket(p_ticket, 'expired');
end;
$$;

revoke all on function public.expire_till_ticket(bigint) from public, anon, authenticated;
grant execute on function public.expire_till_ticket(bigint) to service_role;

create or replace function public.cancel_till_ticket(p_ticket bigint)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_front_desk() then
    raise exception 'Only front desk can cancel a till sale';
  end if;
  return public.close_till_ticket(p_ticket, 'cancelled');
end;
$$;

revoke all on function public.cancel_till_ticket(bigint) from public, anon;
grant execute on function public.cancel_till_ticket(bigint) to authenticated, service_role;

-- Stripe app tickets five minutes past their time. No Stripe event closes
-- one (Checkout tickets are closed by checkout.session.expired), so the
-- webhook sweeps before it matches and the Orders page sweeps as it loads.
-- The grace is for a tap made at minute 29 whose event is still on its way.
-- Service role or front desk; the grace is fixed here, not the caller's.
create or replace function public.expire_overdue_till_tickets()
returns int language plpgsql volatile security definer set search_path = public as $$
declare
  t_id bigint;
  n    int := 0;
begin
  if auth.role() is distinct from 'service_role' and not public.is_front_desk() then
    raise exception 'Only front desk can sweep till sales' using errcode = '42501';
  end if;
  for t_id in
    select id from public.till_tickets
     where status = 'awaiting'
       and method = 'stripe_app'
       and expires_at + interval '5 minutes' < now()
  loop
    if public.close_till_ticket(t_id, 'expired') then
      n := n + 1;
    end if;
  end loop;
  return n;
end;
$$;

revoke all on function public.expire_overdue_till_tickets() from public, anon;
grant execute on function public.expire_overdue_till_tickets() to authenticated, service_role;

-- ── 6. Match a parked payment to a ticket ────────────────────
-- Service role (the match route, after it has checked the caller is front
-- desk). A Stripe app ticket only (a phone link ticket is paid through its
-- own Checkout session), same amount or nothing; settles the ticket and
-- marks the row matched in one transaction.
create or replace function public.match_unmatched_payment(p_id bigint, p_ticket bigint)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare
  u public.stripe_unmatched_payments%rowtype;
  t public.till_tickets%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'match_unmatched_payment is for the service role only' using errcode = '42501';
  end if;

  select * into u from public.stripe_unmatched_payments where id = p_id for update;
  if not found or u.kind <> 'payment' or u.matched_ticket_id is not null or u.dismissed_at is not null then
    return false;
  end if;
  select * into t from public.till_tickets where id = p_ticket;
  if not found or t.method <> 'stripe_app' or t.amount_cents <> u.amount_cents then
    return false;
  end if;

  if not public.settle_till_ticket(p_ticket, u.stripe_payment_intent_id, u.stripe_charge_id, u.paid_at) then
    return false;
  end if;

  update public.stripe_unmatched_payments
     set matched_ticket_id = p_ticket, matched_at = now()
   where id = u.id;
  return true;
end;
$$;

revoke all on function public.match_unmatched_payment(bigint, bigint) from public, anon, authenticated;
grant execute on function public.match_unmatched_payment(bigint, bigint) to service_role;

-- ── 7. A manager says it is dealt with ───────────────────────
create or replace function public.dismiss_unmatched_payment(p_id bigint, p_note text default null)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  if not public.is_manager() then
    raise exception 'Only a manager can dismiss a card payment';
  end if;
  update public.stripe_unmatched_payments
     set dismissed_at = now(),
         dismissed_by = auth.uid(),
         dismissed_note = nullif(trim(p_note), '')
   where id = p_id
     and matched_ticket_id is null
     and dismissed_at is null;
  return found;
end;
$$;

revoke all on function public.dismiss_unmatched_payment(bigint, text) from public, anon;
grant execute on function public.dismiss_unmatched_payment(bigint, text) to authenticated, service_role;
