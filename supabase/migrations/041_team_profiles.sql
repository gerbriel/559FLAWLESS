-- ============================================================
-- 559 Flawless — 041: team member profiles
--
-- `profiles` already carries display_name, slug, bio, avatar_url and
-- accepts_online_booking (001, 020). That is enough to render a name on the
-- booking step and nothing more. A profile — the thing a client reads before
-- deciding who is going to be alone in a room with them — needs specialities,
-- languages, training, a photograph and a considered biography. A studio also
-- needs the other half: what licence this person holds, when it expires, who to
-- call if something happens on the floor.
--
-- Those two halves have opposite audiences, and that is what shapes this
-- migration.
--
-- ── Why three tables and not one wide one ────────────────────
--
-- Row-level security is row-level. Once a policy lets a role SELECT a row, that
-- role reads every column of it. So "the internet may read the biography but
-- not the emergency contact" is not expressible as a policy on a single table —
-- it can only be expressed by the application remembering to name its columns,
-- and an application that must remember is an application that will one day
-- forget. One `select('*')` in a future team page, and a licence number and a
-- next-of-kin phone number are on the public internet.
--
-- A view will not save this either. A Postgres view runs as its OWNER unless
-- created `with (security_invoker = on)`, and migration 028 dropped exactly
-- such a view after it turned out to be handing every signed-in client the
-- whole user list. Read the comment at the top of 028 before reaching for one
-- here.
--
-- So the split is physical, and each table has exactly one rule:
--
--   staff_profiles     the page a client sees.   anon may read (when opted in).
--   staff_credentials  licensure.                the person + managers.
--   staff_employment   HR.                       managers only.
--
-- The public table is a *publication*, not a mirror: it carries its own
-- display_name and slug so the public team page never reads `profiles` at all.
-- Nothing about who else can see a staff member's email, phone or date of birth
-- changes as a result of this migration.
--
-- Table-level GRANTs back the policies up at the bottom of this file. `anon`
-- has no SELECT privilege whatsoever on the two private tables, so a mistake in
-- a policy is still not a leak.
-- ============================================================

-- ── Is this person still someone we would list? ──────────────
--
-- SECURITY DEFINER on purpose. A policy's subquery is itself subject to RLS, so
-- an inline `exists (select 1 from profiles …)` would be evaluated under the
-- caller's own restricted view of `profiles` — under which `anon` sees only
-- bookable providers. A front-desk lead who opted into the team page would then
-- silently vanish from it. Asking the question through a definer function makes
-- the answer the same for everyone; it returns a boolean and nothing else.
create or replace function public.is_listable_staff(p_profile_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = p_profile_id
      and role <> 'client'
      and suspended_at is null
  );
$$;

comment on function public.is_listable_staff(uuid) is
  'Whether a profile is still staff and unsuspended. Used by the public team '
  'policy so that demoting or suspending someone removes them from the website '
  'immediately, without anyone having to remember to untick a box.';

-- ── 1. The public half ───────────────────────────────────────

