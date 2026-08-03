-- ============================================================
-- 559 Flawless — 048: the person whose hands are booked is told
--
-- The studio asked for a booking to wait for the provider to approve it before
-- it lands on the calendar as a commitment. 036 built nearly all of that:
-- booking_review_reason() decides, appointment_route_approval() writes status
-- 'pending' instead of 'confirmed', /dashboard/appointments/pending is the
-- queue, and appointment_notify_review() announces it.
--
-- It announces it to `notify_roles(array['front_desk','manager','admin'])`.
--
-- So the one person the owner named — the provider whose time somebody just
-- asked for — is the one person the notice can miss. A 'provider' is none of
-- those three roles. She keeps her own calendar, she is the one who decides
-- whether that hour of her day is spoken for, and the bell says nothing.
--
-- ── Why she was left out, and why a role list cannot fix it ──
--
-- notify_roles fans out by ROLE, which is the right shape for "the front desk
-- should see this" and the wrong shape for this. Whose booking this is, is not
-- a fact about anybody's permissions; it is a fact about the row. Adding
-- 'provider' to the array would notify every provider in the studio about every
-- other provider's bookings, which is a different bug wearing the same clothes.
--
-- This is the same line 020 drew: a role is about permission, and whether
-- somebody takes appointments is a separate fact. Here the separate fact is
-- `new.provider_id`, so that is what the second recipient is selected by.
--
-- ── The duplicate, which is not hypothetical here ────────────
--
-- notify_roles (006:96) is one insert…select, and it produces exactly one row
-- per profile where `role = any(roles) and suspended_at is null`. No dedupe, no
-- conflict target: every matching profile gets a row.
--
-- 559 Flawless is one person. Per 020, she is an admin BECAUSE she owns the
-- place and a provider BECAUSE she works the room, and `new.provider_id` is her
-- id. A plain second insert would hand her two identical notifications — same
-- booking, same words, same destination — for every online booking the studio
-- takes. That is not a cosmetic annoyance; two bells for one event teaches the
-- owner that the bell over-reports, and a bell you have learned to discount is
-- worse than no bell.
--
-- So the provider's copy is written as an insert…select over `profiles`,
-- filtered by the exact negation of what notify_roles just matched: not
-- suspended, and role NOT in the fan-out list. The array is declared once in a
-- variable and used twice — once as the fan-out, once as its own negation — so
-- the two cannot drift apart the way two copies of a literal would. If a later
-- migration ever adds a role to that list, the exclusion follows it for free.
--
-- Concretely, for one online booking held for review:
--
--   solo owner (admin, and the provider)   → 1 row, from notify_roles
--   provider + separate front desk/owner   → 1 row each, from both paths
--   provider who is also the manager       → 1 row, from notify_roles
--
-- ── The wording the solo owner gets ──────────────────────────
--
-- Falling on the notify_roles side means she reads the front-desk phrasing,
-- 'Needs review — <name>', rather than the provider phrasing. That is accepted
-- deliberately. Giving her the provider wording would mean leaving her out of
-- notify_roles, and notify_roles takes no exclusion argument, so it would mean
-- open-coding the role fan-out here — a second implementation of the studio's
-- notification rule, which is exactly how these drift. Both wordings say the
-- same thing and both link to the same page. One correct row beats a nicer
-- sentence bought with a duplicated fan-out.
--
-- ── A null or inactive provider ──────────────────────────────
--
-- Handled as a filter, not a branch, which is why there is no `if` for it.
--
-- `appointments.provider_id` has been `not null references profiles(id) on
-- delete restrict` since 004, so today it can be neither null nor dangling —
-- the profile of anybody with appointments cannot be deleted at all. The
-- insert…select needs no guard for either case: no matching row, no
-- notification, no error. If some future migration relaxes that column, this
-- degrades to silence instead of raising inside a trigger and taking a client's
-- booking down with it.
--
-- The case that does occur is a suspended provider, and she is skipped by the
-- same `suspended_at is null` rule notify_roles applies to everybody else — a
-- suspended account is one nobody is reading. The booking is not left
-- unattended by that: the front desk, managers and admins are still told, and
-- the queue still holds the row.
--
-- ── The destination ──────────────────────────────────────────
--
-- '/dashboard/appointments/pending' is right for a provider, and that was
-- checked rather than assumed. The page queries `appointments` with the
-- request-scoped client and filters on status alone; what narrows it is RLS —
-- 004's "provider reads own appointments" is `provider_id = auth.uid()`, and
-- "front desk reads all appointments" needs is_front_desk(), which a plain
-- provider fails. So a provider opening that link sees her queue and nobody
-- else's; the page even changes its own sentence to say so.
--
-- The body is the same expression the fan-out is given, character for
-- character, including 036's session-timezone to_char. Two notices about one
-- booking that disagree about when it is would be a new bug. Rendering the time
-- in the studio's zone is worth doing and is a change that has to correct both
-- of them at once; it is not this migration.
--
-- ── Being told when somebody else approves it ────────────────
--
-- Yes, and only when it was somebody else.
--
-- The argument for silence is that the appointment is on her calendar either
-- way — it held its slot the whole time it sat pending. The argument that wins
-- is the asymmetry: the notice above tells her a booking is waiting on HER. If
-- the front desk then declines it, she is told, because 038's
-- appointment_notify already sends her 'Cancelled — <name>'. If the front desk
-- approves it, nothing arrives. She would hear about every outcome except the
-- one where the day got busier, and be left checking a queue that no longer has
-- the row in it with no way to know which way it went.
--
-- Whoever approved it does not need telling that they approved it, so the row
-- is suppressed when the actor is the provider herself — which is the ordinary
-- case, and the only one the solo studio ever has. auth.uid() reads the request
-- claims and is unaffected by SECURITY DEFINER, and PendingBookingActions does
-- the update with the signed-in user's own client, so the actor is real there.
-- A null auth.uid() means the service role, a scheduled job or the SQL editor;
-- that is never a provider tapping Confirm in her own browser, so it counts as
-- somebody else and she is told.
--
-- That notice links to the booking itself rather than to the queue, because by
-- the time it is read the booking has left the queue. 047's rule: the offer to
-- go somewhere has to arrive somewhere that still holds the thing.
--
-- ── And the same duplicate on the ordinary booking path ──────
--
-- 038's appointment_notify has it too: a 'New booking' row written straight to
-- new.provider_id, then the identical text fanned out to
-- front_desk/manager/admin. The solo owner has been getting two of those since
-- 006, and it is fixed below rather than merely noted, because switching
-- approval on is what makes it matter. Every online booking would otherwise
-- give her three notices, two of them word-for-word the same, and a feature
-- that triples the noise for one useful signal is one she turns back off.
-- Fixed with the same predicate as above, so both paths now answer "has
-- notify_roles already reached this person" the same way.
--
-- While that function is open, a second thing in it: `who` is built with a bare
-- trim() and no nullif, so a client whose profile has no name yields '' rather
-- than falling through to the guest name and then to 'A client'. The studio has
-- Google sign-in, and 023 exists precisely because Google accounts arrived with
-- nameless profiles — so "New booking — " with nothing after the dash is
-- reachable, and it is reachable exactly when staff most need to know who this
-- is. 036 already had the nullif; 038 did not. They match now.
--
-- And one judgement rather than a correction: when a booking arrives already
-- held for review, 'New booking' is suppressed entirely. Both triggers fire on
-- the same INSERT and both describe the same event, but only one of them says
-- what to do about it and points at the queue. Two bells for one booking is how
-- an owner learns to stop reading either. With approval off — still the
-- default — status at INSERT is 'confirmed' and nothing about the ordinary path
-- changes at all.
--
-- Nothing here changes a table's shape, and both 'appointment_booked' and
-- 'appointment_changed' are already in the notification_type enum, so
-- src/types/database.ts does not need regenerating.
--
-- Every statement is guarded; running this file twice does nothing the second
-- time.
-- ============================================================

