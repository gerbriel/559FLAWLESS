-- ============================================================
-- 559 Flawless — 083: the card is charged again
--
-- 050 built a membership as "a promise to charge again" and then refused to
-- pretend it could keep that promise: there was no Stripe subscription, no
-- invoice webhook, nothing that took money a second time. Its closing section,
-- "What is not here", listed exactly what a follow-up had to write. This is
-- that follow-up, for gaps 1, 2 and 3 (the subscription, the webhook, and
-- telling somebody when a card fails).
--
-- ── What is now true ────────────────────────────────────────
--
-- A member joining online may choose to renew automatically. When they do,
-- /api/stripe/membership opens Checkout in `mode: 'subscription'` and Stripe
-- holds the card. From then on:
--
--   checkout.session.completed    enrols them (the 050 trigger still sets the
--                                 price snapshot and raises the first charge),
--                                 writes the subscription and customer ids
--                                 onto the row, and settles the first invoice
--   invoice.paid                  → settle_membership_invoice()
--   invoice.payment_failed        → fail_membership_invoice()
--   customer.subscription.updated → sync_membership_subscription()
--   customer.subscription.deleted → end_membership_subscription()
--
-- Every one of those is idempotent, because Stripe retries and because the
-- events arrive in no promised order. The first invoice routinely lands before
-- the checkout session that created the membership; settle returns null for a
-- subscription it cannot find yet and the checkout handler, when it does
-- arrive, retrieves the subscription and settles the first invoice itself.
--
-- ── What Stripe owns now ────────────────────────────────────
--
-- The billing period, once a subscription exists. 050's note said it plainly:
-- Stripe's period is the real one once it owns the billing. So for a row with
-- a `stripe_subscription_id`, `current_period_start/end` are copied from
-- Stripe's invoice and subscription, never computed here. The enrol trigger
-- still writes a first period starting at now(), because it fires on the
-- insert before anybody knows Stripe's clock; the first invoice re-anchors
-- that period to Stripe's (see membership_adopt_stripe_period below), moving
-- the `due` charge with it so the first period has exactly one charge, not a
-- paid one and a stray due one a few seconds apart.
--
-- `membership_is_current()` is untouched. The period end is still the
-- authority. A renewing member whose card fails is set past_due, which stops
-- the benefit at once (status narrows), and a member whose subscription Stripe
-- deletes is set cancelled.
--
-- ── What the studio still does by hand ──────────────────────
--
-- Pay-once members (the 078 path, still the default) and counter enrolments
-- have no subscription. Their periods are raised and settled exactly as 050
-- describes: `renew_membership()` advances them and raises a `due` charge,
-- `mark_membership_charge_paid()` records the money. Nothing in this file
-- touches a row whose `stripe_subscription_id` is null.
--
-- `renew_membership()` must never run on a subscription. It would roll the
-- period forward on the studio's clock while Stripe rolls it on its own, and
-- raise a `due` charge for a period Stripe is about to bill: the member would
-- see a debt they do not owe, and the next invoice would land on a different
-- period_start and leave that debt behind for ever. So it now refuses, with a
-- sentence saying Stripe renews it. The function is otherwise byte-for-byte
-- the 050 version.
--
-- ── Two columns ─────────────────────────────────────────────
--
--   memberships.auto_renew_offered    whether the public page offers the
--                                     renewing option for this plan at all
--   client_memberships.auto_renew     true while a Stripe subscription is set
--                                     to renew
--
-- `cancel_at_period_end` keeps its 050 meaning: the member has asked to stop
-- and keeps the period they paid for. `auto_renew` is the plain fact a screen
-- wants ("will this charge again?") and is false for every pay-once member.
--
-- ── Still not here ──────────────────────────────────────────
--
-- 050 gap 4 (proration) and gap 5 (the ledger) stay out of scope. In
-- particular `payments_kind_check` is NOT widened and `record_payment()` is not
-- touched: subscription money is recorded on `membership_charges`, as the 078
-- online sale already was, and is still absent from the money reports. Widening
-- the ledger is a decision about the ledger.
--
-- Every statement is guarded; running this twice changes nothing.
--
-- TYPES: src/types/memberships.ts gains auto_renew_offered and auto_renew, and
-- src/types/database.ts gains the four service-role functions. Same change.
-- ============================================================

-- ── The two columns ─────────────────────────────────────────
alter table public.memberships
  add column if not exists auto_renew_offered boolean not null default true;

comment on column public.memberships.auto_renew_offered is
  'Whether the public /memberships page offers the renewing option (a Stripe '
  'subscription) for this plan. Off means the plan is sold pay-once only.';

