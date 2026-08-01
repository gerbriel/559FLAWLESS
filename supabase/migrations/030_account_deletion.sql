-- ============================================================
-- 559 Flawless — 030: a client deletes their account
--
-- "Users should be able to delete accounts + all their own info (minus actual
--  orders they purchased, forms they signed)."
--
-- So this migration anonymises. It does not delete. The distinction is the
-- whole design, and it is forced on us by three separate facts.
--
-- ── 1. Deleting the account destroys the records we must keep ──
--
-- `profiles.id references auth.users(id) on delete cascade`, and ten tables
-- cascade again from `profiles`:
--
--   client_records, client_notes, consent_signatures, intake_submissions,
--   patch_tests, treatment_photos, client_tag_links, client_packages
--   (→ package_redemptions), user_activity_log, notifications
--
-- Nothing is protected by RESTRICT. Deleting one auth user therefore erases
-- every signed consent, every health intake, every patch test, every clinical
-- note and every prepaid package balance belonging to that person — measured
-- on a full fixture, all of them dropped to zero. `appointments.client_id` and
-- `orders.client_id` are SET NULL, so the appointment and the receipt survive
-- but stop pointing at anybody, which is worse than either keeping or losing
-- them: an unattributable sale is a hole in the sales-tax record.
--
-- ── 2. And for an ordinary booking it does not even work ──
--
-- `appointments` carries `check (client_id is not null or guest_email is not
-- null or guest_phone is not null)`. ON DELETE SET NULL is an UPDATE, and an
-- UPDATE re-checks the constraint. A booking made by a signed-in client with
-- no guest_* fields therefore fails the delete outright with SQLSTATE 23514.
-- `message_threads` has the identical trap in `thread_has_contact`. The naive
-- "delete my account" is destructive when it succeeds and broken when it
-- doesn't, depending on how the booking happened to be made.
--
-- ── 3. There is a genuine obligation on the other side ──
--
--   Sales and use tax (CDTFA)        4 years  — orders, order_items, payments
--   Federal income tax (IRS)         3–7 years — the same rows
--   Treatment and consent records    7+ years, per esthetics liability cover
--                                    and California's negligence limitations
--                                    period, which tolls for minors
--
-- A signed consent whose signatory has been erased is not evidence of
-- anything, which defeats the reason for keeping it. The same is true of a
-- clinical note: it is a contemporaneous professional record, and editing its
-- text after the fact destroys exactly the quality that makes it worth having.
--
-- ── What this migration therefore does ──
--
-- Keeps the `profiles` row and scrubs it in place, so every FK above stays
-- valid and every retained record keeps pointing at a real (now nameless) key.
-- Removes the ability to identify the person: name, email, phone, date of
-- birth, address, avatar, marketing subscriptions, the messages they wrote,
-- the analytics trail, and the photographs of them. Sign-in is stopped at the
-- auth layer, not by `suspended_at` — that column is a staff gate, and the
-- trigger from 001 forbids a non-admin changing it anyway.
-- ============================================================


-- ── The four calls that are legal, not technical ─────────────
--
-- Each of these trades erasure against evidence, and the answer depends on the
-- studio's insurer and counsel rather than on anything in this codebase. They
-- are settings, not hard-coded behaviour, so the owner can change her mind
-- without a migration — and so that "we kept your consent signature" is a
-- decision somebody made on purpose rather than an accident of implementation.
--
-- Every default below is the conservative one: keep the record, and rely on
-- the profile scrub to break the link to a living person.
create table if not exists public.account_deletion_policy (
  id smallint primary key default 1 check (id = 1),

  -- The name someone signed, their drawn signature, and the IP and user agent
  -- captured at signing. Scrubbing these guts the evidentiary value of the
  -- signature; keeping them means a name survives anonymisation. Note that
  -- `body_snapshot` is template text and is always kept — it is what they
  -- agreed TO, not who they are.
  scrub_consent_signature_identity boolean not null default false,

  -- allergies, medications, medical_notes, fitzpatrick, skin_type, concerns.
  -- These are the clinical justification for what was done to someone. On
  -- their own, with no name attached, they identify nobody.
  scrub_client_record_clinical boolean not null default false,

  -- Provider SOAP notes tied to a visit. Free text, so a name can appear
  -- inside one; but it is the treatment record and rewriting it is
  -- falsification.
  scrub_treatment_notes boolean not null default false,

  -- Notes with no appointment attached are not treatment records — the
  -- staff account-creation path writes one from a free-text box. Scrubbed by
  -- default for that reason.
  scrub_unlinked_notes boolean not null default true,

  -- consent_audit_log exists to prove marketing consent was given and
  -- withdrawn. Its content is an email address, so erasing it fails the very
  -- thing it documents. Kept by default.
  scrub_consent_audit_email boolean not null default false,

  updated_at timestamptz not null default now()
);

