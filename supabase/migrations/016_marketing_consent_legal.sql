-- ============================================================
-- 559 Flawless — 015: marketing consent & legal compliance
--
-- Newsletter subscriptions, consent audit trails, terms acceptance
-- tracking, and unsubscribe token management for CAN-SPAM/GDPR/CCPA
-- compliance.
-- ============================================================

-- ── Newsletter subscriptions ──────────────────────────────────
-- Separate table for newsletter management with full audit trail.
-- Can be subscribed without being a registered user (storefront opt-in).
create table public.newsletter_subscriptions (
  id               bigserial primary key,
  email            text not null,
  
  -- Link to profile if they have an account
  profile_id       uuid references public.profiles(id) on delete set null,
  
  -- Subscription state
  is_subscribed    boolean not null default true,
  
  -- Double opt-in workflow
  confirmed_at     timestamptz,
  confirmation_token text unique,
  confirmation_sent_at timestamptz,
  
  -- Consent evidence (legal requirement)
  subscribed_at    timestamptz not null default now(),
  subscribed_ip    inet,
  subscribed_user_agent text,
  
  -- Unsubscribe tracking
  unsubscribed_at  timestamptz,
  unsubscribed_ip  inet,
  unsubscribe_token text unique not null default encode(gen_random_bytes(32), 'hex'),
  
  -- Source tracking
  -- 'signup', 'checkout', 'footer', 'manual', 'import'
  source           text not null default 'signup',
  
  -- UTM and referrer
  utm_source       text,
  utm_medium       text,
  utm_campaign     text,
  referrer         text,
  
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  
  -- One subscription record per email (can be resubscribed)
  unique (email)
);

create index newsletter_subscriptions_profile_idx on public.newsletter_subscriptions (profile_id);
create index newsletter_subscriptions_subscribed_idx on public.newsletter_subscriptions (is_subscribed, confirmed_at) 
  where is_subscribed and confirmed_at is not null;
create index newsletter_subscriptions_email_idx on public.newsletter_subscriptions (lower(email));
create index newsletter_subscriptions_token_idx on public.newsletter_subscriptions (unsubscribe_token);
create index newsletter_subscriptions_confirmation_idx on public.newsletter_subscriptions (confirmation_token) 
  where confirmation_token is not null;

create trigger newsletter_subscriptions_touch before update on public.newsletter_subscriptions
  for each row execute function public.touch_updated_at();

comment on table public.newsletter_subscriptions is
  'Newsletter subscription management with full audit trail for legal compliance (CAN-SPAM, GDPR, CCPA)';
comment on column public.newsletter_subscriptions.confirmation_token is
  'Token sent in double opt-in email. Null after confirmation.';
comment on column public.newsletter_subscriptions.unsubscribe_token is
  'Permanent token for one-click unsubscribe links. Never expires.';

-- ── Marketing consent tracking ────────────────────────────────
-- Extend profiles with consent timestamp and terms acceptance
-- marketing_consent_at already added in migration 015, skip if exists
alter table public.profiles
  add column if not exists marketing_consent_at timestamptz,
  add column if not exists marketing_consent_ip inet,
  add column if not exists terms_accepted_at timestamptz,
  add column if not exists terms_version_accepted int,
  add column if not exists privacy_accepted_at timestamptz;

create index if not exists profiles_marketing_consent_idx on public.profiles (marketing_consent_at) 
  where marketing_consent_at is not null;

comment on column public.profiles.marketing_consent_at is
  'Timestamp when user consented to marketing emails. NULL = never consented or withdrawn.';
comment on column public.profiles.marketing_consent_ip is
  'IP address when marketing consent was given (for compliance audit trail).';
comment on column public.profiles.terms_accepted_at is
  'Timestamp when user accepted current Terms & Conditions.';
comment on column public.profiles.terms_version_accepted is
  'Version number of terms user agreed to. References site_settings version.';

-- ── Consent audit log ─────────────────────────────────────────
-- Immutable log of all consent changes for compliance reporting
create table public.consent_audit_log (
  id               bigserial primary key,
  profile_id       uuid references public.profiles(id) on delete set null,
  email            text not null,
  
  -- What changed
  -- 'marketing_opted_in', 'marketing_opted_out', 'terms_accepted', 
  -- 'newsletter_subscribed', 'newsletter_unsubscribed', 'newsletter_confirmed'
  event_type       text not null,
  
  -- Context
  ip_address       inet,
  user_agent       text,
  source           text,  -- 'signup', 'settings', 'checkout', 'unsubscribe_link'
  
  -- Metadata (form version, related IDs, etc.)
  metadata         jsonb not null default '{}'::jsonb,
  
  created_at       timestamptz not null default now()
);