alter table public.client_memberships
  add column if not exists auto_renew boolean not null default false;

comment on column public.client_memberships.auto_renew is
  'True while a Stripe subscription is set to renew this membership. Written by '
  'the webhook and the manage route, never by a form. cancel_at_period_end '
  'remains the "asked to stop" flag; this is the plain "will it charge again".';

create index if not exists client_memberships_auto_renew_idx
  on public.client_memberships (current_period_end)
  where auto_renew;

-- ── Adopting Stripe's period ─────────────────────────────────
-- The one place a subscription's period is written. Internal: called by the
-- settle and sync functions below, granted to nobody.
--
-- Two guards, both because Stripe's events arrive out of order:
--
--   1. A period that ends at or before the one the row is already in is an
--      old event arriving late (a retried invoice.paid for last month). It is
--      ignored, so a stale event can never move a member backwards in time.
--      Contiguous periods share a boundary, so "ends at or before our start"
--      is exactly "a previous period".
--
--   2. A period starting within a day of ours is the SAME period re-anchored
--      to Stripe's clock, which only happens to the first period: the enrol
--      trigger started it at now() on insert, Stripe started it at the moment
--      the subscription was created, seconds or minutes earlier. Then the
--      enrol trigger's `due` charge, and any session already spent against the
--      old start, move with it. Without this the first period would carry two
--      rows, one paid by Stripe and one due forever a few seconds earlier.
--      A real renewal starts a whole period (at least a month) later, so it
--      can never be mistaken for this.
create or replace function public.membership_adopt_stripe_period(
  p_client_membership bigint,
  p_period_start timestamptz,
  p_period_end   timestamptz
) returns boolean language plpgsql security definer set search_path = public as $$
declare
  cm record;
  stray bigint;
begin
  if p_period_start is null or p_period_end is null or p_period_end <= p_period_start then
    return false;
  end if;

  select id, current_period_start, current_period_end
    into cm
  from public.client_memberships
  where id = p_client_membership
  for update;

  if not found then
    return false;
  end if;

  -- Guard 1: an old period, arriving late.
  if p_period_end <= cm.current_period_start then
    return false;
  end if;

  -- Already there: nothing to do.
  if cm.current_period_start = p_period_start and cm.current_period_end = p_period_end then
    return true;
  end if;

  -- Guard 2: the first period, re-anchored.
  if cm.current_period_start <> p_period_start
     and abs(extract(epoch from (p_period_start - cm.current_period_start))) < 86400 then

    select id into stray
    from public.membership_charges
    where client_membership_id = p_client_membership
      and period_start = cm.current_period_start
      and status = 'due'
      and stripe_invoice_id is null;

    if stray is not null then
      if exists (
        select 1 from public.membership_charges
        where client_membership_id = p_client_membership
          and period_start = p_period_start
      ) then
        -- A row for Stripe's period already exists, so the trigger's copy is
        -- the duplicate. Void it rather than delete it: it was written, and
        -- the log keeps what was written.
        update public.membership_charges
        set status = 'void',
            note = coalesce(note, 'Replaced by the Stripe invoice for the same period')
        where id = stray;
      else
        update public.membership_charges
        set period_start = p_period_start,
            period_end   = p_period_end
        where id = stray;
      end if;
    end if;

    update public.membership_redemptions
    set redeemed_for_period_start = p_period_start
    where client_membership_id = p_client_membership
      and redeemed_for_period_start = cm.current_period_start;
  end if;

  update public.client_memberships
  set current_period_start = p_period_start,
      current_period_end   = p_period_end
  where id = p_client_membership;

  return true;
end;
$$;

comment on function public.membership_adopt_stripe_period(bigint, timestamptz, timestamptz) is
  'Copy a Stripe billing period onto a subscribed membership. Ignores periods '
  'older than the current one; re-anchors the first period (and its due charge) '
  'when Stripe''s start is within a day of the enrol trigger''s. Internal.';