create table if not exists public.staff_profiles (
  profile_id     uuid primary key references public.profiles(id) on delete cascade,

  -- The one deliberate act. Default false: nobody is published because a row
  -- appeared, only because they said yes.
  is_public      boolean not null default false,

  -- Identity is duplicated here rather than joined from `profiles`, so that the
  -- public team page reads this table and only this table. A denormalised name
  -- is a small price for a public surface with no path back to a row holding a
  -- date of birth.
  display_name   text not null,
  slug           text not null unique,

  headline       text,          -- one line under the name
  bio            text,          -- the long version; profiles.bio stays the booking blurb
  pronouns       text,          -- as they wish to be shown, independent of profiles.pronouns
  photo_url      text,

  -- Professional, and public: this is what a client is choosing on.
  specialities   text[] not null default '{}',
  certifications text[] not null default '{}',
  languages      text[] not null default '{}',
  years_experience int,

  instagram_url  text,
  tiktok_url     text,
  website_url    text,

  sort_order     int not null default 0,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint staff_profiles_slug_shape
    check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length(slug) between 2 and 60),
  constraint staff_profiles_display_name_present
    check (length(trim(display_name)) between 1 and 80),
  constraint staff_profiles_headline_length check (headline is null or length(headline) <= 140),
  constraint staff_profiles_bio_length      check (bio is null or length(bio) <= 4000),
  constraint staff_profiles_pronouns_length check (pronouns is null or length(pronouns) <= 40),
  -- Years, not decades of them. A typo that says 300 years of experience is a
  -- typo that reaches the public site.
  constraint staff_profiles_years_sane
    check (years_experience is null or years_experience between 0 and 70),
  -- Lists, not essays. Keeps the cards on the team page comparable.
  constraint staff_profiles_specialities_bounded
    check (coalesce(array_length(specialities, 1), 0) <= 12),
  constraint staff_profiles_certifications_bounded
    check (coalesce(array_length(certifications, 1), 0) <= 12),
  constraint staff_profiles_languages_bounded
    check (coalesce(array_length(languages, 1), 0) <= 8),
  -- https only. These render as links on a page anyone can reach, and a
  -- javascript: or data: URL in a social field is a stored XSS.
  constraint staff_profiles_instagram_url
    check (instagram_url is null or (instagram_url ~ '^https://' and length(instagram_url) <= 300)),
  constraint staff_profiles_tiktok_url
    check (tiktok_url is null or (tiktok_url ~ '^https://' and length(tiktok_url) <= 300)),
  constraint staff_profiles_website_url
    check (website_url is null or (website_url ~ '^https://' and length(website_url) <= 300)),
  -- Either a remote asset over https, or something served from this app.
  constraint staff_profiles_photo_url
    check (photo_url is null or (photo_url ~ '^(https://|/)' and length(photo_url) <= 500))
);

create index if not exists staff_profiles_public_idx
  on public.staff_profiles (sort_order, display_name) where is_public;

drop trigger if exists staff_profiles_touch on public.staff_profiles;
create trigger staff_profiles_touch
  before update on public.staff_profiles
  for each row execute function public.touch_updated_at();

-- ── 2. Licensure ─────────────────────────────────────────────
--
-- Separate from HR because the audience is different: an esthetician must be
-- able to see her own licence and its expiry — she is the one who has to renew
-- it — but has no business reading her own personnel file.

create table if not exists public.staff_credentials (
  profile_id     uuid primary key references public.profiles(id) on delete cascade,

  licence_number text,
  licence_type   text,
  licence_state  text not null default 'CA',
  licence_issued_on  date,
  licence_expires_on date,

  -- Someone checked it against the state board. A date, not a boolean, because
  -- "verified in 2019" and "verified last week" are different facts.
  verified_at    timestamptz,
  verified_by    uuid references public.profiles(id) on delete set null,

  -- Bookkeeping for notify_expiring_licences(); see below. Not settings.
  expiry_reminder_stage int,
  expiry_reminded_at    timestamptz,

  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint staff_credentials_number_length
    check (licence_number is null or length(trim(licence_number)) between 2 and 40),
  constraint staff_credentials_state_shape
    check (licence_state ~ '^[A-Z]{2}$'),
  constraint staff_credentials_type_known
    check (licence_type is null or licence_type in (
      'esthetician', 'cosmetologist', 'nail_technician',
      'barber', 'electrologist', 'instructor', 'other'
    )),
  constraint staff_credentials_dates_ordered
    check (licence_issued_on is null or licence_expires_on is null
           or licence_expires_on >= licence_issued_on)
);

-- The expiry sweep reads only rows that have a date, and orders by it.
create index if not exists staff_credentials_expiry_idx
  on public.staff_credentials (licence_expires_on)
  where licence_expires_on is not null;

drop trigger if exists staff_credentials_touch on public.staff_credentials;
create trigger staff_credentials_touch
  before update on public.staff_credentials
  for each row execute function public.touch_updated_at();

-- A renewed licence starts a clean reminder cycle. Without this, someone who
-- was warned at 14 days and then renewed for two years would never be warned
-- again — the stored stage would already be tighter than anything the new date
-- could produce.
create or replace function public.staff_credentials_reset_reminders()
returns trigger language plpgsql as $$
begin
  if new.licence_expires_on is distinct from old.licence_expires_on then
    new.expiry_reminder_stage := null;
    new.expiry_reminded_at    := null;
  end if;
  return new;
