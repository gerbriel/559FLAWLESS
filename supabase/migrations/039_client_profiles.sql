-- ============================================================
-- 559 Flawless — 039: the client record, in full
--
-- Three things the owner asked for, which turn out to share one idea: the
-- client file should be able to answer questions about a person without
-- anybody having to remember them.
--
--   1. Banning — sometimes the studio has to stop taking someone's bookings.
--   2. Before & after photographs — a prompt at the right moment, and never
--      a prompt where consent does not permit the photograph.
--   3. Depth — one chronological view of the whole relationship, plus the
--      numbers (lifetime value, cadence, no-show rate) that were already
--      being maintained and were not being shown.
--
-- Nothing here erases anything. A ban is a row, a lift is a column on that
-- row, and the visit history underneath is untouched by both.
-- ============================================================

-- ══════════════════════════════════════════════════════════════
-- 1. BANNING
-- ══════════════════════════════════════════════════════════════
--
-- Why this is NOT `profiles.suspended_at`.
--
-- `suspended_at` is the STAFF kill switch and is load-bearing as one:
-- `is_staff()`, `is_front_desk()`, `is_manager()`, `is_admin()` and
-- `is_provider()` all read it, and "public read bookable providers" hides a
-- suspended provider from the booking page. Setting it on a client would
-- overload a column five permission helpers already depend on, to say
-- something none of them are asking.
--
-- It also cannot carry the answer. A ban needs a reason somebody can review,
-- the name of whoever made the call, an expiry, and — per the multi-location
-- contract — a scope, because a second site may not share the problem. That is
-- a row, not a timestamp. And 001's guard trigger restricts `suspended_at` to
-- admins, which is right for "this employee is locked out" and wrong for
-- "she was abusive to me in the room": the person who needs to stop the next
-- booking is the person who was in the room.
--
-- So: a table. The client's account keeps working — they can still sign in,
-- read their own history, message the studio and buy a product. What stops is
-- the booking, which is the only thing the studio actually wants to stop.

create table if not exists public.client_bans (
  id          bigserial primary key,
  client_id   uuid not null references public.profiles(id) on delete cascade,

  -- Where the decision was made. Always a real site — a ban is issued by
  -- somebody standing somewhere, and recording that is useful even when the
  -- ban applies everywhere. Scope is the next column's job, not this one's.
  location_id bigint not null references public.locations(id) on delete restrict
                default public.default_location_id(),

  -- Defaults to studio-wide, because the reasons that produce a ban — repeated
  -- no-shows, abuse, a safety issue — travel with the person and not with the
  -- building. Turning it off is the deliberate act.
  applies_studio_wide boolean not null default true,

  -- Staff-facing, and staff-facing only. The client is declined politely and
  -- pointed at the phone; they are never shown this text.
  reason      text not null,

  banned_by   uuid references public.profiles(id) on delete set null,
  banned_at   timestamptz not null default now(),
  -- Null = until somebody lifts it. A date = it stops on its own, which is
  -- what "banned for the rest of the season" actually means.
  expires_at  timestamptz,

  -- Lifting is an edit to this row rather than a delete, so "banned in March,
  -- back in June" stays answerable.
  lifted_at   timestamptz,
  lifted_by   uuid references public.profiles(id) on delete set null,
  lift_reason text,

  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  -- A ban nobody wrote a reason for cannot be reviewed, appealed, or
  -- explained to the person on the phone six months later.
  constraint client_bans_reason_present check (length(btrim(reason)) > 0),
  constraint client_bans_expiry_after_start
    check (expires_at is null or expires_at > banned_at),
  constraint client_bans_lift_after_start
    check (lifted_at is null or lifted_at >= banned_at)
);

comment on table public.client_bans is
  'Bookings the studio will not take, and why. Deliberately separate from '
  'profiles.suspended_at, which is the staff lock-out and is read by every '
  'role helper in 001.';
comment on column public.client_bans.applies_studio_wide is
  'True = every site. False = only location_id. There is no unique index '
  'stopping two live bans on one person: "barred from the Shaw Ave room until '
  'March, and barred everywhere permanently" is a coherent thing to record, '
  'and client_is_banned ORs them.';

