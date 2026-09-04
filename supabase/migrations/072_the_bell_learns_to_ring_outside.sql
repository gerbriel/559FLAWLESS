-- ============================================================
-- 559 Flawless — 072: the bell learns to ring outside
--
-- Every notification in this system lands in the in-app bell and nowhere
-- else — which is honest for a client who visits, and silence for one who
-- does not. The app now mirrors notifications to email (Resend, when
-- RESEND_API_KEY is set; a silent no-op until then), and the mirror needs
-- one thing from the schema: a mark saying which rows have already gone out,
-- so a retry never sends twice and a backlog never floods anyone.
--
-- The backfill is the important line: every notification that exists today
-- was delivered in the in-app-only era and must NOT be emailed the moment
-- the key appears — a client would wake to thirty stale bells. Stamped as
-- already-handled; only rows born after this migration ride the mirror.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

alter table public.notifications
  add column if not exists emailed_at timestamptz;

comment on column public.notifications.emailed_at is
  'When the email mirror sent this row (072). Null = still owed an email; stamped on send, on permanent skip (no address), and by the backfill for the in-app-only era.';

update public.notifications
set emailed_at = created_at
where emailed_at is null;

create index if not exists notifications_unemailed_idx
  on public.notifications (created_at)
  where emailed_at is null;
