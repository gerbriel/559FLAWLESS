-- ============================================================
-- 559 Flawless — 047: a notification is an offer to go somewhere
--
-- 007 built the inventory approval queue, and with it a trigger: every insert
-- into `inventory_change_requests` fans a notification out to the managers and
-- admins pointing at /dashboard/inventory/approvals, where they would review
-- what had been proposed.
--
-- 021 removed that workflow on purpose, and said why at length — the queue came
-- from united-metal-components, where a warehouse and an office are different
-- people with different authority, and here it is one or two people in one
-- room. Staff now write stock directly and managers are told after the fact.
-- 021 kept `inventory_change_requests` deliberately, because the rows in it are
-- a record of what was proposed and decided, and that record is worth having
-- even though the flow around it is gone.
--
-- What 021 did not do was take down the trigger. So the studio still has a
-- notification that announces a workflow which has not existed for
-- twenty-six migrations, and it announces it by handing over a link to a page
-- that was never built: src/app/dashboard/inventory holds page.tsx and nothing
-- else. NotificationBell renders `notifications.link` straight into a
-- <Link href> with no allow-list of any kind, so the bell offers the owner a
-- destination and the destination is a 404.
--
-- ── Why this drops the trigger instead of fixing the link ────
--
-- Repointing it at /dashboard/inventory would replace a link that fails with a
-- link that lies. That page shows current stock; it has no proposal on it and
-- no way to approve one, because approving things is exactly what 021 took
-- away. "Inventory change awaiting approval — click here" leading to a stock
-- count is worse than a broken link, because it looks like it worked.
--
-- There is nothing to repoint at, and that is the finding. A notification for a
-- flow that no longer exists should not be minted at all.
--
-- ── It is not already dead, it just looks it ─────────────────
--
-- Nothing in the application inserts into `inventory_change_requests` any more.
-- The name survives in src/ in exactly one place, src/types/database.ts, as a
-- table definition — no query reads it, no route writes it, and no screen
-- mentions the approvals path.
--
-- That is not the same as unreachable. 007's "staff files requests" INSERT
-- policy is still on the table, and 021 had no reason to remove it, so any
-- authenticated staff member talking to PostgREST directly still trips this
-- trigger and still mints the dead link. Deleting the trigger is what actually
-- stops it; the absence of a caller in our own code was never the guarantee.
--
-- (That policy is left exactly as it is. Whether a table kept for its history
-- should still accept new rows is a separate question from this one, and it is
-- not a question a migration about a broken link should answer.)
--
-- ── And the function goes with it ────────────────────────────
--
-- Less urgent than it first looks: a function returning `trigger` cannot be
-- called directly — Postgres refuses outside a trigger context, and PostgREST
-- does not expose it as an RPC — so this particular SECURITY DEFINER is not
-- the open door an ordinary one would be.
--
-- It goes anyway, for two reasons. It is the only thing left in the database
-- that knows the dead URL, and while it exists, restoring the bug is one
-- `create trigger` by someone who assumes a function that exists is a function
-- that is wanted. The table stays because its rows are a record. The machinery
-- that fed the removed workflow is not a record of anything.
--
-- ── The notifications already sent ───────────────────────────
--
-- Rows are sitting in `notifications` carrying that link, and they get three
-- defensible treatments: leave them, repoint them, or strip the link.
--
-- The title and the body stay untouched, because they are true. Someone did
-- propose a change and the managers were told about it, and that happened
-- whatever the studio does with the queue afterwards. Rewriting the text of a
-- notification would be falsifying a record, and this project does not do that
-- anywhere else either — it is the same instinct that keeps `body_snapshot` on
-- a consent signature.
--
-- The link is not part of that record. It is navigation, and it navigates
-- nowhere, so it is nulled out. NotificationBell already renders a notification
-- with no link as plain text rather than a dead anchor, so these degrade to
-- precisely what they are: a note that something happened once. Repointing was
-- rejected for the same reason as above — a link that arrives somewhere
-- unhelpful is not an improvement on a link that arrives nowhere.
--
-- The statement matches on the notification kind AND the exact link, so it
-- cannot reach the '/dashboard/inventory' notifications that adjust_stock has
-- minted since 021: those are type 'system', they point at a page that exists,
-- and they fail both halves of the predicate rather than one.
--
-- Nothing here needs src/types/database.ts regenerated. A trigger is not part
-- of a table's shape, the table itself is unchanged, and 'inventory_approval'
-- stays in the notification_type enum because the rows below still carry it.
--
-- Every statement is guarded; running this file twice does nothing the second
-- time.
-- ============================================================

-- The trigger first: the function cannot be dropped while something depends on
-- it, and dropping it with `cascade` would be asking the database to work out
-- what we meant.
drop trigger if exists inventory_requests_notify on public.inventory_change_requests;

drop function if exists public.inventory_request_notify();

-- Keep the text, drop the destination. Both halves of the predicate are
-- required: the kind alone would be too broad if this type is ever reused, and
-- the link alone would be too broad if anything else ever pointed there.
update public.notifications
set    link = null
where  type = 'inventory_approval'
  and  link = '/dashboard/inventory/approvals';

-- ── The same bug, on the side clients actually see ──────────
--
-- Auditing every link literal any migration mints found a second one, and it is
-- worse than the first because it is not internal. 038 seeds
-- `notification_templates.link_template` as '/booking' for two kinds:
--
--   waitlist_opening  "A spot has opened up"
--   rebooking_nudge   "Ready for your next {{service}}?"
--
-- The route is `/book`. There has never been a `/booking` — src/app/(public)
-- holds `book/`. So a client is told a cancellation freed the slot they have
-- been waiting weeks for, taps it, and gets a 404. That is the single worst
-- moment in the app to hand someone a broken page, and the notification is
-- doing its job perfectly right up until they touch it.
--
-- 038 renders `link_template` into `notification_queue.link` (~650) and inserts
-- that into `notifications.link` (~810), so the wrong value has been copied
-- forward into every row either table has produced. All three are corrected.
--
-- Repointing is right here and dropping was right above, for the same reason in
-- both cases: the test is whether a correct destination exists. For the
-- inventory approvals queue none did, because 021 removed the thing being
-- linked to. Here `/book` is exactly where the notification always meant to
-- send them, and the only defect is four characters.

update public.notification_templates
set    link_template = '/book'
where  link_template = '/booking';

update public.notification_queue
set    link = '/book'
where  link = '/booking';

update public.notifications
set    link = '/book'
where  link = '/booking';

-- The third copy, and the one the three UPDATEs above cannot reach.
-- `notify_waitlist_opening()` passes '/booking' as the `appointment_link`
-- template variable. Today no template interpolates it — the two that could
-- carry a link have the path literally, which is why fixing the seeds fixes the
-- symptom — so this is a landmine rather than a live fault: the moment somebody
-- puts {{appointment_link}} in the waitlist wording, the 404 is back and the
-- data fix will look like it never worked. Redeclared verbatim from 038 with
-- that one string corrected; nothing else about it changes.
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
      'appointment_link', '/book'
    ));
end;
$$;

comment on table public.inventory_change_requests is
  'Historical only. 021 replaced the approve-a-proposal workflow with direct '
  'stock edits and kept these rows as the record of what was proposed and '
  'decided; 047 removed the notification trigger that still fired on insert. '
  'Nothing in the application writes here.';
