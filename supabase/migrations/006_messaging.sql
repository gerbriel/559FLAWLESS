-- ============================================================
-- 559 Flawless — 006: messaging + notifications
--
-- One threaded inbox covers both cases: a signed-in client asking about their
-- appointment, and an anonymous visitor using the contact form. An anonymous
-- thread carries guest_* fields and is matched to a client profile by the same
-- email-then-phone rule the booking flow uses, so the CRM stays whole.
--
-- Internal staff replies live in the same thread with `is_internal = true` and
-- are filtered out of every client-facing policy.
-- ============================================================

create type public.thread_status as enum ('open', 'pending', 'resolved', 'archived');

create table public.message_threads (
  id          uuid primary key default gen_random_uuid(),
  subject     text not null,
  -- Null until matched. Anonymous contact-form threads start with only guest_*.
  client_id   uuid references public.profiles(id) on delete set null,
  guest_name  text,
  guest_email text,
  guest_phone text,

  appointment_id uuid references public.appointments(id) on delete set null,
  assigned_to    uuid references public.profiles(id) on delete set null,
  status         public.thread_status not null default 'open',

  -- Denormalized for the inbox list; maintained by trigger.
  last_message_at   timestamptz not null default now(),
  last_message_from text,
  staff_unread   boolean not null default true,
  client_unread  boolean not null default false,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint thread_has_contact check (
    client_id is not null or guest_email is not null or guest_phone is not null
  )
);

create index message_threads_client_idx  on public.message_threads (client_id, last_message_at desc);
create index message_threads_status_idx  on public.message_threads (status, last_message_at desc);
create index message_threads_unread_idx  on public.message_threads (last_message_at desc)
  where staff_unread;

create table public.messages (
  id         bigserial primary key,
  thread_id  uuid not null references public.message_threads(id) on delete cascade,
  sender_id  uuid references public.profiles(id) on delete set null,
  -- Denormalized so an anonymous sender still renders a name in the inbox.
  sender_name text,
  body       text not null,
  -- Staff-only note inside the thread. Never returned to a client.
  is_internal boolean not null default false,
  attachments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now()
);

create index messages_thread_idx on public.messages (thread_id, created_at);

-- ── Notifications ────────────────────────────────────────────
create type public.notification_type as enum (
  'appointment_booked',
  'appointment_reminder',
  'appointment_changed',
  'appointment_cancelled',
  'intake_flagged',
  'consent_needed',
  'message',
  'order',
  'inventory_low',
  'inventory_approval',
  'system'
);

