-- ============================================================
-- 559 Flawless — 045: going on the booking page is a decision, not a setting
--
-- `accepts_online_booking` decides whether a member of staff appears on the
-- public booking page as somebody a client can reserve time with. Since 001,
-- `profiles` has had an "update own profile" policy, and the escalation guard
-- next to it protects only `role` and `suspended_at`. So this column was
-- self-service: a front-desk hire could put themselves on the booking page.
--
-- In practice they would not have got far — a provider with no rows in
-- `provider_services` offers no services, so nobody can actually book them —
-- but they would appear in the public read of `profiles`, and "nearly harmless
-- because a second thing happens to be empty" is not a permission model.
--
-- The rule this installs is asymmetric on purpose, and it mirrors the reasoning
-- already written into 041 for `staff_profiles.is_public`:
--
--   Turning it ON  is an admin decision. Whether the studio offers this
--                  person's time to the public is the owner's call.
--   Turning it OFF anyone may do to themselves, at any time. Someone who is
--                  ill, leaving, or simply full should never have to find an
--                  admin to stop taking new bookings.
--
-- The same asymmetry as "you can always take your own face off a website".
-- ============================================================

create or replace function public.guard_bookable_flag()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.accepts_online_booking is not distinct from old.accepts_online_booking then
    return new;
  end if;

  -- auth.uid() is null for the service role, a scheduled job and the SQL
  -- editor — all already privileged, and the path 001 documents and permits.
  if auth.uid() is null or public.is_admin() then
    return new;
  end if;

  -- Switching yourself off is always allowed.
  if new.id = auth.uid() and not new.accepts_online_booking then
    return new;
  end if;

  if new.id = auth.uid() then
    raise exception
      'Ask an admin to put you on the booking page. You can take yourself off it at any time.';
  end if;

  raise exception 'Only an admin can change who appears on the booking page';
end;
$$;

drop trigger if exists profiles_guard_bookable on public.profiles;
create trigger profiles_guard_bookable
  before update of accepts_online_booking on public.profiles
  for each row execute function public.guard_bookable_flag();

comment on column public.profiles.accepts_online_booking is
  'Whether this person appears on the public booking page. Independent of role '
  '— a solo owner is an admin who also treats clients (see 020). Admin-only to '
  'turn on; anyone may turn their own off. Defaults to false: no role puts '
  'anybody on the public site.';
