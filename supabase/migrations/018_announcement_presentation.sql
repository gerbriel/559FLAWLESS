-- ============================================================
-- 559 Flawless — 018: announcement presentation
--
-- 014 gave announcements their targeting columns (target_audience,
-- target_pages, priority) but nothing to say HOW they appear. This adds the
-- presentation half: the format, an optional graphic, and dismissal behaviour.
--
-- Targeting is evaluated in the browser, not here — see src/lib/announcements.ts.
-- The public pages are static/ISR, so the server does not know who is looking
-- or what path they are on; it ships every live announcement and the client
-- picks. That keeps the marketing site cacheable and still lets a promo be
-- aimed at, say, signed-out visitors on /book only.
-- ============================================================

create type public.announcement_style as enum (
  'banner',   -- the strip above the site header
  'modal',    -- centred pop-up over a dimmed backdrop
  'corner',   -- small card, bottom-right, least intrusive
  'inline'    -- sits in the page flow at the top of the content
);

alter table public.announcements
  add column if not exists display_style public.announcement_style not null default 'banner',
  -- Optional graphic. Banners show it as a small leading thumbnail; modals and
  -- corner cards show it full-width above the text.
  add column if not exists image_url text,
  -- Whether the viewer can close it, and whether that choice sticks.
  add column if not exists dismissible boolean not null default true,
  -- 'session'  — comes back next visit
  -- 'persist'  — stays dismissed on that device
  -- 'never'    — reappears on every page view
  add column if not exists dismiss_scope text not null default 'session'
    check (dismiss_scope in ('session', 'persist', 'never')),
  -- Modals only: how long to wait before showing, so it does not slam the
  -- visitor the instant the page paints.
  add column if not exists delay_seconds int not null default 0
    check (delay_seconds between 0 and 60);

comment on column public.announcements.display_style is
  'How the announcement renders: banner | modal | corner | inline';
comment on column public.announcements.dismiss_scope is
  'session = returns next visit; persist = stays closed on that device; never = always shows';

-- A modal that cannot be dismissed traps the visitor with no way past it.
alter table public.announcements
  drop constraint if exists announcements_modal_must_be_dismissible;
alter table public.announcements
  add constraint announcements_modal_must_be_dismissible
  check (display_style <> 'modal' or dismissible);

-- Ordering for the picker: highest priority first, newest as the tiebreak.
create index if not exists announcements_live_idx
  on public.announcements (priority desc, created_at desc)
  where is_active;
