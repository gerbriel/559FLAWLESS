-- ============================================================
-- 559 Flawless — 009: analytics + marketing
-- ============================================================

-- ── Page + funnel analytics ──────────────────────────────────
-- Written by every visitor, readable only by managers. The insert policy is
-- open by necessity (anonymous visitors are the point) but the table exposes
-- nothing on read, so it can't be mined.
create table public.analytics_events (
  id         bigserial primary key,
  session_id text not null,
  path       text not null,
  event      text not null default 'pageview',
  referrer   text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  -- Denormalized at write time so segment queries don't join profiles.
  user_role  text,
  user_id    uuid references public.profiles(id) on delete set null,
  -- Free-form payload: which service was viewed, which step was abandoned.
  meta       jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index analytics_events_created_idx on public.analytics_events (created_at desc);
create index analytics_events_path_idx    on public.analytics_events (path, created_at desc);
create index analytics_events_session_idx on public.analytics_events (session_id);
create index analytics_events_event_idx   on public.analytics_events (event, created_at desc);

-- Booking funnel steps, so drop-off between "picked a service" and
-- "confirmed" is measurable rather than guessed at.
-- event values: service_viewed | booking_started | provider_selected |
--               slot_selected | details_entered | booking_completed | booking_abandoned

-- ── Marketing surfaces ───────────────────────────────────────
create table public.announcements (
  id         bigserial primary key,
  title      text not null,
  body       text,
  link_url   text,
  link_label text,
  -- Rendered as the site-wide bar above the header.
  variant    text not null default 'info'
               check (variant in ('info', 'promo', 'urgent')),
  starts_at  timestamptz,
  ends_at    timestamptz,
  is_active  boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.testimonials (
  id           bigserial primary key,
  client_name  text not null,
  service_name text,
  rating       int check (rating between 1 and 5),
  body         text not null,
  image_url    text,
  -- Submitted reviews stay hidden until staff approves them.
  is_approved  boolean not null default false,
  is_featured  boolean not null default false,
  client_id    uuid references public.profiles(id) on delete set null,
  appointment_id uuid references public.appointments(id) on delete set null,
  sort_order   int not null default 0,
  created_at   timestamptz not null default now()
);

create index testimonials_public_idx on public.testimonials (sort_order)
  where is_approved;

create type public.subscriber_status as enum ('active', 'unsubscribed', 'bounced');

create table public.newsletter_subscribers (
  id          bigserial primary key,
  email       text not null unique,
  first_name  text,
  status      public.subscriber_status not null default 'active',
  source      text,
  client_id   uuid references public.profiles(id) on delete set null,
  -- Token the unsubscribe link carries, so no login is required to opt out.
  unsubscribe_token uuid not null default gen_random_uuid(),
  subscribed_at   timestamptz not null default now(),
  unsubscribed_at timestamptz
);

-- ── Editable site copy ───────────────────────────────────────
-- Key/value so the studio can change hero copy, hours, and policy text without
-- a deploy. `value` is jsonb to hold structured blocks, not just strings.
create table public.site_content (
  key        text primary key,
  value      jsonb not null default '{}'::jsonb,
  label      text,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now()
);

create trigger site_content_touch before update on public.site_content
  for each row execute function public.touch_updated_at();

create table public.business_hours (
  day_of_week int primary key check (day_of_week between 0 and 6),
  opens_at    time,
  closes_at   time,
  is_closed   boolean not null default false
);

-- ── FAQ ──────────────────────────────────────────────────────
create table public.faqs (
  id          bigserial primary key,
  question    text not null,
  answer      text not null,
  category    text,
  sort_order  int not null default 0,
  is_active   boolean not null default true
);

-- ── RLS ──────────────────────────────────────────────────────
alter table public.analytics_events        enable row level security;
alter table public.announcements           enable row level security;
alter table public.testimonials            enable row level security;
alter table public.newsletter_subscribers  enable row level security;
alter table public.site_content            enable row level security;
alter table public.business_hours          enable row level security;
alter table public.faqs                    enable row level security;

create policy "anyone writes analytics" on public.analytics_events
  for insert to anon, authenticated with check (true);
create policy "manager reads analytics" on public.analytics_events
  for select using (public.is_manager());

create policy "public reads live announcements" on public.announcements
  for select to anon, authenticated using (
    (is_active
     and (starts_at is null or starts_at <= now())
     and (ends_at   is null or ends_at   >= now()))
    or public.is_staff()
  );
create policy "manager writes announcements" on public.announcements
  for all using (public.is_manager()) with check (public.is_manager());

create policy "public reads approved testimonials" on public.testimonials
  for select to anon, authenticated using (is_approved or public.is_staff());
create policy "client submits testimonial" on public.testimonials
  for insert with check (client_id = auth.uid() and not is_approved);
create policy "manager moderates testimonials" on public.testimonials
  for all using (public.is_manager()) with check (public.is_manager());

-- Signup is open; the list itself is never readable by the public.
create policy "anyone subscribes" on public.newsletter_subscribers
  for insert to anon, authenticated with check (true);
create policy "manager reads subscribers" on public.newsletter_subscribers
  for select using (public.is_manager());
create policy "manager writes subscribers" on public.newsletter_subscribers
  for update using (public.is_manager()) with check (public.is_manager());

create policy "public reads site content" on public.site_content
  for select to anon, authenticated using (true);
create policy "admin writes site content" on public.site_content
  for all using (public.is_admin()) with check (public.is_admin());

create policy "public reads hours" on public.business_hours
  for select to anon, authenticated using (true);
create policy "admin writes hours" on public.business_hours
  for all using (public.is_admin()) with check (public.is_admin());

create policy "public reads faqs" on public.faqs
  for select to anon, authenticated using (is_active or public.is_staff());
create policy "manager writes faqs" on public.faqs
  for all using (public.is_manager()) with check (public.is_manager());

/**
 * Unsubscribe by token — no login, no email enumeration. Returns true when a
 * row actually matched so the page can tell "done" from "bad link".
 */
create or replace function public.newsletter_unsubscribe(p_token uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare hit int;
begin
  update public.newsletter_subscribers
  set status = 'unsubscribed', unsubscribed_at = now()
  where unsubscribe_token = p_token and status = 'active';
  get diagnostics hit = row_count;
  return hit > 0;
end;
$$;