create index consent_audit_log_profile_idx on public.consent_audit_log (profile_id, created_at desc);
create index consent_audit_log_email_idx on public.consent_audit_log (lower(email), created_at desc);
create index consent_audit_log_event_idx on public.consent_audit_log (event_type, created_at desc);

comment on table public.consent_audit_log is
  'Immutable audit trail of all consent events. Required for GDPR/CCPA compliance.';

-- ── Auto-sync profile consent to newsletter ───────────────────
-- When marketing_opt_in changes in profiles, sync to newsletter_subscriptions
create or replace function public.sync_marketing_consent()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_ip inet;
  v_user_agent text;
begin
  -- Only proceed if marketing_opt_in changed
  if (TG_OP = 'INSERT' and new.marketing_opt_in) or 
     (TG_OP = 'UPDATE' and old.marketing_opt_in is distinct from new.marketing_opt_in) then
    
    -- Try to get IP from current request (may be null in some contexts)
    begin
      v_ip := nullif(current_setting('request.headers', true)::json->>'x-forwarded-for', '')::inet;
    exception when others then
      v_ip := null;
    end;
    
    if new.marketing_opt_in then
      -- Opted in: create or reactivate newsletter subscription
      insert into public.newsletter_subscriptions (
        email,
        profile_id,
        is_subscribed,
        subscribed_at,
        subscribed_ip,
        source,
        confirmed_at  -- Auto-confirm for authenticated signups
      ) values (
        new.email,
        new.id,
        true,
        now(),
        v_ip,
        'profile_sync',
        now()  -- Skip double opt-in for profile updates
      )
      on conflict (email) do update set
        is_subscribed = true,
        profile_id = new.id,
        subscribed_at = now(),
        subscribed_ip = v_ip,
        unsubscribed_at = null;
      
      -- Update consent timestamp if not set
      if new.marketing_consent_at is null then
        new.marketing_consent_at := now();
        new.marketing_consent_ip := v_ip;
      end if;
      
      -- Log consent
      insert into public.consent_audit_log (
        profile_id, email, event_type, ip_address, source, metadata
      ) values (
        new.id, new.email, 'marketing_opted_in', v_ip, 'profile_sync',
        jsonb_build_object('trigger', TG_OP)
      );
    else
      -- Opted out: unsubscribe
      update public.newsletter_subscriptions set
        is_subscribed = false,
        unsubscribed_at = now(),
        unsubscribed_ip = v_ip
      where email = new.email;
      
      -- Clear consent timestamp
      new.marketing_consent_at := null;
      new.marketing_consent_ip := null;
      
      -- Log opt-out
      insert into public.consent_audit_log (
        profile_id, email, event_type, ip_address, source, metadata
      ) values (
        new.id, new.email, 'marketing_opted_out', v_ip, 'profile_sync',
        jsonb_build_object('trigger', TG_OP)
      );
    end if;
  end if;
  
  return new;
end;
$$;

drop trigger if exists profiles_sync_marketing_consent on public.profiles;
create trigger profiles_sync_marketing_consent
  before insert or update of marketing_opt_in on public.profiles
  for each row execute function public.sync_marketing_consent();

-- ── Helper: get active marketing subscribers ──────────────────
-- Returns list of confirmed subscribers for broadcast campaigns
create or replace function public.get_marketing_subscribers()
returns table (
  profile_id uuid,
  email text,
  first_name text,
  last_name text,
  unsubscribe_token text
) language sql stable security definer set search_path = public as $$
  select
    n.profile_id,
    n.email,
    p.first_name,
    p.last_name,
    n.unsubscribe_token
  from public.newsletter_subscriptions n
  left join public.profiles p on p.id = n.profile_id
  where n.is_subscribed
    and n.confirmed_at is not null
    and (p.id is null or p.suspended_at is null);
$$;