insert into public.account_deletion_policy (id) values (1) on conflict (id) do nothing;

drop trigger if exists account_deletion_policy_touch on public.account_deletion_policy;
create trigger account_deletion_policy_touch before update on public.account_deletion_policy
  for each row execute function public.touch_updated_at();

comment on table public.account_deletion_policy is
  'Which records survive an account deletion. Every default is the conservative '
  '(retain) choice; changing one is a legal decision, not an engineering one.';


-- ── The tombstone ────────────────────────────────────────────
--
-- So the studio can answer "did this person delete their data?" without
-- keeping the data. Deliberately holds no identifier beyond the uuid that is
-- already stamped on every retained appointment and receipt.
--
-- No hash of the email either: an email address is drawn from a small enough
-- space that a hash is recovered by guessing, so storing one would be keeping
-- the address under a thin disguise rather than anonymising it.
--
-- No foreign key to `profiles`, on purpose. This row's job is to outlive the
-- account, including the case where somebody later hard-deletes the profile
-- despite everything above.
create table if not exists public.deleted_accounts (
  profile_id    uuid primary key,
  deleted_at    timestamptz not null default now(),

  -- 'self' — the client pressed the button. 'admin' — a request arrived by
  -- phone or email and staff actioned it.
  requested_by  text not null check (requested_by in ('self', 'admin')),
  performed_by  uuid,

  -- Counts only. What survived, and what was removed.
  kept          jsonb not null default '{}'::jsonb,
  removed       jsonb not null default '{}'::jsonb,

  -- Whether the auth identity could be scrubbed from SQL. False means the API
  -- route has to finish the job through the GoTrue admin API — see the
  -- exception handler in anonymise_account().
  auth_scrubbed boolean not null default false,

  -- Private-bucket objects the caller still has to remove. SQL cannot delete
  -- from object storage, and the rows that named those paths are gone, so
  -- without this list the files would be orphaned with no way to find them.
  -- Cleared by the API route once storage confirms the delete.
  pending_storage_paths text[] not null default '{}',
  storage_purged_at timestamptz
);

comment on table public.deleted_accounts is
  'One row per anonymised account. Answers "did someone delete their data?" '
  'without retaining the data.';

alter table public.deleted_accounts enable row level security;
alter table public.account_deletion_policy enable row level security;

-- A client may confirm their own deletion landed; that is the only reason they
-- would ever read this, and it holds nothing about them but counts.
drop policy if exists "client reads own tombstone" on public.deleted_accounts;
create policy "client reads own tombstone" on public.deleted_accounts
  for select using (profile_id = auth.uid());
drop policy if exists "manager reads tombstones" on public.deleted_accounts;
create policy "manager reads tombstones" on public.deleted_accounts
  for select using (public.is_manager());
-- Writes come from anonymise_account() only, which runs as the owner.

drop policy if exists "staff reads deletion policy" on public.account_deletion_policy;
create policy "staff reads deletion policy" on public.account_deletion_policy
  for select using (public.is_staff());
drop policy if exists "admin writes deletion policy" on public.account_deletion_policy;
create policy "admin writes deletion policy" on public.account_deletion_policy
  for all using (public.is_admin()) with check (public.is_admin());


-- ── An anonymised account stays anonymised ───────────────────
--
-- 023 wired `handle_new_user` to `after update of raw_user_meta_data on
-- auth.users` so a name arriving late from Google is not lost, and its upsert
-- reads `coalesce(public.profiles.first_name, excluded.first_name)`. That is
-- right for a live account and catastrophic for a scrubbed one: the next OAuth
-- sign-in would quietly restore the name, email and avatar we had just
-- removed. One guard at the top fixes every column at once, which is why the
-- scrub below does not have to defend itself field by field.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  meta      jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  full_name text;
  first     text;
  last      text;
