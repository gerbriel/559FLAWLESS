-- ============================================================
-- 559 Flawless — 027: two-way Google Calendar sync
--
-- 003 created `calendar_connections` and `calendar_busy` and left a comment
-- promising a "calendar-sync edge function". It never existed, so both tables
-- have always been empty: no appointment ever reached Google, and a dentist
-- appointment in the owner's personal calendar never blocked a facial slot.
--
-- The read side was already wired — src/lib/booking.ts consults calendar_busy
-- when generating slots. This migration adds what the write side needs.
-- ============================================================

-- ── 1. Blocks the studio creates need a Google identity ──────
--
-- Time off entered in the app should show up in the calendar, and time off
-- entered in the calendar should stop a client booking over it. That is one
-- loop, so an app-side block has to remember which Google event it became —
-- otherwise editing it here creates a duplicate there.

alter table public.availability_blocks
  add column if not exists google_event_id text;

comment on column public.availability_blocks.google_event_id is
  'The Google event this block was pushed to, so an edit updates rather than '
  'duplicates. Null when the calendar is not connected.';

-- ── 2. Busy intervals need to be replaceable, not just added ──
--
-- A sync re-reads a window from Google. Without an identity per interval the
-- only options are "insert duplicates forever" or "delete the whole window",
-- and the second one races with a sync running concurrently. An id per event
-- makes it an upsert.

alter table public.calendar_busy
  add column if not exists external_id text,
  add column if not exists summary text;

comment on column public.calendar_busy.external_id is
  'Google''s event id. Unique per provider so a re-sync updates in place.';
comment on column public.calendar_busy.summary is
  'Event title, shown to staff on the calendar so an unexplained block is not '
  'a mystery. Never shown to clients.';

-- Older rows have no external id; they came from nothing and can go.
delete from public.calendar_busy where external_id is null;

create unique index if not exists calendar_busy_external_idx
  on public.calendar_busy (provider_id, external_id)
  where external_id is not null;

-- ── 3. Connection health ─────────────────────────────────────
alter table public.calendar_connections
  add column if not exists last_synced_at timestamptz,
  add column if not exists last_sync_error text,
  -- Which direction the studio wants. Both by default: pulling protects the
  -- slots, pushing is what makes the calendar worth looking at.
  add column if not exists push_appointments boolean not null default true,
  add column if not exists pull_busy boolean not null default true;

-- ── 4. RLS ───────────────────────────────────────────────────
alter table public.calendar_connections enable row level security;
alter table public.calendar_busy enable row level security;

-- A provider manages their own connection; an admin can see that one exists.
-- Nobody reads the token columns through PostgREST — they are only ever handled
-- by the service-role client in the route handlers, which decrypt them there.
drop policy if exists "provider reads own connection" on public.calendar_connections;
create policy "provider reads own connection" on public.calendar_connections
  for select using (provider_id = auth.uid() or public.is_admin());

drop policy if exists "provider manages own connection" on public.calendar_connections;
create policy "provider manages own connection" on public.calendar_connections
  for all using (provider_id = auth.uid()) with check (provider_id = auth.uid());

-- Busy time is staff-visible: it is why a slot is missing, and a provider
-- looking at their own day should see it. It is never public — the titles come
-- from someone's personal calendar.
drop policy if exists "staff reads busy" on public.calendar_busy;
create policy "staff reads busy" on public.calendar_busy
  for select using (public.is_staff());

/**
 * Replace a provider's cached busy intervals for one window.
 *
 * Called by the sync route with everything Google returned for that window.
 * Anything previously cached inside the window that Google no longer reports
 * has been deleted or moved there, so it stops blocking here too — which is the
 * whole point of syncing rather than accumulating.
 *
 * Runs as one statement so a booking generating slots mid-sync sees either the
 * old set or the new one, never a half-empty calendar that would let a client
 * book over something real.
 */
create or replace function public.replace_calendar_busy(
  p_provider uuid,
  p_from     timestamptz,
  p_to       timestamptz,
  p_events   jsonb
) returns int language plpgsql security definer set search_path = public as $$
declare
  kept int;
begin
  -- The service role calls this; an authenticated caller must own the calendar.
  if auth.uid() is not null and auth.uid() <> p_provider and not public.is_admin() then
    raise exception 'You can only sync your own calendar';
  end if;

  with incoming as (
    select
      e ->> 'id'                      as external_id,
      (e ->> 'starts_at')::timestamptz as starts_at,
      (e ->> 'ends_at')::timestamptz   as ends_at,
      e ->> 'summary'                  as summary
    from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) e
  ),
  -- Drop anything in the window Google no longer reports.
  removed as (
    delete from public.calendar_busy b
    where b.provider_id = p_provider
      and b.source = 'google'
      and b.starts_at < p_to
      and b.ends_at > p_from
      and (b.external_id is null
           or b.external_id not in (select external_id from incoming))
    returning 1
  ),
  upserted as (
    insert into public.calendar_busy
      (provider_id, starts_at, ends_at, source, external_id, summary, synced_at)
    select p_provider, i.starts_at, i.ends_at, 'google', i.external_id, i.summary, now()
    from incoming i
    where i.ends_at > i.starts_at
    on conflict (provider_id, external_id) where external_id is not null
    do update set
      starts_at = excluded.starts_at,
      ends_at   = excluded.ends_at,
      summary   = excluded.summary,
      synced_at = now()
    returning 1
  )
  select count(*) into kept from upserted;

  update public.calendar_connections
  set last_synced_at = now(), last_sync_error = null
  where provider_id = p_provider;

  return kept;
end;
$$;