-- ── Newsletter subscription management API ───────────────────
-- Public function to subscribe (with double opt-in)
create or replace function public.subscribe_newsletter(
  p_email text,
  p_source text default 'footer',
  p_utm_source text default null,
  p_utm_medium text default null,
  p_utm_campaign text default null,
  p_referrer text default null
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_token text;
  v_ip inet;
  v_existing record;
begin
  -- Get request IP if available
  begin
    v_ip := nullif(current_setting('request.headers', true)::json->>'x-forwarded-for', '')::inet;
  exception when others then
    v_ip := null;
  end;
  
  -- Check if already subscribed
  select * into v_existing
  from public.newsletter_subscriptions
  where email = lower(p_email);
  
  if v_existing.id is not null and v_existing.is_subscribed and v_existing.confirmed_at is not null then
    return jsonb_build_object('status', 'already_subscribed');
  end if;
  
  -- Generate confirmation token
  v_token := encode(gen_random_bytes(32), 'hex');
  
  -- Insert or update subscription
  insert into public.newsletter_subscriptions (
    email,
    profile_id,
    is_subscribed,
    subscribed_at,
    subscribed_ip,
    source,
    utm_source,
    utm_medium,
    utm_campaign,
    referrer,
    confirmation_token,
    confirmation_sent_at
  ) values (
    lower(p_email),
    auth.uid(),  -- Will be null for anonymous
    true,
    now(),
    v_ip,
    p_source,
    p_utm_source,
    p_utm_medium,
    p_utm_campaign,
    p_referrer,
    v_token,
    now()
  )
  on conflict (email) do update set
    is_subscribed = true,
    subscribed_at = now(),
    subscribed_ip = v_ip,
    source = p_source,
    utm_source = p_utm_source,
    utm_medium = p_utm_medium,
    utm_campaign = p_utm_campaign,
    referrer = p_referrer,
    confirmation_token = v_token,
    confirmation_sent_at = now(),
    unsubscribed_at = null,
    profile_id = coalesce(auth.uid(), newsletter_subscriptions.profile_id);
  
  -- Log event
  insert into public.consent_audit_log (
    profile_id, email, event_type, ip_address, source, metadata
  ) values (
    auth.uid(), lower(p_email), 'newsletter_subscribed', v_ip, p_source,
    jsonb_build_object('utm_source', p_utm_source, 'utm_campaign', p_utm_campaign)
  );
  
  return jsonb_build_object(
    'status', 'pending_confirmation',
    'confirmation_token', v_token
  );
end;
$$;

-- Confirm newsletter subscription (from email link)
create or replace function public.confirm_newsletter(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sub record;
begin
  select * into v_sub
  from public.newsletter_subscriptions
  where confirmation_token = p_token;
  
  if v_sub.id is null then
    return jsonb_build_object('status', 'invalid_token');
  end if;
  
  if v_sub.confirmed_at is not null then
    return jsonb_build_object('status', 'already_confirmed');
  end if;
  
  update public.newsletter_subscriptions set
    confirmed_at = now(),
    confirmation_token = null
  where id = v_sub.id;
  
  -- Log confirmation
  insert into public.consent_audit_log (
    profile_id, email, event_type, source, metadata
  ) values (
    v_sub.profile_id, v_sub.email, 'newsletter_confirmed', 'email_link',
    jsonb_build_object('subscription_id', v_sub.id)
  );
  
  return jsonb_build_object('status', 'confirmed', 'email', v_sub.email);
end;
$$;

-- Unsubscribe from newsletter (from email link)
create or replace function public.unsubscribe_newsletter(p_token text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_sub record;
  v_ip inet;
begin
  -- Get request IP
  begin
    v_ip := nullif(current_setting('request.headers', true)::json->>'x-forwarded-for', '')::inet;
  exception when others then
    v_ip := null;
  end;
  
  select * into v_sub
  from public.newsletter_subscriptions
  where unsubscribe_token = p_token;
  
  if v_sub.id is null then
    return jsonb_build_object('status', 'invalid_token');
  end if;
  
  if not v_sub.is_subscribed then
    return jsonb_build_object('status', 'already_unsubscribed');
  end if;
  
  update public.newsletter_subscriptions set
    is_subscribed = false,
    unsubscribed_at = now(),
    unsubscribed_ip = v_ip
  where id = v_sub.id;
  
  -- Also update profile if linked
  if v_sub.profile_id is not null then
    update public.profiles set
      marketing_opt_in = false,
      marketing_consent_at = null
    where id = v_sub.profile_id;
  end if;
  
  -- Log unsubscribe
  insert into public.consent_audit_log (
    profile_id, email, event_type, ip_address, source, metadata
  ) values (
    v_sub.profile_id, v_sub.email, 'newsletter_unsubscribed', v_ip, 'unsubscribe_link',
    jsonb_build_object('subscription_id', v_sub.id)
  );
  
  return jsonb_build_object('status', 'unsubscribed', 'email', v_sub.email);
end;
$$;

-- ── RLS policies ──────────────────────────────────────────────
alter table public.newsletter_subscriptions enable row level security;
alter table public.consent_audit_log enable row level security;

-- Newsletter subscriptions: users can manage their own, managers can view all
drop policy if exists "users read own subscription" on public.newsletter_subscriptions;
create policy "users read own subscription" on public.newsletter_subscriptions
  for select using (
    auth.uid() = profile_id or lower(email) = lower(auth.jwt()->>'email')
  );

drop policy if exists "managers read all subscriptions" on public.newsletter_subscriptions;
create policy "managers read all subscriptions" on public.newsletter_subscriptions
  for select using (public.is_manager());

drop policy if exists "users update own subscription" on public.newsletter_subscriptions;
create policy "users update own subscription" on public.newsletter_subscriptions
  for update using (
    auth.uid() = profile_id or lower(email) = lower(auth.jwt()->>'email')
  );

drop policy if exists "admin writes subscriptions" on public.newsletter_subscriptions;
create policy "admin writes subscriptions" on public.newsletter_subscriptions
  for all using (public.is_admin()) with check (public.is_admin());

-- Consent audit log: users read their own, managers read all
drop policy if exists "users read own consent log" on public.consent_audit_log;
create policy "users read own consent log" on public.consent_audit_log
  for select using (
    auth.uid() = profile_id or lower(email) = lower(auth.jwt()->>'email')
  );

drop policy if exists "managers read all consent logs" on public.consent_audit_log;
create policy "managers read all consent logs" on public.consent_audit_log
  for select using (public.is_manager());

drop policy if exists "system writes consent log" on public.consent_audit_log;
create policy "system writes consent log" on public.consent_audit_log
  for insert with check (true);  -- Trigger-driven, no user direct access

-- ── Seed terms & conditions ───────────────────────────────────
-- Add initial terms and privacy policy to site_settings
insert into public.site_settings (key, type, version, text_value, label, effective_at, is_active)
values 
  (
    'terms_of_service',
    'policy',
    1,
    E'# Terms of Service\n\n**Last Updated:** ' || now()::date || E'\n\n## 1. Agreement to Terms\n\nBy creating an account or booking services at 559 Flawless, you agree to these Terms of Service.\n\n## 2. Services\n\nWe provide professional esthetic services including facials, waxing, nail care, and corrective skin treatments. All services are performed by licensed professionals.\n\n## 3. Booking & Cancellation\n\n- Appointments require a deposit\n- 24-hour cancellation notice required for full refund\n- Late cancellations forfeit deposit\n- Repeated no-shows may result in booking restrictions\n\n## 4. Age Requirements\n\nCertain services require clients to be 18 years or older. You attest that you meet age requirements for services you book.\n\n## 5. Health & Safety\n\n- Clients must disclose relevant health conditions\n- We reserve the right to decline service if contraindications exist\n- Follow aftercare instructions provided\n\n## 6. Photography\n\nTreatment photos are clinical records. Separate consent required for any marketing use.\n\n## 7. Privacy\n\nYour information is handled according to our Privacy Policy.\n\n## 8. Limitation of Liability\n\nServices are provided "as is". We are not liable for results that vary by individual skin type and condition.\n\n## 9. Changes\n\nWe may update these terms. Continued use after changes constitutes acceptance.\n\n## 10. Contact\n\nQuestions? Contact us at [contact info].',
    'Terms of Service',
    now(),
    true
  ),
  (
    'privacy_policy',
    'policy',
    1,
    E'# Privacy Policy\n\n**Last Updated:** ' || now()::date || E'\n\n## Information We Collect\n\n- **Account Information:** Name, email, phone, date of birth\n- **Booking Information:** Service selections, appointment times, provider preferences\n- **Health Information:** Intake forms, consent signatures, clinical notes, treatment photos\n- **Payment Information:** Processed securely through Stripe (we do not store card details)\n- **Usage Data:** Pages visited, booking funnel progression, UTM parameters\n\n## How We Use Your Information\n\n- Provide and improve our services\n- Send appointment reminders and confirmations\n- Marketing communications (only if you opt in)\n- Legal compliance and safety\n\n## Data Security\n\nYour information is encrypted in transit and at rest. Clinical records have restricted access.\n\n## Your Rights\n\n- Access your data\n- Correct inaccuracies\n- Request deletion (subject to legal record-keeping requirements)\n- Opt out of marketing at any time\n- Withdraw consent for treatment photography\n\n## Data Retention\n\nClinical records retained per California licensing requirements. Marketing preferences and general account data retained while account is active.\n\n## Third Parties\n\n- **Stripe:** Payment processing\n- **Supabase:** Data hosting (SOC 2 compliant)\n- We do not sell your data\n\n## Cookies\n\nWe use essential cookies for site function and optional analytics cookies (with your consent).\n\n## Contact\n\nQuestions about your privacy? Contact us at [contact info].',
    'Privacy Policy',
    now(),
    true
  )
on conflict (key, version) do nothing;
