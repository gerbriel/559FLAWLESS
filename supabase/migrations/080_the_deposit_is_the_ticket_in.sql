-- ============================================================
-- 559 Flawless — 080: the deposit is the ticket in
--
-- The studio's rule: an online booking is not a request until its deposit is
-- paid. Before this, booking wrote the row, told the review queue, told the
-- provider, and THEN offered the client a button to pay — which could be
-- ignored, and was. Two confirmed visits on the book today have deposits
-- still owing; four cancelled ones never paid at all.
--
-- `appointments.requested_at` is the new fact. Null means "a hold that has not
-- been requested yet": the slot is reserved (the exclusion constraint still
-- counts it), but nobody has been told. booking.ts leaves it null exactly when
-- a deposit is owed; the Stripe webhook sets it when the deposit is paid.
-- Everything else — staff bookings, the till, a member whose facial is covered
-- so nothing is owed — gets the column default, now(), and behaves as before.
--
-- What reads it:
--   * appointment_notify_review: the queue, the provider and the client are
--     told when requested_at is SET, not when the row is inserted. Same words,
--     later moment.
--   * The dashboard queue, the bell count and the Today/Orders lists filter
--     on it. The calendar does not — a hold blocks time, so it is drawn, marked
--     "awaiting deposit".
--   * release_unpaid_hold(): a hold nobody paid for is DELETED, not cancelled.
--     It was never a booking: no "Cancelled — X" bell for the provider, no
--     cancellation in the reports, no Google event (booking.ts does not push an
--     unrequested hold). The client is told in a notification that survives
--     the delete — notifications.appointment_id is ON DELETE SET NULL (006).
--
-- Timing: Checkout is created with a 30-minute expiry (Stripe's minimum).
-- Stripe's checkout.session.expired event releases the hold at once; the sweep
-- below is the safety net at 60 minutes — a 30-minute buffer so a payment that
-- completed at the last second can never arrive after its hold is gone.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

-- ── The column ────────────────────────────────────────────────
-- Added without a default, backfilled from created_at (every row that exists
-- was requested under the old rules, at the moment it was made), and only
-- THEN given its default — so a re-run cannot reset a webhook-set value.
alter table public.appointments
  add column if not exists requested_at timestamptz;

update public.appointments
set requested_at = created_at
where requested_at is null;

alter table public.appointments
  alter column requested_at set default now();

comment on column public.appointments.requested_at is
  'When this became a request the studio could see. Null while an online '
  'booking''s deposit is owed and unpaid: the slot is held, nothing has been '
  'announced, and release_unpaid_hold() deletes it if nobody pays (080).';

create index if not exists appointments_unrequested_idx
  on public.appointments (created_at)
  where requested_at is null;

-- ── The review notice waits for the deposit ───────────────────
-- 049's function, with one change: "became pending" now also requires
-- requested_at to be set, and an UPDATE that sets it (the webhook) counts as
-- the moment. Everything else is the same text, kept in one piece so the two
-- client messages still match the booking screen.
create or replace function public.appointment_notify_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  review_roles public.user_role[] := array['front_desk', 'manager', 'admin']::public.user_role[];
  who text;
  became_pending boolean;
  was_approved boolean;
  review_body text;
  zone        text;
begin
  if tg_op = 'INSERT' then
    became_pending := new.status = 'pending' and new.requested_at is not null;
    was_approved := false;
  else
    -- Either the status moved to pending on an already-requested row, or the
    -- row was pending all along and has just been requested (deposit paid).
    became_pending := new.status = 'pending'
      and new.requested_at is not null
      and (old.status is distinct from new.status or old.requested_at is null);
    was_approved := old.status = 'pending' and new.status = 'confirmed';
  end if;

  if not became_pending and not was_approved then
    return null;
  end if;

  who := coalesce(
    nullif((select trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, ''))
            from public.profiles p where p.id = new.client_id), ''),
    nullif(trim(coalesce(new.guest_first_name, '') || ' ' || coalesce(new.guest_last_name, '')), ''),
    'A client'
  );

  select coalesce(l.timezone, 'America/Los_Angeles') into zone
  from public.locations l where l.id = new.location_id;
  zone := coalesce(zone, 'America/Los_Angeles');

  if became_pending then
    review_body := public.booking_review_label(new.approval_reason)
      || ' · ' || to_char(new.starts_at at time zone zone, 'Mon DD at HH12:MI AM');

    perform public.notify_roles(
      review_roles,
      'appointment_booked',
      'Needs review — ' || who,
      review_body,
      '/dashboard/appointments/pending',
      new.id
    );

    insert into public.notifications (user_id, type, title, body, link, appointment_id)
    select p.id,
           'appointment_booked'::public.notification_type,
           'Waiting on you — ' || who,
           review_body,
           '/dashboard/appointments/pending',
           new.id
    from public.profiles p
    where p.id = new.provider_id
      and p.suspended_at is null
      and p.role <> all (review_roles);

    if new.client_id is not null then
      insert into public.notifications (user_id, type, title, body, link, appointment_id)
      values (new.client_id, 'appointment_booked', 'Your request has been sent',
              to_char(new.starts_at at time zone zone, 'Mon DD at HH12:MI AM')
                || ' · Not confirmed yet. The studio looks at website bookings'
                || ' before confirming them. Your time stays reserved while that'
                || ' happens and you will be told as soon as it is confirmed.'
                || ' Your forms can be filled in now — we need them before we can'
                || ' treat you either way.',
              '/account/appointments/' || new.id, new.id);
    end if;

  elsif was_approved then
    if new.client_id is not null then
      insert into public.notifications (user_id, type, title, body, link, appointment_id)
      values (new.client_id, 'appointment_changed', 'Your appointment is confirmed',
              to_char(new.starts_at at time zone zone, 'Mon DD at HH12:MI AM'),
              '/account/appointments/' || new.id, new.id);
    end if;

    insert into public.notifications (user_id, type, title, body, link, appointment_id)
    select p.id,
           'appointment_changed'::public.notification_type,
           'Confirmed for you — ' || who,
           to_char(new.starts_at at time zone zone, 'Mon DD at HH12:MI AM'),
           '/dashboard/appointments/' || new.id,
           new.id
    from public.profiles p
    where p.id = new.provider_id
      and p.suspended_at is null
      and auth.uid() is distinct from new.provider_id;
  end if;

  return null;