begin
  if exists (select 1 from public.deleted_accounts where profile_id = new.id) then
    return new;
  end if;

  first := nullif(trim(coalesce(meta ->> 'first_name', meta ->> 'given_name', '')), '');
  last  := nullif(trim(coalesce(meta ->> 'last_name',  meta ->> 'family_name', '')), '');

  full_name := nullif(trim(coalesce(meta ->> 'full_name', meta ->> 'name', '')), '');

  if first is null and full_name is not null then
    first := split_part(full_name, ' ', 1);
    last  := nullif(trim(substr(full_name, length(split_part(full_name, ' ', 1)) + 1)), '');
  end if;

  insert into public.profiles (id, email, first_name, last_name, phone, avatar_url, role)
  values (
    new.id,
    new.email,
    first,
    last,
    nullif(trim(coalesce(meta ->> 'phone', new.phone, '')), ''),
    nullif(trim(coalesce(meta ->> 'avatar_url', meta ->> 'picture', '')), ''),
    'client'
  )
  on conflict (id) do update
    set email      = coalesce(public.profiles.email, excluded.email),
        first_name = coalesce(public.profiles.first_name, excluded.first_name),
        last_name  = coalesce(public.profiles.last_name, excluded.last_name),
        avatar_url = coalesce(public.profiles.avatar_url, excluded.avatar_url);

  return new;
end;
$$;


-- ── The scrub ────────────────────────────────────────────────
/**
 * Anonymise one client account.
 *
 * A client may only do this to themselves. An admin may do it for anyone,
 * because right-to-erasure requests arrive by phone.
 *
 * Clients only. A provider's name is on every appointment they performed and
 * on their licence; erasing a staff member is an employment-records question
 * with a different answer, and this function refuses rather than guessing.
 *
 * Idempotent: every statement is an assignment to a fixed value or a delete of
 * rows already gone, so running it twice changes nothing and the original
 * `deleted_at` is preserved.
 *
 * Returns the counts, plus the storage paths the caller must still purge.
 */
