-- ============================================================
-- 559 Flawless — 014: client tracking & admin features
--
-- Client analytics tracking, service form requirements, announcement
-- targeting, site settings, and staff-created profile tracking.
-- ============================================================

-- ── Client analytics tracking ────────────────────────────────
-- Tracks page visits, cart abandonment, and booking funnel progression.
-- Written by anonymous and authenticated users; readable only by managers.
create table public.client_page_visits (
  id         bigserial primary key,
  session_id text not null,
  client_id  uuid references public.profiles(id) on delete set null,
  
  -- Page tracking
  page_path  text not null,
  page_title text,
  referrer   text,
  
  -- Attribution
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  utm_content  text,
  utm_term     text,
  
  -- Device & browser info
  user_agent text,
  ip_address inet,
  
  -- Context for funnel analysis
  -- booking: started | provider_selected | slot_selected | details_entered | completed | abandoned
  -- cart: item_added | viewed | abandoned | checkout_started | checkout_completed
  event_type text,
  event_data jsonb not null default '{}'::jsonb,
  
  created_at timestamptz not null default now()
);

create index client_page_visits_session_idx on public.client_page_visits (session_id, created_at desc);
create index client_page_visits_client_idx  on public.client_page_visits (client_id, created_at desc);
create index client_page_visits_event_idx   on public.client_page_visits (event_type, created_at desc);
create index client_page_visits_created_idx on public.client_page_visits (created_at desc);
create index client_page_visits_path_idx    on public.client_page_visits (page_path, created_at desc);

-- ── Service form requirements ─────────────────────────────────
-- Links services to required consent and intake forms. Separate from the
-- arrays in consent_forms/intake_forms to allow m:n and revalidation rules.
create table public.service_form_requirements (
  id                bigserial primary key,
  service_id        bigint not null references public.services(id) on delete cascade,
  consent_form_id   bigint references public.consent_forms(id) on delete cascade,
  intake_form_id    bigint references public.intake_forms(id) on delete cascade,
  
  -- At least one form reference is required.
  constraint has_form_reference check (
    consent_form_id is not null or intake_form_id is not null
  ),
  
  is_required       boolean not null default true,
  -- How many days before a signed form must be re-signed. Null = never expires.
  -- e.g., intimate services require 180-day revalidation.
  revalidate_days   int check (revalidate_days is null or revalidate_days > 0),
  
  -- Help text shown to staff when the form is incomplete.
  staff_note        text,
  
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  
  unique (service_id, consent_form_id, intake_form_id)
);

create index service_form_requirements_service_idx  on public.service_form_requirements (service_id);
create index service_form_requirements_consent_idx  on public.service_form_requirements (consent_form_id);
create index service_form_requirements_intake_idx   on public.service_form_requirements (intake_form_id);

create trigger service_form_requirements_touch before update on public.service_form_requirements
  for each row execute function public.touch_updated_at();

-- ── Announcement targeting ────────────────────────────────────
-- Extend announcements table to support targeted delivery.
alter table public.announcements
  add column target_audience jsonb not null default '{"type":"all"}'::jsonb,
  add column target_pages text[] not null default '{}',
  add column priority int not null default 0;

-- target_audience examples:
-- {"type": "all"}
-- {"type": "role", "roles": ["client"]}
-- {"type": "clients", "client_ids": ["uuid1", "uuid2"]}
-- {"type": "authenticated"}
-- {"type": "anonymous"}

-- target_pages: ['/book', '/shop', '/account/*'] or empty for all pages

comment on column public.announcements.target_audience is
  'JSONB defining who sees this announcement: {"type":"all"} | {"type":"role","roles":["client"]} | {"type":"clients","client_ids":["uuid"]}';
comment on column public.announcements.target_pages is
  'Array of page paths where this announcement shows. Empty array = all pages. Supports wildcards: /account/*';
comment on column public.announcements.priority is
  'Display order when multiple announcements match. Higher numbers show first.';

create index announcements_target_idx on public.announcements using gin (target_audience);
create index announcements_priority_idx on public.announcements (priority desc, created_at desc);

