-- ── 075: The morning closes the night before ─────────────────
--
-- One flat notice number cannot say what the studio actually wants: a 10am
-- facial booked at 9:40am is chaos, but so is refusing a 2pm slot at noon.
-- The real rule is two-tier — early slots need to be settled by the previous
-- evening so the morning is knowable before it starts; the rest of the day
-- only needs enough warning to finish the client in the chair.
--
-- `early_slot_boundary`: slots STARTING before this wall-clock time are
-- "morning" slots. `early_cutoff`: the wall-clock time on the PREVIOUS day by
-- which a morning slot must be booked. Both null = rule off, and the flat
-- `min_lead_minutes` stands alone exactly as before. Wall-clock in the
-- studio's zone, like every schedule time in this database (rule 3).
--
-- Staff are exempt, same as they are from min_lead_minutes: the desk fitting
-- somebody in IS the studio deciding its morning is knowable.

alter table public.booking_settings
  add column if not exists early_slot_boundary time,
  add column if not exists early_cutoff time;

comment on column public.booking_settings.early_slot_boundary is
  'Online-booking slots starting before this wall-clock time must be booked '
  'by early_cutoff on the previous day. Null disables the rule.';
comment on column public.booking_settings.early_cutoff is
  'The previous-day wall-clock deadline for slots before early_slot_boundary. '
  'Null disables the rule.';

-- The policy the studio asked for: mornings (before 11:00) close at 21:00 the
-- night before; everything later needs 30 minutes.
update public.booking_settings
   set min_lead_minutes    = 30,
       early_slot_boundary = '11:00',
       early_cutoff        = '21:00'
 where id = 1;
