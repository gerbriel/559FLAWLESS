-- ============================================================
-- 559 Flawless — 057: the till never queues, but strangers do
--
-- Two routes accept POSTs from anyone on the internet: /api/book, which prices
-- services, checks availability and inserts an appointment, and
-- /api/newsletter, which inserts a subscriber. Nothing limits either. A script
-- can fill the diary with pending bookings overnight — approval mode makes the
-- damage worse, because every one of them lands in the review queue and pings
-- the provider — or grow the newsletter table by a million rows for the cost
-- of a loop. /api/availability is read-only but priced per call, and
-- /api/invitations/accept is where an invitation token would be brute-forced
-- from, if anywhere.
--
-- ── Why the limiter lives in Postgres ────────────────────────
--
-- The app runs on Vercel serverless. An in-memory counter dies with the
-- instance and lies across concurrent ones — under real load, exactly when a
-- limiter matters, every instance would be counting its own private view of
-- "how many requests has this address made". There is no Redis here and no
-- appetite for a new paid dependency. The one store every invocation already
-- shares is the database, so the window counter goes there, and the whole
-- check is a single upsert:
--
--     insert ... on conflict (key, window_start) do update
--       set count = rate_limits.count + 1 returning count
--
-- One statement, atomic under the primary key, so two concurrent requests
-- cannot both read 9 and both write 10 — the conflict target serialises them.
--
-- ── What the caller must do with the answer ──────────────────
--
-- FAIL OPEN. This function answers a question; it must never be the reason a
-- booking is refused. The TypeScript caller treats any error — function
-- missing because this migration has not run yet, database briefly away — as
-- "allowed", loudly logged. A broken limiter that turns clients away is a
-- worse failure than the abuse it guards against, which is throttled traffic,
-- not stolen money. The routes deploy before the studio runs this file; that
-- window MUST degrade to open, and does.
--
-- ── Retention ────────────────────────────────────────────────
--
-- Keys are derived from client IP addresses. This studio has already treated
-- an IP leaving the building as an incident (signup once disclosed IPs to
-- ipify and it was removed), so the buckets are deliberately short-lived: an
-- opportunistic delete inside the function clears anything older than a day.
-- random() gates it to roughly 1% of calls so no cron is needed — and random()
-- is fine HERE because this is database plumbing, not application code under
-- the determinism rules.
--
-- RLS is enabled with NO policies: the table is unreachable except through
-- the definer function, which anon must be able to execute — limiting
-- strangers is the entire point, and a stranger is anon.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

create table if not exists public.rate_limits (
  key          text not null,
  window_start timestamptz not null,
  count        int not null default 1,
  primary key (key, window_start)
);

comment on table public.rate_limits is
  'Fixed-window request counters, keyed by (caller, window). Reached only '
  'through check_rate_limit(); no policies on purpose. Buckets are cleared '
  'after a day by the function itself — the keys derive from IP addresses and '
  'are not kept longer than the window needs.';

alter table public.rate_limits enable row level security;

revoke all on public.rate_limits from public, anon, authenticated;

create or replace function public.check_rate_limit(
  p_key            text,
  p_limit          int,
  p_window_seconds int
) returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  bucket timestamptz;
  hits   int;
begin
  -- Refuse nonsense rather than divide by it. A caller passing garbage gets
  -- "allowed" — fail open is the contract — but a zero window would make every
  -- bucket distinct and the limiter a no-op that looks alive.
  if p_key is null or p_limit is null or p_limit < 1
     or p_window_seconds is null or p_window_seconds < 1 then
    return true;
  end if;

  -- The bucket is a floor over epoch seconds: not a schedule, not wall-clock
  -- anywhere, so the studio's timezone rules do not apply to it.
  bucket := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );

  insert into public.rate_limits as rl (key, window_start, count)
  values (left(p_key, 128), bucket, 1)
  on conflict (key, window_start)
  do update set count = rl.count + 1
  returning count into hits;

  -- Opportunistic cleanup, ~1% of calls. Cheap: the PK's leading column is not
  -- useful here, but the table only ever holds a day of buckets for a handful
  -- of routes, so a scan of it is small by construction.
  if random() < 0.01 then
    delete from public.rate_limits where window_start < now() - interval '1 day';
  end if;

  return hits <= p_limit;
end;
$$;

comment on function public.check_rate_limit(text, int, int) is
  'One atomic upsert per request: true while the caller is inside its budget '
  'for the current window, false once over it. Fails open on bad arguments. '
  'The TypeScript caller (src/lib/rate-limit.ts) also fails open on any error, '
  'so this function being absent — the deploy-before-migrate window — degrades '
  'to no limiting rather than to refused bookings.';

revoke all on function public.check_rate_limit(text, int, int) from public;
grant execute on function public.check_rate_limit(text, int, int)
  to anon, authenticated, service_role;
