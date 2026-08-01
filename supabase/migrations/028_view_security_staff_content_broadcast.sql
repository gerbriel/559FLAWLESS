-- ============================================================
-- 559 Flawless — 028: close a data leak, open the content,
--                     measure the banners, message the list
-- ============================================================

-- ── 1. user_management_list was readable by every client ─────
--
-- Supabase's linter flagged this as SECURITY DEFINER, which undersells it.
-- A Postgres view runs as its OWNER unless told otherwise, and this one is
-- owned by the migration role — so it bypassed row-level security on
-- `profiles`. Combined with `grant select … to authenticated`, any signed-in
-- client could read every other client's name, email, phone, role and lifetime
-- spend by querying the view directly. RLS on the underlying table was doing
-- nothing at all. Verified against a real database before writing this.
--
-- It is DROPPED rather than patched with `security_invoker = on`, because:
--
--   * Nothing reads it. The staff user-management screen queries `profiles`
--     directly, so this was pure exposure with no upside.
--   * Dropping removes the hazard outright instead of leaving it one
--     `create or replace view` away from returning — a later edit that forgot
--     the setting would silently reopen the leak, with no error to notice.
--
-- If a view is wanted here later, recreate it WITH the setting, and note that
-- it requires Postgres 15+:
--
--   create view public.user_management_list with (security_invoker = on) as …;

drop view if exists public.user_management_list;

-- ── 2. Site content the studio maintains ─────────────────────
--
-- Opening hours and the legal pages were admin-only. Both are ordinary
-- day-to-day content — "we're closing early on Tuesday" should not need the
-- owner's login.

drop policy if exists "admin writes hours" on public.business_hours;
drop policy if exists "staff writes hours" on public.business_hours;
create policy "staff writes hours" on public.business_hours
  for all using (public.is_front_desk()) with check (public.is_front_desk());

-- Policy documents: managers may publish. The versioning in site_settings
-- means an edit supersedes rather than overwrites, so a client can always be
-- shown the text they actually agreed to.
drop policy if exists "manager writes policies" on public.site_settings;
create policy "manager writes policies" on public.site_settings
  for all
  using (public.is_manager() and type in ('policy', 'content'))
  with check (public.is_manager() and type in ('policy', 'content'));

-- The script-injection rows stay admin-only. A write there is arbitrary
-- JavaScript on every page of the site, which is a different kind of decision
-- from editing the privacy policy.

-- ── 3. Did anyone look at the banner? ────────────────────────
--
-- Announcements could be targeted precisely but never measured, so there was no
-- way to tell a promotion that worked from one nobody saw. Impressions and
-- clicks ride on `analytics_events`, which already has a client-side writer and
-- a consent gate — a second pipeline would need both again.

create index if not exists analytics_announcement_idx
  on public.analytics_events ((meta ->> 'announcement_id'), event)
  where event in ('announcement_view', 'announcement_click', 'announcement_dismiss');

/**
 * How each announcement performed.
 *
 * Views are counted once per session per announcement, not once per page load —
 * a banner in the site header would otherwise score an "impression" on every
 * navigation and read as wildly successful for doing nothing.
 */
create or replace function public.announcement_stats()
returns table (
  announcement_id bigint,
  views bigint,
  clicks bigint,
  dismissals bigint,
  click_rate numeric
) language sql stable security definer set search_path = public as $$
  with events as (
    select
      (e.meta ->> 'announcement_id')::bigint as announcement_id,
      e.event,
      e.session_id
    from public.analytics_events e
    where e.event in ('announcement_view', 'announcement_click', 'announcement_dismiss')
      and e.meta ->> 'announcement_id' ~ '^[0-9]+$'
  ),
  counted as (
    select
      announcement_id,
      count(distinct session_id) filter (where event = 'announcement_view')    as views,
      count(distinct session_id) filter (where event = 'announcement_click')   as clicks,
      count(distinct session_id) filter (where event = 'announcement_dismiss') as dismissals
    from events
    group by announcement_id
  )
  select
    c.announcement_id,
    c.views,
    c.clicks,
    c.dismissals,
    case when c.views > 0
      then round((c.clicks::numeric / c.views) * 100, 1)
      else 0
    end as click_rate
  from counted c
  where public.is_manager();
