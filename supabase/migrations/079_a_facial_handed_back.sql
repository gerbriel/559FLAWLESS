-- ============================================================
-- 559 Flawless — 079: a facial handed back
--
-- Included sessions are used automatically at booking (050, 078) and returned
-- automatically on a cancellation (078). What was missing is the person: a
-- manager deciding a no-show was the studio's fault, or that a member should
-- have one back as goodwill.
--
-- give_back_membership_session() deletes one redemption — the period has the
-- session again — and is careful about the visit it was spent on:
--
--   * a visit still AHEAD (pending, confirmed, checked in) goes back to its
--     normal price, because otherwise the member keeps the free facial on that
--     visit AND gets the session back — the same facial twice;
--   * a visit already OVER (completed, no-show) is left as it was. Handing the
--     session back is then the goodwill, and that visit's history stands.
--
-- Manager and up, like every other write to redemptions (050).
-- ============================================================

create or replace function public.give_back_membership_session(p_redemption bigint)
returns text language plpgsql security definer set search_path = public as $$
declare
  r     record;
  appt  record;
begin
  if not public.is_manager() then
    raise exception 'Only a manager can give a membership session back';
  end if;

  select id, appointment_id, value_cents into r
  from public.membership_redemptions where id = p_redemption
  for update;
  if r.id is null then
    raise exception 'That session was not found — it may already have been given back';
  end if;

  select id, status into appt from public.appointments where id = r.appointment_id for update;

  if appt.id is not null and appt.status in ('pending', 'confirmed', 'checked_in') then
    update public.appointments
    set membership_covered_cents = greatest(membership_covered_cents - r.value_cents, 0)
    where id = appt.id;
    delete from public.membership_redemptions where id = r.id;
    return 'repriced';
  end if;

  delete from public.membership_redemptions where id = r.id;
  return 'returned';
end;
$$;

revoke all on function public.give_back_membership_session(bigint) from public, anon;
grant execute on function public.give_back_membership_session(bigint) to authenticated;
