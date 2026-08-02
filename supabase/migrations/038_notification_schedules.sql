-- ============================================================
-- 559 Flawless — 038: client notifications the studio controls
--
-- 006 gave us notifications and a trigger that fires on booking, change and
-- cancellation, with the wording hard-coded in PL/pgSQL. `reminder_sent_at` and
-- `intake_reminder_sent_at` have existed since 004 and 023 and nothing has ever
-- set them: there was no reminder to send. This migration is the missing half.
--
-- Three tables and one dispatcher:
--
--   notification_templates  what it says       — the studio writes this
--   notification_schedules  when it goes       — the studio sets this
--   notification_queue      what actually went — the record, and the guard
--
-- Delivery today is in-app only: a `notifications` row, plus a message thread
-- when the client should be able to answer back. There is no email or SMS
-- provider on this deployment, so rather than pretend there is, every queue row
-- carries a `channel` and anything that is not `in_app` is left `pending` for a
-- sender to claim through `claim_notification_queue()`. Dropping in Resend or
-- Twilio later means writing that one worker and adding a template row — not
-- reshaping any of this.
--
-- Two rules do the real work:
--
--   * Idempotency is a unique index, not a flag. A cron that runs twice, or a
--     dispatcher that is invoked by hand while the scheduled one is mid-sweep,
--     collides on (recipient, kind, channel, subject, scheduled_for) and the
--     second insert is a no-op. Nothing anywhere has to remember what it did.
--
--   * Whether a message is transactional or marketing is a property of its
--     KIND, fixed in `notification_kind_category()` and forced onto every queue
--     row by a trigger. The studio can rewrite a rebooking nudge but cannot
--     relabel it as transactional to get around someone's opt-out, and cannot
--     accidentally suppress a genuine appointment reminder by treating it as
--     marketing. Both directions of that mistake are expensive.
--
-- Depends on 032 for `public.locations` and `public.default_location_id()`.
-- ============================================================

-- ── Enums ────────────────────────────────────────────────────
-- Wrapped in exception handlers rather than guarded with a catalog lookup so
-- the whole file is re-runnable: `create type` has no IF NOT EXISTS.

do $do$ begin
  create type public.notification_kind as enum (
    'booking_confirmation',
    'appointment_reminder',
    'appointment_changed',
    'appointment_cancelled',
    'waitlist_opening',
    'rebooking_nudge',
    'intake_outstanding',
    'patch_test_due'
  );
exception when duplicate_object then null; end $do$;

-- The delivery route. Only `in_app` is wired; the other two exist so the
-- schema, the queue and the templates do not have to change the day a provider
-- is added.
do $do$ begin
  create type public.notification_channel as enum ('in_app', 'email', 'sms');
exception when duplicate_object then null; end $do$;

-- The consent line. See `notification_kind_category()`.
do $do$ begin
  create type public.notification_category as enum ('transactional', 'marketing');
exception when duplicate_object then null; end $do$;

-- What an offset is measured from. Modelled explicitly because "24 hours
-- before" and "6 weeks after" are the same arithmetic against different clocks,
-- and collapsing them into a signed number alone loses which clock.
do $do$ begin
  create type public.notification_anchor as enum (
    'appointment_start',
    'appointment_end',
    'last_visit'
  );
exception when duplicate_object then null; end $do$;

-- What a queued item is about. Part of the idempotency key.
do $do$ begin
  create type public.notification_subject as enum ('appointment', 'client', 'waitlist_entry');
exception when duplicate_object then null; end $do$;

do $do$ begin
  create type public.notification_queue_status as enum ('pending', 'sent', 'skipped', 'failed');
exception when duplicate_object then null; end $do$;

-- ── Wall clock ↔ instant, the same way src/lib/time.ts does it ─
--
-- Postgres and `zonedTimeToUtc` disagree on one case, and it is the case that
-- matters. On the fall-back overlap — 2026-11-01 01:30 in America/Los_Angeles
-- happens twice — `timestamp '2026-11-01 01:30' at time zone 'America/Los_Angeles'`
-- returns 09:30Z, the SECOND occurrence (PST). src/lib/time.ts deliberately
-- resolves to the FIRST (PDT, 08:30Z). They agree on the spring-forward gap,
-- which both push forward.
--
-- A reminder that lands an hour out once a year is not a catastrophe, but two
-- pieces of the same system computing different instants from the same wall
-- clock is exactly the drift AGENTS.md warns about with the booking engine. So
-- the transliteration lives here and the app and the database stay in step.

/** Offset of `p_zone` from UTC at an instant. East of UTC is positive. */
create or replace function public.tz_offset_at(p_instant timestamptz, p_zone text)
returns interval language sql stable as $$
  select (p_instant at time zone p_zone) - (p_instant at time zone 'UTC');
$$;

/**
 * Wall clock in `p_zone` -> absolute instant, DST-safe.
 *
 * Line-for-line the same method as `zonedTimeToUtc`: guess with the offset at
 * the naive instant, re-resolve with the offset actually in force there, and
 * when the two disagree take the larger shift — which pushes a spring-forward
 * gap onto the far side of the transition and pins a fall-back overlap to its
 * first occurrence.
 */
create or replace function public.zoned_time_to_utc(p_date date, p_time time, p_zone text)
returns timestamptz language plpgsql stable as $$
declare
  naive timestamptz := (p_date + p_time) at time zone 'UTC';
  o1 interval;
  o2 interval;
  o3 interval;