create or replace function public.anonymise_account(p_client uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_caller   uuid := auth.uid();
  v_profile  public.profiles%rowtype;
  v_policy   public.account_deletion_policy%rowtype;
  v_email    text;
  v_tag      text;
  v_stub     text;     -- per-account placeholder address
  v_sessions text[];
  v_paths    text[];
  v_kept     jsonb;
  v_auth_ok  boolean := false;
  v_by       text;
  n          bigint;
  v_removed  jsonb := '{}'::jsonb;
begin
  select * into v_profile from public.profiles where id = p_client;
  if not found then
    raise exception 'No such account' using errcode = 'no_data_found';
  end if;

  -- Authorisation. `v_caller is null` means there is no JWT on the connection:
  -- the SQL editor, a migration, or the service role, all of which are already
  -- privileged. `anon` cannot arrive here at all — EXECUTE is revoked from it
  -- at the bottom of this file, which is what stops an unauthenticated request
  -- passing somebody else's uuid.
  if v_caller is null then
    v_by := 'admin';
  elsif v_caller = p_client then
    v_by := 'self';
  elsif public.is_admin() then
    v_by := 'admin';
  else
    raise exception 'You can only delete your own account'
      using errcode = 'insufficient_privilege';
  end if;

  if v_profile.role <> 'client' then
    raise exception 'Staff accounts are employment records and cannot be self-deleted'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_policy from public.account_deletion_policy where id = 1;

  v_email := v_profile.email;
  v_tag   := replace(p_client::text, '-', '');
  -- .invalid is reserved by RFC 2606 and can never be routed, so a stray
  -- mailing to a scrubbed account goes nowhere. Per-account, not a shared
  -- constant: `newsletter_subscribers.email` is UNIQUE, and a shared stub
  -- would make the second deletion collide with the first.
  v_stub  := 'deleted-' || v_tag || '@deleted.invalid';

  -- What survives. Counted before anything is touched, so the tombstone
  -- records what the studio actually still holds.
  v_kept := jsonb_build_object(
    'appointments',        (select count(*) from public.appointments where client_id = p_client),
    'orders',              (select count(*) from public.orders where client_id = p_client and status <> 'cart'),
    'payments',            (select count(*) from public.payments where client_id = p_client),
    'consent_signatures',  (select count(*) from public.consent_signatures where client_id = p_client),
    'intake_submissions',  (select count(*) from public.intake_submissions where client_id = p_client),
    'clinical_notes',      (select count(*) from public.client_notes where client_id = p_client),
    'patch_tests',         (select count(*) from public.patch_tests where client_id = p_client),
    'gift_cards',          (select count(*) from public.gift_cards where purchased_by = p_client),
    'prepaid_packages',    (select count(*) from public.client_packages where client_id = p_client)
  );

  -- The tombstone goes in FIRST. `handle_new_user` above keys off it, so from
  -- this statement onward nothing can quietly restore what we are about to
  -- remove — including the auth.users update two blocks below, which fires
  -- that very trigger.
  insert into public.deleted_accounts (profile_id, requested_by, performed_by, kept)
  values (p_client, v_by, v_caller, v_kept)
  on conflict (profile_id) do update set kept = excluded.kept;

  -- ── Marketing, in the one order that works ─────────────────
  --
  -- `sync_marketing_consent` (016) fires `before update of marketing_opt_in`
  -- and does two things with the CURRENT email: unsubscribes the newsletter
  -- row that matches it, and writes an audit row containing it. Scrub the
  -- email in the same statement and the unsubscribe silently matches nothing;
  -- scrub it afterwards and the real address has already been copied into the
  -- audit log at the moment of anonymisation. So: unsubscribe explicitly by
  -- id first, flip the flag while the email is still intact, and only then
  -- take the email away.
  delete from public.newsletter_subscriptions
   where profile_id = p_client
      or (v_email is not null and lower(email) = lower(v_email));
  get diagnostics n = row_count;
  v_removed := v_removed || jsonb_build_object('newsletter_subscriptions', n);

  delete from public.newsletter_subscribers
   where client_id = p_client
      or (v_email is not null and lower(email) = lower(v_email));
  get diagnostics n = row_count;
  v_removed := v_removed || jsonb_build_object('newsletter_subscribers', n);

  update public.profiles
     set marketing_opt_in = false,
         sms_opt_in       = false
   where id = p_client;

  -- Proof that consent was given and withdrawn. The event and its timestamp
  -- are the evidence; the address is only the subject line. Scrubbing it is
  -- off by default — see account_deletion_policy.
  if v_policy.scrub_consent_audit_email then
    update public.consent_audit_log
       set email      = v_stub,
           ip_address = null,
           user_agent = null,
           metadata   = '{}'::jsonb
     where profile_id = p_client
        or (v_email is not null and lower(email) = lower(v_email));
  else
    update public.consent_audit_log
       set ip_address = null,
           user_agent = null
     where profile_id = p_client
        or (v_email is not null and lower(email) = lower(v_email));
  end if;

  -- ── The auth identity ──────────────────────────────────────
  --
  -- Best effort from SQL. In a hosted Supabase project the `auth` schema is
  -- owned by supabase_auth_admin and this function's owner may not be able to
  -- write to it, so each statement is wrapped and failure is recorded rather
  -- than raised: the caller's data scrub must not be rolled back because
  -- GoTrue's tables were out of reach. The API route finishes the job through
  -- the admin API, which is the supported path; `auth_scrubbed` on the
  -- tombstone says whether it still needs to.
  begin
    update auth.users
       set email              = v_stub,
           phone              = null,
           raw_user_meta_data = '{}'::jsonb
     where id = p_client;
    v_auth_ok := true;
  exception when others then
    v_auth_ok := false;
  end;

  -- Sign-in has to stop, and `profiles.suspended_at` will not do it: the
  -- role-escalation guard from 001 rejects a non-admin changing it, and it
  -- gates staff surfaces anyway, not a client's login.
  if v_auth_ok and exists (
    select 1 from information_schema.columns
    where table_schema = 'auth' and table_name = 'users' and column_name = 'banned_until'
  ) then
    begin
      execute 'update auth.users set banned_until = $1 where id = $2'
        using now() + interval '100 years', p_client;
    exception when others then null;
    end;
  end if;

  -- The OAuth provider's own copy of their name and email.
  if v_auth_ok and to_regclass('auth.identities') is not null then
    begin
      execute 'update auth.identities set identity_data = '
              '  jsonb_build_object(''sub'', identity_data ->> ''sub'') '
              'where user_id = $1'
        using p_client;
    exception when others then null;
    end;
  end if;

  -- Kill live sessions so the scrub takes effect now rather than at the next
  -- token refresh. Refresh tokens hang off sessions and go with them.
  if v_auth_ok and to_regclass('auth.sessions') is not null then
    begin
      execute 'delete from auth.sessions where user_id = $1' using p_client;
    exception when others then null;
    end;
  end if;

  -- ── profiles ───────────────────────────────────────────────
  --
  -- Placeholders rather than NULLs for the name and email. Partly so the
  -- dashboard renders "Deleted Account" instead of a blank row that looks like
  -- a bug, partly as a second line of defence behind the handle_new_user guard
  -- above, whose coalesce would treat a NULL as "not set yet" and refill it.
  --
  -- Kept: `role` (still a client), `timezone` (a studio default, identifies
  -- nobody), `age_verified_at` and `terms_accepted_at` / `privacy_accepted_at`
  -- — bare timestamps that evidence an attestation without describing anyone,
  -- and the age one is what an intimate-services booking was gated on.
  update public.profiles
     set first_name           = 'Deleted',
         last_name            = 'Account',
         email                = null,
         phone                = null,
         date_of_birth        = null,
         pronouns             = null,
         avatar_url           = null,
         display_name         = null,
         slug                 = null,
         bio                  = null,
         marketing_consent_at = null,
         marketing_consent_ip = null
   where id = p_client;

  -- ── client_records ─────────────────────────────────────────
  -- `referral_source` is marketing attribution ("saw the Instagram ad"), not
  -- clinical, so it goes regardless. The visit counters and lifetime value are
  -- aggregates with no name on them and are what the studio's own reporting is
  -- built from. Withdrawing the blanket photo release is recorded as a
  -- revocation, never by clearing the original grant — same rule the settings
  -- page already follows.
  update public.client_records
     set referral_source = null,
         photo_release_revoked_at = coalesce(photo_release_revoked_at, now())
   where client_id = p_client;

  if v_policy.scrub_client_record_clinical then
    update public.client_records
       set fitzpatrick = null, skin_type = null, concerns = '{}',
           allergies = null, medications = null, medical_notes = null
     where client_id = p_client;
  end if;

  -- ── Clinical notes ─────────────────────────────────────────
  if v_policy.scrub_treatment_notes then
    update public.client_notes
       set body = '[removed at the client''s request]',
           products_used = null, next_visit_plan = null
     where client_id = p_client;
  elsif v_policy.scrub_unlinked_notes then
    -- A note attached to no visit is not a treatment record. The staff
    -- account-creation form writes one from a free-text box, so this is where
    -- "called about a Groupon, mobile is 559-…" ends up.
    update public.client_notes
       set body = '[removed at the client''s request]',
           products_used = null, next_visit_plan = null
     where client_id = p_client and appointment_id is null;
  end if;

  -- ── Consent signatures ─────────────────────────────────────
  if v_policy.scrub_consent_signature_identity then
    update public.consent_signatures
       set signed_name = 'Deleted Account', signature_data = null,
           ip_address = null, user_agent = null
     where client_id = p_client;
  end if;

  -- ── Appointments ───────────────────────────────────────────
  -- `client_id` stays: it is what keeps the sales-tax record attributable, and
  -- nulling it would trip `appointment_has_contact` once the guest columns are
  -- gone. The guest_* columns are a duplicate of the contact details on the
  -- profile — booking.ts writes them on every online booking even when the
  -- client is signed in — so they are pure contact data and go.
  --
  -- `client_notes` here is what the client typed into the booking form, and
  -- routinely carries a phone number or an address ("text me when you're
  -- ready"). What was actually done to them is in appointment_services, the
  -- provider's notes and the intake — none of which depend on this box.
  -- `staff_notes` is the studio's own record and stays.
  update public.appointments
     set guest_first_name = null,
         guest_last_name  = null,
         guest_email      = null,
         guest_phone      = null,
         client_notes     = null
   where client_id = p_client;

  -- ── Orders ─────────────────────────────────────────────────
  -- A cart is not a purchase. Nothing was sold, so there is nothing to keep.
  delete from public.orders where client_id = p_client and status = 'cart';
  get diagnostics n = row_count;
  v_removed := v_removed || jsonb_build_object('abandoned_carts', n);

  -- The name and street address go; the city, state and ZIP stay. That split
  -- is deliberate: California assesses sales tax by district, so where a parcel
  -- was shipped is part of the tax record the CDTFA can ask for, while "93728"
  -- covers thousands of households and names none of them.
  update public.orders
     set guest_name  = null,
         guest_email = null,
         guest_phone = null,
         ship_name   = null,
         ship_line1  = null,
         ship_line2  = null,
         notes       = null     -- client-supplied delivery instructions
   where client_id = p_client;

  -- ── Gift cards ─────────────────────────────────────────────
  -- The card and its balance stay: an unredeemed card is money the studio
  -- owes, and it may be in a third party's wallet right now. The personal note
  -- written on it has no such basis and goes.
  --
  -- `recipient_name` / `recipient_email` stay too, and that is not an
  -- oversight — that is somebody else's data and somebody else's entitlement
  -- to the balance. A person's right to erase their own information does not
  -- extend to erasing the record of what they gave to another.
  update public.gift_cards set message = null where purchased_by = p_client;

  -- ── Messages ───────────────────────────────────────────────
  -- The studio's replies stay: if the answer was "come in and we'll patch test
  -- first", that is a record worth having. What the client wrote is theirs,
  -- and the subject line is the first thing they typed.
  update public.message_threads
     set subject           = 'Conversation with a former client',
         guest_name        = null,
         guest_email       = null,
         guest_phone       = null,
         last_message_from = null,
         client_unread     = false
   where client_id = p_client;

  update public.messages m
     set body        = '[removed at the client''s request]',
         sender_name = null,
         attachments = '[]'::jsonb
   where m.sender_id = p_client and not m.is_internal;
  get diagnostics n = row_count;
  v_removed := v_removed || jsonb_build_object('messages_scrubbed', n);

  -- ── Notifications ──────────────────────────────────────────
  -- The client's own go entirely. The subtle ones are the STAFF copies: the
  -- triggers in 006 write "New booking — Maria Testcase" and the first 140
  -- characters of a client's message into rows addressed to the front desk.
  -- Those are keyed to the staff member's user_id, so nothing about deleting
  -- the client would ever have touched them. The row stays, so the inbox
  -- history is intact; the name comes out of it.
  delete from public.notifications where user_id = p_client;
  get diagnostics n = row_count;
  v_removed := v_removed || jsonb_build_object('own_notifications', n);

  update public.notifications
     set title = 'Former client',
         body  = null
   where user_id <> p_client
     and (appointment_id in (select id from public.appointments where client_id = p_client)
       or thread_id     in (select id from public.message_threads where client_id = p_client));
  get diagnostics n = row_count;
  v_removed := v_removed || jsonb_build_object('staff_notifications_scrubbed', n);

  -- ── Analytics ──────────────────────────────────────────────
  -- Deleted, not de-linked. Nulling `user_id` would look like anonymisation,
  -- but `analytics_events.meta` carries whatever the app put there — the
  -- intake form writes the client's health flags into it — and
  -- `client_page_visits` stores a raw IP and user agent beside every page in
  -- the trail. Neither survives having its owner column blanked in any
  -- meaningful sense, so both go, including the pre-login rows sharing a
  -- session id with a known one.
  select coalesce(array_agg(distinct session_id), '{}') into v_sessions
  from (
    select session_id from public.analytics_events where user_id = p_client
    union
    select session_id from public.client_page_visits where client_id = p_client
  ) s;

  delete from public.analytics_events
   where user_id = p_client or session_id = any(v_sessions);
  get diagnostics n = row_count;
  v_removed := v_removed || jsonb_build_object('analytics_events', n);

  delete from public.client_page_visits
   where client_id = p_client or session_id = any(v_sessions);
  get diagnostics n = row_count;
  v_removed := v_removed || jsonb_build_object('page_visits', n);

  -- An announcement can be aimed at named people.
  update public.announcements
     set target_audience = jsonb_set(
           target_audience, '{client_ids}',
           coalesce((
             select jsonb_agg(e)
             from jsonb_array_elements(target_audience -> 'client_ids') e
             where e <> to_jsonb(p_client::text)
           ), '[]'::jsonb))
   where target_audience -> 'client_ids' @> to_jsonb(p_client::text);

  -- ── CRM labels ─────────────────────────────────────────────
  -- Staff opinions ("VIP", "sensitive skin"), not records. There is a real
  -- cost here and it should be named: a `do-not-book` tag goes with them, and
  -- if they open a new account the studio starts from nothing. Honouring that
  -- tag would mean keeping the identity it is attached to, which is the exact
  -- opposite of what was asked for.
  delete from public.client_tag_links where client_id = p_client;
  get diagnostics n = row_count;
  v_removed := v_removed || jsonb_build_object('tags', n);

  -- ── Testimonials ───────────────────────────────────────────
  -- Public marketing content, published under their name with their
  -- permission. Withdrawing permission means taking it down, and the body
  -- itself often identifies the writer.
  delete from public.testimonials where client_id = p_client;
  get diagnostics n = row_count;
  v_removed := v_removed || jsonb_build_object('testimonials', n);

  -- ── Treatment photography ──────────────────────────────────
  -- A photograph of someone's face is the most identifying thing in the
  -- system, and photography here is consent-based and revocable by design —
  -- the settings page promises exactly that, per-image consent is a CHECK
  -- constraint, and `deletion_requested_at` already exists for this purpose.
  --
  -- The rows go rather than being flagged: `check (consent_given)` means the
  -- flag cannot be turned off, and a row pointing at a purged image is not a
  -- clinical record, it is a dangling path. That the treatment happened is
  -- recorded in the appointment and the provider's notes.
  --
  -- The paths are carried out on the tombstone because SQL cannot reach object
  -- storage: delete these rows without keeping the paths somewhere and the
  -- files are orphaned in a private bucket forever with nothing left to name
  -- them.
  select coalesce(array_agg(storage_path), '{}') into v_paths
  from public.treatment_photos where client_id = p_client;

  delete from public.treatment_photos where client_id = p_client;
  get diagnostics n = row_count;
  v_removed := v_removed || jsonb_build_object('treatment_photos', n);

  -- ── Admin audit trail ──────────────────────────────────────
  -- The actions stay — a role change or a password reset is the studio's own
  -- audit trail. `details` is a jsonb blob that the admin routes fill with
  -- whatever they just changed, name and email included, and the IP and user
  -- agent are network identifiers with nothing to justify them once the
  -- account is gone.
  update public.user_activity_log
     set details = '{}'::jsonb, ip_address = null, user_agent = null
   where user_id = p_client;

  perform public.log_user_activity(
    p_client, 'account_anonymised',
    jsonb_build_object('requested_by', v_by), v_caller);

  -- Accumulate rather than overwrite. A second run finds no photo rows — it
  -- already deleted them — and assigning v_paths straight in would wipe the
  -- only remaining record of files that object storage still holds. The list
  -- clears when the caller confirms the purge, and not before.
  update public.deleted_accounts d
     set removed = v_removed,
         auth_scrubbed = v_auth_ok or d.auth_scrubbed,
         pending_storage_paths = case
           when d.storage_purged_at is not null then '{}'::text[]
           else array(select distinct unnest(d.pending_storage_paths || v_paths))
         end
   where d.profile_id = p_client
  returning d.pending_storage_paths into v_paths;

  return jsonb_build_object(
    'status',        'anonymised',
    'profile_id',    p_client,
    'requested_by',  v_by,
    'kept',          v_kept,
    'removed',       v_removed,
    'auth_scrubbed', v_auth_ok,
    -- Objects in the private `treatment` bucket the caller must now remove.
    -- Still listed on a re-run, so a purge that failed the first time can be
    -- retried simply by pressing the button again.
    'storage_paths', to_jsonb(v_paths)
  );
end;
$$;

-- Functions are executable by PUBLIC unless told otherwise, and PostgREST
-- exposes them over HTTP. Without this, an unauthenticated request could call
-- anonymise_account() with any uuid and the `v_caller is null` branch above —
-- which exists for the service role — would wave it straight through.
revoke all on function public.anonymise_account(uuid) from public;
revoke all on function public.anonymise_account(uuid) from anon;
grant execute on function public.anonymise_account(uuid) to authenticated;
grant execute on function public.anonymise_account(uuid) to service_role;

comment on function public.anonymise_account(uuid) is
  'Scrub every identifying field for one client while keeping the appointments, '
  'orders, payments, signed consent and clinical records the studio is obliged '
  'to retain. Self or admin only. Idempotent. Returns counts plus the storage '
  'paths the caller must purge — see src/app/api/account/delete/route.ts.';

comment on column public.deleted_accounts.pending_storage_paths is
  'Treatment-photo objects still to remove from the private bucket. SQL cannot '
  'delete from object storage; the API route does it and stamps storage_purged_at.';