-- Redeclared whole from 036. The routing, the TG_OP branch and the client's
-- confirmation are reproduced exactly; what is new is the provider on both
-- sides. The only restructuring is that `was_approved` is now its own branch
-- with the client's notice nested inside it, instead of
-- `elsif was_approved and new.client_id is not null` — the client is still
-- notified under precisely the same condition, but the provider's copy has to
-- be reachable for a guest booking too, and a guest booking has no client_id.
create or replace function public.appointment_notify_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  -- Declared once and used twice: as the fan-out, and as the negation that
  -- stops the provider's copy doubling for anyone already in it. Writing the
  -- array out a second time is how the duplicate comes back.
  review_roles public.user_role[] := array['front_desk', 'manager', 'admin']::public.user_role[];
  who text;
  became_pending boolean;
  was_approved boolean;
  review_body text;
begin
  -- NEW is unassigned during DELETE and OLD during INSERT, and touching an
  -- unassigned record raises rather than returning null. Branch on TG_OP.
  if tg_op = 'INSERT' then
    became_pending := new.status = 'pending';
    was_approved := false;
  else
    became_pending := new.status = 'pending' and old.status is distinct from new.status;
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

  if became_pending then
    review_body := public.booking_review_label(new.approval_reason)
      || ' · ' || to_char(new.starts_at, 'Mon DD at HH12:MI AM');

    perform public.notify_roles(
      review_roles,
      'appointment_booked',
      'Needs review — ' || who,
      review_body,
      '/dashboard/appointments/pending',
      new.id
    );

    -- The provider whose time this is, unless the line above already reached
    -- her. Selected from profiles rather than inserted outright so that a
    -- provider_id which is null, dangling or suspended produces no row instead
    -- of an error or an unread notification.
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

  elsif was_approved then
    if new.client_id is not null then
      insert into public.notifications (user_id, type, title, body, link, appointment_id)
      values (new.client_id, 'appointment_changed', 'Your appointment is confirmed',
              to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
              '/account/appointments/' || new.id, new.id);
    end if;

    -- Someone else answered a booking that was waiting on her. Links to the
    -- booking, not to the queue it has just left.
    insert into public.notifications (user_id, type, title, body, link, appointment_id)
    select p.id,
           'appointment_changed'::public.notification_type,
           'Confirmed for you — ' || who,
           to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
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