begin
  o1 := public.tz_offset_at(naive, p_zone);
  o2 := public.tz_offset_at(naive - o1, p_zone);
  if o1 = o2 then return naive - o1; end if;

  o3 := public.tz_offset_at(naive - o2, p_zone);
  if o2 = o3 then return naive - o2; end if;

  return naive - least(o2, o3);
end;
$$;

/**
 * Move an instant to a given wall-clock time on the same local calendar day.
 *
 * This is what makes "nudge to rebook six weeks later" arrive at ten in the
 * morning instead of whenever the previous appointment happened to end. Pure
 * minute offsets stay exact durations — 1440 minutes is 1440 minutes, so a
 * 24-hour reminder for a Sunday-after-the-change appointment lands an hour off
 * the wall clock, which is correct for a duration and wrong for a habit. A
 * schedule that cares about the hour sets `send_at_local` and gets the hour.
 */
create or replace function public.snap_to_local_time(
  p_instant timestamptz,
  p_zone    text,
  p_time    time
) returns timestamptz language sql stable as $$
  select case
    when p_instant is null or p_time is null then p_instant
    else public.zoned_time_to_utc((p_instant at time zone p_zone)::date, p_time, p_zone)
  end;
$$;

-- ── The transactional / marketing line ───────────────────────

/**
 * Which side of consent law a kind falls on.
 *
 * Transactional: the client asked for the thing this is about. A reminder for
 * an appointment they booked, a form they must complete before being treated, a
 * patch test their treatment requires, a cancellation they need to know about,
 * and a waitlist opening they explicitly asked to be told about. None of these
 * are suppressed by `marketing_opt_in` — withholding them is a service failure,
 * and an opt-out of promotion is not an opt-out of being told your appointment
 * moved.
 *
 * Marketing: a rebooking nudge. Nobody asked for it, it exists to generate a
 * booking, and sending it to someone who opted out is a legal problem.
 *
 * IMMUTABLE and hard-coded on purpose. The studio owns the wording and the
 * timing; it does not own this.
 */
create or replace function public.notification_kind_category(p_kind public.notification_kind)
returns public.notification_category language sql immutable as $$
  select case p_kind
    when 'rebooking_nudge' then 'marketing'
    else 'transactional'
  end::public.notification_category;
$$;

/**
 * Map a template kind onto the `notification_type` the bell already renders.
 *
 * Mapping rather than extending the 006 enum: `waitlist_opening` and
 * `rebooking_nudge` have no equivalent there, and adding values would ripple
 * into `src/types/database.ts` and every switch on the union for no gain — the
 * bell groups by type, and both of those are genuinely "something the studio
 * sent you".
 */
create or replace function public.notification_kind_to_type(p_kind public.notification_kind)
returns public.notification_type language sql immutable as $$
  select case p_kind
    when 'booking_confirmation' then 'appointment_booked'
    when 'appointment_reminder' then 'appointment_reminder'
    when 'appointment_changed'  then 'appointment_changed'
    when 'appointment_cancelled' then 'appointment_cancelled'
    when 'intake_outstanding'   then 'consent_needed'
    when 'patch_test_due'       then 'consent_needed'
    else 'system'
  end::public.notification_type;
$$;

-- ── Placeholders ─────────────────────────────────────────────

/**
 * Substitute {{placeholders}} in a template.
 *
 * The exact supported set — nothing else is defined, and nothing else is
 * touched:
 *
 *   {{client_first_name}}   first name, or "there" when we only have a guest
 *   {{client_last_name}}    surname, or empty
 *   {{client_name}}         both, trimmed
 *   {{service}}             the services on the appointment, joined with " + "
 *   {{provider}}            who is treating them
 *   {{when}}                "Monday, March 9 at 9:00 AM", in the location's zone
 *   {{date}}                "Monday, March 9"
 *   {{time}}                "9:00 AM"
 *   {{last_visit}}          date of the visit being followed up
 *   {{location}}            the location's name
 *   {{location_address}}    street, city, state
 *   {{location_phone}}      the number to call
 *   {{cancellation_reason}} what was given, or empty
 *   {{appointment_link}}    the client's own page for that appointment
 *
 * An unknown placeholder is LEFT ALONE — `{{nonsense}}` renders as
 * `{{nonsense}}`, not as an error and not as an empty string. A template is
 * something a person types into a text box; a typo there must produce a
 * slightly odd message, never a failed send and never a booking that rolls back.
 *
 * `{{ spaced_out }}` is accepted and normalised first, so the substitution
 * itself can be a plain string replace. Doing it the other way round — one
 * regexp per key with the value in the replacement — would let a client whose
 * name contained `\1` or `&` rewrite the rest of the message.
 */
create or replace function public.render_notification_template(
  p_template text,
  p_vars     jsonb
) returns text language plpgsql immutable as $$
declare
  rendered text;
  k text;
  v text;
begin
  if p_template is null then return null; end if;

  rendered := regexp_replace(p_template, '\{\{\s*([a-zA-Z0-9_]+)\s*\}\}', '{{\1}}', 'g');

  for k, v in select key, value from jsonb_each_text(coalesce(p_vars, '{}'::jsonb)) loop
    rendered := replace(rendered, '{{' || k || '}}', coalesce(v, ''));
  end loop;

  return rendered;
end;
$$;

-- ── Which location an appointment belongs to ─────────────────