end;
$$;

drop trigger if exists appointments_notify_review on public.appointments;
create trigger appointments_notify_review
  after insert or update on public.appointments
  for each row execute function public.appointment_notify_review();

-- ── Releasing a hold nobody paid for ──────────────────────────
-- Refuses anything that was requested, paid, not booked online, or already
-- past deciding — so it is safe to call from a retried webhook, and safe to
-- call on a hold the client paid for through a second Checkout session.
create or replace function public.release_unpaid_hold(p_appointment uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  a    record;
  zone text;
begin
  select id, client_id, starts_at, location_id, source, status,
         deposit_cents, deposit_status, requested_at
  into a
  from public.appointments where id = p_appointment
  for update;

  if a.id is null then return false; end if;
  if a.requested_at is not null
     or a.deposit_status = 'paid'
     or a.deposit_cents <= 0
     or a.source <> 'online'
     or a.status not in ('pending', 'confirmed') then
    return false;
  end if;

  select coalesce(l.timezone, 'America/Los_Angeles') into zone
  from public.locations l where l.id = a.location_id;
  zone := coalesce(zone, 'America/Los_Angeles');

  -- Told before the delete, with no appointment_id: the link goes to booking
  -- again, because the thing it would have pointed at is about to be gone.
  if a.client_id is not null then
    insert into public.notifications (user_id, type, title, body, link)
    values (
      a.client_id, 'appointment_cancelled', 'Your booking request was not sent',
      to_char(a.starts_at at time zone zone, 'Mon DD at HH12:MI AM')
        || ' · The deposit was not paid in time, so the request never reached'
        || ' the studio and the time has been released. You are welcome to'
        || ' book again.',
      '/book'
    );
  end if;

  delete from public.appointments where id = a.id;
  return true;
end;
$$;

create or replace function public.release_unpaid_holds()
returns integer language plpgsql security definer set search_path = public as $$
declare
  n int := 0;
  r record;
begin
  for r in
    select id from public.appointments
    where requested_at is null
      and deposit_cents > 0
      and deposit_status = 'pending'
      and source = 'online'
      and status in ('pending', 'confirmed')
      and created_at < now() - interval '60 minutes'
  loop
    if public.release_unpaid_hold(r.id) then n := n + 1; end if;
  end loop;
  return n;
end;
$$;

comment on function public.release_unpaid_holds() is
  'Deletes online holds whose deposit was never paid, an hour after they were '
  'made. The Stripe checkout.session.expired webhook does the same at 30 '
  'minutes; this is the safety net. Safe to call repeatedly.';

-- Only the service role (the webhook) and the scheduler. A client must not be
-- able to delete somebody else's hold, and staff have the queue for decisions.
revoke all on function public.release_unpaid_hold(uuid) from public, anon, authenticated;
revoke all on function public.release_unpaid_holds() from public, anon, authenticated;
-- Revoking from PUBLIC takes the default away from service_role too; the
-- webhook runs as service_role, so it is named. pg_cron runs as the owner.
grant execute on function public.release_unpaid_hold(uuid) to service_role;
grant execute on function public.release_unpaid_holds() to service_role;

-- ── The sweep, every 10 minutes ───────────────────────────────
do $$
declare
  has_cron boolean;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into has_cron;
  if not has_cron then
    raise warning
      'pg_cron is not enabled, so the unpaid-hold sweep is not scheduled. '
      'Holds are still released by the Stripe expiry webhook; enable pg_cron '
      'and re-run this migration for the safety net.';
    return;
  end if;

  begin
    perform cron.unschedule('559-unpaid-holds');
  exception when others then
    null;
  end;

  perform cron.schedule(
    '559-unpaid-holds',
    '*/10 * * * *',
    $job$select public.release_unpaid_holds()$job$
  );
end $$;
