-- ============================================================
-- 559 Flawless — 015: user management + enhanced marketing consent
-- ============================================================

-- ── Enhanced newsletter subscribers ─────────────────────────
-- Add consent tracking and preferences to newsletter_subscribers
alter table public.newsletter_subscribers
  add column if not exists consent_ip inet,
  add column if not exists consent_user_agent text,
  add column if not exists preferences jsonb not null default '{}'::jsonb;

comment on column public.newsletter_subscribers.consent_ip is 'IP address when consent was given';
comment on column public.newsletter_subscribers.consent_user_agent is 'User agent when consent was given';
comment on column public.newsletter_subscribers.preferences is 'Segment preferences and communication settings';

-- ── Marketing consent timestamp for profiles ────────────────
-- Add timestamp to track when marketing consent was given
alter table public.profiles
  add column if not exists marketing_consent_at timestamptz;

comment on column public.profiles.marketing_consent_at is 'When marketing_opt_in was set to true';

-- ── Activity log ─────────────────────────────────────────────
-- Track significant user actions for admin audit trail
create table if not exists public.user_activity_log (
  id            bigserial primary key,
  user_id       uuid not null references public.profiles(id) on delete cascade,
  action        text not null,
  -- client_login, role_changed, profile_updated, password_reset_requested, etc.
  details       jsonb not null default '{}'::jsonb,
  -- Store what changed: old_role, new_role, updated_fields, etc.
  performed_by  uuid references public.profiles(id) on delete set null,
  -- Null when user performs action themselves
  ip_address    inet,
  user_agent    text,
  created_at    timestamptz not null default now()
);

create index user_activity_log_user_idx on public.user_activity_log (user_id, created_at desc);
create index user_activity_log_action_idx on public.user_activity_log (action, created_at desc);
create index user_activity_log_created_idx on public.user_activity_log (created_at desc);

-- ── RLS for activity log ─────────────────────────────────────
alter table public.user_activity_log enable row level security;

create policy "admin reads activity log" on public.user_activity_log
  for select using (public.is_admin());

create policy "system writes activity log" on public.user_activity_log
  for insert with check (true);
-- Any authenticated user can log their own activity; admin actions logged server-side

-- ── Helper function to log activity ──────────────────────────
create or replace function public.log_user_activity(
  p_user_id uuid,
  p_action text,
  p_details jsonb default '{}'::jsonb,
  p_performed_by uuid default null,
  p_ip_address inet default null,
  p_user_agent text default null
)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.user_activity_log (
    user_id, action, details, performed_by, ip_address, user_agent
  ) values (
    p_user_id, p_action, p_details, 
    coalesce(p_performed_by, auth.uid()),
    p_ip_address, p_user_agent
  );
end;
$$;

-- ── Trigger to log profile role changes ─────────────────────
create or replace function public.log_profile_role_change()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.role is distinct from old.role then
    perform public.log_user_activity(
      new.id,
      'role_changed',
      jsonb_build_object(
        'old_role', old.role,
        'new_role', new.role
      )
    );
  end if;
  
  if new.suspended_at is distinct from old.suspended_at then
    perform public.log_user_activity(
      new.id,
      case when new.suspended_at is not null 
        then 'account_suspended' 
        else 'account_activated' 
      end,
      jsonb_build_object(
        'suspended_at', new.suspended_at
      )
    );
  end if;
  
  if new.marketing_opt_in is distinct from old.marketing_opt_in 
     and new.marketing_opt_in = true 
     and new.marketing_consent_at is null then
    new.marketing_consent_at = now();
  end if;
  
  return new;
end;
$$;

create trigger profiles_log_changes
  before update on public.profiles
  for each row execute function public.log_profile_role_change();

-- ── View for user management list ────────────────────────────
-- Aggregates key stats for the admin user list
create or replace view public.user_management_list as
select
  p.id,
  p.first_name,
  p.last_name,
  p.email,
  p.phone,
  p.role,
  p.suspended_at,
  p.created_at,
  p.updated_at,
  (select max(created_at) from public.user_activity_log 
   where user_id = p.id and action = 'client_login') as last_login_at,
  (select count(*) from public.appointments 
   where client_id = p.id) as appointment_count,
  (select count(*) from public.orders 
   where client_id = p.id) as order_count,
  (select sum(total_cents) from public.orders 
   where client_id = p.id and status = 'completed') as lifetime_value_cents
from public.profiles p;

comment on view public.user_management_list is 'Aggregated user data for admin user management interface';

-- ── RLS: admins read the view ────────────────────────────────
-- Views inherit RLS from underlying tables, but we grant explicit access
grant select on public.user_management_list to authenticated;

-- ── Last admin protection ────────────────────────────────────
-- Prevent removing or suspending the last admin account
create or replace function public.prevent_last_admin_removal()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  admin_count int;
begin
  -- Count active admins (excluding the one being modified)
  select count(*) into admin_count
  from public.profiles
  where role = 'admin'
    and suspended_at is null
    and id != new.id;
  
  -- If this is a role change from admin or suspension of an admin
  if old.role = 'admin' and (
    new.role != 'admin' or new.suspended_at is not null
  ) then
    if admin_count = 0 then
      raise exception 'Cannot remove or suspend the last admin account';
    end if;
  end if;
  
  return new;
end;
$$;

create trigger profiles_prevent_last_admin
  before update on public.profiles
  for each row
  when (old.role = 'admin')
  execute function public.prevent_last_admin_removal();
