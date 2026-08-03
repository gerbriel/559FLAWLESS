-- ============================================================
-- 559 Flawless — 049: the notification system says the booking is confirmed
--
-- The studio switched approval on. 036 built it, 048 made the provider hear
-- about it, and BookingFlow now tells the client the truth on the screen they
-- read the moment they finish booking: "Your time is held." Not confirmed yet,
-- the studio looks at some website bookings first, nobody else can take your
-- slot while that happens.
--
-- Then the same client's notification arrives, and it says "You are booked in —
-- your Signature Facial is confirmed for Monday, March 9."
--
-- Two messages about one booking, minutes apart, from the same studio, and only
-- one of them can be true. The screen is right and the notification is wrong,
-- and the notification is the one that persists, the one that gets read second,
-- and the one that sounds official. A client who books, closes the tab, and
-- comes back to that message has been told they have an appointment that nobody
-- has agreed to give them. When the provider then declines it, the studio is not
-- managing an expectation — it is retracting a commitment it appeared to make.
--
-- ── Where it comes from ──────────────────────────────────────
--
-- 038's `appointment_services_confirm` is a statement trigger on
-- `appointment_services`, and it is a good design: it waits until the booking
-- actually has services on it, so the confirmation can name what was booked, and
-- it uses the appointment's own `created_at` as the idempotency handle so adding
-- an add-on next month cannot resend it. What it asks is
--
--     where ap.client_id is not null and ap.status <> 'cancelled'
--
-- and `<> 'cancelled'` was a complete question in a world where the only two
-- states a fresh booking could be in were 'confirmed' and 'gone'. 'pending' has
-- been in `appointment_status` since 004, labelled "awaiting staff confirmation
-- (auto_confirm = false)", but until the studio turned the flag off no row was
-- ever in it. The predicate was not wrong; it aged into being wrong the day a
-- setting changed. That is the shape of most of this batch.
--
-- The second one is the same fact reached by the other road. The dispatcher's
-- candidate query asks `a.status in ('pending', 'confirmed', 'checked_in')`, so
-- an unapproved booking is a candidate for every appointment-anchored schedule
-- the studio has. Two of those are the seeded reminders. "See you tomorrow"
-- about something the studio has not agreed to is worse than silence, because
-- silence at least leaves the client in the state they were actually left in.
--
-- ── Why removing 'pending' from that list is the wrong fix ───
--
-- Because it would take the feature apart. The owner described the waiting
-- period as doing work: "client books, they fill out nesesarry forms in the mean
-- time the procider can review and approve of booking." The chasers ARE the
-- waiting period. `intake_outstanding` and `patch_test_due` exist to make sure
-- that when the provider looks at the queue there is nothing outstanding on the
-- client's side — and a patch test in particular has its own lead time measured
-- in days, so a booking whose patch test was never chased is precisely the
-- booking that becomes unapprovable. Silencing those while a booking is pending
-- would mean the only bookings the studio never chases are the ones it has not
-- decided about yet.
--
-- So the question is not "should a pending booking generate notifications" but
-- "which sentences are still true about a booking nobody has approved", and that
-- is a fact about the KIND, not about the query. It gets a name:
-- `notification_kind_survives_pending()`. Every place that has to make this
-- decision asks that one function, so the three call sites below cannot drift
-- into three different answers the way three copies of a kind list would.
--
-- Every existing kind is enumerated in it explicitly, and the fallthrough is
-- FALSE — deny by default. That direction is chosen deliberately. A kind added
-- by some later migration that this function has never heard of goes silent
-- while a booking is held, and somebody eventually asks why a message did not
-- arrive; the other default fails by asserting something untrue to a client
-- about whether they have an appointment, which is the entire bug being fixed
-- here and is not the failure mode to leave armed for the next person.
--
-- The eight answers, and why:
--
--   booking_confirmation  false — it contains the word "confirmed". Nothing more
--                                 needs saying about it.
--   appointment_reminder  false — asserts an appointment exists to be reminded
--                                 about.
--   intake_outstanding    true  — the waiting period, doing its job.
--   patch_test_due        true  — the same, and the one with a lead time that
--                                 makes it urgent rather than merely useful.
--   appointment_changed   true  — this is the one that looks like it should be
--                                 false and is not. "Your X is now Tuesday at
--                                 2" is a fact about the request itself and
--                                 asserts nothing about approval. If the studio
--                                 moves a held booking before deciding on it,
--                                 the alternative to telling the client is
--                                 approving it later at an hour they were never
--                                 told about. Silence is the worse error here,
--                                 which is exactly the test being applied to
--                                 the reminder in the opposite direction.
--   appointment_cancelled true  — telling somebody their held booking is off is
--                                 right in every state. (In practice a decline
--                                 sets status 'cancelled' before this is asked,
--                                 so the gate never sees it; the answer is still
--                                 the answer.)
--   waitlist_opening      true  — about a different slot entirely, and it never
--                                 carries an appointment_id, so the gate is
--                                 never consulted for it.
--   rebooking_nudge       true  — and it cannot matter. The schedule CHECK from
--                                 038 forbids it an appointment anchor, and the
--                                 last_visit branch already refuses to nudge any
--                                 client with a future booking in 'pending',
--                                 'confirmed' or 'checked_in'. A held booking is
--                                 still something on the books; being invited to
--                                 rebook while waiting to hear about a booking
--                                 would read as a studio that does not know who
--                                 you are. That guard is correct and is left
--                                 alone — it is not this gate's job.
--
-- ── Three call sites, and why the third one is not paranoia ──
--
-- The materialisation query and the confirmation trigger are the two faults.
-- `deliver_notification` gets the same gate as a second reading, and the reason
-- is a real window rather than a general nervousness about defence in depth.
--
-- A booking can go BACKWARDS into 'pending' after it was confirmed: 036's
-- `appointment_services_route_approval` flips any online booking to pending the
-- moment a service marked `requires_booking_approval` is added to it, and staff
-- add services to existing bookings. Meanwhile `materialise_due_notifications`
-- writes rows for anything due within the next hour and
-- `deliver_due_notifications` only sends what is due NOW, so a queue row can sit
-- correct-when-written for up to an hour before it goes out. Add an upsell to a
-- confirmed booking in that hour and the reminder that was true when it was
-- queued is false when it lands.
--
-- 038 already re-reads the appointment at delivery for exactly this class of
-- reason — "reminding someone about an appointment that was cancelled, or that
-- has already started, is worse than saying nothing" — and re-checks consent
-- there too, because the later answer is the one that counts. Adding approval
-- state to that re-read is finishing an argument its author already made, not
-- starting a new one.
--
-- A row stopped there is marked `skipped` with `appointment_unapproved` and is
-- not retried when the booking is later approved, which is deliberate and worth
-- being explicit about: the skipped row keeps the idempotency key, so nothing
-- re-materialises in its place. That is the right outcome. The obligation it
-- represented was "remind them about tomorrow", and if it was suppressed the
-- moment is gone; a reminder delivered late because approval came through at
-- lunchtime is not the reminder anybody scheduled. The second seeded schedule
-- line (two hours before) is still ahead and will materialise fresh against the
-- state as it is then. And "why did she not get her reminder" stays answerable
-- from `notification_queue`, which is what `skipped_reason` is for.
--
-- ── An ordering dependency worth writing down ────────────────
--
-- The gate in `appointment_services_confirm` reads `ap.status`, and for the
-- service-policy route that status is set by `appointment_services_route_approval`
-- during the same INSERT. It reads the right value because one is a row-level
-- AFTER trigger and the other is a statement-level AFTER trigger, and Postgres
-- fires every row-level AFTER trigger for a statement before the statement-level
-- ones. If either is ever changed to the other timing — in particular if the
-- confirmation is made row-level, when its name sorts FIRST alphabetically —
-- this gate silently stops working and the false confirmation comes back. The
-- confirmation is statement-level for its own good reasons (one booking, one
-- message, however many lines went in); this is a second reason not to change it.
--
-- ── What the client gets instead ─────────────────────────────
--
-- Suppressing the false confirmation leaves silence, and silence is not a fix.
-- Someone who books, reads "your time is held", and closes the tab now has no
-- record of it anywhere they will look later. So the held booking gets its own
-- notice, written the way 036 and 048 write the client's approval notice: a
-- direct insert into `notifications`, not a template. That is not laziness about
-- reuse — a template is a thing the studio edits in Settings, and this pair of
-- messages ("held", then "confirmed") only works if the two agree with each
-- other and with the booking screen. The approval half is already a hard-coded
-- insert for the same reason.
--
-- What it says, and the three things it deliberately does not:
--
--   * It does not name the review reason. `booking_review_label()` is shared
--     with the queue and the staff bell, and its vocabulary is written for
--     staff: 'Missed appointments on record' is a note about a client, not a
--     message to them. The booking screen tells the client only the general
--     shape of the rule — "the studio looks at some website bookings" — and this
--     says the same, because two surfaces describing the same hold should not
--     disagree about how much of the studio's reasoning the client is shown.
--
--   * It does not offer the forms as the thing that unlocks approval. They are
--     not: PendingBookingActions writes a status and nothing else, and the
--     pending queue reads no form state at all. BookingFlow is careful about
--     this and the wording here matches it — the forms are needed before
--     treatment either way, and the waiting period is simply a good time to do
--     them.
--
--   * It does not promise anything to a guest. Like the approval notice it is
--     keyed to `client_id`, so a booking with no account produces no row. The
--     booking screen already promises a guest contact rather than a bell.
--
-- The link is '/account/appointments/<id>', the same row the approval notice
-- points at, and that was checked rather than assumed — 047's rule is that a
-- notification is an offer to go somewhere and the destination has to hold the
-- thing, and until very recently that page did not qualify. It printed the raw
-- enum `pending` in a green success badge, so it would have greeted this notice
-- with the client's own booking coloured as though it were settled. It now
-- reads its words from a single client-facing vocabulary in
-- `src/app/account/appointments/_lib/status.ts`, where pending is 'Awaiting
-- confirmation' in a warning tone on both the list and the detail page, and it
-- carries an explanation of the hold and a link to the forms.
--
-- So the pair of notices now lands on the same row: "your time is held" and,
-- later, "your appointment is confirmed", both opening the one screen whose
-- state changes between them. A client who taps both sees the system agreeing
-- with itself, which is the whole of what this batch is for. RLS puts them
-- there safely — 004's client policy is `client_id = auth.uid()`, so the link
-- resolves for its recipient and nobody else.
--
-- One limitation, stated rather than papered over: no client-facing surface
-- renders `notifications` rows today. The bell is mounted in the dashboard
-- layout only; on the client side the unread count appears as a badge beside
-- "Messages" in AccountNav. So this row is currently a durable record and a
-- number, not something a client can open and read. That is equally true of the
-- approval notice 036 has been writing since it was built, and it is a gap in
-- the account area rather than a reason to write a different row here — this
-- notice is what any client-facing notification list will show the day one
-- exists, and not writing it would leave that surface with a booking that
-- appears from nowhere already approved.
--
-- ── Why the confirmation is suppressed and not merely deferred ─
--
-- The tempting alternative is to hold `booking_confirmation` back and send the
-- real template at approval, so an approved client gets exactly the message an
-- auto-confirmed client gets, just later. It is rejected, for two reasons that
-- point the same way.
--
-- The client already gets a notice on approval — 036 writes 'Your appointment is
-- confirmed' and 048 kept it — so deferring the template would mean either two
-- messages saying the same thing at the same moment, which is the "two bells for
-- one event" 048 spends a paragraph refusing, or replacing that insert with a
-- templated send. And the templated send is contingent: a template row can be
-- deactivated in Settings, and `enqueue_notification` correctly treats that as
-- "the studio switched this off". Routing the approval notice through it would
-- make the one message that says a held booking is finally real switchable off
-- by accident, from a screen about something else. The unconditional insert is
-- the more robust of the two and it stays.
--
-- Nothing here changes a table's shape. No enum gains a value —
-- 'appointment_booked' is in `notification_type` already and
-- `appointment_unapproved` is a free-text `skipped_reason`. `src/types/database.ts`
-- does not need regenerating.
--
-- Every statement is guarded; running this file twice does nothing the second
-- time.
-- ============================================================