create index if not exists client_bans_client_idx
  on public.client_bans (client_id, banned_at desc);
-- The lookup client_is_banned actually performs.
create index if not exists client_bans_live_idx
  on public.client_bans (client_id, location_id)
  where lifted_at is null;
create index if not exists client_bans_location_idx
  on public.client_bans (location_id, banned_at desc);

create or replace function public.client_bans_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target_role public.user_role;
begin
  select role into target_role from public.profiles where id = new.client_id;

  if target_role is null then
    raise exception 'Unknown profile %', new.client_id;
  end if;

  -- The distinction this whole table exists to make. Locking out an employee
  -- is profiles.suspended_at and an admin's decision; refusing a client's
  -- booking is this.
  if target_role <> 'client' then
    raise exception 'Only a client can be banned — use suspended_at for staff accounts';
  end if;

  new.banned_by := coalesce(new.banned_by, auth.uid());
  return new;
end;
$$;

drop trigger if exists client_bans_before_insert on public.client_bans;
create trigger client_bans_before_insert
  before insert on public.client_bans
  for each row execute function public.client_bans_before_insert();

/**
 * A ban is append-only apart from being lifted.
 *
 * RLS can gate a whole UPDATE but not a column, so the column rule lives here.
 * Without it the "manager lifts a ban" policy would also let a manager rewrite
 * the reason, move the date, or re-point the row at somebody else — which is
 * the one thing a record like this must not allow.
 */
create or replace function public.client_bans_before_update()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.client_id is distinct from old.client_id
     or new.location_id is distinct from old.location_id
     or new.applies_studio_wide is distinct from old.applies_studio_wide
     or new.reason is distinct from old.reason
     or new.banned_by is distinct from old.banned_by
     or new.banned_at is distinct from old.banned_at
     or new.expires_at is distinct from old.expires_at
  then
    raise exception 'A ban cannot be edited — lift it and record a new one';
  end if;

  -- Un-lifting would quietly rewrite the history the lift columns exist to
  -- keep. Banning someone again is a new row.
  if old.lifted_at is not null and new.lifted_at is distinct from old.lifted_at then
    raise exception 'A lifted ban cannot be re-applied — record a new ban';
  end if;

  if new.lifted_at is not null and old.lifted_at is null then
    new.lifted_by := coalesce(new.lifted_by, auth.uid());
  end if;

  return new;
end;
$$;

drop trigger if exists client_bans_before_update on public.client_bans;
create trigger client_bans_before_update
  before update on public.client_bans
  for each row execute function public.client_bans_before_update();

drop trigger if exists client_bans_touch on public.client_bans;
create trigger client_bans_touch before update on public.client_bans
  for each row execute function public.touch_updated_at();

/**
 * Is this person barred from booking here, right now?
 *
 * The one predicate. `p_location_id` null means "anywhere" — the answer the
 * CRM wants when it renders a badge on a client's name. Pass a real location
 * and it answers for that site: a ban scoped to one room does not close the
 * other one.
 *
 * SECURITY INVOKER on purpose. It reads client_bans, whose SELECT policy is
 * staff-only, so a client asking about somebody else gets false rather than an
 * enumeration oracle. The two callers that need it regardless — the trigger
 * below and the service-role booking engine — reach it as a definer-owned
 * trigger and as service_role respectively.
 */
create or replace function public.client_is_banned(
  p_client_id  uuid,
  p_location_id bigint default null
) returns boolean language sql stable set search_path = public as $$
  select exists (
    select 1
    from public.client_bans b
    where b.client_id = p_client_id
      and b.lifted_at is null
      and (b.expires_at is null or b.expires_at > now())
      and (b.applies_studio_wide
           or p_location_id is null
           or b.location_id = p_location_id)
  );
$$;

revoke all on function public.client_is_banned(uuid, bigint) from public;
grant execute on function public.client_is_banned(uuid, bigint) to service_role;

