-- ============================================================
-- 559 Flawless — 085: a guard that trusted no login
--
-- A family of SECURITY DEFINER functions opens with
--
--   if auth.uid() is not null and not public.is_manager() then raise ...
--
-- (or is_front_desk, is_staff, is_admin, or a filter of the shape
-- `is_staff() or auth.uid() is null`). The reading behind it was "no JWT means
-- the service role, a scheduled job or the SQL editor, all already
-- privileged". That holds only if nobody else can reach the function without a
-- JWT, and somebody can: CREATE FUNCTION grants EXECUTE to PUBLIC, Supabase's
-- default privileges grant it to anon as well, and a request made with the
-- public anon key and no session runs with auth.uid() null. The guard then
-- waves a stranger through as if they were the service role. 050 granted
-- renew_membership and mark_membership_charge_paid to authenticated and never
-- took them away from anyone else, so anyone holding the anon key could renew
-- a membership or mark a charge paid. Others in the family were worse (the
-- sales tax rate, the ledger, stock counts).
--
-- The fix is the grant, not the guard: revoke from public and anon, grant to
-- authenticated (every one of these is called from a signed-in browser or
-- route somewhere in src) and service_role. The guard is left alone; with anon
-- shut out, a null auth.uid() once again means what it was written to mean.
--
-- Revoked from public and anon here:
--   renew_membership(bigint)
--   mark_membership_charge_paid(bigint, text, text)
--   publish_consent_version(bigint, text, text, bigint[], bigint[], int, boolean)  (026)
--   set_sales_tax_rate(numeric)                                                   (026)
--   record_payment(int, text, text, uuid, bigint, text)                           (025)
--   replace_calendar_busy(uuid, timestamptz, timestamptz, jsonb)                  (027)
--   adjust_stock(bigint, numeric, stock_reason, text, uuid, bigint)               (032)
--   generate_recurring_expenses(date)                                             (033)
--   correct_time_entry(bigint, timestamptz, timestamptz, text, bigint)            (035)
--   time_clock_reminder_candidates(integer, integer, integer)                     (035)
--   send_time_clock_reminders(integer, integer, integer)                          (035, 077)
--   resource_conflicts(bigint, timestamptz, timestamptz, bigint[], uuid)          (037, anon only before)
--   waitlist_matches(uuid)                                                        (037, anon only before)
--   waitlist_notify_for_appointment(uuid, int)                                    (037, anon only before)
--   waitlist_sweep()                                                              (037, anon only before)
--   get_or_create_referral_code(uuid)                                             (068, public only before)
--
-- waitlist_release_expired() (037) has no guard at all and nothing in src
-- calls it; its only callers are waitlist_sweep() and
-- waitlist_notify_for_appointment(), both SECURITY DEFINER, which run as the
-- owner and need no grant. So it is revoked from public, anon AND
-- authenticated, and granted to service_role only.
--
-- Already closed by their own migration and not touched: scheduled_job_status
-- (044), client_claim_status (055), notify_expiring_licences (041),
-- publish_intake_version (046), purge_empty_profile (056). Trigger functions
-- with the same guard (track_profile_creator, staff_permissions_guard,
-- role_permissions_guard, guard_bookable_flag and the rest) cannot be called
-- through the API, so they are not in the list.
--
-- Revoking from anon alone (037) is not enough: anon is a member of PUBLIC, and
-- the PUBLIC grant still lets it in. Revoking from PUBLIC alone (068) is not
-- enough either: Supabase grants anon directly. Both, every time.
--
-- Every statement is guarded on the function existing; running this twice
-- changes nothing.
-- ============================================================

do $$
declare
  sig text;
begin
  foreach sig in array array[
    'public.renew_membership(bigint)',
    'public.mark_membership_charge_paid(bigint, text, text)',
    'public.publish_consent_version(bigint, text, text, bigint[], bigint[], int, boolean)',
    'public.set_sales_tax_rate(numeric)',
    'public.record_payment(int, text, text, uuid, bigint, text)',
    'public.replace_calendar_busy(uuid, timestamptz, timestamptz, jsonb)',
    'public.adjust_stock(bigint, numeric, public.stock_reason, text, uuid, bigint)',
    'public.generate_recurring_expenses(date)',
    'public.correct_time_entry(bigint, timestamptz, timestamptz, text, bigint)',
    'public.time_clock_reminder_candidates(integer, integer, integer)',
    'public.send_time_clock_reminders(integer, integer, integer)',
    'public.resource_conflicts(bigint, timestamptz, timestamptz, bigint[], uuid)',
    'public.waitlist_matches(uuid)',
    'public.waitlist_notify_for_appointment(uuid, int)',
    'public.waitlist_sweep()',
    'public.get_or_create_referral_code(uuid)'
  ]
  loop
    if to_regprocedure(sig) is null then
      raise notice '085: % does not exist, skipped', sig;
      continue;
    end if;
    execute format('revoke all on function %s from public, anon', sig);
    execute format('grant execute on function %s to authenticated, service_role', sig);
  end loop;
end;
$$;

do $$
begin
  if to_regprocedure('public.waitlist_release_expired()') is null then
    raise notice '085: public.waitlist_release_expired() does not exist, skipped';
    return;
  end if;
  revoke all on function public.waitlist_release_expired() from public, anon, authenticated;
  grant execute on function public.waitlist_release_expired() to service_role;
end;
$$;