-- ── The rule, in one place ───────────────────────────────────
--
-- Immutable and hard-coded, the same posture as `notification_kind_category()`
-- (038) and for the same reason: the studio owns the wording and the timing of
-- its messages, and does not own whether a sentence is true. Every kind is named
-- so that adding one to the enum without an answer here is a decision somebody
-- has to make rather than a default they inherit.
create or replace function public.notification_kind_survives_pending(
  p_kind public.notification_kind
) returns boolean language sql immutable as $$
  select case p_kind
    -- Says "confirmed" in as many words.
    when 'booking_confirmation' then false
    -- Asserts there is an appointment to be reminded about.
    when 'appointment_reminder' then false
    -- The waiting period doing its work. This is the point of the feature.
    when 'intake_outstanding'    then true
    when 'patch_test_due'        then true
    -- Facts about the request, not claims about approval. Silence is worse.
    when 'appointment_changed'   then true
    when 'appointment_cancelled' then true
    -- Never carries an appointment_id; the gate is never consulted for it.
    when 'waitlist_opening'      then true
    -- Unreachable while a booking is held, by its own guards rather than this
    -- one. See the header.
    when 'rebooking_nudge'       then true
    -- Deny by default. A kind nobody has thought about is silent about a
    -- booking nobody has approved.
    else false
  end;
