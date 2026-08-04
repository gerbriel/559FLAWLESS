-- ============================================================
-- 559 Flawless — 058: an outage should not look like a quiet day
--
-- The audit that hardened this app found the same shape in dozens of places:
-- a database read fails, the code coalesces the missing rows to an empty
-- array, and the screen renders an authoritative nothing. The booking page
-- shows no open slots — indistinguishable from fully booked, silently costing
-- bookings. The staff Today page shows a day with no appointments — clients
-- standing at the door unexpected. And the only trace anywhere is a
-- console.error, which on Vercel's Hobby plan evaporates within about an hour.
-- When a client phones saying "booking failed", the studio has nothing.
--
-- Sentry would do this. It is also a dependency, an account, and a data
-- processor agreement for a single-room studio, when the durable shared store
-- this app already has — the same argument 057 made for the rate limiter — is
-- the database. The calendar sync already proved the pattern here:
-- `last_sync_error` is a column, not a log line, and it is the one failure
-- record in the app that has ever been readable a day later.
--
-- So: `app_errors`. A row per failure that matters, written by the server
-- through the one narrow function below, readable by managers on a Settings
-- page. Not a log — a short-lived incident record, capped and self-cleaning,
-- for the question "what went wrong around 2pm Tuesday when Maria said the
-- booking page was broken".
--
-- ── What is deliberately NOT recorded ────────────────────────
--
-- No IP addresses, no auth tokens, no request bodies. `context` carries ids —
-- an appointment id, a provider id, a route name — which are meaningless
-- outside this database and RLS-guarded inside it. The retention is 30 days,
-- enforced opportunistically on write exactly the way 057 cleans its buckets,
-- because an incident record old enough that nobody asked about it is just
-- surface area.
--
-- ── Who writes, who reads ────────────────────────────────────
--
-- Writes: the service role only, through log_app_error(). The function exists
-- rather than a bare insert so the write path is one place — it enforces the
-- length caps and does the cleanup — and so nothing client-side can ever mint
-- error rows, however creatively: EXECUTE is revoked from anon AND
-- authenticated. A browser has no business reporting server errors.
--
-- Reads: managers, via RLS. The rows can name guest emails in context (a
-- failed booking IS about somebody), so they are staff data, and the
-- narrowest staff audience that would act on them is the one that reads them.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

create table if not exists public.app_errors (
  id         bigserial primary key,
  /** Where it happened, as a stable name: 'api/book', 'stripe/webhook',
   *  'availability', 'calendar/push'. What the Settings page groups by. */
  scope      text not null,
  message    text not null,
  /** Ids and small facts, never bodies or credentials. */
  context    jsonb not null default '{}'::jsonb,
  /** Next's error digest when one exists, so a screenshot of the client-facing
   *  boundary can be matched to the server-side record. */
  digest     text,
  created_at timestamptz not null default now()
);

comment on table public.app_errors is
  'Short-lived incident records written by the server via log_app_error(). '
  'Thirty-day retention, self-cleaning. The answer to "what went wrong when '
  'the client phoned" now survives longer than Vercel''s hour of logs.';

create index if not exists app_errors_recent_idx
  on public.app_errors (created_at desc);
create index if not exists app_errors_scope_idx
  on public.app_errors (scope, created_at desc);

alter table public.app_errors enable row level security;

drop policy if exists "manager reads app errors" on public.app_errors;
create policy "manager reads app errors" on public.app_errors
  for select to authenticated using (public.is_manager());

-- No insert/update/delete policies: the service role bypasses RLS and is the
-- only writer, through the function below.
revoke all on public.app_errors from public, anon;
grant select on public.app_errors to authenticated;

create or replace function public.log_app_error(
  p_scope   text,
  p_message text,
  p_context jsonb default '{}'::jsonb,
  p_digest  text default null
) returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
begin
  -- Caps rather than refusals: a 100KB message becomes a 2KB one, because the
  -- error path must never itself error over tidiness.
  insert into public.app_errors (scope, message, context, digest)
  values (
    left(coalesce(p_scope, 'unknown'), 80),
    left(coalesce(p_message, '(no message)'), 2000),
    coalesce(p_context, '{}'::jsonb),
    left(p_digest, 120)
  );

  -- Opportunistic retention, 057's pattern: ~1% of writes sweep. random() is
  -- fine here — database plumbing, not app code under the determinism rules.
  if random() < 0.01 then
    delete from public.app_errors where created_at < now() - interval '30 days';
  end if;
end;
$$;

comment on function public.log_app_error(text, text, jsonb, text) is
  'The one write path into app_errors. Service role only — a browser has no '
  'business reporting server errors, so EXECUTE is revoked from anon and '
  'authenticated alike. Caps its inputs and sweeps 30-day retention itself.';

revoke all on function public.log_app_error(text, text, jsonb, text)
  from public, anon, authenticated;
grant execute on function public.log_app_error(text, text, jsonb, text) to service_role;
