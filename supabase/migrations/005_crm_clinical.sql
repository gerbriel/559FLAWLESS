-- ============================================================
-- 559 Flawless — 005: CRM + clinical records
--
-- This migration holds the most sensitive data in the system: health intake,
-- contraindications, signed consent, and treatment photography. Two rules run
-- through all of it:
--   1. Nothing here is ever readable by `anon`.
--   2. A client can read their own record but cannot edit clinical history —
--      signed consent and provider notes are append-only from the client side.
-- ============================================================

-- ── Extended client record ───────────────────────────────────
-- Kept separate from `profiles` so the public "bookable provider" policy on
-- profiles can never expose health data.
create table public.client_records (
  client_id     uuid primary key references public.profiles(id) on delete cascade,

  -- Fitzpatrick I–VI drives peel strength and laser/lightening suitability.
  fitzpatrick   int check (fitzpatrick between 1 and 6),
  skin_type     text,     -- oily / dry / combination / sensitive
  concerns      text[] not null default '{}',
  allergies     text,
  medications   text,
  medical_notes text,

  referral_source text,
  preferred_provider_id uuid references public.profiles(id) on delete set null,

  -- Rolling stats maintained by trigger; used by the CRM list and analytics.
  first_visit_at  timestamptz,
  last_visit_at   timestamptz,
  visit_count     int not null default 0,
  no_show_count   int not null default 0,
  cancel_count    int not null default 0,
  lifetime_value_cents bigint not null default 0,

  -- Blanket photo release. Individual photos ALSO carry their own consent
  -- flag; both must be true before an image is stored.
  photo_release_at timestamptz,
  photo_release_revoked_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger client_records_touch before update on public.client_records
  for each row execute function public.touch_updated_at();

-- ── Tags (VIP, sensitive skin, payment plan, do-not-book) ─────
create table public.client_tags (
  id     bigserial primary key,
  name   text not null unique,
  color  text not null default 'clay',
  created_at timestamptz not null default now()
);

create table public.client_tag_links (
  client_id uuid   not null references public.profiles(id) on delete cascade,
  tag_id    bigint not null references public.client_tags(id) on delete cascade,
  primary key (client_id, tag_id)
);

-- ── Provider notes (SOAP-style, one per visit) ───────────────
create table public.client_notes (
  id             bigserial primary key,
  client_id      uuid not null references public.profiles(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  author_id      uuid references public.profiles(id) on delete set null,
  -- Observations, products used, settings, client reaction, plan for next visit.
  body           text not null,
  products_used  text,
  next_visit_plan text,
  -- Notes are clinical records: never exposed to the client.
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create index client_notes_client_idx on public.client_notes (client_id, created_at desc);

create trigger client_notes_touch before update on public.client_notes
  for each row execute function public.touch_updated_at();

-- ── Consent forms ────────────────────────────────────────────
-- Templates are versioned and never edited in place. A signature points at the
-- exact version that was displayed, and stores a copy of the body text, so a
-- later template change can't rewrite what someone actually agreed to.
create table public.consent_forms (
  id          bigserial primary key,
  slug        text not null,
  version     int  not null default 1,
  title       text not null,
  body        text not null,
  -- Which services require this form. Empty = applies to nothing by itself.
  service_ids bigint[] not null default '{}',
  category_ids bigint[] not null default '{}',
  requires_initials boolean not null default false,
  -- Re-sign after this many days (annual health re-attestation).
  revalidate_after_days int not null default 365,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now(),
  unique (slug, version)
);

create table public.consent_signatures (
  id              bigserial primary key,
  consent_form_id bigint not null references public.consent_forms(id) on delete restrict,
  client_id       uuid   not null references public.profiles(id) on delete cascade,
  appointment_id  uuid   references public.appointments(id) on delete set null,

  signed_name     text not null,
  -- Data-URL or storage path of the drawn signature.
  signature_data  text,
  -- Verbatim copy of what was on screen at signing time.
  body_snapshot   text not null,
  form_version    int  not null,

  -- Evidence of signing, for a disputed claim later.
  ip_address      inet,
  user_agent      text,
  signed_at       timestamptz not null default now(),
  expires_at      timestamptz
);

create index consent_signatures_client_idx on public.consent_signatures (client_id, signed_at desc);
create index consent_signatures_appt_idx   on public.consent_signatures (appointment_id);

-- ── Intake / contraindication screening ──────────────────────
-- Questions live in a versioned template; answers are stored as jsonb keyed by
-- question id. `flags` is denormalized out of the answers so staff can filter
-- ("show me everyone on Accutane") without scanning jsonb.
create table public.intake_forms (
  id         bigserial primary key,
  slug       text not null,
  version    int  not null default 1,
  title      text not null,
  -- [{ id, label, type, options[], flag_when }]
  questions  jsonb not null default '[]'::jsonb,
  service_ids  bigint[] not null default '{}',
  category_ids bigint[] not null default '{}',
  is_active  boolean not null default true,
  created_at timestamptz not null default now(),
  unique (slug, version)
);

create table public.intake_submissions (
  id             bigserial primary key,
  intake_form_id bigint not null references public.intake_forms(id) on delete restrict,
  client_id      uuid   not null references public.profiles(id) on delete cascade,
  appointment_id uuid   references public.appointments(id) on delete set null,
  answers        jsonb  not null default '{}'::jsonb,
  -- e.g. {accutane, retinoid_7d, pregnant, active_cold_sore, recent_peel,
  --       blood_thinner, keloid_history, sun_exposure_48h, antibiotics}
  flags          text[] not null default '{}',
  -- A provider must clear any flag before treatment proceeds.
  reviewed_by    uuid references public.profiles(id) on delete set null,
  reviewed_at    timestamptz,
  review_notes   text,
  submitted_at   timestamptz not null default now()
);

create index intake_submissions_client_idx on public.intake_submissions (client_id, submitted_at desc);
create index intake_submissions_flags_idx  on public.intake_submissions using gin (flags);
create index intake_submissions_pending_idx on public.intake_submissions (submitted_at)
  where reviewed_at is null;

-- ── Patch tests ──────────────────────────────────────────────
-- Required before certain peels and lightening protocols.
create table public.patch_tests (
  id          bigserial primary key,
  client_id   uuid not null references public.profiles(id) on delete cascade,
  service_id  bigint references public.services(id) on delete set null,
  product     text,
  performed_at timestamptz not null default now(),
  performed_by uuid references public.profiles(id) on delete set null,
  result      text not null default 'pending'
                check (result in ('pending', 'pass', 'fail')),
  reaction_notes text,
  -- Pass expires; a stale test doesn't clear a new treatment.
  expires_at  timestamptz
);

create index patch_tests_client_idx on public.patch_tests (client_id, performed_at desc);

-- ── Treatment photography ────────────────────────────────────
-- Images live in a PRIVATE storage bucket; this table holds only the path plus
-- the consent that justifies keeping it. Access is via short-lived signed URLs
-- minted server-side — never a public bucket URL.
create table public.treatment_photos (
  id             bigserial primary key,
  client_id      uuid not null references public.profiles(id) on delete cascade,
  appointment_id uuid references public.appointments(id) on delete set null,
  storage_path   text not null unique,
  phase          text not null check (phase in ('before', 'after', 'progress')),
  body_area      text,
  taken_at       timestamptz not null default now(),
  taken_by       uuid references public.profiles(id) on delete set null,
  notes          text,

  -- Per-image consent, independent of the blanket release on client_records.
  consent_given  boolean not null default false,
  -- Separate, narrower permission: marketing use is opt-in on its own.
  marketing_consent boolean not null default false,
  -- Set when a client withdraws consent; the nightly job purges the object.
  deletion_requested_at timestamptz,

  created_at     timestamptz not null default now()
);

create index treatment_photos_client_idx on public.treatment_photos (client_id, taken_at desc);
create index treatment_photos_appt_idx   on public.treatment_photos (appointment_id);

-- A photo may not be recorded without consent on the row itself.
alter table public.treatment_photos
  add constraint treatment_photos_require_consent check (consent_given);

-- ── Visit stats maintenance ──────────────────────────────────
-- Fires on INSERT and UPDATE, so OLD is unassigned on the insert path — read
-- NEW only, and guard the null case (a guest booking that matched no account).
create or replace function public.client_record_sync_stats()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target uuid := new.client_id;
begin
  if target is null then return null; end if;

  insert into public.client_records (client_id) values (target)
  on conflict (client_id) do nothing;

  update public.client_records r
  set first_visit_at = s.first_visit,
      last_visit_at  = s.last_visit,
      visit_count    = s.visits,
      no_show_count  = s.no_shows,
      cancel_count   = s.cancels,
      lifetime_value_cents = s.ltv
  from (
    select
      min(starts_at) filter (where status = 'completed')   as first_visit,
      max(starts_at) filter (where status = 'completed')   as last_visit,
      count(*)       filter (where status = 'completed')   as visits,
      count(*)       filter (where status = 'no_show')     as no_shows,
      count(*)       filter (where status = 'cancelled')   as cancels,
      coalesce(sum(total_cents) filter (where status = 'completed'), 0) as ltv
    from public.appointments where client_id = target
  ) s
  where r.client_id = target;

  return null;
end;
$$;

create trigger appointments_sync_client_stats
  after insert or update of status, total_cents, client_id
  on public.appointments
  for each row execute function public.client_record_sync_stats();

-- ── RLS ──────────────────────────────────────────────────────
alter table public.client_records      enable row level security;
alter table public.client_tags         enable row level security;
alter table public.client_tag_links    enable row level security;
alter table public.client_notes        enable row level security;
alter table public.consent_forms       enable row level security;
alter table public.consent_signatures  enable row level security;
alter table public.intake_forms        enable row level security;
alter table public.intake_submissions  enable row level security;
alter table public.patch_tests         enable row level security;
alter table public.treatment_photos    enable row level security;

/**
 * True when the current user has treated (or is scheduled to treat) this
 * client. Providers get clinical access to their own clients only; front desk
 * and up get the whole book.
 */
create or replace function public.treats_client(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_front_desk() or exists (
    select 1 from public.appointments
    where client_id = target and provider_id = auth.uid()
  );
$$;

-- Client record: own read, staff read, staff write. Clients may edit their own
-- lifestyle fields via the intake flow, not by writing here directly.
create policy "client reads own record" on public.client_records
  for select using (client_id = auth.uid());
create policy "staff reads client records" on public.client_records
  for select using (public.treats_client(client_id));
create policy "staff writes client records" on public.client_records
  for all using (public.treats_client(client_id)) with check (public.treats_client(client_id));

create policy "staff reads tags" on public.client_tags
  for select using (public.is_staff());
create policy "manager writes tags" on public.client_tags
  for all using (public.is_manager()) with check (public.is_manager());
create policy "staff manages tag links" on public.client_tag_links
  for all using (public.is_front_desk()) with check (public.is_front_desk());

-- Provider notes are staff-only in both directions. A client cannot read them.
create policy "staff reads notes" on public.client_notes
  for select using (public.treats_client(client_id));
create policy "staff writes notes" on public.client_notes
  for insert with check (public.is_staff() and author_id = auth.uid());
create policy "author edits own notes" on public.client_notes
  for update using (author_id = auth.uid() or public.is_manager())
  with check (author_id = auth.uid() or public.is_manager());

-- Consent + intake templates are public to read: they have to render on the
-- booking page before an account exists.
create policy "public reads active consent forms" on public.consent_forms
  for select to anon, authenticated using (is_active or public.is_staff());
create policy "admin writes consent forms" on public.consent_forms
  for all using (public.is_admin()) with check (public.is_admin());
create policy "public reads active intake forms" on public.intake_forms
  for select to anon, authenticated using (is_active or public.is_staff());
create policy "admin writes intake forms" on public.intake_forms
  for all using (public.is_admin()) with check (public.is_admin());

-- Signatures: a client signs their own and can read their own. Nobody edits or
-- deletes one — a signed consent is evidence.
create policy "client reads own signatures" on public.consent_signatures
  for select using (client_id = auth.uid());
create policy "staff reads signatures" on public.consent_signatures
  for select using (public.treats_client(client_id));
create policy "client signs own consent" on public.consent_signatures
  for insert with check (client_id = auth.uid());
create policy "staff records signature" on public.consent_signatures
  for insert with check (public.is_front_desk());

create policy "client reads own intake" on public.intake_submissions
  for select using (client_id = auth.uid());
create policy "staff reads intake" on public.intake_submissions
  for select using (public.treats_client(client_id));
create policy "client submits own intake" on public.intake_submissions
  for insert with check (client_id = auth.uid());
create policy "staff submits intake" on public.intake_submissions
  for insert with check (public.is_front_desk());
-- Only a provider clears a flag, and only via the review columns.
create policy "provider reviews intake" on public.intake_submissions
  for update using (public.is_staff()) with check (public.is_staff());

create policy "client reads own patch tests" on public.patch_tests
  for select using (client_id = auth.uid());
create policy "staff manages patch tests" on public.patch_tests
  for all using (public.treats_client(client_id)) with check (public.is_staff());

-- Photos: the client owns their images and can always see them and request
-- deletion. Staff access is limited to providers who treat that client.
create policy "client reads own photos" on public.treatment_photos
  for select using (client_id = auth.uid());
create policy "staff reads treated client photos" on public.treatment_photos
  for select using (public.treats_client(client_id));
create policy "staff uploads photos" on public.treatment_photos
  for insert with check (public.is_staff() and taken_by = auth.uid());
create policy "staff updates photos" on public.treatment_photos
  for update using (public.treats_client(client_id)) with check (public.is_staff());
-- Withdrawing consent: the client flags the row, a job purges the object.
create policy "client requests photo deletion" on public.treatment_photos
  for update using (client_id = auth.uid()) with check (client_id = auth.uid());
create policy "admin deletes photos" on public.treatment_photos
  for delete using (public.is_admin() or client_id = auth.uid());
