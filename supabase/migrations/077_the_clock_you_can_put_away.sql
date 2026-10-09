-- ============================================================
-- 559 Flawless — 077: the clock you can put away
--
-- A one-person studio does not punch a clock. The time clock (035) is right
-- for a studio with staff on hourly pay and noise for one without, so it
-- becomes a switch: `booking_settings.time_clock_enabled`, managers and up,
-- on by default so nothing changes until someone turns it off.
--
-- Off means:
--   * the dashboard stops drawing the clock button, the Timesheets nav entry
--     and the Timesheets tab (the app reads the flag);
--   * the reminder sweep stops nudging people about punches nobody is
--     expected to make (below — the cron job keeps running and sends nothing,
--     so turning it back on needs no rescheduling).
--
-- Nothing is deleted. Every entry already recorded stays exactly where it is
-- and is all still there when the switch goes back on.
--
-- `my_hours_enabled` is the same idea for "My hours", with one difference: it
-- only takes the page out of the menu, the Calendar tabs and the Today screen.
-- Working hours are what online booking offers, and that page is also where a
-- provider connects Google Calendar — so it keeps working, reached from
-- Settings, for whoever needs to change either.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

alter table public.booking_settings
  add column if not exists time_clock_enabled boolean not null default true,
  add column if not exists my_hours_enabled boolean not null default true;

comment on column public.booking_settings.my_hours_enabled is
  'Show "My hours" in the dashboard menu and Calendar tabs. Off only hides it: '
  'working hours still drive booking, and the page stays reachable from Settings.';

comment on column public.booking_settings.time_clock_enabled is
  'Show the staff time clock and Timesheets, and send clock in/out reminders. '
  'Off hides both; recorded entries are kept.';

create or replace function public.send_time_clock_reminders(
  p_late_in_minutes  integer default 15,
  p_late_out_minutes integer default 15,
  p_orphan_hours     integer default 12
) returns integer language plpgsql security definer set search_path = public as $$
declare
  c           record;
  -- v_ prefixed because `link` and `title` are columns on notifications, and an
  -- unprefixed local of the same name is an ambiguous reference, not a shadow.
  v_link      text;
  v_day_start timestamptz;
  v_sent      integer := 0;
begin
  if auth.uid() is not null and not public.is_manager() then
    raise exception 'Only a manager can run the reminder sweep';
  end if;

  -- Clock switched off (077): nobody is expected to punch, so nobody is nudged.
  if not coalesce((select time_clock_enabled from public.booking_settings where id = 1), true) then
    return 0;
  end if;

  for c in
    select * from public.time_clock_reminder_candidates(
      p_late_in_minutes, p_late_out_minutes, p_orphan_hours)
  loop
    v_link := '/dashboard/timesheets?remind=' || c.kind;
    v_day_start := (c.local_date::timestamp at time zone c.timezone);

    if exists (
      select 1 from public.notifications n
      where n.user_id = c.staff_id
        and n.link = v_link
        and n.created_at >= v_day_start
    ) then
      continue;
    end if;

    if c.kind = 'clock_in' then
      insert into public.notifications (user_id, type, title, body, link)
      values (
        c.staff_id, 'system', 'You have not clocked in',
        'Your shift started at ' ||
          to_char(c.shift_start at time zone c.timezone, 'FMHH12:MI AM') ||
          '. Open the clock when you get a moment — a missing punch is easier to fix today than at payroll.',
        v_link
      );
    else
      insert into public.notifications (user_id, type, title, body, link)
      values (
        c.staff_id, 'system', 'You are still clocked in',
        case when c.shift_end is null
          then 'That shift has been open a while. Clock out so your hours are right.'
          else 'Your shift ended at ' ||
               to_char(c.shift_end at time zone c.timezone, 'FMHH12:MI AM') ||
               ' and you are still on the clock. Clock out so your hours are right.'
        end,
        v_link
      );
    end if;

    v_sent := v_sent + 1;
  end loop;

  return v_sent;
end;
$$;

comment on function public.send_time_clock_reminders(integer, integer, integer) is
  'Writes clock in/out nudges to notifications. Safe to call repeatedly; one per person per kind per local day.';
