-- ============================================================
-- 559 Flawless — 082: the review notice says what it is
--
-- "Needs review — Kristy Xiong · Every online booking is held for review ·
-- Oct 20 at 10:00 AM" is the whole of what the queue, the bell and the email
-- (072 mirrors every notification out) have ever said. Deciding from it means
-- opening the dashboard, because the three things the answer actually turns
-- on are all missing: what was booked, whether the money arrived, and whether
-- this is a session the studio already sold.
--
-- Since 080 the notice fires when the deposit lands, so the money is knowable
-- at exactly the moment it is written. The body becomes:
--
--   Dermaplaning Facial + LED · Oct 20 at 10:00 AM · Deposit $30.00 paid ·
--   Membership visit 2 of 4 · Every online booking is held for review
--
-- Order is what-when-money-why: the first two identify the booking, the third
-- is the one fact that used to require a second screen, and the reason it was
-- flagged comes last because with auto_confirm off it is the same sentence
-- every time.
--
-- Every clause is omitted rather than guessed when the fact behind it is not
-- there. That is not defensive padding — it is the ordering. The lines, the
-- membership redemption and the promotions are all written AFTER the
-- appointment row, so a booking announced at INSERT (nothing owed, which with
-- a studio-wide default deposit set means none today) has none of them yet,
-- and an empty clause is worse than a missing one.
--
-- Only `review_body` changes. The firing rules from 080, the client's own
-- wording and the approval branch are reproduced exactly.
-- ============================================================

create or replace function public.appointment_notify_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  review_roles public.user_role[] := array['front_desk', 'manager', 'admin']::public.user_role[];
  who text;
  became_pending boolean;
  was_approved boolean;
  review_body text;
  zone        text;
  services_label text;
  deposit_label  text;
  member_label   text;
  mem            record;
  spent          int;
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
    -- ── What was booked ──────────────────────────────────────
    -- Every line, add-ons included, in the order the receipt reads. Joined
    -- the way the queue joins them: naming only the first described a
    -- three-service visit as a single wax.
    select string_agg(l.name_snapshot, ' + ' order by l.sort_order, l.id)
      into services_label
    from public.appointment_services l
    where l.appointment_id = new.id;

    -- ── Whether the money arrived ────────────────────────────
    -- 'paid' is the fact the Stripe webhook writes before it sets
    -- requested_at, so on the ordinary path this reads paid and says so with
    -- the amount. A deposit still owed is said plainly rather than left out:
    -- it means this came in by some other door.
    if new.deposit_cents > 0 and new.deposit_status = 'paid' then
      deposit_label := 'Deposit $' || to_char(new.deposit_cents / 100.0, 'FM999G999D00') || ' paid';
    elsif new.deposit_cents > 0 then
      deposit_label := 'Deposit $' || to_char(new.deposit_cents / 100.0, 'FM999G999D00') || ' due';
    else
      deposit_label := 'No deposit';
    end if;

    -- ── Whether this is a session already sold ───────────────
    -- `membership_redemptions` is the record that an included session was
    -- spent on this appointment (050). Which visit it is, is counted within
    -- the period it was claimed for — the same bucket the allowance is
    -- counted against — and chronologically by start time, so "visit 2 of 4"
    -- means the second of that month's facials, whatever order they were
    -- booked in.
    select cm.id as membership, r.redeemed_for_period_start as period,
           m.included_sessions_per_period as allowance
      into mem
    from public.membership_redemptions r
    join public.client_memberships cm on cm.id = r.client_membership_id
    join public.memberships m on m.id = cm.membership_id
    where r.appointment_id = new.id
    limit 1;

    if mem.membership is not null then
      select coalesce(sum(r2.sessions), 0) into spent
      from public.membership_redemptions r2
      join public.appointments a2 on a2.id = r2.appointment_id
      where r2.client_membership_id = mem.membership
        and r2.redeemed_for_period_start = mem.period
        and a2.starts_at <= new.starts_at;

      -- An unlimited plan has no "of", so it does not claim one.
      member_label := case
        when mem.allowance > 0 then 'Membership visit ' || spent || ' of ' || mem.allowance
        else 'Membership visit ' || spent
      end;
    end if;

    review_body := concat_ws(' · ',
      nullif(services_label, ''),
      to_char(new.starts_at at time zone zone, 'Mon DD at HH12:MI AM'),
      deposit_label,
      member_label,
      public.booking_review_label(new.approval_reason)
    );

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

comment on function public.appointment_notify_review() is
  'Tells the review queue a booking is waiting, tells the provider whose time '
  'it is, tells the client their time is held, and tells the client again when '
  'it is confirmed. The staff notice names the services, the time, the deposit '
  'and the membership session it spends (082); the client''s says nothing '
  'about why it was flagged, because that vocabulary is written for staff.';