$$;

comment on function public.notification_kind_survives_pending(public.notification_kind) is
  'Is this kind of message still true about a booking the studio has not '
  'approved yet? Asked by the dispatcher, by delivery, and by the booking '
  'confirmation trigger, so all three answer it the same way. Deny by default: '
  'an unrecognised kind is silent while a booking is pending.';

-- Knows nothing and reveals nothing — an enum in, a boolean out. Left open like
-- `booking_review_label` (036) and granted alongside `notification_kind_category`
-- (038), whose shape it shares.
grant execute on function
  public.notification_kind_survives_pending(public.notification_kind) to authenticated;
grant execute on function
  public.notification_kind_survives_pending(public.notification_kind) to service_role;

-- ── Fault 1: the confirmation itself ─────────────────────────
--
-- Redeclared whole from 038. The loop, the transition table, the per-appointment
-- exception handler and the `created_at` idempotency handle are reproduced
-- exactly; the only change is one conjunct in the WHERE clause. The kind is a
-- constant here, so the call to the gate folds to a constant too — it is written
-- as a call rather than as `ap.status <> 'pending'` so that this trigger is
-- visibly governed by the same rule as the other two sites and cannot be
-- adjusted independently of them.
create or replace function public.appointment_services_confirm()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  a record;
begin
  for a in
    select distinct ap.id, ap.client_id, ap.created_at
    from inserted i
    join public.appointments ap on ap.id = i.appointment_id
    where ap.client_id is not null and ap.status <> 'cancelled'
      and (ap.status <> 'pending'
           or public.notification_kind_survives_pending('booking_confirmation'))
  loop
    begin
      perform public.send_notification_now(
        'booking_confirmation', a.client_id, 'appointment', a.id::text,
        public.notification_location_for_appointment(a.id), a.id, a.created_at);
    exception when others then
      raise warning 'booking confirmation failed for %: %', a.id, sqlerrm;
    end;
  end loop;

  return null;