/**
 * The one seam between appointments and locations.
 *
 * `appointments` predates 032 and there is no guarantee about when it gains a
 * `location_id`, so the column is read through `to_jsonb` rather than named
 * directly: a direct reference would make this whole file fail to apply against
 * a database where the column has not landed yet, and a catalogue branch would
 * need dynamic SQL. An absent key is simply null and the primary location takes
 * over.
 *
 * Every schedule, template and queue row is location-scoped, so this is the
 * only place that has to know how an appointment finds its location. Migration
 * 037 grows a richer version of the same idea (`appointment_location_id`, which
 * also falls back through the room and its resources); if both are present this
 * can safely become a one-line delegation to it.
 */
create or replace function public.notification_location_for_appointment(p_appointment uuid)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(
    (select nullif(to_jsonb(a) ->> 'location_id', '')::bigint
       from public.appointments a where a.id = p_appointment),
    public.default_location_id()
  );
$$;

-- ── Templates: what it says ──────────────────────────────────

create table if not exists public.notification_templates (
  id          bigserial primary key,
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),
  kind        public.notification_kind not null,
  channel     public.notification_channel not null default 'in_app',

  title_template text not null,
  body_template  text not null,
  -- Where the notification points. Rendered through the same substitution.
  link_template  text,

  -- Should the client be able to answer? Delivery then opens a thread in the
  -- studio inbox alongside the notification, so a reply lands on their record
  -- rather than in a void. Off for reminders — a reminder does not need a
  -- conversation and every one would be an unread thread.
  opens_thread boolean not null default false,

  is_active  boolean not null default true,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint notification_templates_unique unique (location_id, kind, channel)
);

create index if not exists notification_templates_lookup_idx
  on public.notification_templates (location_id, kind, channel) where is_active;

drop trigger if exists notification_templates_touch on public.notification_templates;
create trigger notification_templates_touch before update on public.notification_templates
  for each row execute function public.touch_updated_at();

-- ── Schedules: when it goes ──────────────────────────────────

create table if not exists public.notification_schedules (
  id          bigserial primary key,
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),
  kind        public.notification_kind not null,
  -- What the studio calls this line in Settings, e.g. "The day before".
  label       text not null,

  anchor         public.notification_anchor not null,
  -- Signed minutes from the anchor. Negative is before, positive is after.
  offset_minutes int not null,
  -- Optional wall-clock time in the location's zone. Null keeps the offset an
  -- exact duration; set, it moves the send to that hour on the same local day.
  send_at_local  time,

  -- Scope. Both null = every appointment. This is what "six weeks after a
  -- facial" is made of.
  service_id  bigint references public.services(id) on delete cascade,
  category_id bigint references public.service_categories(id) on delete cascade,

  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- A rebooking nudge is measured from the last visit and nothing else is;
  -- anything anchored on an appointment is measured from that appointment.
  constraint notification_schedules_anchor_matches_kind check (
    (kind = 'rebooking_nudge' and anchor = 'last_visit' and offset_minutes > 0)
    or (kind <> 'rebooking_nudge' and anchor in ('appointment_start', 'appointment_end'))
  ),
  -- Scope by service or by category, not both — "a facial" is one question.
  constraint notification_schedules_scope_single check (
    service_id is null or category_id is null
  )
);

-- Two identical lines would mean two identical messages, and the idempotency
-- key would not catch it because the schedule id is not part of it.
create unique index if not exists notification_schedules_unique_idx
  on public.notification_schedules (
    location_id, kind, anchor, offset_minutes,
    coalesce(service_id, 0), coalesce(category_id, 0)
  );

create index if not exists notification_schedules_active_idx
  on public.notification_schedules (location_id, kind) where is_active;

drop trigger if exists notification_schedules_touch on public.notification_schedules;
create trigger notification_schedules_touch before update on public.notification_schedules
  for each row execute function public.touch_updated_at();

-- ── Queue: what actually went ────────────────────────────────

create table if not exists public.notification_queue (
  id          bigserial primary key,
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),
  schedule_id bigint references public.notification_schedules(id) on delete set null,
  template_id bigint references public.notification_templates(id) on delete set null,

  kind     public.notification_kind not null,
  -- Forced from the kind by trigger. Denormalised so the record shows what was
  -- decided at the time, not what the rule says today.
  category public.notification_category not null default 'transactional',
  channel  public.notification_channel not null default 'in_app',

  recipient_id uuid not null references public.profiles(id) on delete cascade,
  subject_type public.notification_subject not null,
  -- Text, not a uuid or a bigint: subjects come from three different tables and
  -- a waitlist entry is not an appointment. It is an identity, not a join key —
  -- `appointment_id` below is the real FK when there is one.
  subject_id   text not null,
  appointment_id uuid references public.appointments(id) on delete cascade,

  scheduled_for timestamptz not null,

  -- Rendered at materialisation, so the row is a record of what was actually
  -- said and the send path is dumb. Editing a template changes everything not
  -- yet due; it cannot rewrite something already queued.
  title text not null,
  body  text,
  link  text,

  status   public.notification_queue_status not null default 'pending',
  attempts int not null default 0,
  sent_at  timestamptz,
  notification_id bigint references public.notifications(id) on delete set null,
  thread_id       uuid references public.message_threads(id) on delete set null,
  skipped_reason  text,
  last_error      text,
  created_at timestamptz not null default now()
);