-- ── invoice.paid ─────────────────────────────────────────────
create or replace function public.settle_membership_invoice(
  p_subscription   text,
  p_invoice        text,
  p_period_start   timestamptz,
  p_period_end     timestamptz,
  p_amount_cents   int,
  p_payment_intent text
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  cm        record;
  charge_id bigint;
  existing  record;
  moved     boolean;
begin
  -- FOR UPDATE serialises this against a concurrent retry, a concurrent sync
  -- and the manage route, all of which write the same row.
  select id, status
    into cm
  from public.client_memberships
  where stripe_subscription_id = p_subscription
  for update;

  -- The invoice can arrive before checkout.session.completed has enrolled
  -- anybody. Not an error: the checkout handler settles the first invoice
  -- itself once the membership exists.
  if not found then
    return null;
  end if;

  moved := public.membership_adopt_stripe_period(cm.id, p_period_start, p_period_end);

  -- Paying for the period the member is in (or a newer one) is what makes the
  -- membership good again. Paying a period that is over says nothing about
  -- the current one. A cancelled membership stays cancelled: undoing that is
  -- an enrolment.
  if moved and cm.status in ('active', 'past_due', 'expired') then
    update public.client_memberships
    set status = 'active'
    where id = cm.id and status <> 'active';
  end if;

  -- Idempotency on the invoice. stripe_invoice_id is unique, so a retry must
  -- find its own row by that key first; an insert on the period key would hit
  -- the invoice key instead and raise. A failed invoice that Stripe later
  -- collects is the same invoice id, so this is also how 'failed' turns 'paid'.
  select id, status into existing
  from public.membership_charges
  where stripe_invoice_id = p_invoice;

  if found then
    if existing.status not in ('paid', 'refunded') then
      update public.membership_charges
      set status = 'paid',
          method = 'stripe',
          paid_at = now(),
          amount_cents = coalesce(p_amount_cents, amount_cents),
          stripe_payment_intent_id = coalesce(p_payment_intent, stripe_payment_intent_id)
      where id = existing.id;
    end if;
    return existing.id;
  end if;

  insert into public.membership_charges
    (client_membership_id, period_start, period_end, amount_cents,
     status, method, paid_at, stripe_invoice_id, stripe_payment_intent_id, note)
  values
    (cm.id, p_period_start, p_period_end, greatest(coalesce(p_amount_cents, 0), 0),
     'paid', 'stripe', now(), p_invoice, p_payment_intent, 'Charged by Stripe')
  on conflict (client_membership_id, period_start) do update
    set status = 'paid',
        method = 'stripe',
        paid_at = now(),
        period_end = excluded.period_end,
        amount_cents = excluded.amount_cents,
        stripe_invoice_id = excluded.stripe_invoice_id,
        stripe_payment_intent_id = excluded.stripe_payment_intent_id
    -- A period already settled (by a person at the counter, say) is not
    -- overwritten. Money that moved twice needs a person, not an UPDATE.
    where public.membership_charges.status not in ('paid', 'refunded')
  returning id into charge_id;

  if charge_id is null then
    select id into charge_id
    from public.membership_charges
    where client_membership_id = cm.id and period_start = p_period_start;
  end if;

  return charge_id;
end;
$$;

comment on function public.settle_membership_invoice(text, text, timestamptz, timestamptz, int, text) is
  'invoice.paid for a membership subscription. Adopts Stripe''s period, clears '
  'past_due, records the period paid. Idempotent on the invoice id and the '
  'period. Returns null when no membership has this subscription yet.';

-- ── invoice.payment_failed ───────────────────────────────────
create or replace function public.fail_membership_invoice(
  p_subscription text,
  p_invoice      text,
  p_period_start timestamptz,
  p_period_end   timestamptz,
  p_amount_cents int
) returns void language plpgsql security definer set search_path = public as $$
declare
  cm       record;
  existing record;
  already_failed boolean := false;
  who      text;
begin
  select cm2.id, cm2.client_id, cm2.status, m.name as plan_name
    into cm
  from public.client_memberships cm2
  join public.memberships m on m.id = cm2.membership_id
  where cm2.stripe_subscription_id = p_subscription
  for update of cm2;

  if not found then
    return;
  end if;

  select id, status into existing
  from public.membership_charges
  where stripe_invoice_id = p_invoice;

  if found then
    already_failed := existing.status = 'failed';
    if existing.status not in ('paid', 'refunded', 'failed') then
      update public.membership_charges
      set status = 'failed'
      where id = existing.id;
    end if;
  elsif p_period_start is not null and p_period_end > p_period_start then
    -- Same shape as settle: the period key is the idempotency key, and a row
    -- already paid for this period is never marked failed after the fact.
    insert into public.membership_charges
      (client_membership_id, period_start, period_end, amount_cents,
       status, method, stripe_invoice_id, note)
    values
      (cm.id, p_period_start, p_period_end, greatest(coalesce(p_amount_cents, 0), 0),
       'failed', 'stripe', p_invoice, 'Card declined at renewal')
    on conflict (client_membership_id, period_start) do update
      set status = 'failed',
          method = 'stripe',
          stripe_invoice_id = excluded.stripe_invoice_id
      where public.membership_charges.status not in ('paid', 'refunded');
  end if;

  -- past_due stops the benefit at once (membership_is_current reads status
  -- 'active'). Only from active: a cancelled membership stays ended, and an
  -- expired one is not made live by a failure.
  update public.client_memberships
  set status = 'past_due'
  where id = cm.id and status = 'active';

  -- Stripe retries a failed card on its own schedule and fires this event for
  -- every attempt, and retries the webhook itself on any 5xx. One notice per
  -- failed invoice is the useful number; five is noise that teaches people to
  -- ignore the bell.
  if already_failed then
    return;
  end if;

  select coalesce(
           nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
           'A member'
         )
    into who
  from public.profiles p where p.id = cm.client_id;
  who := coalesce(who, 'A member');

  perform public.notify_roles(
    array['manager', 'admin']::public.user_role[],
    'system',
    'Membership card declined: ' || who,
    cm.plan_name || '. Stripe will retry the card. Their benefit is paused until it goes through.',
    '/dashboard/clients/' || cm.client_id::text
  );

  insert into public.notifications (user_id, type, title, body, link)
  select p.id,
         'system'::public.notification_type,
         'Your membership payment did not go through',
         'We could not charge your card for ' || cm.plan_name
           || '. Update your card to keep your member benefits.',
         '/memberships'
  from public.profiles p
  where p.id = cm.client_id and p.suspended_at is null;
end;
$$;

comment on function public.fail_membership_invoice(text, text, timestamptz, timestamptz, int) is
  'invoice.payment_failed for a membership subscription. past_due on the '
  'membership, failed on the period''s charge (never over a paid one), one '
  'notice to managers and the member per failed invoice.';

-- ── customer.subscription.updated ────────────────────────────
create or replace function public.sync_membership_subscription(
  p_subscription         text,
  p_cancel_at_period_end boolean,
  p_period_start         timestamptz,
  p_period_end           timestamptz,
  p_status               text
) returns void language plpgsql security definer set search_path = public as $$
declare
  cm record;
begin
  select id, status, cancelled_at
    into cm
  from public.client_memberships
  where stripe_subscription_id = p_subscription
  for update;

  if not found then
    return;
  end if;

  perform public.membership_adopt_stripe_period(cm.id, p_period_start, p_period_end);

  update public.client_memberships
  set cancel_at_period_end = coalesce(p_cancel_at_period_end, false),
      auto_renew = status <> 'cancelled'
                   and not coalesce(p_cancel_at_period_end, false)
                   and p_status in ('active', 'trialing', 'past_due'),
      -- When they asked to stop is kept from the first time they asked.
      -- Resuming clears it on a membership that is still running.
      cancelled_at = case
                       when coalesce(p_cancel_at_period_end, false) then coalesce(cancelled_at, now())
                       when status = 'cancelled' then cancelled_at
                       else null
                     end,
      status = case
                 when p_status in ('past_due', 'unpaid') and status = 'active'
                   then 'past_due'::public.membership_status
                 when p_status = 'active' and status in ('past_due', 'expired')
                   then 'active'::public.membership_status
                 else status
               end
  where id = cm.id;
end;
$$;

comment on function public.sync_membership_subscription(text, boolean, timestamptz, timestamptz, text) is
  'customer.subscription.updated. Mirrors cancel_at_period_end, derives '
  'auto_renew, adopts Stripe''s period and maps Stripe''s status onto ours.';

-- ── customer.subscription.deleted ────────────────────────────
-- Stripe fires this AT the period end when cancel_at_period_end was set, so a
-- member who asked to stop keeps the period they paid for and loses the
-- benefit on the day it was due to end anyway. When somebody cancels the
-- subscription outright in Stripe, the event fires immediately and the benefit
-- stops immediately, which is what "cancel now" means. Either way the status
-- is the honest one: the subscription is over.
create or replace function public.end_membership_subscription(
  p_subscription text,
  p_ended_at     timestamptz
) returns void language plpgsql security definer set search_path = public as $$
begin
  update public.client_memberships
  set status = 'cancelled',
      ended_at = coalesce(ended_at, p_ended_at, now()),
      cancelled_at = coalesce(cancelled_at, p_ended_at, now()),
      auto_renew = false
  where stripe_subscription_id = p_subscription
    and (status <> 'cancelled' or auto_renew or ended_at is null);
end;
$$;

comment on function public.end_membership_subscription(text, timestamptz) is
  'customer.subscription.deleted. Ends the membership; idempotent.';

-- ── renew_membership refuses a subscription ──────────────────
-- The 050 function, unchanged but for the guard after the lookup.
create or replace function public.renew_membership(p_client_membership bigint)
returns timestamptz language plpgsql security definer set search_path = public as $$
declare
  cm     record;
  months int;
  price  int;
  new_start timestamptz;
  new_end   timestamptz;
begin
  if auth.uid() is not null and not public.is_manager() then
    raise exception 'Only a manager can renew a membership';
  end if;

  select cm2.*, m.period_months
    into cm
  from public.client_memberships cm2
  join public.memberships m on m.id = cm2.membership_id
  where cm2.id = p_client_membership
  for update of cm2;

  if not found then
    raise exception 'No such membership';
  end if;

  -- 083: Stripe owns the period of a subscription. Rolling it here would raise
  -- a due charge for a period Stripe is about to bill.
  if cm.stripe_subscription_id is not null then
    raise exception 'Stripe renews this membership automatically, so there is nothing to renew by hand';
  end if;

  -- 'expired' is renewable: it means a period ran out, which is precisely the
  -- thing a renewal fixes. 'cancelled' is not — somebody decided, and undoing
  -- a decision is an enrolment, not a renewal.
  if cm.status = 'cancelled' then
    raise exception 'That membership was cancelled — enrol them again rather than renewing it';
  end if;

  -- Somebody who asked to stop has paid for the period they are in and gets it.
  -- Renewal is where that request is honoured, because renewal is the only
  -- moment the studio would otherwise charge them again.
  if cm.cancel_at_period_end then
    update public.client_memberships
    set status = 'cancelled',
        ended_at = cm.current_period_end,
        cancelled_at = coalesce(cm.cancelled_at, now())
    where id = p_client_membership;
    return cm.current_period_end;
  end if;

  months := cm.period_months;
  price  := cm.price_cents_snapshot;

  -- A renewal taken BEFORE the period runs out continues from where it ends,
  -- so paying early never shortens what was already paid for. A renewal taken
  -- after it has run out starts today instead of back-dating to a period end
  -- that may be months gone — otherwise renewing a long-lapsed membership would
  -- hand out a period that was already over, which reads as "renewed" on every
  -- screen and grants nothing. The studio loses the days it lapsed for. That is
  -- the right way round: the member did not have the benefit during them.
  new_start := case
                 when cm.current_period_end > now() then cm.current_period_end
                 else now()
               end;
  new_end   := new_start + make_interval(months => months);

  update public.client_memberships
  set current_period_start = new_start,
      current_period_end   = new_end,
      status = case when status = 'expired' then 'active' else status end
  where id = p_client_membership;

  insert into public.membership_charges
    (client_membership_id, period_start, period_end, amount_cents, status)
  values
    (p_client_membership, new_start, new_end, price, 'due')
  on conflict (client_membership_id, period_start) do nothing;

  return new_end;
end;
$$;

comment on function public.renew_membership(bigint) is
  'Advance a pay-once membership one period and raise the charge for it, as '
  '`due`. Does not take money. Honours cancel_at_period_end by ending the '
  'membership instead. Refuses a membership with a Stripe subscription (083).';

-- ── Who may call these ───────────────────────────────────────
-- The webhook, with the service role, and nobody else. A signed-in client who
-- could call settle_membership_invoice could mark their own period paid.
revoke all on function public.membership_adopt_stripe_period(bigint, timestamptz, timestamptz)
  from public, anon, authenticated;
revoke all on function public.settle_membership_invoice(text, text, timestamptz, timestamptz, int, text)
  from public, anon, authenticated;
revoke all on function public.fail_membership_invoice(text, text, timestamptz, timestamptz, int)
  from public, anon, authenticated;
revoke all on function public.sync_membership_subscription(text, boolean, timestamptz, timestamptz, text)
  from public, anon, authenticated;
revoke all on function public.end_membership_subscription(text, timestamptz)
  from public, anon, authenticated;

grant execute on function public.membership_adopt_stripe_period(bigint, timestamptz, timestamptz)
  to service_role;
grant execute on function public.settle_membership_invoice(text, text, timestamptz, timestamptz, int, text)
  to service_role;
grant execute on function public.fail_membership_invoice(text, text, timestamptz, timestamptz, int)
  to service_role;
grant execute on function public.sync_membership_subscription(text, boolean, timestamptz, timestamptz, text)
  to service_role;
grant execute on function public.end_membership_subscription(text, timestamptz)
  to service_role;