end;
$$;

-- 038 already attached this. Reattached so the file stands on its own if the
-- trigger is ever dropped, and so that the statement-level timing the gate
-- depends on is restated where it is depended upon.
drop trigger if exists appointment_services_confirm on public.appointment_services;
create trigger appointment_services_confirm
  after insert on public.appointment_services
  referencing new table as inserted
  for each statement execute function public.appointment_services_confirm();

comment on function public.appointment_services_confirm() is
  'Sends the client their booking confirmation once the appointment has services '
  'on it. Statement-level so one booking is one message, and so it runs after '
  'appointment_services_route_approval has had its say about whether the booking '
  'is held for review — a held booking is not confirmed and is not told it is.';

-- ── Fault 2: the dispatcher's candidates ─────────────────────
--
-- Redeclared whole from 038. Both anchor branches, the service and category
-- scoping, the per-kind eligibility CASE, the window test and the `made` counter
-- are reproduced exactly. The single change is one conjunct added under the
-- status filter in the appointment-anchored branch. The original
-- `status in ('pending', 'confirmed', 'checked_in')` is left standing rather
-- than rewritten, so what this migration did to it stays legible.
create or replace function public.materialise_due_notifications(
  p_now              timestamptz default now(),
  p_horizon_minutes  int default 60,
  p_lookback_minutes int default 2880
) returns int language plpgsql security definer set search_path = public as $$
declare
  win_lo timestamptz := p_now - make_interval(mins => greatest(p_lookback_minutes, 0));
  win_hi timestamptz := p_now + make_interval(mins => greatest(p_horizon_minutes, 0));
  sched  public.notification_schedules%rowtype;
  zone   text;
  row    record;
  queued bigint;
  -- Counts rows actually created, not candidates considered — so a second run
  -- reports 0 and the number in the log means what it looks like it means.
  made   int := 0;
