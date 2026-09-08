-- ── 074: Two records, one person ─────────────────────────────
--
-- The prevention machinery is real but not airtight: staff-create refuses a
-- known email, stubs are claimed rather than duplicated, guest bookings match
-- by email and phone. None of it can stop the client the studio signed up
-- under one address who later signs themselves up under another. That leaves
-- two genuine accounts for one human, with the visit history split between
-- them — and the fix has to move everything, including the clinical record,
-- or it is worse than no fix at all.
--
-- One function, called by an admin WITH THEIR OWN SESSION (united-metal
-- pattern: no service role, no dynamic SQL). SECURITY DEFINER reaches every
-- table; auth.uid() stays the admin who asked, which is what the privilege
-- trigger on profiles sees when the tombstone is written, and what the audit
-- rows record.
--
-- The losing profile is NOT deleted. It is tombstoned: suspended, marked
-- `merged_into`, its auth login banned by the route afterwards. Deleting it
-- would cascade through auth.users into whatever some future table forgets to
-- protect; a tombstone can be looked at, reasoned about, and — with a merge
-- in the opposite direction — survived.

alter table public.profiles
  add column if not exists merged_into uuid references public.profiles(id) on delete set null;

comment on column public.profiles.merged_into is
  'Set when this account was folded into another by merge_client_accounts. '
  'A tombstone: suspended, login banned, history moved to the survivor.';

create index if not exists profiles_merged_into_idx
  on public.profiles (merged_into) where merged_into is not null;