-- 036 already attached this and the definition above replaces the body in
-- place, so this is belt and braces rather than a fix: it means the file stands
-- on its own if the trigger is ever dropped, and re-running it is a no-op.
drop trigger if exists appointments_notify_review on public.appointments;
create trigger appointments_notify_review
  after insert or update on public.appointments
  for each row execute function public.appointment_notify_review();

comment on function public.appointment_notify_review() is
  'Tells the review queue a booking is waiting, and tells the client when it is '
  'not waiting any more. The provider whose time was booked is told on both '
  'sides — held for review, and confirmed by somebody other than her. She is '
  'selected by appointments.provider_id, not by role, and only when the '
  'front_desk/manager/admin fan-out did not already reach her, because a solo '
  'owner is both (020).';

-- ── The ordinary booking path, same two corrections ──────────
--
-- Redeclared whole from 038. Every branch is reproduced exactly; what changes is
-- the `who` fallback and the INSERT branch's provider row, which is now selected
-- under the same "notify_roles did not already reach her" predicate used above.
-- The cancellation branch writes a direct provider row too, but there is no
-- notify_roles beside it, so there is nothing there to duplicate and it is
-- untouched.
create or replace function public.appointment_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who          text;
  loc          bigint;
  booked_roles public.user_role[] := array['front_desk', 'manager', 'admin']::public.user_role[];
begin
  -- nullif on each candidate, so a profile with no name falls through to the
  -- guest name and then to 'A client' instead of stopping at an empty string.
  who := coalesce(
    nullif((select trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))
            from public.profiles where id = new.client_id), ''),
    nullif(trim(coalesce(new.guest_first_name,'') || ' ' || coalesce(new.guest_last_name,'')), ''),
    'A client'
  );

  loc := public.notification_location_for_appointment(new.id);

  -- A booking held for review is announced by appointment_notify_review, in
  -- words that say what to do about it and pointing at the queue. Sending 'New
  -- booking' as well would be two bells for one event, and the less useful one
  -- arrives second. With approval switched off — the default — nothing here
  -- changes: status is 'confirmed' at INSERT and this is the only notice.
  if tg_op = 'INSERT' and new.status = 'pending' then
    return null;
  end if;

  if tg_op = 'INSERT' then
    perform public.notify_roles(
      booked_roles,
      'appointment_booked', 'New booking — ' || who,
      to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
      '/dashboard/appointments/' || new.id, new.id);

    -- The provider, unless the line above already reached her.
    insert into public.notifications (user_id, type, title, body, link, appointment_id)
    select p.id,
           'appointment_booked'::public.notification_type,
           'New booking — ' || who,
           to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
           '/dashboard/appointments/' || new.id,
           new.id
    from public.profiles p
    where p.id = new.provider_id
      and p.suspended_at is null
      and p.role <> all (booked_roles);

    -- The client's confirmation is NOT sent from here any more. At INSERT the
    -- appointment has no line items — booking.ts writes them in the next
    -- statement — so a confirmation written here could never name the service,
    -- and it went out even on the path where the line insert failed and the
    -- appointment was deleted a moment later. `appointment_services_confirm`
    -- sends it instead, once the booking is actually a booking.

  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    insert into public.notifications (user_id, type, title, body, link, appointment_id)
    values (new.provider_id, 'appointment_cancelled',
            'Cancelled — ' || who,
            to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
            '/dashboard/appointments/' || new.id, new.id);

    if new.client_id is not null and new.cancelled_by is distinct from new.client_id then
      begin
        perform public.send_notification_now(
          'appointment_cancelled', new.client_id, 'appointment', new.id::text,
          loc, new.id, now());
      exception when others then
        -- A notification must never be the reason a cancellation fails to
        -- commit. The slot has to be released either way.
        raise warning 'cancellation notice failed for %: %', new.id, sqlerrm;
      end;
    end if;

  elsif new.starts_at is distinct from old.starts_at then
    if new.client_id is not null then
      begin
        perform public.send_notification_now(
          'appointment_changed', new.client_id, 'appointment', new.id::text,
          loc, new.id, now());
      exception when others then
        raise warning 'reschedule notice failed for %: %', new.id, sqlerrm;
      end;
    end if;
  end if;

  return null;
end;
$$;