begin
  for sched in
    select s.* from public.notification_schedules s
    join public.locations l on l.id = s.location_id
    where s.is_active and l.is_active
    order by s.id
  loop
    select coalesce(l.timezone, 'America/Los_Angeles') into zone
    from public.locations l where l.id = sched.location_id;

    if sched.anchor in ('appointment_start', 'appointment_end') then
      -- ── Appointment-anchored: reminders, forms, patch tests ──
      for row in
        select a.id, a.client_id,
               public.snap_to_local_time(
                 case when sched.anchor = 'appointment_start' then a.starts_at else a.ends_at end
                   + make_interval(mins => sched.offset_minutes),
                 zone, sched.send_at_local) as due_at
        from public.appointments a
        where a.client_id is not null
          and a.status in ('pending', 'confirmed', 'checked_in')
          -- A booking still waiting on the studio is not something to send "see
          -- you tomorrow" about. Chasing the forms and the patch test IS the
          -- waiting period, so those two go on. See
          -- notification_kind_survives_pending().
          and (a.status <> 'pending'
               or public.notification_kind_survives_pending(sched.kind))
          -- Never remind about something that has already begun.
          and a.starts_at > p_now
          and public.notification_location_for_appointment(a.id) = sched.location_id
          and (
            sched.service_id is null or exists (
              select 1 from public.appointment_services aps
              where aps.appointment_id = a.id and aps.service_id = sched.service_id)
          )
          and (
            sched.category_id is null or exists (
              select 1 from public.appointment_services aps
              join public.services sv on sv.id = aps.service_id
              where aps.appointment_id = a.id and sv.category_id = sched.category_id)
          )
          and case sched.kind
            when 'intake_outstanding' then a.intake_completed_at is null
            when 'patch_test_due' then
              exists (
                select 1 from public.appointment_services aps
                join public.services sv on sv.id = aps.service_id
                where aps.appointment_id = a.id and sv.patch_test_hours > 0
              )
              and not exists (
                select 1 from public.patch_tests pt
                where pt.client_id = a.client_id and pt.result = 'pass'
                  and (pt.expires_at is null or pt.expires_at > a.starts_at)
              )
            else true
          end
      loop
        if row.due_at between win_lo and win_hi then
          for queued in
            select public.enqueue_notification(
              sched.kind, row.client_id, 'appointment', row.id::text,
              row.due_at, sched.location_id, row.id, sched.id)
          loop
            made := made + 1;
          end loop;
        end if;
      end loop;

    else
      -- ── last_visit: the rebooking nudge ─────────────────────
      --
      -- The guard is the whole difference between useful and annoying: a client
      -- who ALREADY has something on the books is never nudged, whatever they
      -- have booked and whichever schedule matched. Being told to come back for
      -- a facial by the same studio you are seeing on Thursday reads as a
      -- business that does not know who you are.
      --
      -- 'pending' stays in that list on purpose. A booking held for review is
      -- something on the books; a client waiting to hear about one is the last
      -- person who should be invited to make another.
      --
      -- The subject is the completed appointment, so one visit earns one nudge
      -- per schedule line, permanently — not one per dispatcher run.
      for row in
        with scoped as (
          select distinct on (a.client_id) a.client_id, a.id, a.ends_at
          from public.appointments a
          where a.status = 'completed'
            and a.client_id is not null
            and public.notification_location_for_appointment(a.id) = sched.location_id
            and (
              sched.service_id is null or exists (
                select 1 from public.appointment_services aps
                where aps.appointment_id = a.id and aps.service_id = sched.service_id)
            )
            and (
              sched.category_id is null or exists (
                select 1 from public.appointment_services aps
                join public.services sv on sv.id = aps.service_id
                where aps.appointment_id = a.id and sv.category_id = sched.category_id)
            )
          order by a.client_id, a.ends_at desc
        )
        select s.client_id, s.id,
               public.snap_to_local_time(
                 s.ends_at + make_interval(mins => sched.offset_minutes),
                 zone, sched.send_at_local) as due_at
        from scoped s
        where not exists (
          select 1 from public.appointments f
          where f.client_id = s.client_id
            and f.status in ('pending', 'confirmed', 'checked_in')
            and f.starts_at > p_now
        )
      loop
        if row.due_at between win_lo and win_hi then
          for queued in
            select public.enqueue_notification(
              sched.kind, row.client_id, 'appointment', row.id::text,
              row.due_at, sched.location_id, row.id, sched.id)
          loop
            made := made + 1;
          end loop;
        end if;
      end loop;
    end if;
  end loop;

  return made;
