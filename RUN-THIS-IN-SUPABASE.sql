-- ============================================================
-- 559 Flawless — migrations 044 and 045
-- 020-043 already applied. Safe to re-run.
--
-- 044 schedules the background jobs. ENABLE pg_cron FIRST:
--     Supabase Dashboard → Database → Extensions → pg_cron.
--     Without it, 044 applies harmlessly and tells you so.
--
-- 045 makes appearing on the booking page an admin decision,
--     while letting anyone take themselves off at any time.
-- ============================================================


-- ── 044_scheduled_jobs.sql ──

-- ============================================================
-- 559 Flawless — 044: the jobs that have to run without anyone pressing a button
--
-- Six things were built across 033–041 that only work if something runs them on
-- a schedule, and until now nothing did. Vercel's Hobby plan allows exactly one
-- cron job per day, and calendar sync already has it — which is fine for the
-- calendar (it also refreshes opportunistically whenever the booking page is
-- loaded) and useless for "you forgot to clock in".
--
-- pg_cron is the right answer here rather than merely the free one. Every job
-- below is a plain SQL function, so the database calls it directly:
--
--   * no HTTP hop, so no bearer token to leak and no route to authorise
--   * no third-party scheduler to sign up for, keep alive, or notice has died
--   * no cold start, and no timeout at 10 seconds
--   * it runs where the data is, inside the same transaction boundary
--
-- The one job that genuinely cannot live here is calendar sync, because it has
-- to talk to Google. That stays on the Vercel cron in vercel.json.
--
-- ── Before this migration will do anything ───────────────────
--
-- pg_cron must be enabled for the project:
--   Supabase Dashboard → Database → Extensions → search "pg_cron" → enable.
--
-- The block below tries to enable it too, and if it cannot (the role lacks the
-- privilege on some plans) it says so clearly rather than failing the whole
-- migration — everything else in this file is then skipped and can be re-run
-- once the extension is on.
-- ============================================================

do $$
declare
  has_cron boolean;
begin
  select exists (select 1 from pg_extension where extname = 'pg_cron') into has_cron;

  if not has_cron then
    begin
      create extension if not exists pg_cron;
      has_cron := true;
      raise notice 'pg_cron enabled.';
    exception when others then
      raise warning
        'pg_cron is not enabled and could not be enabled from here (%). '
        'Turn it on under Database → Extensions in the Supabase dashboard, '
        'then re-run this migration. Nothing else in it has been applied.',
        sqlerrm;
      return;
    end;
  end if;

  -- ── Times are UTC ──────────────────────────────────────────
  -- pg_cron schedules in UTC regardless of the studio's timezone. Fresno is
  -- UTC-7 in summer and UTC-8 in winter, so a job pinned to a wall-clock hour
  -- drifts by one hour across the year. Each choice below is either
  -- hour-insensitive (it runs often) or deliberately placed far enough from a
  -- boundary that an hour of drift changes nothing.

  -- Unschedule first so this migration is re-runnable. cron.unschedule raises
  -- if the job does not exist, hence the per-job exception block.
  declare
    job text;
  begin
    foreach job in array array[
      '559-notifications', '559-waitlist', '559-timeclock',
      '559-licences', '559-recurring-expenses'
    ] loop
      begin
        perform cron.unschedule(job);
      exception when others then
        null;  -- not scheduled yet; nothing to remove
      end;
    end loop;
  end;

  -- ── Notifications: every 15 minutes ────────────────────────
  -- Reminders are the point of this one, and "24 hours before" has to mean
  -- roughly that. The queue is keyed on (recipient, kind, subject, scheduled_for)
  -- so running it often is free — a second pass in the same window sends
  -- nothing. Verified idempotent in 038.
  perform cron.schedule(
    '559-notifications',
    '*/15 * * * *',
    $job$select public.dispatch_notifications()$job$
  );

  -- ── Waitlist: every 10 minutes ─────────────────────────────
  -- A claim window expires and the next person in the queue should be told
  -- promptly — a slot released at 2pm that nobody hears about until midnight is
  -- a slot the studio did not fill. Cheap: it does nothing when nothing lapsed.
  perform cron.schedule(
    '559-waitlist',
    '*/10 * * * *',
    $job$select public.waitlist_sweep()$job$
  );

  -- ── Clock in/out reminders: every 15 minutes, working hours ─
  -- The whole value is timeliness; a daily digest telling someone they forgot
  -- to clock in yesterday is worth nothing. 13:00–04:00 UTC covers roughly
  -- 5am–9pm Pacific across both halves of the year, which is wider than the
  -- studio's day at either end — the function only notifies people who are
  -- actually late against their own roster, so an out-of-hours run is a no-op.
  perform cron.schedule(
    '559-timeclock',
    '*/15 13-23,0-4 * * *',
    $job$select public.send_time_clock_reminders()$job$
  );

  -- ── Licence expiry: once daily ─────────────────────────────
  -- 16:00 UTC is 8am or 9am Pacific — the start of the day either way, which is
  -- when a warning is actionable. Idempotent by threshold: 60/30/14/7 days then
  -- expiry, each sent once, verified in 041.
  perform cron.schedule(
    '559-licences',
    '0 16 * * *',
    $job$select public.notify_expiring_licences()$job$
  );

  -- ── Recurring expenses: daily, early ───────────────────────
  -- Posts rent, software and anything else due. 10:00 UTC is the small hours
  -- locally, so a month boundary has fully turned over in the studio's own
  -- timezone before anything is posted. Idempotent on (rule, period) — 033
  -- proved a second run posts zero.
  perform cron.schedule(
    '559-recurring-expenses',
    '0 10 * * *',
    $job$select public.generate_recurring_expenses()$job$
  );

  raise notice 'Scheduled 5 jobs. Inspect them with: select * from cron.job;';
