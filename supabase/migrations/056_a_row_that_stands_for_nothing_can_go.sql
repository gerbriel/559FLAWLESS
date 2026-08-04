-- ============================================================
-- 559 Flawless — 056: a row that stands for nothing can go
--
-- The Clients screen is nineteen rows of "Deleted Account". 030 built that on
-- purpose: deletion anonymises rather than deletes, because the business keeps
-- what tangibly happened — appointments, money, signed consent — and the person
-- stops being identifiable in it. For a client with history, that shell row is
-- load-bearing. Appointments still point at it, signatures still hang off it,
-- and 030's roster note says why the name renders at all: a blank row "looks
-- like a bug"; "Deleted Account" is a fact.
--
-- But most of these nineteen have no history. They are test accounts, or
-- clients who signed up and never came, deleted before anything happened. For
-- them the shell preserves nothing — there is no appointment to point at it, no
-- signature to keep readable, no order to account for. It is a tombstone over
-- an empty grave, and nineteen of them bury the actual client list.
--
-- ── Why this is a function and not a DELETE button ───────────
--
-- Because whether the delete is safe is a fact about forty foreign keys, and
-- several of them would lie about it. `consent_signatures.client_id`,
-- `intake_submissions.client_id`, `treatment_photos.client_id` and
-- `client_notes.client_id` are all ON DELETE CASCADE — a plain DELETE on the
-- wrong profile would not fail, it would quietly take the clinical record with
-- it. AGENTS.md rule 5 says nothing may do that. So the judgement "this row
-- stands for nothing" is made here, next to the data, by checking the four
-- things that make a client tangible:
--
--     an appointment, as client or as guest-matched
--     a consent signature or an intake submission
--     a treatment photo
--     a payment, through any appointment (orders and payments do not
--       reference profiles directly; they hang off appointments)
--
-- Any of those present → the profile is REFUSED, whatever its name says. The
-- shell is doing its job and stays. None present → the profile row goes, the
-- auth user is deleted by the API route alongside (auth.users is not
-- reachable from SQL here), and the `deleted_accounts` audit row is KEPT —
-- the record that an account was deleted is not the account.
--
-- Staff accounts are refused outright. A provider row is load-bearing in ways
-- no client row is (appointments.provider_id is RESTRICT), and removing staff
-- is suspension, not deletion.
--
-- ── Who may call it ──────────────────────────────────────────
--
-- Admin only. This is the first genuinely destructive verb in the schema —
-- everything else archives, anonymises or refuses — and the narrowest audience
-- for a new destructive verb is the right starting point. It can be widened to
-- managers later in one line; it cannot be un-run.
--
-- The stubs need none of this. A stub is a contact and an intention — 051's
-- words — with no clinical record, no money and no appointments possible. RLS
-- already lets front desk delete one; the screen just never offered it. That
-- half of the request is UI alone.
--
-- Every statement is guarded; running this file twice changes nothing.
-- ============================================================

/**
 * Delete an anonymised client profile that stands for nothing.
 *
 * Returns the profile id when it deleted, and raises with a plain sentence
 * when it refuses. The caller deletes the auth user only after this commits —
 * a profile that cannot be deleted must keep its login row untouched.
 */
create or replace function public.purge_empty_profile(p_profile uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  target record;
  target_email text;
begin
  if auth.uid() is not null and not public.is_admin() then
    raise exception 'Only an admin can permanently delete a client';
  end if;

  select p.*, (d.profile_id is not null) as was_anonymised
    into target
  from public.profiles p
  left join public.deleted_accounts d on d.profile_id = p.id
  where p.id = p_profile
  for update of p;

  if not found then
    raise exception 'No such profile';
  end if;

  if target.role <> 'client' then
    raise exception 'Staff accounts are suspended, never deleted — their rows are load-bearing';
  end if;

  -- ── The four things that make a client tangible ────────────
  if exists (select 1 from public.appointments a where a.client_id = p_profile) then
    raise exception 'This client has appointments on record, so the row stays. Their identity is already removed.';
  end if;

  -- A guest booking matched later by email would re-point at this profile;
  -- check the address too while it still exists on the row.
  target_email := nullif(lower(btrim(coalesce(target.email, ''))), '');
  if target_email is not null and exists (
    select 1 from public.appointments a where lower(a.guest_email) = target_email
  ) then
    raise exception 'This client has guest bookings under their address, so the row stays.';
  end if;

  if exists (select 1 from public.consent_signatures s where s.client_id = p_profile)
     or exists (select 1 from public.intake_submissions i where i.client_id = p_profile) then
    raise exception 'This client signed forms. Signed consent is never deleted.';
  end if;

  if exists (select 1 from public.treatment_photos t where t.client_id = p_profile) then
    raise exception 'This client has treatment photos on record, so the row stays.';
  end if;

  -- Money hangs off appointments, and no appointments exist by this point —
  -- but gift cards purchased by the profile reference it directly.
  if exists (select 1 from public.gift_cards g where g.purchased_by = p_profile) then
    raise exception 'This client purchased a gift card, so the row stays.';
  end if;

  -- Everything else that references this profile is either SET NULL (logs,
  -- analytics) or CASCADE over rows that are themselves intangible for a
  -- client with no visits (tags, bans, waitlist entries, memberships that were
  -- never redeemed against an appointment). The one CASCADE worth naming:
  -- client_memberships goes with the profile, and any membership_charges rows
  -- go with it — a charge log for a person with no appointments and no orders
  -- records intent, not money moved, and keeping it under a deleted profile
  -- would keep a row nothing can ever display.

  delete from public.profiles where id = p_profile;

  -- The audit row survives on purpose. deleted_accounts.profile_id has no FK —
  -- 030 built it as a standalone record precisely so it outlives everything.
  return p_profile;
end;
$$;

revoke all on function public.purge_empty_profile(uuid) from public, anon;
grant execute on function public.purge_empty_profile(uuid) to authenticated, service_role;

comment on function public.purge_empty_profile(uuid) is
  'Remove an anonymised client row that no appointment, signature, photo or '
  'gift card references. Refuses — with a sentence, not a constraint dump — '
  'whenever the shell row is still standing for something. Admin only. The '
  'deleted_accounts audit row is kept: the record that an account was deleted '
  'is not the account.';