/**
 * The ban, enforced where it cannot be routed around.
 *
 * `src/lib/booking.ts` is the only public path into `appointments` and it is
 * not edited here; this is the same shape of guarantee as the GiST exclusion
 * constraint next to it. Application code checks so the UI can say something
 * sensible — this is what makes it true, for the public booking route, for a
 * staff booking, and for anything written later.
 *
 * SQLSTATE 23P02 is chosen to sit beside 23P01 (exclusion_violation, the
 * double-booking guard): same class, integrity constraint violation, and
 * undefined by PostgreSQL. `booking.ts` maps it exactly the way it already
 * maps 23P01 — see the integration note at the bottom of this file.
 *
 * THE TRIGGER NAME IS LOAD-BEARING: triggers of the same event and timing fire in
 * alphabetical order, and this must run AFTER `appointments_match_client`
 * (which resolves a guest booking's email to a profile) and before
 * `appointments_set_slot`. match < refuse < set_slot. Renaming it to sort
 * ahead of the matcher would let a banned client rebook as a guest with the
 * email already on their account.
 */
create or replace function public.appointment_refuse_banned_client()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.client_id is not null
     and public.client_is_banned(new.client_id, new.location_id) then
    raise exception using
      errcode = '23P02',
      message = 'This client cannot be booked',
      -- What booking.ts branches on if it prefers a string to the SQLSTATE.
      detail  = 'client_banned',
      hint    = 'Lift the ban on the client record first.';
  end if;
  return new;
end;
$$;

drop trigger if exists appointments_refuse_banned_client on public.appointments;
create trigger appointments_refuse_banned_client
  before insert or update of client_id, starts_at, location_id
  on public.appointments
  for each row execute function public.appointment_refuse_banned_client();

-- Cancelling a banned client's existing appointment only touches `status`, so
-- staff can still clear the calendar after issuing a ban. Rescheduling one
-- cannot: moving a booking for somebody the studio has stopped taking is the
-- case this is here to refuse.

-- ── RLS ──────────────────────────────────────────────────────
alter table public.client_bans enable row level security;

-- No client policy of any kind. A client never reads this table: they are
-- declined at the point of booking and pointed at the phone, and the reason
-- somebody wrote about them is a staff note, not a notice.
drop policy if exists "staff reads client bans" on public.client_bans;
create policy "staff reads client bans" on public.client_bans
  for select using (public.is_staff());

-- Anyone on staff may stop the next booking. In a one-room studio the person
-- who needs this is the person who was in the room, and making her find a
-- manager first defeats the point.
drop policy if exists "staff records a ban" on public.client_bans;
create policy "staff records a ban" on public.client_bans
  for insert with check (public.is_staff() and banned_by = auth.uid());

-- Letting somebody back in is the heavier decision, so it sits a tier up.
drop policy if exists "manager lifts a ban" on public.client_bans;
create policy "manager lifts a ban" on public.client_bans
  for update using (public.is_manager()) with check (public.is_manager());

-- Deliberately no DELETE policy. A ban that can be deleted is a ban that can
-- be denied later.

-- ══════════════════════════════════════════════════════════════
-- 2. BEFORE & AFTER PHOTOGRAPHS
-- ══════════════════════════════════════════════════════════════
--
-- Which services are worth photographing is a property of the service, not
-- something to remember per visit. A peel series and a lightening protocol are
-- the whole point — the client cannot see six weeks of progress in a mirror.

alter table public.services
  add column if not exists photo_documentation boolean not null default false;

-- 0 = no follow-up. Otherwise: days after the visit at which a progress
-- photograph is worth asking for. Six weeks is the usual interval for a
-- lightening or peel series, which is why the reminder reads the way it does.
alter table public.services
  add column if not exists photo_followup_days int not null default 0
    check (photo_followup_days >= 0);

comment on column public.services.photo_documentation is
  'Opts a service into before/after documentation. The prompt still will not '
  'appear without the client photo release — see client_photo_consent_ok.';

-- Turn it on for the two categories that are a series by definition. Guarded
-- on "nothing is documented yet" rather than on the category, so a re-run
-- cannot switch back on something the owner has since switched off.
update public.services s
   set photo_documentation = true,
       photo_followup_days = 42
  from public.service_categories c
 where c.id = s.category_id
   and c.slug in ('chemical-peels', 'skin-lightening')
   and not exists (select 1 from public.services where photo_documentation);