end $$;

/**
 * What the scheduler is doing, for the dashboard.
 *
 * Reads pg_cron's own tables so the studio can see that the jobs exist and when
 * each last ran — a scheduler nobody can observe is one that fails silently.
 * Returns no rows when pg_cron is not enabled, which the UI renders as "not
 * set up" rather than as an error.
 */
create or replace function public.scheduled_job_status()
returns table (
  jobname     text,
  schedule    text,
  active      boolean,
  last_run    timestamptz,
  last_status text
) language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_manager() and auth.uid() is not null then
    raise exception 'Only a manager can view scheduled jobs';
  end if;

  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    return;
  end if;

  return query execute $q$
    select
      j.jobname::text,
      j.schedule::text,
      j.active,
      r.start_time,
      r.status::text
    from cron.job j
    left join lateral (
      select start_time, status
      from cron.job_run_details d
      where d.jobid = j.jobid
      order by start_time desc
      limit 1
    ) r on true
    where j.jobname like '559-%'
    order by j.jobname
  $q$;
end;
$$;

revoke all on function public.scheduled_job_status() from public, anon;
grant execute on function public.scheduled_job_status() to authenticated, service_role;

comment on function public.scheduled_job_status() is
  'What pg_cron is running for this studio, and how each job last finished. '
  'Empty when pg_cron is not enabled — the UI shows that as "not set up".';

-- ── 045_bookable_is_a_decision.sql ──

-- ============================================================
-- 559 Flawless — 045: going on the booking page is a decision, not a setting
--
-- `accepts_online_booking` decides whether a member of staff appears on the
-- public booking page as somebody a client can reserve time with. Since 001,
-- `profiles` has had an "update own profile" policy, and the escalation guard
-- next to it protects only `role` and `suspended_at`. So this column was
-- self-service: a front-desk hire could put themselves on the booking page.
--
-- In practice they would not have got far — a provider with no rows in
-- `provider_services` offers no services, so nobody can actually book them —
-- but they would appear in the public read of `profiles`, and "nearly harmless
-- because a second thing happens to be empty" is not a permission model.
--
-- The rule this installs is asymmetric on purpose, and it mirrors the reasoning
-- already written into 041 for `staff_profiles.is_public`:
--
--   Turning it ON  is an admin decision. Whether the studio offers this
--                  person's time to the public is the owner's call.
--   Turning it OFF anyone may do to themselves, at any time. Someone who is
--                  ill, leaving, or simply full should never have to find an
--                  admin to stop taking new bookings.
--
-- The same asymmetry as "you can always take your own face off a website".
-- ============================================================

create or replace function public.guard_bookable_flag()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.accepts_online_booking is not distinct from old.accepts_online_booking then
    return new;
  end if;

  -- auth.uid() is null for the service role, a scheduled job and the SQL
  -- editor — all already privileged, and the path 001 documents and permits.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  -- Switching yourself off is always allowed.
  if new.id = auth.uid() and not new.accepts_online_booking then
    return new;
  end if;

  if new.id = auth.uid() then
    raise exception
      'Ask an admin to put you on the booking page. You can take yourself off it at any time.';
  end if;

  raise exception 'Only an admin can change who appears on the booking page';
end;
$$;

drop trigger if exists profiles_guard_bookable on public.profiles;
create trigger profiles_guard_bookable
  before update of accepts_online_booking on public.profiles
  for each row execute function public.guard_bookable_flag();

comment on column public.profiles.accepts_online_booking is
  'Whether this person appears on the public booking page. Independent of role '
  '— a solo owner is an admin who also treats clients (see 020). Admin-only to '
  'turn on; anyone may turn their own off. Defaults to false: no role puts '
  'anybody on the public site.';