end;
$$;

comment on function public.materialise_due_notifications(timestamptz, int, int) is
  'Turns schedules into queue rows for everything that has come due. A booking '
  'still awaiting the studio''s approval is a candidate only for the kinds that '
  'are true about an unapproved booking — see '
  'notification_kind_survives_pending().';

-- ── The same question, re-asked at the moment of sending ─────
--
-- Redeclared whole from 038. Every branch is reproduced exactly — the non-in_app
-- early return, the recipient check, the marketing re-read, the appointment-gone
-- and cancelled and already-started skips, the thread path and its refinement of
-- the notification `message_after_insert` already wrote, the plain insert when
-- there is no thread, the queue close-out and the two appointment stamps. What
-- is added is one skip, placed with the others that exist for the same reason:
-- state the queue row was written against can change before it goes out, and the
-- state at delivery is the one that counts.
create or replace function public.deliver_notification(p_queue_id bigint)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  q         public.notification_queue%rowtype;
  tpl       public.notification_templates%rowtype;
  recipient public.profiles%rowtype;
  appt      public.appointments%rowtype;
  sender    uuid;
  sender_name text;
  new_thread uuid;
  new_notification bigint;
begin
  select * into q from public.notification_queue where id = p_queue_id for update;
  if q.id is null or q.status <> 'pending' then
    return false;
  end if;

  -- Anything not in-app belongs to a sender that does not exist yet. Left
  -- pending on purpose: a `skipped` row would hide the backlog.
  if q.channel <> 'in_app' then
    return false;
  end if;

  select * into recipient from public.profiles where id = q.recipient_id;
  if recipient.id is null or recipient.suspended_at is not null then
    update public.notification_queue
    set status = 'skipped', skipped_reason = 'recipient_unavailable', attempts = attempts + 1
    where id = q.id;
    return false;
  end if;

  -- Consent is re-read at the moment of sending. Someone who opted out after
  -- this was queued does not get it.
  if q.category = 'marketing' and not coalesce(recipient.marketing_opt_in, false) then
    update public.notification_queue
    set status = 'skipped', skipped_reason = 'marketing_opt_out', attempts = attempts + 1
    where id = q.id;
    return false;
  end if;

  if q.appointment_id is not null then
    select * into appt from public.appointments where id = q.appointment_id;

    if appt.id is null then
      update public.notification_queue
      set status = 'skipped', skipped_reason = 'appointment_gone', attempts = attempts + 1
      where id = q.id;
      return false;
    end if;

    -- Approval state is re-read here, not just at materialisation, because a
    -- confirmed booking can go back to 'pending': adding a service that requires
    -- approval flips it (036), and a queue row can be written up to an horizon
    -- ahead of the moment it is sent. Applies to every kind, so a reschedule
    -- notice or a cancellation still reaches a client whose booking is held —
    -- those are facts about the booking, not claims that it was agreed to.
    if appt.status = 'pending'
       and not public.notification_kind_survives_pending(q.kind) then
      update public.notification_queue
      set status = 'skipped', skipped_reason = 'appointment_unapproved', attempts = attempts + 1
      where id = q.id;
      return false;
    end if;

    -- Reminding someone about an appointment that was cancelled, or that has
    -- already started, is worse than saying nothing. The cancellation notice
    -- itself is obviously exempt.
    if q.kind in ('appointment_reminder', 'intake_outstanding', 'patch_test_due') then
      if appt.status = 'cancelled' then
        update public.notification_queue
        set status = 'skipped', skipped_reason = 'appointment_cancelled', attempts = attempts + 1
        where id = q.id;
        return false;
      end if;
      if appt.starts_at <= now() then
        update public.notification_queue
        set status = 'skipped', skipped_reason = 'appointment_started', attempts = attempts + 1
        where id = q.id;
        return false;
      end if;
    end if;
  end if;

  select * into tpl from public.notification_templates where id = q.template_id;

  if coalesce(tpl.opens_thread, false) then
    sender := public.notification_sender(q.appointment_id);

    if sender is not null then
      select trim(concat_ws(' ', p.first_name, p.last_name)) into sender_name
      from public.profiles p where p.id = sender;

      insert into public.message_threads (client_id, subject, status, appointment_id, staff_unread)
      values (q.recipient_id, q.title, 'open', q.appointment_id, false)
      returning id into new_thread;

      insert into public.messages (thread_id, sender_id, sender_name, body, is_internal)
      values (new_thread, sender, coalesce(nullif(sender_name, ''), '559 Flawless'),
              coalesce(q.body, q.title), false);

      -- `message_after_insert` has already written the client's ping — it is the
      -- single writer of that row, and inserting a second here is exactly the
      -- double-notification 028 had to go back and fix. Refine the one it made
      -- so the client sees the studio's own wording instead of "New reply".
      select id into new_notification
      from public.notifications
      where thread_id = new_thread and user_id = q.recipient_id
      order by id desc limit 1;

      if new_notification is not null then
        update public.notifications
        set type = public.notification_kind_to_type(q.kind),
            title = q.title,
            body  = q.body,
            link  = coalesce(q.link, '/account/messages/' || new_thread),
            appointment_id = coalesce(q.appointment_id, appointment_id)
        where id = new_notification;
      end if;
    end if;
  end if;

  -- No thread, or no staff account to send from: an ordinary notification.
  if new_notification is null then
    insert into public.notifications (user_id, type, title, body, link, appointment_id, thread_id)
    values (q.recipient_id, public.notification_kind_to_type(q.kind), q.title, q.body,
            coalesce(q.link, case when new_thread is not null
                                  then '/account/messages/' || new_thread end),
            q.appointment_id, new_thread)
    returning id into new_notification;
  end if;

  update public.notification_queue
  set status = 'sent',
      sent_at = now(),
      attempts = attempts + 1,
      notification_id = new_notification,
      thread_id = new_thread
  where id = q.id;

  -- The columns that have been sitting empty since 004 and 023. Set last, once
  -- the message is genuinely out, so a failure halfway never leaves the
  -- appointment claiming a reminder that nobody received.
  if q.appointment_id is not null then
    if q.kind = 'appointment_reminder' then
      update public.appointments set reminder_sent_at = now() where id = q.appointment_id;
    elsif q.kind = 'intake_outstanding' then
      update public.appointments set intake_reminder_sent_at = now() where id = q.appointment_id;
    end if;
  end if;

  return true;
