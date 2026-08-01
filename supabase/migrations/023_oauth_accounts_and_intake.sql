-- ============================================================
-- 559 Flawless — 023: Google sign-in, account completion,
--                     intake after booking
-- ============================================================

-- ── 1. A profile that survives Google sign-in ────────────────
--
-- `handle_new_user` read `first_name` and `last_name` from the user metadata,
-- which is what our own sign-up form writes. Google writes `given_name`,
-- `family_name`, `full_name` and `name` instead, so a Google account arrived
-- with a nameless profile — and a nameless profile is a client the studio
-- cannot identify on the day.
--
-- Roles are deliberately NOT taken from metadata. Anyone can put
-- {"role":"admin"} in an OAuth payload; self-signup is always a client, and
-- staff are promoted afterwards by an existing admin.

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta      jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  full_name text;
  first     text;
  last      text;
begin
  first := nullif(trim(coalesce(meta ->> 'first_name', meta ->> 'given_name', '')), '');
  last  := nullif(trim(coalesce(meta ->> 'last_name',  meta ->> 'family_name', '')), '');

  -- Google always sends a display name even when it withholds the parts.
  full_name := nullif(trim(coalesce(meta ->> 'full_name', meta ->> 'name', '')), '');

  if first is null and full_name is not null then
    first := split_part(full_name, ' ', 1);
    -- Everything after the first space, so "Ana Maria Ruiz" keeps "Maria Ruiz"
    -- rather than losing the middle name.
    last  := nullif(trim(substr(full_name, length(split_part(full_name, ' ', 1)) + 1)), '');
  end if;

  insert into public.profiles (id, email, first_name, last_name, phone, avatar_url, role)
  values (
    new.id,
    new.email,
    first,
    last,
    nullif(trim(coalesce(meta ->> 'phone', new.phone, '')), ''),
    nullif(trim(coalesce(meta ->> 'avatar_url', meta ->> 'picture', '')), ''),
    'client'
  )
  on conflict (id) do update
    -- A returning OAuth user should not lose a name they already have, but an
    -- empty profile should gain one.
    set email      = coalesce(public.profiles.email, excluded.email),
        first_name = coalesce(public.profiles.first_name, excluded.first_name),
        last_name  = coalesce(public.profiles.last_name, excluded.last_name),
        avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url);

  return new;
end;
$$;

-- OAuth updates the metadata on every sign-in; catch a name that arrives late.
drop trigger if exists on_auth_user_updated on auth.users;
create trigger on_auth_user_updated
  after update of raw_user_meta_data on auth.users
  for each row execute function public.handle_new_user();

-- ── 2. Knowing when an account still needs details ───────────
--
-- Google gives a name, an email and a picture. It does not give a phone number
-- or a date of birth, and the studio needs both: one to reach someone when a
-- slot moves, the other because several services have an age minimum.

alter table public.profiles
  add column if not exists profile_completed_at timestamptz;

comment on column public.profiles.profile_completed_at is
  'Set when the client has supplied the details sign-in cannot provide (phone, '
  'date of birth). Null means the "finish your profile" step is still owed.';

/**
 * Does this account still owe us the details a booking needs?
 *
 * Derived rather than trusted: a client who clears their phone number is
 * incomplete again, whatever the timestamp says.
 */
create or replace function public.profile_needs_completion(p_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = p_id
      and role = 'client'
      and (
        first_name is null or trim(first_name) = ''
        or phone is null or trim(phone) = ''
        or date_of_birth is null
      )
  );
$$;

-- Backfill: anyone who already has the details is complete.
update public.profiles
set profile_completed_at = coalesce(profile_completed_at, now())
where role = 'client'
  and profile_completed_at is null
  and first_name is not null and trim(first_name) <> ''
  and phone is not null and trim(phone) <> ''
  and date_of_birth is not null;

-- ── 3. Intake belongs after the booking, not in front of it ──
--
-- Requiring two clinical forms before the "Confirm" button means a client who
-- came to reserve a slot leaves without one. The slot is the commitment; the
-- paperwork is a condition of being treated, which is a different deadline.
--
-- So the appointment records what it is waiting for, and the studio can see at
-- a glance who has not filled anything in yet.

alter table public.appointments
  add column if not exists intake_completed_at timestamptz,
  add column if not exists intake_reminder_sent_at timestamptz;

comment on column public.appointments.intake_completed_at is
  'When every form this appointment requires was submitted. Null while any are '
  'outstanding — the client is prompted after booking and reminded before the visit.';

