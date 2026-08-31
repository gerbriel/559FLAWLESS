-- ============================================================
-- 559 Flawless — 069: the reward waits for the visit
--
-- 068 marked a referral reward `earned` the moment the friend BOOKED. The
-- studio's actual rule is stricter, and right: the referrer gets their $20
-- when the friend's first visit is COMPLETE and PAID IN FULL — a booking that
-- cancels, no-shows, or walks out owing money earned nobody anything.
--
-- So the row gains a fourth state, and it is the first one:
--
--   pending  the friend booked; nothing is owed to anyone yet
--   earned   their visit completed and its balance reached zero
--   applied  the desk took it off one of the referrer's visits
--   void     staff struck it
--
-- The promotion from pending to earned is decided HERE, by triggers on the
-- two events that can complete the condition — the appointment reaching
-- `completed`, and a payment landing — because "paid in full" is the
-- database's own arithmetic (appointment_balance_cents, 025) and application
-- code re-implementing it is how the two would drift. The referrer is
-- notified at the moment it truly becomes theirs, not before.
--
-- Also seeded: the reward itself, $20 flat, as the studio stated — only if no
-- referral promotion exists yet, so a configured board is never overwritten.
-- Rewards stack by construction: each earned row is applied on its own, and
-- every application adds to the same promo_discount_cents.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

-- ── 1. The fourth state ──────────────────────────────────────

alter table public.referral_redemptions
  drop constraint if exists referral_redemptions_reward_status_check;
alter table public.referral_redemptions
  add constraint referral_redemptions_reward_status_check
  check (reward_status in ('pending', 'earned', 'applied', 'void'));
alter table public.referral_redemptions
  alter column reward_status set default 'pending';

-- Any reward 068 marked earned ahead of the rule goes back to pending unless
-- its visit has actually finished and paid. Applied rewards are history and
-- stay applied — clawing back money already honoured is not a thing a
-- migration does.
update public.referral_redemptions r
set reward_status = 'pending'
where r.reward_status = 'earned'
  and not exists (
    select 1 from public.appointments a
    where a.id = r.appointment_id
      and a.status = 'completed'
      and coalesce(public.appointment_balance_cents(a.id), 0) = 0
  );

-- ── 2. The settlement ────────────────────────────────────────

/**
 * Promote this appointment's pending referral rewards, if it has finished
 * and is fully paid. Called by both triggers below; safe to call any number
 * of times — the status transition is the guard.
 */
create or replace function public.referral_settle(p_appointment uuid)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  if not exists (
    select 1 from public.appointments a
    where a.id = p_appointment and a.status = 'completed'
  ) then
    return;
  end if;

  if coalesce(public.appointment_balance_cents(p_appointment), 0) <> 0 then
    return;
  end if;

  -- Earn, and tell the referrer at the moment it becomes true.
  with u as (
    update public.referral_redemptions
    set reward_status = 'earned'
    where appointment_id = p_appointment
      and reward_status = 'pending'
    returning referrer_id
  )
  insert into public.notifications (user_id, type, title, body, link)
  select
    referrer_id,
    'system',
    'Your referral reward is ready',
    'Your friend''s first visit is complete. Your reward is waiting — the front desk can take it off your next visit.',
    '/account/rewards'
  from u;
end;
$$;

revoke all on function public.referral_settle(uuid) from public;

/** The visit finished — maybe the money already had. */
create or replace function public.referral_settle_on_status()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'completed' and old.status is distinct from 'completed' then
    begin
      perform public.referral_settle(new.id);
    exception when others then
      -- A reward is a nicety; the status change is not. Swallow and move on.
      null;
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists appointments_referral_settle on public.appointments;
create trigger appointments_referral_settle
  after update of status on public.appointments
  for each row execute function public.referral_settle_on_status();

/** The money landed — maybe the visit already had. */
create or replace function public.referral_settle_on_payment()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.appointment_id is not null and new.status = 'succeeded' then
    begin
      perform public.referral_settle(new.appointment_id);
    exception when others then
      null;
    end;
  end if;
  return null;
end;
$$;

drop trigger if exists payments_referral_settle on public.payments;
create trigger payments_referral_settle
  after insert on public.payments
  for each row execute function public.referral_settle_on_payment();

-- ── 3. The reward itself, as stated: $20 flat ────────────────

insert into public.promotions (name, kind, amount_cents, is_active)
select 'Referral reward', 'referral', 2000, true
where not exists (select 1 from public.promotions where kind = 'referral');

-- ============================================================
-- Deliberately left alone:
--
-- * Applying stays a front-desk act on the appointment screen (068), one
--   earned row at a time — which is exactly what makes rewards stackable:
--   three friends brought in, three taps, $60 off one visit.
-- * Loyalty points (067) keep accruing untouched. They are simply no longer
--   SHOWN to clients — a UI decision, made in the code, not here.
-- ============================================================
