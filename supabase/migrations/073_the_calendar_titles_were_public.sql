-- ============================================================
-- 559 Flawless — 073: the calendar titles were public
--
-- 003 made `calendar_busy` publicly readable, back when it held bare windows
-- and the availability engine read it as the visitor. 027 added `summary` —
-- the TITLE of the provider's own Google event, which in practice is a
-- client's name — and wrote the staff-only policy that should have replaced
-- the public one. It did not DROP it, and permissive policies OR together:
-- verified 2026-09-05, the anon key read personal event titles straight off
-- the REST API.
--
-- Nothing public reads this table anymore — availability is computed
-- server-side (booking.ts, admin client) and every UI reader is a staff
-- session under 027's policy. The visitor's view of busy time is, as it
-- always should have been: a slot that simply is not offered.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

drop policy if exists "public read busy" on public.calendar_busy;

revoke all on public.calendar_busy from public, anon;
