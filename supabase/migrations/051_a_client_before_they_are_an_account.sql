-- ============================================================
-- 559 Flawless — 051: a client the studio knows, before they are an account
--
-- The studio has a client list on paper, or in whatever it used before this.
-- Some of those people have an email address and some do not — a walk-in who
-- gave a phone number, a regular of eight years who has never been asked, a
-- name and a note about their skin and nothing else. The importer refuses all
-- of them, and it refuses them for a real reason rather than a fussy one:
--
--     profiles.id uuid primary key references auth.users(id) on delete cascade
--
-- A profile IS an account. There is no such thing in this schema as a client
-- without a login, so "import a client with no email" is not a validation rule
-- anyone chose — it is the shape of the table. The importer says so plainly and
-- then rejects the row, which is honest and useless: the studio has the person
-- in front of them and nowhere to put them.
--
-- The tempting fix is to mint an auth user with a made-up address —
-- someone+1739@studio.invalid — and it is worse than doing nothing. It puts a
-- lie in `profiles.email`, which is the column `appointment_match_client` (004)
-- matches guests on, so the next time that person books as a guest with their
-- real address the studio gets a second record and the duplicate this migration
-- exists to prevent arrives by the door it was meant to close.
--
-- ── What this adds ──────────────────────────────────────────
--
-- `client_stubs`: someone the studio knows, with no account. A name, whatever
-- contact details exist, and notes. It is deliberately NOT a profile and
-- deliberately holds no clinical record — `client_records`, `client_notes`,
-- `intake_submissions` and `consent_signatures` all key to a profile and stay
-- that way, because health information belongs to a person who has consented
-- to it being held, not to a row somebody pasted out of a spreadsheet.
--
-- A stub is a contact and an intention. It is the answer to "who do I still
-- need to get into the system", and its whole life is to stop being a stub.
--
-- ── How it stops being one ──────────────────────────────────
--
-- `invitations.client_stub_id` points an invitation at the stub it is for. When
-- that invitation is accepted, `claim_client_stub()` marks the stub claimed by
-- the new profile and copies across anything the profile is missing — a phone
-- number the studio had and the signup form did not ask for.
--
-- The claim is what makes this worth building. Without it, inviting an imported
-- client produces a second record beside the first and the studio is back to
-- reconciling two lists by hand, which is the thing the import was for.
--
-- ── Why the stub is not merged INTO, and holds no history ───
--
-- No appointment, order or payment can reference a stub. Every one of those
-- tables keys to `profiles` or carries the guest columns 004 already gave them,
-- and adding a third possibility to the booking engine would mean every query
-- that asks "whose appointment is this" gaining a second branch — including the
-- exclusion constraint's neighbourhood, which is the last place in this schema
-- anyone should be adding cases.
--
-- So a stub is a contact record and nothing else, and claiming one is a claim,
-- not a migration of history. If the studio books somebody who is still a stub,
-- they book them as a guest exactly as they do today, and 004's matcher ties
-- that visit to the real profile the moment one exists. The two mechanisms
-- already compose; this one does not need to know about that one.
--
-- ── Matching, so a stub cannot become the duplicate ─────────
--
-- A stub with an email that already belongs to a profile is a stub that should
-- never have been created, so a trigger refuses it. The same for a stub
-- duplicating another stub. Both use the rule `appointment_match_client` has
-- used since 004 — email first, case-insensitively; then phone on digits alone,
-- and only when there are at least ten of them — because a second answer to
-- "is this the same person" is how a client list grows two of everybody.
--
-- A stub with NEITHER an email nor a phone is allowed. That is the case the
-- whole migration is for, and there is nothing to match it on; two of them are
-- two different people until somebody says otherwise.
--
-- Every statement is guarded. Running this twice does nothing the second time.
-- ============================================================

