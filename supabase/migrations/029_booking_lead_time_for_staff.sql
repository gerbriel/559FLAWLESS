-- ============================================================
-- 559 Flawless — 029: staff set how far ahead people must book
-- ============================================================

-- `booking_settings` was admin-only. How much notice the studio needs is an
-- operational decision that changes with how busy the week is — "I need a day's
-- warning this month" should not require the owner's login.
--
-- The deposit default stays in the same table and is therefore also opened up;
-- that is deliberate. A manager already sets prices under Services, and a
-- deposit is the same kind of decision. The genuinely dangerous switches — age
-- gates, patch tests, per-service deposits — live on `services` and are still
-- guarded by the trigger from migration 022.

drop policy if exists "admin manages booking settings" on public.booking_settings;
drop policy if exists "manager manages booking settings" on public.booking_settings;
create policy "manager manages booking settings" on public.booking_settings
  for all using (public.is_manager()) with check (public.is_manager());

-- A day's notice is the sane default for a single-room studio: enough to plan
-- the day, not so much that a Friday cancellation cannot be refilled. 003 set
-- 120 minutes, which in practice means someone can book while standing outside.
update public.booking_settings
set min_lead_minutes = 1440
where id = 1 and min_lead_minutes = 120;

comment on column public.booking_settings.min_lead_minutes is
  'How much notice a client must give, in minutes. 1440 = 24 hours. Applied by '
  'src/lib/availability.ts when generating slots, so a change takes effect on '
  'the next page load. Staff booking bypasses it — the studio can always fit '
  'someone in.';

/**
 * Guard the notice period against a typo.
 *
 * Zero is legitimate (walk-ins welcome). A month is not: it would silently
 * empty the booking calendar, and the first sign would be the phone not
 * ringing. 30 days is far past anything a studio would intend.
 */
create or replace function public.booking_settings_guard()
returns trigger language plpgsql as $$
begin
  if new.min_lead_minutes < 0 or new.min_lead_minutes > 43200 then
    raise exception 'Notice period must be between 0 and 30 days';
  end if;
  if new.max_advance_days < 1 or new.max_advance_days > 730 then
    raise exception 'The booking window must be between 1 and 730 days';
  end if;
  if new.min_lead_minutes > new.max_advance_days * 1440 then
    raise exception
      'Clients would have to book further ahead than the calendar opens — nothing would be bookable';
  end if;
  return new;
end;
$$;

drop trigger if exists booking_settings_guard on public.booking_settings;
create trigger booking_settings_guard
  before insert or update on public.booking_settings
  for each row execute function public.booking_settings_guard();