-- ── The separate written consent §6 requires ─────────────────
--
-- 'photo-release' (seeded in 010) covers clinical before-and-afters. It does
-- not cover intimate areas, and the intimate-services consent the client signs
-- says so in as many words: "no photograph of any intimate area will be taken
-- unless I give separate written consent". This is that separate consent. It
-- is a second form rather than a checkbox because that sentence promised a
-- second decision, taken on its own.
insert into public.consent_forms
  (slug, version, title, body, category_ids, revalidate_after_days)
select 'intimate-photography', 1, 'Intimate Area Photography Consent',
$$This is a separate permission from the general photography release, and from consent to the treatment itself. Declining it changes nothing about the service I receive.

I consent to clinical photographs being taken of the intimate area being treated, for my own treatment record, so that my esthetician and I can see whether the protocol is working.

I understand that these photographs are stored in a private, encrypted location, that they are visible only to me and to the staff who treat me, and that they are never shown to anyone else.

I understand that my face will not appear in these photographs, that I will be draped and exposed only for the moment the photograph is taken, and that I may ask for the photograph to be deleted immediately after it is shown to me.

I understand that these photographs will never be used for marketing, teaching, or any other purpose, regardless of any other permission I have given.

I may withdraw this consent at any time, without giving a reason, and my photographs will be deleted when I do.$$,
  array(select id from public.service_categories where slug in ('skin-lightening', 'waxing')),
  180
on conflict (slug, version) do nothing;

/**
 * May we photograph this client at all?
 *
 * Two gates, and both have to be open:
 *
 *   • The blanket release on client_records. Read exactly the way
 *     src/app/account/settings/page.tsx reads it — set, and not revoked — so
 *     the reminder and the client's own settings page can never disagree about
 *     what she chose. 030's anonymisation stamps the revocation without
 *     clearing the grant, and this is why: a withdrawal is recorded, never
 *     erased, and it still closes the gate.
 *
 *   • For an intimate service, the separate written consent above, unexpired.
 *     `expires_at` is honoured when the signing flow set one; when it did not,
 *     the form's own revalidate_after_days is applied to signed_at, so a
 *     lapsed intimate consent closes the gate either way.
 *
 * SECURITY INVOKER. It reads client_records and consent_signatures under the
 * caller's own RLS, so it fails closed for anyone who has no business asking.
 */
create or replace function public.client_photo_consent_ok(
  p_client_id uuid,
  p_intimate  boolean default false
) returns boolean language sql stable set search_path = public as $$
  select
    exists (
      select 1 from public.client_records r
      where r.client_id = p_client_id
        and r.photo_release_at is not null
        and r.photo_release_revoked_at is null
    )
    and (
      not coalesce(p_intimate, false)
      or exists (
        select 1
        from public.consent_signatures s
        join public.consent_forms f on f.id = s.consent_form_id
        where s.client_id = p_client_id
          and f.slug = 'intimate-photography'
          and (
            case
              when s.expires_at is not null then s.expires_at > now()
              else s.signed_at > now() - make_interval(days => f.revalidate_after_days)
            end
          )
      )
    );
$$;

/**
 * What photograph, if any, is due on this appointment right now.
 *
 * `photo_due` is null unless every condition holds: a service on the visit is
 * documented, the client's consent covers it, and the photograph is not
 * already there. That is deliberate — the suppression lives in SQL, so a
 * second surface built later cannot forget it the way a component could.
 *
 * A revoked photograph (deletion_requested_at) does not count as taken. The
 * nightly purge has not run yet and the image is on its way out; asking for a
 * replacement is the right prompt, not "already done".
 */
drop view if exists public.client_photo_status;
drop view if exists public.appointment_photo_prompts;