create index if not exists appointments_intake_pending_idx
  on public.appointments (starts_at)
  where intake_completed_at is null and status in ('pending', 'confirmed');

/**
 * The forms an appointment still needs.
 *
 * A form attaches to services two ways: the `service_ids`/`category_ids` arrays
 * on the template itself, and an explicit row in `service_form_requirements`.
 * Both are honoured, because both are in use.
 *
 * A signature counts only while it is unexpired — a health attestation from two
 * years ago is not evidence of anything current, which is the whole reason
 * consent_forms carries `revalidate_after_days`.
 */
create or replace function public.appointment_outstanding_forms(p_appointment uuid)
returns table (kind text, form_id bigint, slug text, title text, is_required boolean)
language sql stable security definer set search_path = public as $$
  with appt as (
    select id, client_id from public.appointments where id = p_appointment
  ),
  booked as (
    select distinct s.id as service_id, s.category_id
    from public.appointment_services aps
    join public.services s on s.id = aps.service_id
    where aps.appointment_id = p_appointment
  ),
  -- Consent forms this appointment pulls in, from either attachment route.
  needed_consent as (
    select distinct cf.id, cf.slug, cf.title, true as is_required
    from public.consent_forms cf
    where cf.is_active
      and (
        exists (select 1 from booked b where b.service_id = any (cf.service_ids))
        or exists (select 1 from booked b where b.category_id = any (cf.category_ids))
        or exists (
          select 1 from public.service_form_requirements r
          join booked b on b.service_id = r.service_id
          where r.consent_form_id = cf.id
        )
      )
  ),
  needed_intake as (
    select distinct f.id, f.slug, f.title,
           coalesce(bool_or(r.is_required), true) as is_required
    from public.intake_forms f
    left join public.service_form_requirements r on r.intake_form_id = f.id
      and r.service_id in (select service_id from booked)
    where f.is_active
      and (
        exists (select 1 from booked b where b.service_id = any (f.service_ids))
        or exists (select 1 from booked b where b.category_id = any (f.category_ids))
        or exists (
          select 1 from public.service_form_requirements r2
          join booked b on b.service_id = r2.service_id
          where r2.intake_form_id = f.id
        )
      )
    group by f.id, f.slug, f.title
  )
  select 'consent'::text, c.id, c.slug, c.title, c.is_required
  from needed_consent c
  where not exists (
    select 1 from public.consent_signatures sig
    where sig.client_id = (select client_id from appt)
      and sig.consent_form_id = c.id
      and (sig.expires_at is null or sig.expires_at > now())
  )
  union all
  select 'intake'::text, i.id, i.slug, i.title, i.is_required
  from needed_intake i
  where not exists (
    select 1 from public.intake_submissions sub
    where sub.client_id = (select client_id from appt)
      and sub.intake_form_id = i.id
      -- Re-ask each visit rather than reuse an old answer: skin, medication and
      -- pregnancy status all change, and that is exactly what the form asks about.
      and sub.appointment_id = p_appointment
  );
$$;

/**
 * Recompute `intake_completed_at` for an appointment.
 * Called after a form is submitted, so the flag never drifts from the forms.
 */
create or replace function public.refresh_appointment_intake(p_appointment uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.appointments
  set intake_completed_at = case
    when exists (
      select 1 from public.appointment_outstanding_forms(p_appointment)
      where is_required
    ) then null
    else coalesce(intake_completed_at, now())
  end
  where id = p_appointment;
end;
$$;

-- Submitting either kind of form re-checks the appointment it belongs to.
create or replace function public.form_submission_refresh_intake()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.appointment_id is not null then
    perform public.refresh_appointment_intake(new.appointment_id);
  end if;
  return null;
end;
$$;

drop trigger if exists intake_submissions_refresh on public.intake_submissions;
create trigger intake_submissions_refresh
  after insert on public.intake_submissions
  for each row execute function public.form_submission_refresh_intake();

drop trigger if exists consent_signatures_refresh on public.consent_signatures;
create trigger consent_signatures_refresh
  after insert on public.consent_signatures
  for each row execute function public.form_submission_refresh_intake();

-- ── 4. Sales tax the studio can set ──────────────────────────
insert into public.site_settings (key, type, version, text_value, label, description, is_active)
select 'sales_tax_rate', 'config', 1, '0.0835',
       'Sales tax rate',
       'Applied to in-store product sales. Fresno County is 0.0835 (8.35%). '
       'Enter it as a decimal, not a percentage.',
       true
where not exists (select 1 from public.site_settings where key = 'sales_tax_rate');