/**
 * The whole idempotency guarantee, in one index.
 *
 * Same person, same kind, same channel, same subject, same intended instant —
 * one row, forever. Run the dispatcher twice in a row, run it by hand while the
 * cron is mid-sweep, replay a week of missed runs: the second insert conflicts
 * and does nothing. `scheduled_for` is derived from the anchor, never from
 * now(), which is what makes it stable across runs — and what makes a genuinely
 * new obligation (a rescheduled appointment, a second reminder at a different
 * offset) a genuinely new row.
 *
 * `channel` is in the key so an email copy of the same reminder is a separate
 * row with its own send state, rather than the in-app one blocking it.
 */
create unique index if not exists notification_queue_idempotency_idx
  on public.notification_queue (recipient_id, kind, channel, subject_type, subject_id, scheduled_for);

create index if not exists notification_queue_due_idx
  on public.notification_queue (channel, scheduled_for) where status = 'pending';
create index if not exists notification_queue_recipient_idx
  on public.notification_queue (recipient_id, scheduled_for desc);
create index if not exists notification_queue_appointment_idx
  on public.notification_queue (appointment_id) where appointment_id is not null;

-- The category is not the caller's to choose.
create or replace function public.notification_queue_set_category()
returns trigger language plpgsql as $$
begin
  new.category := public.notification_kind_category(new.kind);
  return new;
end;
$$;

drop trigger if exists notification_queue_category on public.notification_queue;
create trigger notification_queue_category
  before insert or update on public.notification_queue
  for each row execute function public.notification_queue_set_category();

-- ── Variables ────────────────────────────────────────────────

/**
 * Everything a template can name, for one client and (optionally) one
 * appointment. See `render_notification_template` for the documented set.
 *
 * Dates and times are rendered in the LOCATION's zone — `locations.timezone`
 * is authoritative and nothing here hardcodes America/Los_Angeles.
 */
