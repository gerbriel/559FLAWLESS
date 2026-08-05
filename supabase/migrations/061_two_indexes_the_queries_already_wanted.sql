-- ============================================================
-- 559 Flawless — 061: two indexes the queries already wanted
--
-- Nothing here changes behaviour; both statements exist because a query the
-- app already runs has no index that serves it, and each will scan its whole
-- table quietly until the tables are big enough for someone to notice.
--
-- ── The whole-studio calendar range read ─────────────────────
--
-- /dashboard/calendar reads, for front desk and up:
--
--     starts_at >= A and starts_at <= B and status <> 'cancelled'
--
-- with no provider filter. 004's appointments_upcoming_idx looks like it
-- serves this and does not: it is partial on `status in ('pending',
-- 'confirmed')`, and the calendar's predicate also admits checked_in,
-- completed and no_show — a partial index only answers queries whose
-- predicate it implies, so the planner cannot use it here and falls back to
-- scanning. The provider-first index (provider_id, starts_at) is no help when
-- there is no provider in the question.
--
-- A plain btree on starts_at answers the range for every status; the residual
-- `<> 'cancelled'` filter is cheap on the rows the range admits. The partial
-- index stays — availability's own reads match its predicate exactly.
--
-- ── The per-person read of analytics_events ──────────────────
--
-- 009 indexed created_at, path, session_id and event — every axis except who.
-- Nothing asked "this person's events" until now; 060's "client reads own
-- events" policy and the account interest card ask exactly that on every
-- account visit, and the client insights work reads it per profile. Without
-- an index each of those is a full scan of a table that only grows.
--
-- Partial on `user_id is not null` on purpose: most rows are anonymous, the
-- per-person questions can never match them, and the null majority would be
-- dead weight in the index.
--
-- Both guarded; running this twice changes nothing.
-- ============================================================

create index if not exists appointments_starts_at_idx
  on public.appointments (starts_at);

create index if not exists analytics_events_user_idx
  on public.analytics_events (user_id, created_at desc)
  where user_id is not null;