-- ── Site settings ─────────────────────────────────────────────
-- Admin-managed content: policies, terms, analytics scripts, etc.
-- Versioned for policy content; single-row for scripts and config.
create type public.setting_type as enum (
  'policy',      -- Privacy policy, terms of service (versioned)
  'script',      -- Analytics scripts, pixels, tag manager
  'config',      -- Single-value settings
  'content'      -- Arbitrary content blocks
);

create table public.site_settings (
  id          bigserial primary key,
  key         text not null,
  type        public.setting_type not null default 'config',
  
  -- For versioned content like policies
  version     int not null default 1,
  
  -- JSON for structured data, text for simple values
  value       jsonb not null default '{}'::jsonb,
  text_value  text,
  
  -- Script injection
  -- Valid positions: 'head_start', 'head_end', 'body_start', 'body_end'
  script_position text check (script_position in ('head_start', 'head_end', 'body_start', 'body_end')),
  -- Google Analytics ID, Tag Manager ID, Facebook Pixel, etc.
  script_provider text,
  
  -- Display metadata
  label       text,
  description text,
  help_text   text,
  
  -- Policy versioning
  effective_at timestamptz,
  superseded_at timestamptz,
  
  is_active   boolean not null default true,
  
  created_by  uuid references public.profiles(id) on delete set null,
  updated_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  
  unique (key, version)
);

create index site_settings_key_idx     on public.site_settings (key, version desc);
create index site_settings_type_idx    on public.site_settings (type, is_active);
create index site_settings_active_idx  on public.site_settings (key) where is_active;

create trigger site_settings_touch before update on public.site_settings
  for each row execute function public.touch_updated_at();

-- Helper function to get the latest active version of a setting
create or replace function public.get_site_setting(p_key text)
returns jsonb language sql stable security definer set search_path = public as $$
  select value from public.site_settings
  where key = p_key and is_active
  order by version desc
  limit 1;
$$;

-- ── Staff profile creation tracking ───────────────────────────
-- Track which staff member created a client profile (e.g., booking on behalf).
alter table public.profiles
  add column created_by_staff_id uuid references public.profiles(id) on delete set null;

create index profiles_created_by_staff_idx on public.profiles (created_by_staff_id)
  where created_by_staff_id is not null;

comment on column public.profiles.created_by_staff_id is
  'Set when a staff member creates a client profile. NULL for self-signup.';

-- ── RLS policies ──────────────────────────────────────────────
alter table public.client_page_visits         enable row level security;
alter table public.service_form_requirements  enable row level security;
alter table public.site_settings              enable row level security;

-- Client page visits: writable by anyone (including anon for pre-login tracking),
-- readable only by managers for analytics.
create policy "anyone writes page visits" on public.client_page_visits
  for insert to anon, authenticated with check (true);

create policy "manager reads page visits" on public.client_page_visits
  for select using (public.is_manager());

create policy "admin deletes page visits" on public.client_page_visits
  for delete using (public.is_admin());

-- Service form requirements: readable by all (needed for booking flow),
-- writable only by admins.
create policy "public reads form requirements" on public.service_form_requirements
  for select to anon, authenticated using (true);

create policy "admin writes form requirements" on public.service_form_requirements
  for all using (public.is_admin()) with check (public.is_admin());

-- Site settings: readable by all for public settings (policies, content),
-- writable only by admins. Scripts are server-side only (not exposed via RLS).
create policy "public reads active settings" on public.site_settings
  for select to anon, authenticated using (
    is_active and type in ('policy', 'content', 'config')
  );

create policy "admin reads all settings" on public.site_settings
  for select using (public.is_admin());

create policy "admin writes settings" on public.site_settings
  for all using (public.is_admin()) with check (public.is_admin());

-- ── Enhanced appointment creation by staff ────────────────────
-- The existing "front desk creates appointments" policy already allows staff
-- to create appointments. We enhance it to properly track who created it and
-- ensure provider_id is not required when staff books.

-- Update the appointments insert policy to allow staff to book for any provider
drop policy if exists "front desk creates appointments" on public.appointments;

create policy "staff creates appointments" on public.appointments
  for insert with check (
    public.is_front_desk() or provider_id = auth.uid()
  );

-- Track appointment creation actor if not already present
-- (created_by field already exists in appointments table)