end;
$$;

comment on function public.deliver_notification(bigint) is
  'Delivers one queued item in-app and closes it out. Recipient availability, '
  'marketing consent and the appointment''s own state — gone, cancelled, already '
  'started, or still awaiting the studio''s approval — are all re-read here '
  'rather than trusted from when the row was queued. Anything stopped is marked '
  'skipped with a reason, never deleted.';

-- ── And the notice the client should have had all along ──────
--
-- Redeclared whole from 048. The TG_OP branch, the review_roles array used as
-- both fan-out and its own negation, the `who` fallback chain, the staff
-- fan-out, the provider's copy on both sides and the approval notice are all
-- reproduced exactly. What is added is the client's own row in the
-- `became_pending` branch — the half that was missing when the false
-- confirmation was covering for it.
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
  zone        text;
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

  -- Every to_char below renders an instant, and a bare to_char uses the SESSION
  -- timezone — UTC on Supabase, because nothing sets one. 036 has had that bug
  -- since it was written and it only ever reached staff, who could reconcile it
  -- against the calendar. It reaches a CLIENT the moment this migration starts
  -- telling her the time her booking is held for, and "we are holding 9:00 PM"
  -- for a 2:00 PM appointment is not a cosmetic defect. Resolved the same way
  -- 038 resolves it everywhere: from the location, defaulting to the studio's
  -- own zone.
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

    -- The client's own copy, in the same words the booking screen used a moment
    -- earlier. Not `review_body`: that carries booking_review_label(), which is
    -- staff vocabulary — 'Missed appointments on record' is a note about a
    -- person, not a message to them. Keyed to client_id, so a guest booking
    -- produces nothing and is contacted the way the screen promised instead.
    if new.client_id is not null then
      insert into public.notifications (user_id, type, title, body, link, appointment_id)
      values (new.client_id, 'appointment_booked', 'Your time is held',
              to_char(new.starts_at at time zone zone, 'Mon DD at HH12:MI AM')
                || ' · Not confirmed yet. The studio looks at some website bookings'
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

    -- Someone else answered a booking that was waiting on her. Links to the
    -- booking, not to the queue it has just left.
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

-- Attached by 036 and reattached by 048; the definition above replaces the body
-- in place, so this is belt and braces rather than a fix.
drop trigger if exists appointments_notify_review on public.appointments;
create trigger appointments_notify_review
  after insert or update on public.appointments
  for each row execute function public.appointment_notify_review();

comment on function public.appointment_notify_review() is
  'Tells the review queue a booking is waiting, tells the provider whose time it '
  'is, tells the client their time is held, and tells the client again when it '
  'is confirmed. The client''s held notice says nothing about why the booking '
  'was flagged — that vocabulary is written for staff — and nothing about the '
  'forms unlocking approval, because they do not.';