$$;

-- ── 4. Messaging the list from inside the app ────────────────
--
-- A newsletter to people who already have an account does not need email at
-- all: they have an inbox here, it is already realtime, and a message in it is
-- tied to the client record. Subscribers without an account cannot be reached
-- this way, so they are listed separately for a manual send rather than
-- silently dropped.

create table if not exists public.broadcasts (
  id           bigserial primary key,
  subject      text not null,
  body         text not null,
  -- Who it went to, for the record. 'clients' = every client with an account;
  -- 'subscribers' = accounts whose email is on the newsletter list.
  audience     text not null default 'subscribers'
                 check (audience in ('clients', 'subscribers', 'staff')),
  sent_by      uuid references public.profiles(id) on delete set null,
  recipient_count int not null default 0,
  -- Subscribers with no account, who have to be emailed by hand.
  unreachable_count int not null default 0,
  created_at   timestamptz not null default now()
);

create index if not exists broadcasts_recent_idx on public.broadcasts (created_at desc);

alter table public.broadcasts enable row level security;

drop policy if exists "staff reads broadcasts" on public.broadcasts;
create policy "staff reads broadcasts" on public.broadcasts
  for select using (public.is_staff());

drop policy if exists "manager sends broadcasts" on public.broadcasts;
create policy "manager sends broadcasts" on public.broadcasts
  for insert with check (public.is_manager());

/**
 * Send an in-app message to every reachable recipient.
 *
 * Each person gets their own thread rather than a shared one, so a reply comes
 * back as an ordinary conversation with that client and nobody sees anyone
 * else's response. That is also why this is not a mailing list: a client
 * replying to a newsletter here lands in the studio's inbox attached to their
 * record.
 *
 * Returns what was sent and what could not be, so the UI can show the studio
 * exactly who still needs an email by hand.
 */
create or replace function public.send_broadcast(
  p_subject  text,
  p_body     text,
  p_audience text default 'subscribers'
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  sender      uuid := auth.uid();
  sender_name text;
  recipient   record;
  thread      uuid;
  sent        int := 0;
  unreachable int := 0;
  broadcast   bigint;
begin
  if not public.is_manager() and sender is not null then
    raise exception 'Only a manager can send a broadcast';
  end if;
  if coalesce(trim(p_subject), '') = '' or coalesce(trim(p_body), '') = '' then
    raise exception 'A broadcast needs a subject and a message';
  end if;

  select trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
  into sender_name from public.profiles where id = sender;

  -- Subscribers with no account: counted, not messaged. They are listed in the
  -- dashboard so the studio knows exactly who to email by hand.
  if p_audience = 'subscribers' then
    select count(*) into unreachable
    from public.newsletter_subscribers n
    where n.status = 'active' and n.client_id is null;
  end if;

  for recipient in
    select p.id, p.first_name
    from public.profiles p
    where p.suspended_at is null
      and case
        when p_audience = 'clients' then p.role = 'client'
        when p_audience = 'staff'   then p.role <> 'client'
        else p.role = 'client' and exists (
          select 1 from public.newsletter_subscribers n
          where n.client_id = p.id and n.status = 'active'
        )
      end
  loop
    insert into public.message_threads (client_id, subject, status, staff_unread)
    values (recipient.id, p_subject, 'open', false)
    returning id into thread;

    -- No notification is written here. `messages_after_insert` already raises
    -- one for the client whenever staff post a non-internal message, and
    -- inserting a second gave every recipient two pings for one newsletter.
    insert into public.messages (thread_id, sender_id, sender_name, body, is_internal)
    values (thread, sender, coalesce(nullif(sender_name, ''), '559 Flawless'), p_body, false);

    sent := sent + 1;
  end loop;

  insert into public.broadcasts
    (subject, body, audience, sent_by, recipient_count, unreachable_count)
  values (p_subject, p_body, p_audience, sender, sent, unreachable)
  returning id into broadcast;

  return jsonb_build_object(
    'broadcast_id', broadcast,
    'sent', sent,
    'unreachable', unreachable
  );
end;
$$;