create view public.appointment_photo_prompts
with (security_invoker = on) as
with documented as (
  select
    line.appointment_id,
    bool_or(s.photo_documentation)                                     as photo_documented,
    -- Either flag is enough: 002 carries is_intimate on the service AND on
    -- the category, and the stricter reading is the only safe one here.
    bool_or(s.is_intimate or c.is_intimate)                            as intimate,
    max(s.photo_followup_days) filter (where s.photo_documentation)    as followup_days,
    string_agg(distinct s.name, ', ') filter (where s.photo_documentation)
                                                                       as documented_services
  from public.appointment_services line
  join public.services s           on s.id = line.service_id
  join public.service_categories c on c.id = s.category_id
  group by line.appointment_id
)
select
  a.id                                   as appointment_id,
  a.client_id,
  a.provider_id,
  a.location_id,
  a.starts_at,
  a.status,
  coalesce(d.photo_documented, false)    as photo_documented,
  coalesce(d.intimate, false)            as intimate,
  d.documented_services,
  coalesce(d.followup_days, 0)           as followup_days,
  coalesce(shot.before_count, 0)         as before_count,
  coalesce(shot.after_count, 0)          as after_count,
  coalesce(shot.progress_count, 0)       as progress_count,
  coalesce(cons.ok, false)               as consent_ok,
  case
    when not coalesce(d.photo_documented, false) then null
    when not coalesce(cons.ok, false)            then null
    when a.status = 'checked_in' and coalesce(shot.before_count, 0) = 0 then 'before'
    when a.status = 'completed'  and coalesce(shot.after_count, 0)  = 0 then 'after'
    else null
  end                                    as photo_due
from public.appointments a
left join documented d on d.appointment_id = a.id
left join lateral (
  select
    count(*) filter (where t.phase = 'before')::int   as before_count,
    count(*) filter (where t.phase = 'after')::int    as after_count,
    count(*) filter (where t.phase = 'progress')::int as progress_count
  from public.treatment_photos t
  where t.appointment_id = a.id
    and t.deletion_requested_at is null
) shot on true
left join lateral (
  select public.client_photo_consent_ok(a.client_id, coalesce(d.intimate, false)) as ok
) cons on true
where a.client_id is not null;

comment on view public.appointment_photo_prompts is
  'Per-appointment photo prompt. photo_due is null whenever consent does not '
  'permit the photograph, so the gate is in SQL and not in a component.';

/**
 * The same question asked of a person rather than a visit: what has been
 * photographed, what the consent position is, and whether a progress
 * photograph is overdue.
 *
 * Built on the view above rather than repeating its joins, so "when may we
 * photograph this client" has exactly one answer in the schema.
 */
create view public.client_photo_status
with (security_invoker = on) as
select
  r.client_id,
  r.photo_release_at,
  r.photo_release_revoked_at,
  public.client_photo_consent_ok(r.client_id, false) as photo_release_ok,
  public.client_photo_consent_ok(r.client_id, true)  as intimate_consent_ok,

  coalesce(v.documented_visits, 0)   as documented_visits,
  coalesce(v.visits_with_photos, 0)  as visits_with_photos,

  coalesce(ph.photo_count, 0)        as photo_count,
  coalesce(ph.before_count, 0)       as before_count,
  coalesce(ph.after_count, 0)        as after_count,
  coalesce(ph.progress_count, 0)     as progress_count,
  ph.last_photo_at,

  f.followup_service,
  -- The visit being followed up, so the reminder can say "it has been six
  -- weeks since the peel" rather than quoting a due date at somebody.
  f.followup_visit_at,
  f.followup_due_at,
  -- Overdue means the interval has passed AND nothing has been taken since it
  -- came due — a photograph taken last week answers the reminder.
  (
    f.followup_due_at is not null
    and f.followup_due_at <= now()
    and (ph.last_photo_at is null or ph.last_photo_at < f.followup_due_at)
  )                                  as followup_overdue
from public.client_records r
left join lateral (
  select
    count(*) filter (
      where q.photo_documented and q.status = 'completed'
    )::int as documented_visits,
    count(*) filter (
      where q.photo_documented and q.status = 'completed'
        and q.before_count + q.after_count + q.progress_count > 0
    )::int as visits_with_photos
  from public.appointment_photo_prompts q
  where q.client_id = r.client_id
) v on true
left join lateral (
  -- The most recent documented visit that carries a follow-up interval. The
  -- consent gate is repeated here rather than inherited, because a client who
  -- has revoked must not be chased for a progress photograph either.
  select
    q.documented_services as followup_service,
    q.starts_at          as followup_visit_at,
    q.starts_at + make_interval(days => q.followup_days) as followup_due_at
  from public.appointment_photo_prompts q
  where q.client_id = r.client_id
    and q.status = 'completed'
    and q.photo_documented
    and q.followup_days > 0
    and q.consent_ok
  order by q.starts_at desc
  limit 1
) f on true
left join lateral (
  select
    count(*)::int                                     as photo_count,
    count(*) filter (where t.phase = 'before')::int   as before_count,
    count(*) filter (where t.phase = 'after')::int    as after_count,
    count(*) filter (where t.phase = 'progress')::int as progress_count,
    max(t.taken_at)                                   as last_photo_at
  from public.treatment_photos t
  where t.client_id = r.client_id
    and t.deletion_requested_at is null
) ph on true;

