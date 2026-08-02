-- ============================================================
-- 559 Flawless — 042: saved custom reports
--
-- The custom report builder compiles a definition — subject, columns, filters,
-- grouping, sort — into a PostgREST query issued through the CALLER'S own
-- client. This table stores those definitions so a manager can come back to
-- "retail by channel, this quarter" without rebuilding it.
--
-- What a row here is NOT: it is not SQL, and it is never executed as SQL. The
-- `definition` jsonb is re-validated against the builder's allow-list on every
-- run (`sanitiseDefinition` in src/lib/reports/custom.ts), so a definition that
-- was hand-edited in the database to name a clinical column does not become a
-- clinical query — the unknown key is dropped before anything is compiled.
-- The stored shape is a convenience, not a privilege.
--
-- RLS therefore protects the definitions themselves (who may see whose saved
-- views), not the data they return. The data is still protected by the policies
-- on `appointments`, `orders`, `payments`, `expenses` and `client_records`,
-- exactly as it is everywhere else.
--
-- TYPES: `src/types/database.ts` needs
--   saved_reports: TableDef<SavedReport, [ToProfile<'saved_reports', 'created_by'>]>
-- Until it does, the table is reached through `reportsDb()` in
-- src/lib/reports/custom.ts, the same escape hatch 035 uses.
--
-- Re-runnable: every statement is guarded, so applying this twice is a no-op.
-- ============================================================

create table if not exists public.saved_reports (
  id          bigserial primary key,
  name        text not null,
  /**
   * The builder's definition. Validated on read, never trusted: see the note
   * above. Kept as jsonb rather than columns because the builder's shape is
   * still moving and a migration per new filter would be absurd.
   */
  definition  jsonb not null,
  /**
   * Visible to every manager rather than only its author. Saved views are how a
   * studio agrees on what a number means, so sharing is the useful default —
   * but it is opt-in, because a half-finished draft is not a house standard.
   */
  is_shared   boolean not null default false,
  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on table public.saved_reports is
  'Saved custom-report definitions. Never executed as SQL — re-validated '
  'against the builder allow-list on every run.';

-- A definition must be an object. A bare array or scalar would sail through
-- jsonb and then fail confusingly in the compiler.
alter table public.saved_reports drop constraint if exists saved_reports_definition_is_object;
alter table public.saved_reports
  add constraint saved_reports_definition_is_object
  check (jsonb_typeof(definition) = 'object');

alter table public.saved_reports drop constraint if exists saved_reports_name_not_blank;
alter table public.saved_reports
  add constraint saved_reports_name_not_blank
  check (length(btrim(name)) between 1 and 120);

-- The list is read as "mine and everyone's shared", newest first.
create index if not exists saved_reports_created_by_idx
  on public.saved_reports (created_by, created_at desc);
create index if not exists saved_reports_shared_idx
  on public.saved_reports (created_at desc) where is_shared;

-- ── Keep updated_at honest ───────────────────────────────────
create or replace function public.saved_reports_touch()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists saved_reports_touch on public.saved_reports;
create trigger saved_reports_touch
  before update on public.saved_reports
  for each row execute function public.saved_reports_touch();

-- ── RLS ──────────────────────────────────────────────────────
alter table public.saved_reports enable row level security;

-- Nothing here is readable by anon, and nothing is readable below manager. The
-- builder itself is a manager tool; a saved definition names the subjects and
-- filters the business reports on, which is not front-desk business.
drop policy if exists "saved_reports_select" on public.saved_reports;
create policy "saved_reports_select" on public.saved_reports
  for select to authenticated
  using (public.is_manager() and (is_shared or created_by = auth.uid()));

drop policy if exists "saved_reports_insert" on public.saved_reports;
create policy "saved_reports_insert" on public.saved_reports
  for insert to authenticated
  -- Authorship is not a claim the row gets to make about itself.
  with check (public.is_manager() and created_by = auth.uid());

drop policy if exists "saved_reports_update" on public.saved_reports;
create policy "saved_reports_update" on public.saved_reports
  for update to authenticated
  using (public.is_manager() and (created_by = auth.uid() or public.is_admin()))
  -- WITH CHECK repeats the USING test so an update cannot hand the row to
  -- someone else on its way past.
  with check (public.is_manager() and (created_by = auth.uid() or public.is_admin()));

drop policy if exists "saved_reports_delete" on public.saved_reports;
create policy "saved_reports_delete" on public.saved_reports
  for delete to authenticated
  using (public.is_manager() and (created_by = auth.uid() or public.is_admin()));

grant select, insert, update, delete on public.saved_reports to authenticated;
grant usage, select on sequence public.saved_reports_id_seq to authenticated;
