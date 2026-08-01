-- ============================================================
-- 559 Flawless — 020: let any staff member be bookable
--
-- The role enum treats 'provider' and 'admin' as separate people. That is right
-- for a studio with a front desk and several estheticians, and wrong for this
-- one: 559 Flawless is one person who both owns the business and performs the
-- treatments. Forcing her to choose meant either an owner who cannot be booked
-- or a provider who cannot reach Settings.
--
-- So "is this person bookable" stops being a question about their role and
-- becomes what it always should have been: `accepts_online_booking`, plus not
-- being a client and not being suspended. A role is about permissions; whether
-- someone takes appointments is a separate fact.
-- ============================================================

-- The public booking page needs to read whoever is bookable.
drop policy if exists "public read bookable providers" on public.profiles;
create policy "public read bookable providers"
  on public.profiles for select to anon, authenticated
  using (
    role <> 'client'
    and accepts_online_booking
    and suspended_at is null
  );

-- `is_provider()` answers "does this person treat clients", which an admin who
-- runs the room absolutely does. Permission checks use is_manager/is_admin and
-- are unaffected.
create or replace function public.is_provider()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid()
      and role <> 'client'
      and accepts_online_booking
      and suspended_at is null
  );
$$;

comment on column public.profiles.accepts_online_booking is
  'Whether this staff member takes appointments. Independent of role, so a solo '
  'owner can be admin and bookable at the same time.';