-- ── Enhanced profile creation by staff ────────────────────────
-- Allow front desk to create client profiles when booking on behalf.
-- Existing policy "insert own profile" only allows self-creation.

create policy "staff creates client profiles" on public.profiles
  for insert with check (
    public.is_front_desk() and role = 'client'
  );

-- Trigger to populate created_by_staff_id when staff creates a profile
create or replace function public.track_profile_creator()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  -- If authenticated and not creating their own profile, record the creator
  if auth.uid() is not null and auth.uid() <> new.id then
    new.created_by_staff_id := auth.uid();
  end if;
  return new;
end;
$$;

create trigger profiles_track_creator
  before insert on public.profiles
  for each row execute function public.track_profile_creator();

-- ── Helper: check form completion ─────────────────────────────
-- Returns true if the client has completed all required forms for a service.
-- Used by booking flow to gate appointment creation.
create or replace function public.service_forms_complete(
  p_service_id bigint,
  p_client_id uuid
)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  req record;
  latest_signature timestamptz;
  latest_intake timestamptz;
  is_expired boolean;
begin
  -- Check each required form for this service
  for req in
    select consent_form_id, intake_form_id, revalidate_days
    from public.service_form_requirements
    where service_id = p_service_id and is_required
  loop
    if req.consent_form_id is not null then
      -- Check consent signature exists and is not expired
      select max(signed_at) into latest_signature
      from public.consent_signatures
      where client_id = p_client_id and consent_form_id = req.consent_form_id;
      
      if latest_signature is null then
        return false;
      end if;
      
      -- Check expiration if revalidate_days is set
      if req.revalidate_days is not null then
        is_expired := latest_signature < (now() - make_interval(days => req.revalidate_days));
        if is_expired then
          return false;
        end if;
      end if;
    end if;
    
    if req.intake_form_id is not null then
      -- Check intake submission exists (intakes don't typically expire)
      select max(submitted_at) into latest_intake
      from public.intake_submissions
      where client_id = p_client_id and intake_form_id = req.intake_form_id;
      
      if latest_intake is null then
        return false;
      end if;
    end if;
  end loop;
  
  return true;
end;
$$;

-- ── Seed initial settings ─────────────────────────────────────
-- Privacy policy placeholder
insert into public.site_settings (key, type, version, label, text_value, is_active)
values (
  'privacy_policy',
  'policy',
  1,
  'Privacy Policy',
  '# Privacy Policy

This privacy policy will be updated by the studio administrator.

Last updated: ' || now()::date,
  true
) on conflict (key, version) do nothing;

-- Terms of service placeholder
insert into public.site_settings (key, type, version, label, text_value, is_active)
values (
  'terms_of_service',
  'policy',
  1,
  'Terms of Service',
  '# Terms of Service

These terms will be updated by the studio administrator.

Last updated: ' || now()::date,
  true
) on conflict (key, version) do nothing;

-- Analytics config placeholders
insert into public.site_settings (key, type, label, description, value, is_active)
values
  (
    'google_analytics_id',
    'config',
    'Google Analytics ID',
    'Google Analytics Measurement ID (G-XXXXXXXXXX)',
    '{"enabled": false, "measurement_id": ""}'::jsonb,
    true
  ),
  (
    'google_tag_manager_id',
    'config',
    'Google Tag Manager ID',
    'GTM Container ID (GTM-XXXXXX)',
    '{"enabled": false, "container_id": ""}'::jsonb,
    true
  ),
  (
    'facebook_pixel_id',
    'config',
    'Facebook Pixel ID',
    'Meta/Facebook Pixel ID',
    '{"enabled": false, "pixel_id": ""}'::jsonb,
    true
  )
on conflict (key, version) do nothing;

-- Booking settings
insert into public.site_settings (key, type, label, description, value, is_active)
values (
  'booking_settings',
  'config',
  'Booking Configuration',
  'Booking flow and availability settings',
  '{
    "allow_same_day": true,
    "min_advance_hours": 2,
    "max_advance_days": 90,
    "default_buffer_minutes": 15,
    "auto_confirm": false,
    "require_deposit": true,
    "deposit_percentage": 50
  }'::jsonb,
  true
) on conflict (key, version) do nothing;