end;
$$;

drop trigger if exists staff_credentials_reset_reminders on public.staff_credentials;
create trigger staff_credentials_reset_reminders
  before update of licence_expires_on on public.staff_credentials
  for each row execute function public.staff_credentials_reset_reminders();

-- ── 3. HR ────────────────────────────────────────────────────
--
-- Managers only, including on your own row. An employment record is a record
-- the studio keeps ABOUT someone; letting the subject edit their own start
-- date, classification or the notes written about them would make it evidence
-- of nothing. The emergency contact sits here for the same reason it sits in a
-- personnel file: it is used by whoever is holding the room when its owner
-- cannot answer for themselves.

create table if not exists public.staff_employment (
  profile_id      uuid primary key references public.profiles(id) on delete cascade,

  started_on      date,
  ended_on        date,
  -- Booth renter matters in this trade specifically: a renter is not an
  -- employee, and the studio's obligations differ.
  employment_type text,

  emergency_contact_name         text,
  emergency_contact_phone        text,
  emergency_contact_relationship text,

  internal_notes  text,

  updated_by      uuid references public.profiles(id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  constraint staff_employment_type_known
    check (employment_type is null or employment_type in (
      'employee', 'independent_contractor', 'booth_renter', 'apprentice', 'owner'
    )),
  constraint staff_employment_dates_ordered
    check (started_on is null or ended_on is null or ended_on >= started_on),
  constraint staff_employment_contact_lengths
    check ((emergency_contact_name is null or length(emergency_contact_name) <= 120)
       and (emergency_contact_phone is null or length(emergency_contact_phone) <= 40)
       and (emergency_contact_relationship is null or length(emergency_contact_relationship) <= 60)),
  constraint staff_employment_notes_length
    check (internal_notes is null or length(internal_notes) <= 8000)
);

drop trigger if exists staff_employment_touch on public.staff_employment;
create trigger staff_employment_touch
  before update on public.staff_employment
  for each row execute function public.touch_updated_at();

-- ── Slugs ────────────────────────────────────────────────────
/**
 * A url-safe handle for /team/<slug>, unique across the table.
 *
 * Derived once, at the moment a staff row first appears, and never re-derived:
 * a published URL that changes because someone corrected the spelling of their
 * own name is a broken link and a lost search ranking. Renaming is possible —
 * the column is editable — it just is not automatic.
 */
create or replace function public.staff_profile_slug(p_name text, p_profile_id uuid)
returns text language plpgsql stable set search_path = public as $$
declare
  base      text;
  candidate text;
  n         int := 1;
begin
  base := lower(coalesce(nullif(trim(p_name), ''), ''));
  base := regexp_replace(base, '[^a-z0-9]+', '-', 'g');
  base := trim(both '-' from base);
  base := left(base, 50);

  -- Nothing usable in the name (initials only, non-latin script, empty). The
  -- uuid prefix is ugly but it is a working URL, and it can be edited.
  if base = '' or length(base) < 2 then
    base := 'team-' || left(replace(p_profile_id::text, '-', ''), 8);
  end if;

  candidate := base;
  while exists (
    select 1 from public.staff_profiles s
    where s.slug = candidate and s.profile_id <> p_profile_id
  ) loop
    n := n + 1;
    candidate := left(base, 55) || '-' || n;
  end loop;

  return candidate;
end;
$$;

/**
 * Every staff member gets a (private, unpublished) profile row the moment they
 * become staff, so the dashboard editor has something to open and the studio
 * can see at a glance who has filled theirs in. Publishing stays a decision.
 */
create or replace function public.ensure_staff_profile()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  name text;
begin
  if new.role = 'client' then
    return null;
  end if;

  name := coalesce(
    nullif(trim(coalesce(new.display_name, '')), ''),
    nullif(trim(coalesce(new.first_name, '') || ' ' || coalesce(new.last_name, '')), ''),
    'Team member'
  );

  insert into public.staff_profiles (profile_id, display_name, slug)
  values (new.id, name, public.staff_profile_slug(name, new.id))
  on conflict (profile_id) do nothing;

  return null;
end;
$$;

drop trigger if exists profiles_ensure_staff_profile on public.profiles;
create trigger profiles_ensure_staff_profile
  after insert or update of role on public.profiles
  for each row execute function public.ensure_staff_profile();

-- Backfill whoever is already staff. Idempotent by way of the conflict clause.
insert into public.staff_profiles (profile_id, display_name, slug)
select
  p.id,
  coalesce(
    nullif(trim(coalesce(p.display_name, '')), ''),
    nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
    'Team member'
  ),
  public.staff_profile_slug(
    coalesce(
      nullif(trim(coalesce(p.display_name, '')), ''),
      nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
      'Team member'
    ),
    p.id
  )
from public.profiles p
where p.role <> 'client'
on conflict (profile_id) do nothing;

-- ── RLS ──────────────────────────────────────────────────────

alter table public.staff_profiles    enable row level security;
alter table public.staff_credentials enable row level security;
alter table public.staff_employment  enable row level security;

-- staff_profiles: the only one of the three the internet can see, and then only
-- the rows that asked to be seen and still belong to unsuspended staff.
drop policy if exists "public reads listed team members" on public.staff_profiles;
create policy "public reads listed team members" on public.staff_profiles
  for select to anon, authenticated
  using (is_public and public.is_listable_staff(profile_id));

drop policy if exists "staff reads team profiles" on public.staff_profiles;
create policy "staff reads team profiles" on public.staff_profiles
  for select using (public.is_staff());

-- Your own page is yours, including whether it is published at all: a person
-- can always take their own photograph and biography off a public website.
drop policy if exists "staff writes own team profile" on public.staff_profiles;
create policy "staff writes own team profile" on public.staff_profiles
  for update
  using (profile_id = auth.uid() and public.is_staff())
  with check (profile_id = auth.uid() and public.is_staff());

drop policy if exists "manager writes any team profile" on public.staff_profiles;
create policy "manager writes any team profile" on public.staff_profiles
  for update using (public.is_manager()) with check (public.is_manager());

drop policy if exists "staff creates own team profile" on public.staff_profiles;
create policy "staff creates own team profile" on public.staff_profiles
  for insert with check (
    public.is_manager()
    or (profile_id = auth.uid() and public.is_staff())
  );

drop policy if exists "manager deletes team profile" on public.staff_profiles;
create policy "manager deletes team profile" on public.staff_profiles
  for delete using (public.is_manager());

-- staff_credentials: yours to read, a manager's to record. No `to anon` clause
-- exists anywhere on this table, and anon holds no privilege on it either.
drop policy if exists "staff reads own credentials" on public.staff_credentials;
create policy "staff reads own credentials" on public.staff_credentials
  for select using (profile_id = auth.uid() or public.is_manager());

drop policy if exists "manager writes credentials" on public.staff_credentials;
create policy "manager writes credentials" on public.staff_credentials
  for all using (public.is_manager()) with check (public.is_manager());

-- staff_employment: managers, full stop — including the subject's own row.
drop policy if exists "manager reads employment" on public.staff_employment;
create policy "manager reads employment" on public.staff_employment
  for select using (public.is_manager());

drop policy if exists "manager writes employment" on public.staff_employment;
create policy "manager writes employment" on public.staff_employment
  for all using (public.is_manager()) with check (public.is_manager());

-- ── Privileges ───────────────────────────────────────────────
--
-- Belt and braces. Supabase grants broadly to `anon` and `authenticated` by
-- default and leaves RLS to do the filtering; here the private tables are taken
-- away from `anon` at the privilege level as well, so a future policy written
-- in haste still cannot put a licence number or a next-of-kin phone number on
-- the public internet. There is no combination of `select` and `to anon` that
-- gets past a missing GRANT.

grant select on public.staff_profiles to anon;
grant select, insert, update on public.staff_profiles to authenticated;
grant all on public.staff_profiles to service_role;

revoke all on public.staff_credentials from anon;
grant select, insert, update, delete on public.staff_credentials to authenticated;
grant all on public.staff_credentials to service_role;

revoke all on public.staff_employment from anon;
grant select, insert, update, delete on public.staff_employment to authenticated;
grant all on public.staff_employment to service_role;

-- ── Licence expiry ───────────────────────────────────────────
--
-- An esthetician working on a lapsed licence is not a paperwork problem, it is
-- an unlicensed treatment: uninsured, and in California a citable offence for
-- the establishment as much as the individual. Nobody notices a date in a
-- database, so the database has to speak up.

/**
 * How a licence stands today, as a single word.
 *
 * `expired` | `expires_soon` (inside 60 days) | `valid` | `unknown` (no date on
 * file, which is its own kind of problem and is surfaced as such).
 */
create or replace function public.licence_status(p_expires_on date, p_soon_days int default 60)
returns text language sql immutable as $$
  select case
    when p_expires_on is null then 'unknown'
    when p_expires_on < current_date then 'expired'
    when p_expires_on <= current_date + greatest(p_soon_days, 0) then 'expires_soon'
    else 'valid'
  end;
$$;

/**
 * Warn about licences that are running out, once per threshold crossed.
 *
 * Thresholds are 60, 30, 14 and 7 days, then expiry itself. The tightest stage
 * already sent is stored on the row, so this is safe to run every day: a
 * licence 45 days out has already had its 60-day warning and gets nothing
 * further until it crosses 30. Renewing clears the record (see
 * staff_credentials_reset_reminders), so the next cycle starts fresh.
 *
 * Two audiences, deliberately. The holder is told because they are the only
 * person who can renew it; the managers are told because they are the ones who
 * have to stop putting that person on the book if it lapses.
 *
 * SECURITY DEFINER, so it checks its own caller rather than taking anyone's
 * word for it — the same shape as adjust_stock in 021. `auth.uid() is null`
 * means the service role, a scheduled job or the SQL editor, all of which are
 * already privileged.
 *
 * Returns the number of people notified.
 */
create or replace function public.notify_expiring_licences()
returns int language plpgsql security definer set search_path = public as $$
declare
  thresholds constant int[] := array[60, 30, 14, 7];
  cred       record;
  days_left  int;
  stage      int;
  holder     text;
  headline   text;
  detail     text;
  notified   int := 0;
begin
  if auth.uid() is not null and not public.is_manager() then
    raise exception 'Only a manager can run the licence expiry check';
  end if;

  for cred in
    select
      c.profile_id,
      c.licence_expires_on,
      c.expiry_reminder_stage,
      coalesce(
        nullif(trim(coalesce(p.display_name, '')), ''),
        nullif(trim(coalesce(p.first_name, '') || ' ' || coalesce(p.last_name, '')), ''),
        'A team member'
      ) as name
    from public.staff_credentials c
    join public.profiles p on p.id = c.profile_id
    where c.licence_expires_on is not null
      and p.role <> 'client'
      and p.suspended_at is null
      -- Nothing to say while it is more than the widest threshold away.
      and c.licence_expires_on <= current_date + thresholds[1]
  loop
    days_left := cred.licence_expires_on - current_date;
    holder    := cred.name;

    -- -1 is "expired", and is tighter than every threshold, so the ordinary
    -- comparison below covers it without a special case.
    if days_left < 0 then
      stage := -1;
    else
      select min(t) into stage from unnest(thresholds) t where days_left <= t;
    end if;

    if stage is null then
      continue;
    end if;

    -- Already told them at this stage or a tighter one.
    if cred.expiry_reminder_stage is not null and stage >= cred.expiry_reminder_stage then
      continue;
    end if;

    if stage = -1 then
      headline := 'Licence expired — ' || holder;
      detail := holder || '''s licence expired on ' ||
                to_char(cred.licence_expires_on, 'FMMonth FMDD, YYYY') ||
                '. Treatments cannot be performed on a lapsed licence.';
    else
      headline := 'Licence expires in ' || days_left || ' day' ||
                  case when days_left = 1 then '' else 's' end || ' — ' || holder;
      detail := holder || '''s licence expires on ' ||
                to_char(cred.licence_expires_on, 'FMMonth FMDD, YYYY') || '.';
    end if;

    insert into public.notifications (user_id, type, title, body, link)
    select p.id, 'system', headline, detail, '/dashboard/settings/team'
    from public.profiles p
    where p.suspended_at is null
      and (p.role in ('manager', 'admin') or p.id = cred.profile_id);

    update public.staff_credentials
    set expiry_reminder_stage = stage,
        expiry_reminded_at    = now()
    where profile_id = cred.profile_id;

    notified := notified + 1;
  end loop;

  return notified;
end;
$$;

revoke all on function public.notify_expiring_licences() from public;
revoke all on function public.notify_expiring_licences() from anon;
grant execute on function public.notify_expiring_licences() to authenticated;
grant execute on function public.notify_expiring_licences() to service_role;

comment on function public.notify_expiring_licences() is
  'Run daily. Idempotent: each licence produces at most one notification per '
  'threshold crossed (60/30/14/7 days, then expiry). Schedule it with '
  'select cron.schedule(''licence-expiry'', ''0 15 * * *'', '
  '''select public.notify_expiring_licences()'') once pg_cron is enabled, or '
  'call the RPC from a scheduled job. A manager can also run it by hand from '
  'the team screen.';

-- `is_listable_staff` is called from a policy `anon` is subject to, so anon
-- must be able to execute it. It answers one boolean about staff-ness and
-- reads nothing back to the caller.
grant execute on function public.is_listable_staff(uuid) to anon, authenticated, service_role;
grant execute on function public.licence_status(date, int) to authenticated, service_role;
grant execute on function public.staff_profile_slug(text, uuid) to authenticated, service_role;

-- ── Headshots ────────────────────────────────────────────────
--
-- The `site` bucket is public and, since 011, manager-writable only. A provider
-- updating her own photograph is not a manager operation, so team photos get a
-- prefix of their own: site/team/<profile uuid>/<file>. The path segment is the
-- authorisation, exactly as it is for treatment photography.

drop policy if exists "staff writes own team photo" on storage.objects;
create policy "staff writes own team photo" on storage.objects
  for insert to authenticated with check (
    bucket_id = 'site'
    and (storage.foldername(name))[1] = 'team'
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_manager())
  );

drop policy if exists "staff updates own team photo" on storage.objects;
create policy "staff updates own team photo" on storage.objects
  for update to authenticated using (
    bucket_id = 'site'
    and (storage.foldername(name))[1] = 'team'
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_manager())
  );

drop policy if exists "staff deletes own team photo" on storage.objects;
create policy "staff deletes own team photo" on storage.objects
  for delete to authenticated using (
    bucket_id = 'site'
    and (storage.foldername(name))[1] = 'team'
    and ((storage.foldername(name))[2] = auth.uid()::text or public.is_manager())
  );

-- ── Comments ─────────────────────────────────────────────────

comment on table public.staff_profiles is
  'The public half of a team member profile. Readable by anon when is_public. '
  'Carries its own display_name and slug so the public team page never needs '
  'to read profiles — see the header of 041 for why the split is physical.';
comment on column public.staff_profiles.is_public is
  'Opt-in, default false. Editable by the person themselves as well as a '
  'manager: taking your own face off a public website is not a request.';
comment on column public.staff_profiles.bio is
  'The long biography for /team/<slug>. profiles.bio stays the short blurb '
  'shown on the booking step.';

comment on table public.staff_credentials is
  'Licensure. Readable by the holder and by managers. Never by anon — there is '
  'no anon policy and no anon GRANT.';
comment on column public.staff_credentials.expiry_reminder_stage is
  'Tightest reminder threshold already sent (60/30/14/7, or -1 for expired). '
  'Bookkeeping for notify_expiring_licences(), cleared when the expiry date '
  'changes. Not a setting.';

comment on table public.staff_employment is
  'Personnel record. Managers only, including on your own row — an employment '
  'record the subject can edit is evidence of nothing.';