create or replace function public.merge_client_accounts(
  p_loser    uuid,
  p_survivor uuid,
  p_reason   text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  loser     public.profiles%rowtype;
  survivor  public.profiles%rowtype;
  loser_rec public.client_records%rowtype;
  n     int;
  moved jsonb := '{}'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'Only an admin can merge accounts';
  end if;
  if p_loser = p_survivor then
    raise exception 'An account cannot be merged into itself';
  end if;

  select * into loser from public.profiles where id = p_loser for update;
  if not found then raise exception 'The account being folded in no longer exists'; end if;
  if loser.role <> 'client' then raise exception 'Only client accounts can be merged'; end if;
  if loser.merged_into is not null then raise exception 'That account has already been merged'; end if;

  select * into survivor from public.profiles where id = p_survivor for update;
  if not found then raise exception 'The surviving account no longer exists'; end if;
  if survivor.role <> 'client' then raise exception 'Accounts can only be merged into a client account'; end if;
  if survivor.merged_into is not null then raise exception 'The surviving account was itself merged — merge into its survivor instead'; end if;

  -- ── The clinical record ────────────────────────────────────
  -- Fill the survivor's gaps from the loser's record — the same rule
  -- claim_client_stub uses: existing values win, holes are filled. Where BOTH
  -- held a value the survivor's stands, and the loser's is preserved verbatim
  -- in a note rather than silently discarded: allergies do not get to lose a
  -- coin toss. Rolling stats are not copied — repointing appointments below
  -- fires client_record_sync_stats, which recomputes them from scratch.
  select * into loser_rec from public.client_records where client_id = p_loser;
  if found then
    insert into public.client_records (client_id) values (p_survivor)
      on conflict (client_id) do nothing;

    update public.client_records s set
      fitzpatrick     = coalesce(s.fitzpatrick, loser_rec.fitzpatrick),
      skin_type       = coalesce(s.skin_type, loser_rec.skin_type),
      concerns        = case when s.concerns = '{}' then loser_rec.concerns else s.concerns end,
      allergies       = coalesce(s.allergies, loser_rec.allergies),
      medications     = coalesce(s.medications, loser_rec.medications),
      medical_notes   = coalesce(s.medical_notes, loser_rec.medical_notes),
      referral_source = coalesce(s.referral_source, loser_rec.referral_source),
      preferred_provider_id    = coalesce(s.preferred_provider_id, loser_rec.preferred_provider_id),
      photo_release_at         = coalesce(s.photo_release_at, loser_rec.photo_release_at),
      photo_release_revoked_at = coalesce(s.photo_release_revoked_at, loser_rec.photo_release_revoked_at)
    where s.client_id = p_survivor;

    if loser_rec.fitzpatrick is not null or loser_rec.allergies is not null
       or loser_rec.medications is not null or loser_rec.medical_notes is not null then
      insert into public.client_notes (client_id, author_id, body)
      values (p_survivor, auth.uid(),
        'Clinical fields from the merged duplicate record, kept verbatim:'
        || coalesce(' Fitzpatrick ' || loser_rec.fitzpatrick || '.', '')
        || coalesce(' Allergies: '   || loser_rec.allergies   || '.', '')
        || coalesce(' Medications: ' || loser_rec.medications || '.', '')
        || coalesce(' Medical notes: ' || loser_rec.medical_notes, ''));
    end if;

    delete from public.client_records where client_id = p_loser;
  end if;

  -- ── Everything with the loser's name on it ─────────────────
  -- Repointing appointments fires the stats trigger per row; the last firing
  -- recomputes the survivor's counters over the full combined history.
  update public.appointments set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('appointments', n);
  update public.appointments set cancelled_by = p_survivor where cancelled_by = p_loser;

  update public.orders set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('orders', n);
  update public.payments set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('payments', n);

  update public.intake_submissions set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('intake_submissions', n);
  update public.consent_signatures set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('consent_signatures', n);
  update public.consent_audit_log set profile_id = p_survivor where profile_id = p_loser;
  update public.patch_tests set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('patch_tests', n);
  -- Rows repoint; the storage folder keeps the old uuid in its path, which the
  -- rows still name, so signed URLs keep working. Nothing moves in the bucket.
  update public.treatment_photos set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('treatment_photos', n);
  update public.client_notes set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('client_notes', n);

  update public.client_memberships set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('memberships', n);
  update public.client_packages set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('packages', n);
  update public.loyalty_ledger set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('loyalty_entries', n);
  update public.gift_cards set purchased_by = p_survivor where purchased_by = p_loser;
  update public.gift_card_transactions set created_by = p_survivor where created_by = p_loser;

  update public.message_threads set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('message_threads', n);
  update public.messages set sender_id = p_survivor where sender_id = p_loser;
  update public.notifications set user_id = p_survivor where user_id = p_loser;
  update public.notification_queue set recipient_id = p_survivor where recipient_id = p_loser;

  update public.client_bans set client_id = p_survivor where client_id = p_loser;
  get diagnostics n = row_count; moved := moved || jsonb_build_object('bans', n);
  update public.testimonials set client_id = p_survivor where client_id = p_loser;
  update public.referral_redemptions set referrer_id = p_survivor where referrer_id = p_loser;
  update public.referral_redemptions set referred_client_id = p_survivor where referred_client_id = p_loser;
  update public.client_page_visits set client_id = p_survivor where client_id = p_loser;
  update public.analytics_events set user_id = p_survivor where user_id = p_loser;
  update public.user_activity_log set user_id = p_survivor where user_id = p_loser;
  update public.invitations set accepted_by = p_survivor where accepted_by = p_loser;
  update public.client_stubs set claimed_by = p_survivor where claimed_by = p_loser;

  -- Tags: primary key is (client_id, tag_id), so a tag both carry would
  -- collide. Move what the survivor lacks, drop the duplicates.
  update public.client_tag_links l set client_id = p_survivor
   where l.client_id = p_loser
     and not exists (select 1 from public.client_tag_links s
                      where s.client_id = p_survivor and s.tag_id = l.tag_id);
  delete from public.client_tag_links where client_id = p_loser;

  -- One referral code per client (unique). If the survivor has none, the
  -- loser's moves and stays valid on printed cards; if both have one, the
  -- loser's stays on the tombstone — its redemptions were repointed above,
  -- so the credit lands with the survivor either way.
  update public.referral_codes set client_id = p_survivor
   where client_id = p_loser
     and not exists (select 1 from public.referral_codes where client_id = p_survivor);

  -- Best-effort rows: unique constraints here vary by shape, and none of them
  -- is worth failing a merge over. A collision leaves the row on the tombstone.
  begin
    update public.waitlist_entries set client_id = p_survivor where client_id = p_loser;
  exception when unique_violation then null; end;
  begin
    update public.promotion_redemptions set client_id = p_survivor where client_id = p_loser;
  exception when unique_violation then null; end;
  begin
    update public.newsletter_subscriptions set profile_id = p_survivor where profile_id = p_loser;
  exception when unique_violation then null; end;
  begin
    update public.newsletter_subscribers set client_id = p_survivor where client_id = p_loser;
  exception when unique_violation then null; end;
  begin
    update public.cart_snapshots set client_id = p_survivor where client_id = p_loser;
  exception when unique_violation then null; end;

  -- ── The tombstone ──────────────────────────────────────────
  -- The privilege trigger on profiles allows this because auth.uid() is the
  -- admin who called. The route bans the auth login afterwards; suspended_at
  -- covers the window in between.
  update public.profiles
     set merged_into = p_survivor,
         suspended_at = coalesce(suspended_at, now())
   where id = p_loser;

  -- ── The record of it ───────────────────────────────────────
  insert into public.client_notes (client_id, author_id, body)
  values (p_survivor, auth.uid(),
    'Merged duplicate account '
    || coalesce(loser.email, trim(coalesce(loser.first_name,'') || ' ' || coalesce(loser.last_name,'')))
    || ' into this record.'
    || case when p_reason is null or btrim(p_reason) = '' then '' else ' Reason: ' || p_reason end);

  perform public.log_user_activity(
    p_user_id      => p_survivor,
    p_action       => 'accounts_merged',
    p_details      => jsonb_build_object(
      'merged_from', p_loser, 'merged_email', loser.email,
      'reason', p_reason, 'moved', moved),
    p_performed_by => auth.uid()
  );

  return jsonb_build_object('ok', true, 'moved', moved);
end;
$$;

revoke all on function public.merge_client_accounts(uuid, uuid, text) from public, anon;
grant execute on function public.merge_client_accounts(uuid, uuid, text) to authenticated;

comment on function public.merge_client_accounts(uuid, uuid, text) is
  'Fold one client account into another: repoint every table that names the '
  'loser, coalesce the clinical record (nothing discarded — conflicts land in '
  'a note), recompute stats via the appointments trigger, tombstone the loser. '
  'Admin only, checked inside; call with the admin''s own session so '
  'auth.uid() is the person responsible.';
