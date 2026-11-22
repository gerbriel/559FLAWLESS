-- ============================================================
-- 559 Flawless — 084: book now, or when you are ready
--
-- Paying for a membership used to end on a thank-you line and nothing else.
-- The money was in, the visits were not, and nobody on either side had said
-- what happens next. A new member now answers one question straight after
-- Stripe hands them back: pick my dates now, or I will book when I am ready.
--
-- "Now" sends them into the booking flow with the membership in view. "Later"
-- is a perfectly good answer, but it is also the answer that quietly turns
-- into three months of paid-for facials nobody booked, and the studio wants to
-- see exactly that list: who said later and has not booked since. That is a
-- staff question answered by joining this table to appointments; this table
-- only records the answer.
--
-- One row per client, not per membership. The welcome page renders before the
-- webhook has necessarily enrolled anyone (Stripe's redirect and Stripe's
-- webhook race), so the answer cannot hang off a client_memberships id that
-- may not exist yet. It is the client's latest answer; answering again
-- overwrites it and moves decided_at.
--
-- RLS: a client reads and writes their own row only; staff read everyone's.
-- Nobody deletes through the API. Every statement is guarded; running this
-- twice changes nothing.
-- ============================================================

create table if not exists public.membership_booking_intents (
  client_id  uuid primary key references public.profiles(id) on delete cascade,
  intent     text not null check (intent in ('now', 'later')),
  decided_at timestamptz not null default now()
);

comment on table public.membership_booking_intents is
  'What a new member said straight after paying: book now, or book when ready '
  '(084). One row per client, the latest answer. Staff use it to find members '
  'who said later and have not booked.';

alter table public.membership_booking_intents enable row level security;

drop policy if exists "membership_booking_intents_select" on public.membership_booking_intents;
create policy "membership_booking_intents_select" on public.membership_booking_intents
  for select to authenticated
  using (client_id = auth.uid() or public.is_staff());

drop policy if exists "membership_booking_intents_insert" on public.membership_booking_intents;
create policy "membership_booking_intents_insert" on public.membership_booking_intents
  for insert to authenticated
  with check (client_id = auth.uid());

drop policy if exists "membership_booking_intents_update" on public.membership_booking_intents;
create policy "membership_booking_intents_update" on public.membership_booking_intents
  for update to authenticated
  using (client_id = auth.uid())
  with check (client_id = auth.uid());

revoke all on table public.membership_booking_intents from public, anon;
grant select, insert, update on table public.membership_booking_intents to authenticated;

-- decided_at is the database's clock, not the browser's. The column default
-- covers the first answer; an upsert that overwrites the row never reaches a
-- default, so this trigger stamps every insert and update. It also means a
-- client cannot backdate their own answer through the update policy.
create or replace function public.membership_booking_intent_stamp()
returns trigger language plpgsql set search_path = public as $$
begin
  new.decided_at := now();
  return new;
end;
$$;

drop trigger if exists membership_booking_intents_stamp on public.membership_booking_intents;
create trigger membership_booking_intents_stamp
  before insert or update on public.membership_booking_intents
  for each row execute function public.membership_booking_intent_stamp();
