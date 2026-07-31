-- ============================================================
-- 559 Flawless — 013: enable Realtime on messages + notifications
--
-- The client subscribes to INSERTs on `messages` (filtered to their thread) so
-- a reply from the other side appears without a manual refresh. Row-level
-- security is still enforced on the realtime stream — a client only receives
-- rows their SELECT policy would return, so internal notes never reach them.
--
-- `add table` errors if the table is already a member of the publication, so
-- each is guarded to keep the migration idempotent.
-- ============================================================

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'message_threads'
  ) then
    alter publication supabase_realtime add table public.message_threads;
  end if;

  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'notifications'
  ) then
    alter publication supabase_realtime add table public.notifications;
  end if;
end $$;