-- ══════════════════════════════════════════════════════════════
-- 3. DEPTH
-- ══════════════════════════════════════════════════════════════

-- ── Tags ─────────────────────────────────────────────────────
-- 005 created the table and nothing ever gave it a shape to render.
alter table public.client_tags add column if not exists description text;
alter table public.client_tags add column if not exists sort_order int not null default 0;
-- Some tags are a colour on a chip; some are the thing you must read before
-- you touch someone's skin. This is which.
alter table public.client_tags add column if not exists is_alert boolean not null default false;

insert into public.client_tags (name, color, description, is_alert, sort_order) values
  ('VIP',              'clay',   'Regular. Worth a call before a schedule change.',           false, 10),
  ('Sensitive skin',   'amber',  'Reacts easily. Patch test and step the strength down.',     true,  20),
  ('Keloid history',   'amber',  'Scars readily — no extractions or aggressive exfoliation.', true,  30),
  ('Photo study',      'sage',   'Documented series. Photographs matter to this protocol.',   false, 40),
  ('Payment plan',     'stone',  'Pays across visits. Check the balance at the counter.',     false, 50),
  ('Referred a friend','sage',   'Has sent someone else here.',                               false, 60)
on conflict (name) do nothing;

/**
 * The whole relationship, in order.
 *
 * One query instead of nine, and — because it is a UNION of tables that each
 * carry their own policies, read through security_invoker — one place where
 * "who may see what" is already answered. A client reading their own timeline
 * gets appointments, orders, payments, consent, intake and their own
 * photographs; the provider notes and the ban rows are simply not there,
 * because client_notes and client_bans do not let them be.
 *
 * `ref` is text because the ids being unioned are not the same type: an
 * appointment is a uuid, an order is a bigint. The consumer pairs it with
 * `kind` to build a link.
 *
 * `location_id` is null on rows that belong to the business rather than to a
 * building — 032 drew that line deliberately for the clinical and CRM side, and
 * this view honours it rather than inventing an address for a consent form.
 */
drop view if exists public.client_timeline;

create view public.client_timeline
with (security_invoker = on) as

  -- Visits.
  select
    a.client_id,
    a.starts_at                                   as occurred_at,
    'appointment'                                 as kind,
    a.id::text                                    as ref,
    coalesce(
      (select string_agg(l.name_snapshot, ' + ' order by l.sort_order)
         from public.appointment_services l where l.appointment_id = a.id),
      'Appointment'
    )                                             as title,
    null::text                                    as detail,
    a.total_cents::bigint                         as amount_cents,
    a.status::text                                as status,
    a.location_id
  from public.appointments a
  where a.client_id is not null

union all

  -- Retail, in the room and online. Unpaid carts are not history.
  select
    o.client_id,
    coalesce(o.paid_at, o.created_at),
    'purchase',
    o.id::text,
    coalesce(
      (select string_agg(
                i.name_snapshot || case when i.qty > 1 then ' ×' || i.qty else '' end,
                ', ' order by i.id)
         from public.order_items i where i.order_id = o.id),
      'Order'
    ),
    o.order_number,
    o.total_cents::bigint,
    o.status::text,
    o.location_id
  from public.orders o
  where o.client_id is not null
    and o.status in ('paid', 'fulfilling', 'ready_for_pickup', 'shipped', 'completed', 'refunded')

union all

  -- Money that actually moved. Deliberately separate from the two rows above:
  -- an appointment is what was billed, a payment is what was taken, and the
  -- gap between them is the balance somebody has to chase.
  select
    p.client_id,
    p.created_at,
    'payment',
    p.id::text,
    initcap(replace(p.kind, '_', ' ')) || ' · ' || replace(p.method, '_', ' '),
    p.note,
    p.amount_cents::bigint,
    p.status,
    null::bigint
  from public.payments p
  where p.client_id is not null
    and p.status = 'succeeded'