create or replace function public.notification_vars(
  p_client      uuid,
  p_appointment uuid,
  p_location    bigint
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  loc      public.locations%rowtype;
  appt     public.appointments%rowtype;
  client   public.profiles%rowtype;
  provider public.profiles%rowtype;
  zone     text;
  services text;
  first_name text;
  last_name  text;
begin
  select * into loc from public.locations
  where id = coalesce(p_location, public.default_location_id());
  zone := coalesce(loc.timezone, 'America/Los_Angeles');

  if p_appointment is not null then
    select * into appt from public.appointments where id = p_appointment;
    select string_agg(aps.name_snapshot, ' + ' order by aps.sort_order, aps.id)
    into services
    from public.appointment_services aps
    where aps.appointment_id = p_appointment and aps.service_id is not null;
  end if;

  select * into client from public.profiles where id = coalesce(p_client, appt.client_id);
  select * into provider from public.profiles where id = appt.provider_id;

  first_name := nullif(trim(coalesce(client.first_name, appt.guest_first_name, '')), '');
  last_name  := nullif(trim(coalesce(client.last_name, appt.guest_last_name, '')), '');

  return jsonb_build_object(
    -- "there" rather than an empty greeting: "Hi , your appointment" reads as a
    -- bug to the person receiving it.
    'client_first_name', coalesce(first_name, 'there'),
    'client_last_name',  coalesce(last_name, ''),
    'client_name',       coalesce(trim(concat_ws(' ', first_name, last_name)), ''),
    'service',           coalesce(services, ''),
    'provider',          coalesce(
                           nullif(trim(coalesce(provider.display_name, '')), ''),
                           nullif(trim(coalesce(provider.first_name, '')), ''),
                           ''),
    'when', case when appt.starts_at is null then '' else
      to_char(appt.starts_at at time zone zone, 'FMDay, FMMonth FMDD')
        || ' at ' || to_char(appt.starts_at at time zone zone, 'FMHH12:MI AM') end,
    'date', case when appt.starts_at is null then '' else
      to_char(appt.starts_at at time zone zone, 'FMDay, FMMonth FMDD') end,
    'time', case when appt.starts_at is null then '' else
      to_char(appt.starts_at at time zone zone, 'FMHH12:MI AM') end,
    'last_visit', case when appt.starts_at is null then '' else
      to_char(appt.starts_at at time zone zone, 'FMMonth FMDD') end,
    'location',         coalesce(loc.name, ''),
    'location_address', coalesce(
      trim(both ', ' from concat_ws(', ', loc.address_line1, loc.city, loc.state)), ''),
    'location_phone',   coalesce(loc.phone, ''),
    'cancellation_reason', coalesce(appt.cancellation_reason, ''),
    'appointment_link', case when appt.id is null then '/account/appointments'
                             else '/account/appointments/' || appt.id end
  );
end;
$$;

/** Plausible values for every placeholder, for the preview in Settings. */
create or replace function public.notification_sample_vars()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  loc public.locations%rowtype;
begin
  select * into loc from public.locations where id = public.default_location_id();

  return jsonb_build_object(
    'client_first_name', 'Marisol',
    'client_last_name',  'Reyes',
    'client_name',       'Marisol Reyes',
    'service',           'Signature Facial',
    'provider',          'Yesenia',
    'when',              'Monday, March 9 at 9:00 AM',
    'date',              'Monday, March 9',
    'time',              '9:00 AM',
    'last_visit',        'January 26',
    'location',          coalesce(loc.name, '559 Flawless'),
    'location_address',  coalesce(
      trim(both ', ' from concat_ws(', ', loc.address_line1, loc.city, loc.state)),
      '285 W Shaw Ave, Fresno, CA'),
    'location_phone',    coalesce(loc.phone, '(559) 477-2999'),
    'cancellation_reason', 'The studio had to close that day.',
    'appointment_link',  '/account/appointments'
  );
end;
$$;

/** Render a draft against sample values. Used by the preview in Settings. */
create or replace function public.preview_notification_template(
  p_title text,
  p_body  text,
  p_link  text default null,
  p_vars  jsonb default null
) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  vars jsonb := coalesce(p_vars, public.notification_sample_vars());
begin
  if not public.is_staff() then
    raise exception 'Only staff can preview notification templates';
  end if;

  return jsonb_build_object(
    'title', public.render_notification_template(p_title, vars),
    'body',  public.render_notification_template(p_body, vars),
    'link',  public.render_notification_template(p_link, vars),
    'vars',  vars
  );
end;
$$;

-- ── Enqueue ──────────────────────────────────────────────────

/**
 * Put one obligation on the queue, once.
 *
 * Renders every active template for (location, kind) — one row per channel —
 * and returns the ids it created. A conflict on the idempotency index returns
 * nothing, which is the normal, expected outcome of the second dispatcher run.
 *
 * The opt-out check happens here AND again at delivery. Here so a marketing row
 * is never even written for someone who said no; again at delivery because
 * somebody can withdraw consent between the two, and the later answer is the
 * one that counts.
 *
 * No active template for the kind means nothing is sent. That is what the
 * on/off switch in Settings is: switching a kind off has to actually stop it.
 */
create or replace function public.enqueue_notification(
  p_kind         public.notification_kind,
  p_recipient    uuid,
  p_subject_type public.notification_subject,
  p_subject_id   text,
  p_scheduled_for timestamptz,
  p_location     bigint default null,
  p_appointment  uuid default null,
  p_schedule     bigint default null,
  p_vars         jsonb default '{}'::jsonb
) returns setof bigint language plpgsql security definer set search_path = public as $$
declare
  loc       bigint := coalesce(p_location, public.default_location_id());
  recipient public.profiles%rowtype;
  tpl       public.notification_templates%rowtype;
  vars      jsonb;
  queued    bigint;
  rendered_title text;
begin
  if p_recipient is null or p_subject_id is null or p_scheduled_for is null then
    return;
  end if;

  select * into recipient from public.profiles where id = p_recipient;
  if recipient.id is null or recipient.suspended_at is not null then
    return;
  end if;

  if public.notification_kind_category(p_kind) = 'marketing'
     and not coalesce(recipient.marketing_opt_in, false) then
    return;
  end if;

  vars := public.notification_vars(p_recipient, p_appointment, loc)
          || coalesce(p_vars, '{}'::jsonb);

  for tpl in
    select * from public.notification_templates
    where location_id = loc and kind = p_kind and is_active
    order by channel
  loop
    rendered_title := public.render_notification_template(tpl.title_template, vars);
    -- A template whose title renders to nothing would produce a notification
    -- with a blank line where the message should be; fall back to the raw
    -- title rather than send that.
    if coalesce(trim(rendered_title), '') = '' then
      rendered_title := tpl.title_template;
    end if;

    insert into public.notification_queue (
      location_id, schedule_id, template_id, kind, channel,
      recipient_id, subject_type, subject_id, appointment_id,
      scheduled_for, title, body, link
    ) values (
      loc, p_schedule, tpl.id, p_kind, tpl.channel,
      p_recipient, p_subject_type, p_subject_id, p_appointment,
      p_scheduled_for,
      rendered_title,
      public.render_notification_template(tpl.body_template, vars),
      public.render_notification_template(tpl.link_template, vars)
    )
    on conflict (recipient_id, kind, channel, subject_type, subject_id, scheduled_for)
    do nothing
    returning id into queued;

    if queued is not null then
      return next queued;
      queued := null;
    end if;
  end loop;
end;
$$;

-- ── Delivery ─────────────────────────────────────────────────

/**
 * Who a templated message comes from, when it opens a thread.
 *
 * `message_after_insert` decides which way to notify by looking up the sender's
 * role: a null sender reads as the CLIENT writing in, and would ping the front
 * desk about a message the studio itself sent. So there must be a staff sender,
 * and the appointment's own provider is the truthful one when there is an
 * appointment.
 */
create or replace function public.notification_sender(p_appointment uuid)
returns uuid language sql stable security definer set search_path = public as $$
  select coalesce(
    (select a.provider_id from public.appointments a where a.id = p_appointment),
    (select p.id from public.profiles p
      where p.role = 'admin' and p.suspended_at is null order by p.created_at limit 1),
    (select p.id from public.profiles p
      where p.role <> 'client' and p.suspended_at is null order by p.created_at limit 1)
  );
$$;

/**
 * Deliver one queued item in-app and close it out.
 *
 * Returns true when something went out. Everything else — opted out since,
 * appointment cancelled underneath us, the moment already passed — marks the
 * row `skipped` with a reason rather than deleting it, because "why did she not
 * get her reminder" is a question the studio will ask.
 */
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

/** Enqueue and deliver in one step, for the event-driven kinds. */
create or replace function public.send_notification_now(
  p_kind         public.notification_kind,
  p_recipient    uuid,
  p_subject_type public.notification_subject,
  p_subject_id   text,
  p_location     bigint default null,
  p_appointment  uuid default null,
  p_scheduled_for timestamptz default null,
  p_vars         jsonb default '{}'::jsonb
) returns int language plpgsql security definer set search_path = public as $$
declare
  queued bigint;
  sent   int := 0;
begin
  for queued in
    select public.enqueue_notification(
      p_kind, p_recipient, p_subject_type, p_subject_id,
      coalesce(p_scheduled_for, now()), p_location, p_appointment, null, p_vars)
  loop
    if public.deliver_notification(queued) then sent := sent + 1; end if;
  end loop;

  return sent;
end;
$$;

-- ── The dispatcher ───────────────────────────────────────────

/**
 * Turn schedules into queue rows for everything that has come due.
 *
 * Only what is due — not the whole future. A queue row is therefore a record of
 * an obligation the studio is about to meet, which means an edit to a template
 * takes effect on everything that has not come due yet, and the wording of
 * something already queued stays what it was.
 *
 * `p_lookback_minutes` is the catch-up window and it is deliberately finite. A
 * dispatcher that has not run for a fortnight must not celebrate by sending a
 * fortnight of reminders; it sends what came due since roughly the last run and
 * lets the rest go.
 */
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

/**
 * Send everything in-app that is due, one row at a time.
 *
 * Each delivery gets its own subtransaction so a single bad row cannot take the
 * sweep down with it — it is marked `failed` with the error and the next one
 * carries on. `failed` rows are left alone rather than retried automatically:
 * something that threw once will usually throw again, and a queue that retries
 * on its own is a queue that sends forty copies at three in the morning.
 */
create or replace function public.deliver_due_notifications(
  p_now   timestamptz default now(),
  p_limit int default 200
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  item   record;
  sent   int := 0;
  skipped int := 0;
  failed int := 0;
begin
  for item in
    select id from public.notification_queue
    where status = 'pending' and channel = 'in_app' and scheduled_for <= p_now
    order by scheduled_for, id
    limit greatest(p_limit, 0)
  loop
    begin
      if public.deliver_notification(item.id) then
        sent := sent + 1;
      else
        skipped := skipped + 1;
      end if;
    exception when others then
      failed := failed + 1;
      update public.notification_queue
      set status = 'failed', last_error = sqlerrm, attempts = attempts + 1
      where id = item.id;
    end;
  end loop;

  return jsonb_build_object('sent', sent, 'skipped', skipped, 'failed', failed);
end;
$$;

/**
 * The scheduled sweep: materialise, then deliver. One call, safe to repeat.
 *
 * Running this twice back to back sends nothing the second time — not because
 * it remembers, but because every row it would create already exists.
 */
create or replace function public.dispatch_notifications(
  p_now              timestamptz default now(),
  p_horizon_minutes  int default 60,
  p_lookback_minutes int default 2880,
  p_limit            int default 200
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  made      int;
  delivered jsonb;
  waiting   int;
begin
  made := public.materialise_due_notifications(p_now, p_horizon_minutes, p_lookback_minutes);
  delivered := public.deliver_due_notifications(p_now, p_limit);

  select count(*) into waiting
  from public.notification_queue
  where status = 'pending' and channel <> 'in_app' and scheduled_for <= p_now;

  return jsonb_build_object(
    'materialised', made,
    'sent',    (delivered ->> 'sent')::int,
    'skipped', (delivered ->> 'skipped')::int,
    'failed',  (delivered ->> 'failed')::int,
    -- Rows queued for a channel this deployment cannot send yet. Not an error;
    -- a number that should be zero until an email or SMS worker exists.
    'awaiting_sender', waiting
  ) ;
end;
$$;

/**
 * The send-adapter seam.
 *
 * An email or SMS worker claims a batch through this, delivers it however it
 * likes, and calls `mark_notification_sent` per row. `for update skip locked`
 * means two workers can run at once without either waiting or double-sending.
 * Nothing calls it today; it is here so adding a provider is a worker and a
 * template row, not a redesign.
 */
create or replace function public.claim_notification_queue(
  p_channel public.notification_channel,
  p_limit   int default 50,
  p_now     timestamptz default now()
) returns setof public.notification_queue language sql security definer set search_path = public as $$
  select * from public.notification_queue
  where status = 'pending' and channel = p_channel and scheduled_for <= p_now
  order by scheduled_for, id
  limit greatest(p_limit, 0)
  for update skip locked;
$$;

/** Close out a row a sender delivered outside the database. */
create or replace function public.mark_notification_sent(
  p_queue_id bigint,
  p_error    text default null
) returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.notification_queue
  set status = case when p_error is null then 'sent' else 'failed' end,
      sent_at = case when p_error is null then now() else sent_at end,
      last_error = p_error,
      attempts = attempts + 1
  where id = p_queue_id and status = 'pending';

  return found;
end;
$$;

/**
 * A slot came free and someone asked to be told.
 *
 * There is no waitlist table in this schema yet — whoever builds one calls this
 * and gets templating, opt-out handling, the queue record and idempotency for
 * free. `p_opened_at` is the idempotency handle: pass the instant the slot
 * actually opened (the cancelled appointment's `cancelled_at`, say) rather than
 * letting it default, and a retried or double-fired waitlist sweep cannot send
 * the same person the same opening twice.
 *
 * Transactional, not marketing: being told about an opening is the fulfilment
 * of a request the client made, not a promotion. Someone who has opted out of
 * marketing and then joined a waitlist still hears about their slot.
 */
create or replace function public.notify_waitlist_opening(
  p_client    uuid,
  p_entry_id  text,
  p_starts_at timestamptz,
  p_service   text default null,
  p_location  bigint default null,
  p_opened_at timestamptz default now()
) returns int language plpgsql security definer set search_path = public as $$
declare
  loc  bigint := coalesce(p_location, public.default_location_id());
  zone text;
begin
  select coalesce(l.timezone, 'America/Los_Angeles') into zone
  from public.locations l where l.id = loc;

  return public.send_notification_now(
    'waitlist_opening', p_client, 'waitlist_entry', p_entry_id,
    loc, null, p_opened_at,
    jsonb_build_object(
      'service', coalesce(p_service, ''),
      'when', to_char(p_starts_at at time zone zone, 'FMDay, FMMonth FMDD')
                || ' at ' || to_char(p_starts_at at time zone zone, 'FMHH12:MI AM'),
      'date', to_char(p_starts_at at time zone zone, 'FMDay, FMMonth FMDD'),
      'time', to_char(p_starts_at at time zone zone, 'FMHH12:MI AM'),
      'appointment_link', '/booking'
    ));
end;
$$;

-- ── The appointment triggers, rewritten to use the templates ─
--
-- 006's version wrote the client's wording into PL/pgSQL, which meant the
-- studio could not change a word of the three messages clients see most. Staff
-- notifications are untouched — those are internal and nobody is editing them.

create or replace function public.appointment_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who text;
  loc bigint;
begin
  who := coalesce(
    (select trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))
     from public.profiles where id = new.client_id),
    trim(coalesce(new.guest_first_name,'') || ' ' || coalesce(new.guest_last_name,'')),
    'A client'
  );

  loc := public.notification_location_for_appointment(new.id);

  if tg_op = 'INSERT' then
    insert into public.notifications (user_id, type, title, body, link, appointment_id)
    values (new.provider_id, 'appointment_booked',
            'New booking — ' || who,
            to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
            '/dashboard/appointments/' || new.id, new.id);

    perform public.notify_roles(
      array['front_desk', 'manager', 'admin']::public.user_role[],
      'appointment_booked', 'New booking — ' || who,
      to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
      '/dashboard/appointments/' || new.id, new.id);

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

/**
 * Confirm a booking once it has services on it.
 *
 * Statement-level with a transition table, so one booking is one confirmation
 * however many lines went in. `scheduled_for` is the appointment's own
 * `created_at`, which makes the idempotency key permanent: adding an add-on
 * next week re-fires this trigger, collides, and sends nothing.
 */
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

drop trigger if exists appointment_services_confirm on public.appointment_services;
create trigger appointment_services_confirm
  after insert on public.appointment_services
  referencing new table as inserted
  for each statement execute function public.appointment_services_confirm();

-- ── Seeds ────────────────────────────────────────────────────
--
-- Written once per location. Guarded by `not exists` so a re-run never
-- overwrites what the studio has since rewritten — the whole point of putting
-- the wording in a table is that theirs wins.

insert into public.notification_templates
  (location_id, kind, channel, title_template, body_template, link_template, opens_thread)
select l.id, v.kind::public.notification_kind, 'in_app',
       v.title, v.body, v.link, v.opens_thread
from public.locations l
cross join (values
  ('booking_confirmation',
   'You are booked in',
   E'{{client_first_name}}, your {{service}} is confirmed for {{when}} at {{location}}.\n\n{{location_address}}. If you need to move it, call {{location_phone}} or cancel from your account.',
   '{{appointment_link}}', false),

  ('appointment_reminder',
   'Reminder — {{service}} {{when}}',
   E'See you {{when}}, {{client_first_name}}.\n\n{{location}}, {{location_address}}. Call {{location_phone}} if anything has changed.',
   '{{appointment_link}}', false),

  ('appointment_changed',
   'Your appointment has moved',
   E'{{client_first_name}}, your {{service}} is now {{when}} at {{location}}.\n\nIf that does not work, call {{location_phone}} and we will find another time.',
   '{{appointment_link}}', false),

  ('appointment_cancelled',
   'Your appointment was cancelled',
   E'{{client_first_name}}, your {{service}} on {{when}} has been cancelled.\n\n{{cancellation_reason}}\n\nYou can rebook whenever suits you, or reply here and we will sort it out.',
   '{{appointment_link}}', true),

  ('waitlist_opening',
   'A spot has opened up',
   E'{{client_first_name}}, {{service}} is free {{when}} at {{location}}.\n\nIt is first come, first served — book it from your account, or reply here and we will hold it while we talk.',
   '/booking', true),

  ('rebooking_nudge',
   'Ready for your next {{service}}?',
   E'{{client_first_name}}, it has been a while since your {{service}} on {{last_visit}}.\n\nBook whenever it suits you — or reply here and we will find you a time. If you would rather not hear from us about this, you can turn it off in your account settings.',
   '/booking', true),

  ('intake_outstanding',
   'Forms to finish before {{when}}',
   E'{{client_first_name}}, your {{service}} on {{when}} still needs its forms completed.\n\nThey take a couple of minutes and we cannot treat you without them, so it is worth doing now rather than in the doorway.',
   '/account/forms', false),

  ('patch_test_due',
   'Patch test needed before {{when}}',
   E'{{client_first_name}}, {{service}} on {{when}} needs a patch test first — it is how we check your skin will tolerate the product, and it takes five minutes.\n\nCall {{location_phone}} and we will get you in beforehand.',
   '/account/appointments', false)
) as v(kind, title, body, link, opens_thread)
where not exists (
  select 1 from public.notification_templates t
  where t.location_id = l.id and t.kind = v.kind::public.notification_kind
    and t.channel = 'in_app'
);

insert into public.notification_schedules
  (location_id, kind, label, anchor, offset_minutes, send_at_local, is_active)
select l.id, v.kind::public.notification_kind, v.label,
       v.anchor::public.notification_anchor, v.offset_minutes, v.send_at_local::time, v.is_active
from public.locations l
cross join (values
  -- The two everyone expects. Left as exact durations: a reminder is a
  -- countdown to a specific moment, and the hour it lands on does not matter.
  ('appointment_reminder', 'The day before',   'appointment_start', -1440, null, true),
  ('appointment_reminder', 'Two hours before', 'appointment_start', -120,  null, true),

  -- These do care about the hour — nobody wants a form chased at 4am — so they
  -- snap to a wall-clock time in the location's own zone.
  ('intake_outstanding', 'Three days before',  'appointment_start', -4320,  '10:00', true),
  ('patch_test_due',     'A week before',      'appointment_start', -10080, '10:00', true),

  -- Six weeks. Off by default: it is marketing, and the studio should choose to
  -- start sending it rather than discover it already went.
  ('rebooking_nudge', 'Six weeks after a visit', 'last_visit', 60480, '10:00', false)
) as v(kind, label, anchor, offset_minutes, send_at_local, is_active)
where not exists (
  select 1 from public.notification_schedules s
  where s.location_id = l.id
    and s.kind = v.kind::public.notification_kind
    and s.anchor = v.anchor::public.notification_anchor
    and s.offset_minutes = v.offset_minutes
    and s.service_id is null and s.category_id is null
);

-- ── RLS ──────────────────────────────────────────────────────
--
-- Templates and schedules are settings: staff read them, managers change them.
-- The queue is a record and nobody writes it by hand — there is no insert,
-- update or delete policy at all, so the only ways in are the SECURITY DEFINER
-- functions above and the service role. A client never reads the queue either;
-- what a client sees is the `notifications` row it produced.

alter table public.notification_templates enable row level security;
alter table public.notification_schedules enable row level security;
alter table public.notification_queue     enable row level security;

drop policy if exists "staff reads notification templates" on public.notification_templates;
create policy "staff reads notification templates" on public.notification_templates
  for select using (public.is_staff());

drop policy if exists "manager writes notification templates" on public.notification_templates;
create policy "manager writes notification templates" on public.notification_templates
  for all using (public.is_manager()) with check (public.is_manager());

drop policy if exists "staff reads notification schedules" on public.notification_schedules;
create policy "staff reads notification schedules" on public.notification_schedules
  for select using (public.is_staff());

drop policy if exists "manager writes notification schedules" on public.notification_schedules;
create policy "manager writes notification schedules" on public.notification_schedules
  for all using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager reads notification queue" on public.notification_queue;
create policy "manager reads notification queue" on public.notification_queue
  for select using (public.is_manager());

-- ── Grants ───────────────────────────────────────────────────

grant select, insert, update, delete on public.notification_templates to authenticated;
grant select, insert, update, delete on public.notification_schedules to authenticated;
grant select on public.notification_queue to authenticated;
grant usage, select on sequence public.notification_templates_id_seq to authenticated;
grant usage, select on sequence public.notification_schedules_id_seq to authenticated;

grant all on public.notification_templates to service_role;
grant all on public.notification_schedules to service_role;
grant all on public.notification_queue     to service_role;
grant usage, select on sequence public.notification_templates_id_seq to service_role;
grant usage, select on sequence public.notification_schedules_id_seq to service_role;
grant usage, select on sequence public.notification_queue_id_seq     to service_role;

grant execute on function public.render_notification_template(text, jsonb) to authenticated;
grant execute on function public.notification_sample_vars() to authenticated;
grant execute on function public.preview_notification_template(text, text, text, jsonb) to authenticated;
grant execute on function public.notification_kind_category(public.notification_kind) to authenticated;

-- The dispatcher is the service role's, called from the cron route after it has
-- checked its bearer token. Nothing signed in gets to run it directly.
grant execute on function public.dispatch_notifications(timestamptz, int, int, int) to service_role;
grant execute on function public.materialise_due_notifications(timestamptz, int, int) to service_role;
grant execute on function public.deliver_due_notifications(timestamptz, int) to service_role;
grant execute on function public.claim_notification_queue(public.notification_channel, int, timestamptz) to service_role;
grant execute on function public.mark_notification_sent(bigint, text) to service_role;
grant execute on function public.notify_waitlist_opening(uuid, text, timestamptz, text, bigint, timestamptz) to service_role;

comment on table public.notification_templates is
  'What each kind of client message says. One row per (location, kind, channel); '
  'the studio edits these in Settings. Placeholders are documented on '
  'render_notification_template().';
comment on table public.notification_schedules is
  'When each kind goes out, as a signed minute offset from an anchor. Negative '
  'is before, positive is after. send_at_local moves it to a wall-clock hour in '
  'the location''s own timezone.';
comment on table public.notification_queue is
  'Every message the studio owes or has sent. The unique index on (recipient, '
  'kind, channel, subject, scheduled_for) is what makes a dispatcher run '
  'repeatable.';