create table public.notifications (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  type       public.notification_type not null default 'system',
  title      text not null,
  body       text,
  -- In-app destination, e.g. /dashboard/appointments/<id>
  link       text,
  appointment_id uuid references public.appointments(id) on delete cascade,
  thread_id  uuid references public.message_threads(id) on delete cascade,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_user_idx on public.notifications (user_id, created_at desc);
create index notifications_unread_idx on public.notifications (user_id)
  where read_at is null;

-- ── Fan-out helper ───────────────────────────────────────────
/** Notify every user holding one of `roles`. */
create or replace function public.notify_roles(
  roles       public.user_role[],
  n_type      public.notification_type,
  n_title     text,
  n_body      text default null,
  n_link      text default null,
  n_appointment uuid default null,
  n_thread    uuid default null
) returns void language sql security definer set search_path = public as $$
  insert into public.notifications (user_id, type, title, body, link, appointment_id, thread_id)
  select p.id, n_type, n_title, n_body, n_link, n_appointment, n_thread
  from public.profiles p
  where p.role = any(roles) and p.suspended_at is null;
$$;

-- ── Thread triggers ──────────────────────────────────────────
create trigger message_threads_touch before update on public.message_threads
  for each row execute function public.touch_updated_at();

-- Match an anonymous thread to an existing client, same rule as bookings.
create or replace function public.thread_match_client()
returns trigger language plpgsql security definer set search_path = public as $$
declare matched uuid;
begin
  if new.client_id is not null then return new; end if;

  if new.guest_email is not null then
    select id into matched from public.profiles
    where lower(email) = lower(new.guest_email) and role = 'client' limit 1;
  end if;

  if matched is null and new.guest_phone is not null then
    select id into matched from public.profiles
    where regexp_replace(coalesce(phone, ''), '\D', '', 'g')
        = regexp_replace(new.guest_phone, '\D', '', 'g')
      and length(regexp_replace(new.guest_phone, '\D', '', 'g')) >= 10
      and role = 'client' limit 1;
  end if;

  new.client_id := matched;
  return new;
end;
$$;

create trigger message_threads_match_client
  before insert on public.message_threads
  for each row execute function public.thread_match_client();

-- Roll a new message up to its thread and notify the other side.
create or replace function public.message_after_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  t             public.message_threads%rowtype;
  sender_role   public.user_role;
  from_staff    boolean;
begin
  select * into t from public.message_threads where id = new.thread_id;

  select role into sender_role from public.profiles where id = new.sender_id;
  from_staff := sender_role is not null and sender_role <> 'client';

  update public.message_threads
  set last_message_at   = new.created_at,
      last_message_from = coalesce(new.sender_name, 'Guest'),
      -- An internal note marks the thread unread for staff only.
      staff_unread  = case when from_staff and not new.is_internal then false else true end,
      client_unread = case
                        when new.is_internal then client_unread
                        when from_staff      then true
                        else client_unread
                      end,
      status = case when status = 'resolved' then 'open' else status end
  where id = new.thread_id;

  if from_staff and not new.is_internal then
    -- Staff replied → notify the client (only possible once matched).
    if t.client_id is not null then
      insert into public.notifications (user_id, type, title, body, link, thread_id)
      values (t.client_id, 'message', 'New reply from 559 Flawless',
              left(new.body, 140), '/account/messages/' || t.id, t.id);
    end if;
  elsif not new.is_internal then
    -- Client or guest wrote in → notify the front desk.
    perform public.notify_roles(
      array['front_desk', 'manager', 'admin']::public.user_role[],
      'message',
      coalesce(new.sender_name, t.guest_name, 'A client') || ' sent a message',
      left(new.body, 140),
      '/dashboard/messages/' || t.id,
      null,
      t.id
    );
  end if;

  return null;
end;
$$;

create trigger messages_after_insert
  after insert on public.messages
  for each row execute function public.message_after_insert();

-- ── Appointment notifications ────────────────────────────────
create or replace function public.appointment_notify()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  who text;
begin
  who := coalesce(
    (select trim(coalesce(first_name,'') || ' ' || coalesce(last_name,''))
     from public.profiles where id = new.client_id),
    trim(coalesce(new.guest_first_name,'') || ' ' || coalesce(new.guest_last_name,'')),
    'A client'
  );

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

    if new.client_id is not null then
      insert into public.notifications (user_id, type, title, body, link, appointment_id)
      values (new.client_id, 'appointment_booked', 'Your appointment is booked',
              to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
              '/account/appointments/' || new.id, new.id);
    end if;

  elsif new.status = 'cancelled' and old.status <> 'cancelled' then
    insert into public.notifications (user_id, type, title, body, link, appointment_id)
    values (new.provider_id, 'appointment_cancelled',
            'Cancelled — ' || who,
            to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
            '/dashboard/appointments/' || new.id, new.id);

    if new.client_id is not null and new.cancelled_by is distinct from new.client_id then
      insert into public.notifications (user_id, type, title, body, link, appointment_id)
      values (new.client_id, 'appointment_cancelled', 'Your appointment was cancelled',
              coalesce(new.cancellation_reason, 'Please contact us to rebook.'),
              '/account/appointments/' || new.id, new.id);
    end if;

  elsif new.starts_at is distinct from old.starts_at then
    if new.client_id is not null then
      insert into public.notifications (user_id, type, title, body, link, appointment_id)
      values (new.client_id, 'appointment_changed', 'Your appointment was rescheduled',
              to_char(new.starts_at, 'Mon DD at HH12:MI AM'),
              '/account/appointments/' || new.id, new.id);
    end if;
  end if;

  return null;
end;
$$;

create trigger appointments_notify
  after insert or update on public.appointments
  for each row execute function public.appointment_notify();

-- A flagged intake needs a provider to clear it before treatment.
create or replace function public.intake_notify_flags()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if array_length(new.flags, 1) > 0 then
    perform public.notify_roles(
      array['provider', 'manager', 'admin']::public.user_role[],
      'intake_flagged',
      'Intake needs review — ' || array_length(new.flags, 1) || ' flag(s)',
      array_to_string(new.flags, ', '),
      '/dashboard/clients/' || new.client_id);
  end if;
  return null;
end;
$$;

create trigger intake_submissions_notify
  after insert on public.intake_submissions
  for each row execute function public.intake_notify_flags();

-- ── RLS ──────────────────────────────────────────────────────
alter table public.message_threads enable row level security;
alter table public.messages        enable row level security;
alter table public.notifications   enable row level security;

create policy "client reads own threads" on public.message_threads
  for select using (client_id = auth.uid());
create policy "staff reads threads" on public.message_threads
  for select using (public.is_front_desk());
-- Anyone may open a thread — that is the public contact form. They cannot read
-- it back unless they are signed in and matched.
create policy "anyone opens a thread" on public.message_threads
  for insert to anon, authenticated with check (true);
create policy "client updates own thread" on public.message_threads
  for update using (client_id = auth.uid()) with check (client_id = auth.uid());
create policy "staff updates threads" on public.message_threads
  for update using (public.is_front_desk()) with check (public.is_front_desk());

-- Clients never see internal notes.
create policy "client reads own messages" on public.messages
  for select using (
    not is_internal and exists (
      select 1 from public.message_threads t
      where t.id = thread_id and t.client_id = auth.uid()
    )
  );
create policy "staff reads all messages" on public.messages
  for select using (public.is_front_desk());
create policy "client posts to own thread" on public.messages
  for insert with check (
    not is_internal
    and sender_id = auth.uid()
    and exists (
      select 1 from public.message_threads t
      where t.id = thread_id and t.client_id = auth.uid()
    )
  );
create policy "guest posts first message" on public.messages
  for insert to anon with check (not is_internal and sender_id is null);
create policy "staff posts messages" on public.messages
  for insert with check (public.is_front_desk() and sender_id = auth.uid());

create policy "read own notifications" on public.notifications
  for select using (user_id = auth.uid());
create policy "update own notifications" on public.notifications
  for update using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy "delete own notifications" on public.notifications
  for delete using (user_id = auth.uid());