create table if not exists public.client_stubs (
  id         bigserial primary key,

  first_name text not null,
  last_name  text,
  email      text,
  phone      text,

  /** Free text the studio pasted in — allergies noted on paper, preferences,
   *  "always books with Linda". NOT clinical: see the header. */
  note       text,

  /** Where it came from, so an import can be reviewed or undone as a batch. */
  source     text not null default 'manual',
  /** Set by the importer to the id of the run that created the row. Null for
   *  anything typed in by hand. */
  import_batch text,

  /** The profile that claimed this stub. Once set, the stub is history. */
  claimed_by uuid references public.profiles(id) on delete set null,
  claimed_at timestamptz,

  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.client_stubs is
  'Somebody the studio knows who has no account. A contact record and an '
  'intention, not a profile: no clinical data, no appointments, no money. It '
  'exists so an imported client with no email address can be held somewhere '
  'until an invitation turns them into a real profile, and claimed rather than '
  'duplicated when it does.';

alter table public.client_stubs drop constraint if exists client_stubs_name_present;
alter table public.client_stubs
  add constraint client_stubs_name_present
  check (length(btrim(first_name)) between 1 and 120);

alter table public.client_stubs drop constraint if exists client_stubs_source_known;
alter table public.client_stubs
  add constraint client_stubs_source_known
  check (source in ('manual', 'import', 'walk_in'));

-- Claimed is a pair: both or neither. A stub with a claimant and no timestamp
-- is a row nobody can reason about later.
alter table public.client_stubs drop constraint if exists client_stubs_claim_is_whole;
alter table public.client_stubs
  add constraint client_stubs_claim_is_whole
  check ((claimed_by is null) = (claimed_at is null));

-- Only UNCLAIMED stubs are unique on contact details. A claimed one is history
-- and history is allowed to contain the address the profile now holds.
create unique index if not exists client_stubs_unclaimed_email_idx
  on public.client_stubs (lower(btrim(email)))
  where claimed_by is null and email is not null and btrim(email) <> '';

create index if not exists client_stubs_open_idx
  on public.client_stubs (created_at desc) where claimed_by is null;
create index if not exists client_stubs_batch_idx
  on public.client_stubs (import_batch) where import_batch is not null;

drop trigger if exists client_stubs_touch on public.client_stubs;
create trigger client_stubs_touch before update on public.client_stubs
  for each row execute function public.touch_updated_at();

-- ── A stub must not be a person the studio already has ───────
create or replace function public.client_stub_is_not_a_duplicate()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  digits text;
  clash  uuid;
begin
  -- A claimed stub is history; nothing about it needs re-checking.
  if new.claimed_by is not null then
    return new;
  end if;

  new.email := nullif(btrim(new.email), '');
  new.phone := nullif(btrim(new.phone), '');
  digits := nullif(regexp_replace(coalesce(new.phone, ''), '\D', '', 'g'), '');

  if new.email is not null then
    select p.id into clash from public.profiles p
    where lower(p.email) = lower(new.email) limit 1;
    if clash is not null then
      raise exception
        'That email address already belongs to a client account — open them instead of adding them again'
        using errcode = '23505';
    end if;
  end if;

  -- Phone is the fallback match, and only when there are enough digits to mean
  -- anything. Same rule as appointment_match_client (004).
  if digits is not null and length(digits) >= 10 then
    select p.id into clash from public.profiles p
    where regexp_replace(coalesce(p.phone, ''), '\D', '', 'g') = digits limit 1;
    if clash is not null then
      raise exception
        'That phone number already belongs to a client account — open them instead of adding them again'
        using errcode = '23505';
    end if;

    if exists (
      select 1 from public.client_stubs s
      where s.claimed_by is null
        and s.id is distinct from new.id
        and regexp_replace(coalesce(s.phone, ''), '\D', '', 'g') = digits
    ) then
      raise exception 'That phone number is already on the list to invite'
        using errcode = '23505';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists client_stubs_not_a_duplicate on public.client_stubs;
create trigger client_stubs_not_a_duplicate
  before insert or update of email, phone on public.client_stubs
  for each row execute function public.client_stub_is_not_a_duplicate();

-- ── The invitation that turns one into an account ────────────
alter table public.invitations
  add column if not exists client_stub_id bigint
    references public.client_stubs(id) on delete set null;

comment on column public.invitations.client_stub_id is
  'The client_stub this invitation is for, when it was sent to somebody the '
  'studio already had on its list. Accepting it claims that stub rather than '
  'creating a second record for the same person.';

create index if not exists invitations_stub_idx
  on public.invitations (client_stub_id) where client_stub_id is not null;

/**
 * Claim a stub for a profile.
 *
 * Called when an invitation carrying a stub is accepted. Idempotent: a stub
 * already claimed by this profile returns quietly, so a retried acceptance
 * cannot fail the signup it is part of.
 *
 * Fills in what the profile is missing rather than overwriting it. The signup
 * form is the person telling the studio who they are; the stub is the studio's
 * older note about them. When they disagree, the person wins.
 */
create or replace function public.claim_client_stub(
  p_stub bigint,
  p_profile uuid
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  stub record;
begin
  select * into stub from public.client_stubs where id = p_stub for update;
  if not found then
    return null;
  end if;

  if stub.claimed_by is not null then
    -- Already claimed by this person: nothing to do. Claimed by somebody else:
    -- refuse, because that is two people being told they are the same one.
    if stub.claimed_by = p_profile then
      return stub.id;
    end if;
    raise exception 'That client has already been claimed by another account';
  end if;

  update public.profiles p
  set first_name = coalesce(nullif(btrim(p.first_name), ''), stub.first_name),
      last_name  = coalesce(nullif(btrim(p.last_name), ''),  stub.last_name),
      phone      = coalesce(nullif(btrim(p.phone), ''),      stub.phone)
  where p.id = p_profile;

  update public.client_stubs
  set claimed_by = p_profile, claimed_at = now()
  where id = p_stub;

  return p_stub;
end;
$$;

revoke all on function public.claim_client_stub(bigint, uuid) from public, anon;
grant execute on function public.claim_client_stub(bigint, uuid) to service_role;

comment on function public.claim_client_stub(bigint, uuid) is
  'Tie an imported client to the account that just accepted their invitation. '
  'service_role only: it is called from the invitation acceptance path, which '
  'has already proved the token, and it writes to a profile.';

-- ── RLS ──────────────────────────────────────────────────────
--
-- Staff read the list; front desk and up maintain it. A client never sees it:
-- it is the studio's list of people it has not signed up yet, and one row of it
-- is somebody else's name and phone number.
alter table public.client_stubs enable row level security;

drop policy if exists "staff read client stubs" on public.client_stubs;
create policy "staff read client stubs" on public.client_stubs
  for select to authenticated using (public.is_staff());

drop policy if exists "front desk writes client stubs" on public.client_stubs;
create policy "front desk writes client stubs" on public.client_stubs
  for all to authenticated
  using (public.is_front_desk()) with check (public.is_front_desk());

grant select, insert, update, delete on public.client_stubs to authenticated;
grant usage, select on sequence public.client_stubs_id_seq to authenticated;