union all

  -- Clinical notes. Staff-only, by client_notes' own policies.
  select
    n.client_id,
    n.created_at,
    'note',
    n.id::text,
    n.body,
    nullif(
      concat_ws(
        ' · ',
        nullif('Products: ' || n.products_used, 'Products: '),
        nullif('Next: ' || n.next_visit_plan, 'Next: ')
      ),
      ''
    ),
    null::bigint,
    null::text,
    null::bigint
  from public.client_notes n

union all

  select
    s.client_id,
    s.signed_at,
    'consent',
    s.id::text,
    f.title,
    'Signed as ' || s.signed_name,
    null::bigint,
    case when s.expires_at is not null and s.expires_at <= now()
         then 'expired' else 'valid' end,
    null::bigint
  from public.consent_signatures s
  join public.consent_forms f on f.id = s.consent_form_id

union all

  select
    i.client_id,
    i.submitted_at,
    'intake',
    i.id::text,
    coalesce(f.title, 'Intake'),
    nullif(array_to_string(i.flags, ', '), ''),
    null::bigint,
    case when i.reviewed_at is null then 'unreviewed' else 'reviewed' end,
    null::bigint
  from public.intake_submissions i
  join public.intake_forms f on f.id = i.intake_form_id

union all

  select
    t.client_id,
    t.taken_at,
    'photo',
    t.id::text,
    initcap(t.phase) || coalesce(' · ' || t.body_area, ''),
    t.notes,
    null::bigint,
    case when t.deletion_requested_at is not null then 'deletion_requested' else 'held' end,
    null::bigint
  from public.treatment_photos t

union all

  select
    pt.client_id,
    pt.performed_at,
    'patch_test',
    pt.id::text,
    coalesce(sv.name, pt.product, 'Patch test'),
    pt.reaction_notes,
    null::bigint,
    pt.result,
    null::bigint
  from public.patch_tests pt
  left join public.services sv on sv.id = pt.service_id

union all

  -- The ban itself, and the lift, as two events — because that is how they
  -- read on a timeline and how somebody reconstructs what happened.
  select
    b.client_id,
    b.banned_at,
    'ban',
    b.id::text,
    b.reason,
    case
      when b.expires_at is not null
        then 'Until ' || to_char(b.expires_at, 'Mon FMDD, YYYY')
      else 'No end date'
    end,
    null::bigint,
    case when b.applies_studio_wide then 'studio_wide' else 'this_location' end,
    b.location_id
  from public.client_bans b

union all

  select
    b.client_id,
    b.lifted_at,
    'ban_lifted',
    b.id::text,
    coalesce(b.lift_reason, 'Ban lifted'),
    null::text,
    null::bigint,
    null::text,
    b.location_id
  from public.client_bans b
  where b.lifted_at is not null;

comment on view public.client_timeline is
  'Every dated fact about a client in one chronological feed. Reads through '
  'security_invoker, so each source table''s RLS decides what the caller sees '
  '— a client querying it simply does not get the clinical rows.';

-- ============================================================
-- INTEGRATION NOTE — src/lib/booking.ts (not edited here)
--
-- The trigger above already refuses the insert, so a banned client cannot be
-- booked today by any route. What booking.ts owes it is the polite decline:
-- one branch beside the existing 23P01 one, in BOTH createBooking and
-- createStaffBooking:
--
--   if (insertError.code === '23P02') return failure('client_banned', 403)
--
-- plus 'client_banned' on the BookingError union, and in
-- BOOKING_ERROR_MESSAGES — copy that declines and points at the phone,
-- never the word "banned":
--
--   client_banned:
--     'We are not able to book this one online. Please call the studio and
--      we will take it from there.'
--
-- (Exported as BANNED_BOOKING_MESSAGE in src/types/clientprofile.ts, so the
--  ban panel can show staff exactly what the client will be shown.)
--
-- The staff reason stays in client_bans, where only staff can read it.
-- ============================================================
