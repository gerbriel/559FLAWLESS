-- ============================================================
-- 559 Flawless — 031: invitations
--
-- Two ways existed to get an account: self-signup (always a client, see 023)
-- and `api/admin/clients/create` (staff conjure a walk-in's account outright).
-- Neither can say "here is a link, set yourself up as a provider" — so the only
-- route to a staff account was create-then-promote, which means an admin has to
-- invent a password for someone else and read it out.
--
-- An invitation is a one-time bearer credential: whoever holds the link may
-- claim EXACTLY the account the studio described, once, before it expires.
-- That framing decides every design choice below.
-- ============================================================

-- ── The table ────────────────────────────────────────────────
--
-- What is NOT stored here is the interesting part: the token itself. Only its
-- SHA-256 lives in the row, so a leaked backup, an over-broad SELECT, or a
-- future logging mistake yields hashes and not working links. The plaintext
-- exists in exactly two places — the invitee's link, and the HTTP response that
-- created it. It follows that a pending invitation's link cannot be re-shown
-- later; "send a new link" issues a fresh invitation that supersedes the old
-- one (see the supersede rule in invitations_before_insert). That is a feature:
-- it means a rotated link is also a revoked link.
--
-- The token is generated in the route handler (32 random bytes, base64url) —
-- 256 bits, so guessing is not a threat model, and the DB never sees it.

create table if not exists public.invitations (
  id            bigserial primary key,

  -- Lower-cased on the way in by the trigger; the check then holds it that way
  -- so the partial unique index below is a real "one live invite per address".
  email         text not null,
  first_name    text,
  last_name     text,
  -- A line from the person inviting, shown on the accept page. Optional.
  note          text,

  -- The whole point of the row. Immutable after insert — see
  -- invitations_before_update. Nothing may edit an invitation into a
  -- higher-privileged one after the tier check has passed.
  role          public.user_role not null default 'client',

  invited_by    uuid not null references public.profiles(id) on delete cascade,

  -- sha256(token) as lowercase hex. Unique so a token identifies one row.
  token_hash    text not null unique,

  expires_at    timestamptz not null default (now() + interval '7 days'),

  accepted_at   timestamptz,
  accepted_by   uuid references public.profiles(id) on delete set null,
  revoked_at    timestamptz,
  revoked_by    uuid references public.profiles(id) on delete set null,

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),

  constraint invitations_email_normalised
    check (email = lower(email) and position('@' in email) > 1 and length(email) <= 254),
  constraint invitations_token_hash_shape
    check (token_hash ~ '^[0-9a-f]{64}$'),
  -- A bearer credential with no horizon is a password nobody rotates. 30 days
  -- is already generous for "please set up your account"; the route caps the
  -- choice there and this is 31 so that clock skew between the app server (which
  -- computes expires_at) and the database (which stamps created_at) cannot
  -- reject a legitimate 30-day invitation.
  constraint invitations_expiry_bounded
    check (expires_at > created_at and expires_at <= created_at + interval '31 days'),
  constraint invitations_accepted_pair
    check ((accepted_at is null) = (accepted_by is null))
);

-- Inviting the same address twice is normal — the first link went to a typo'd
-- inbox, or the person lost it. At most one may be live at a time, so the
-- superseded link stops working the moment the new one is issued.
create unique index if not exists invitations_one_live_per_email
  on public.invitations (email)
  where accepted_at is null and revoked_at is null;

create index if not exists invitations_pending_idx
  on public.invitations (created_at desc)
  where accepted_at is null and revoked_at is null;

create index if not exists invitations_invited_by_idx
  on public.invitations (invited_by, created_at desc);

drop trigger if exists invitations_touch on public.invitations;
create trigger invitations_touch
  before update on public.invitations
  for each row execute function public.touch_updated_at();

comment on table public.invitations is
  'One-time, expiring links that let someone claim a specific account at a '
  'specific role. Only the SHA-256 of the token is stored, so a link can never '
  'be re-displayed — issuing a new one supersedes the old.';

comment on column public.invitations.role is
  'The role the invitee receives. Set once, at insert, under the tier check in '
  'invitations_before_insert; immutable thereafter.';

-- ── Who may invite whom, enforced against the inviter''s stored role ─────────
--
-- The RLS policies below already encode the tier rule, but RLS is only a
-- boundary for callers that are subject to it — and `createAdminClient()` uses
-- the service role, which bypasses RLS entirely. A route handler with a bug (or
-- a later one written in a hurry) could therefore insert `role = 'admin'` on
-- behalf of a front-desk user and RLS would not object.
--
-- So the tier check lives in a trigger, and it deliberately checks the role of
-- `invited_by` rather than the role of `auth.uid()`. Triggers fire for the
-- service role too, and `invited_by` is NOT NULL, so there is no caller — not
-- the anon key, not the service key, not psql — that can produce a staff
-- invitation attributed to a non-admin. The claim "only an admin can create a
-- staff invitation" is then a property of the database, not of the route.

create or replace function public.invitations_before_insert()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  inviter_role      public.user_role;
  inviter_suspended timestamptz;
begin
  new.email := lower(trim(new.email));

  select role, suspended_at
    into inviter_role, inviter_suspended
  from public.profiles
  where id = new.invited_by;

  if inviter_role is null then
    raise exception 'An invitation must name the staff member who sent it';
  end if;

  -- A suspended account keeps its role so history stays readable; it must not
  -- keep its powers. Every is_* helper in 001 checks this, and so does this.
  if inviter_suspended is not null then
    raise exception 'A suspended account cannot invite anyone';
  end if;

  if new.role = 'client' then
    if inviter_role not in ('front_desk', 'manager', 'admin') then
      raise exception 'Only front desk and above can invite a client';
    end if;
  else
    if inviter_role <> 'admin' then
      raise exception 'Only an admin can invite staff';
    end if;
  end if;

  -- An invitation creates an account; it cannot adopt one. If this address is
  -- already here, the answer is to change their role in User Management, which
  -- is admin-only and audited. Redeeming onto an existing account is refused a
  -- second time in redeem_invitation, because this check races with signup.
  if exists (select 1 from public.profiles where lower(email) = new.email) then
    raise exception
      'That email already has an account — change their role in User Management instead';
  end if;

  -- Supersede rather than collide with invitations_one_live_per_email. Doing it
  -- here, in the same statement, is what makes "issue a new link" atomically
  -- equal to "revoke the old one".
  update public.invitations
     set revoked_at = now(),
         revoked_by = new.invited_by
   where email = new.email
     and accepted_at is null
     and revoked_at is null;

  return new;
end;
$$;

drop trigger if exists invitations_guard_insert on public.invitations;
create trigger invitations_guard_insert
  before insert on public.invitations
  for each row execute function public.invitations_before_insert();

-- ── An invitation is not editable ────────────────────────────
--
-- Revoking is the only thing a person may do to an invitation after sending it.
-- Accepting is done by redeem_invitation and nothing else. Freezing the rest
-- means the tier check above can never be sidestepped by inserting a client
-- invitation and then editing it up to `admin`.

create or replace function public.invitations_before_update()
returns trigger language plpgsql as $$
begin
  if new.email      is distinct from old.email
     or new.role       is distinct from old.role
     or new.invited_by is distinct from old.invited_by
     or new.token_hash is distinct from old.token_hash
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at
     or new.first_name is distinct from old.first_name
     or new.last_name  is distinct from old.last_name
     or new.note       is distinct from old.note then
    raise exception 'An invitation cannot be edited — revoke it and send a new one';
  end if;

  if old.accepted_at is not null
     and (new.accepted_at is distinct from old.accepted_at
          or new.accepted_by is distinct from old.accepted_by
          or new.revoked_at  is distinct from old.revoked_at) then
    raise exception 'An accepted invitation is a record of what happened and cannot change';
  end if;

  if old.revoked_at is not null and new.revoked_at is null then
    raise exception 'A revoked invitation cannot be reinstated';
  end if;

  if new.accepted_at is not null and new.revoked_at is not null then
    raise exception 'A revoked invitation cannot be accepted';
  end if;

  return new;
end;
$$;

drop trigger if exists invitations_guard_update on public.invitations;
create trigger invitations_guard_update
  before update on public.invitations
  for each row execute function public.invitations_before_update();

-- ── RLS ──────────────────────────────────────────────────────
--
-- No anon policy at all: an invitation row carries an email address, an
-- intended role, and a token hash, and none of that is public.
--
-- Reads are front desk and up rather than `is_staff()`. A provider cannot
-- invite anyone, so a list of who has been invited is of no use to them, and
-- least privilege is the default here as everywhere else.

alter table public.invitations enable row level security;

drop policy if exists "front desk reads invitations" on public.invitations;
create policy "front desk reads invitations" on public.invitations
  for select to authenticated
  using (public.is_front_desk());

drop policy if exists "invite within your tier" on public.invitations;
create policy "invite within your tier" on public.invitations
  for insert to authenticated
  with check (
    -- You send invitations as yourself. Combined with the trigger above (which
    -- reads the role of exactly this column) that makes impersonation useless.
    invited_by = auth.uid()
    and (
      (role = 'client'  and public.is_front_desk())
      or (role <> 'client' and public.is_admin())
    )
  );

-- Revoking only. `accepted_at is null` in the WITH CHECK is what stops this
-- policy being used to mark an invitation accepted — acceptance is
-- redeem_invitation's job and runs as the service role, outside RLS.
drop policy if exists "revoke an invitation" on public.invitations;
create policy "revoke an invitation" on public.invitations
  for update to authenticated
  using (
    accepted_at is null
    and (public.is_admin() or (role = 'client' and public.is_front_desk()))
  )
  with check (
    accepted_at is null
    and (public.is_admin() or (role = 'client' and public.is_front_desk()))
  );

-- No delete policy. An invitation that was sent is a fact about who was offered
-- what, and the user-management screen is the wrong place to lose that.

-- Supabase's default privileges cover tables created by the migration role, but
-- being explicit about a table that holds credentials is worth the two lines.
grant select, insert, update on public.invitations to authenticated;
grant usage, select on sequence public.invitations_id_seq to authenticated;
grant all on public.invitations to service_role;
grant usage, select on sequence public.invitations_id_seq to service_role;
revoke all on public.invitations from anon;

-- ── Reading an invitation with the token, before you have an account ─────────
--
-- The accept page must render "Yesenia invited you to join as a provider"
-- before the invitee has signed in — so this is anon-callable. It is safe
-- because the token IS the argument: without a 256-bit secret it returns
-- nothing, and it can never return a different invitation than the one asked
-- for. No token hash, no id, and no other row is exposed.
--
-- sha256() is the core Postgres function, not pgcrypto's digest(). pgcrypto
-- lives in the `extensions` schema on Supabase and in `public` on a plain
-- Postgres, so `set search_path = public` would resolve digest() on one and not
-- the other. sha256(bytea) is in pg_catalog and always found.

create or replace function public.invitation_preview(p_token text)
returns table (
  email           text,
  role            public.user_role,
  first_name      text,
  last_name       text,
  note            text,
  invited_by_name text,
  expires_at      timestamptz,
  status          text
)
language sql stable security definer set search_path = public as $$
  select
    i.email,
    i.role,
    i.first_name,
    i.last_name,
    i.note,
    nullif(trim(coalesce(
      p.display_name,
      concat_ws(' ', p.first_name, p.last_name)
    )), ''),
    i.expires_at,
    case
      when i.accepted_at is not null then 'accepted'
      when i.revoked_at  is not null then 'revoked'
      when i.expires_at <= now()     then 'expired'
      else 'pending'
    end
  from public.invitations i
  left join public.profiles p on p.id = i.invited_by
  where length(coalesce(p_token, '')) between 16 and 400
    and i.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

grant execute on function public.invitation_preview(text) to anon, authenticated;

-- ── Redemption: the one place an invitation becomes a role ───────────────────
--
-- 001 installs `guard_profile_privileges`, which raises on any change to
-- `profiles.role` unless the caller is an admin — that trigger is the reason
-- the sensible "update own profile" policy cannot be used to self-promote. This
-- function must not become the hole in it. How it avoids that:
--
--   1. The role written is read from the invitation row, never from an
--      argument. There is no parameter here that says "make me a provider";
--      there is only "here is a token", and the token was minted by an insert
--      that already passed the admin-only tier check. A client who forges a
--      request can name any p_user they like and still cannot name a role.
--
--   2. The invitation must be live: not accepted, not revoked, not expired.
--      The row is taken FOR UPDATE first, so two browsers racing the same link
--      serialise and the second one finds accepted_at set.
--
--   3. The account being promoted must own the invited email address, compared
--      case-insensitively against `profiles.email`. Stealing a link therefore
--      does not promote your existing account — it only lets you claim the
--      invited address, which is the credential the studio deliberately issued.
--
--   4. The target must currently be a `client`. An invitation cannot be used to
--      re-role an existing staff member, and it cannot be used twice against
--      one person.
--
--   5. EXECUTE is revoked from PUBLIC/anon/authenticated and granted only to
--      service_role. A signed-in client calling this over PostgREST gets
--      "permission denied for function" — it is not part of the API surface the
--      anon key can reach. The one caller is `POST /api/invitations/accept`,
--      which has just created the auth user for that exact email.
--
-- And if it were ever granted more widely, it still fails closed: under an
-- authenticated JWT `auth.uid()` is not null and not an admin, so the 001
-- trigger raises on the UPDATE and the whole transaction rolls back. The
-- service role reaches the same trigger with `auth.uid()` null, which is the
-- already-privileged path 001 documents and permits.

create or replace function public.redeem_invitation(p_token text, p_user uuid)
returns public.user_role
language plpgsql security definer set search_path = public as $$
declare
  inv    public.invitations%rowtype;
  target public.profiles%rowtype;
begin
  select * into inv
  from public.invitations
  where length(coalesce(p_token, '')) between 16 and 400
    and token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
  for update;

  -- 22023 = invalid_parameter_value. A distinct SQLSTATE so the route can tell
  -- "this link is no good" (show it to the invitee) from a genuine 500.
  if not found then
    raise exception 'This invitation link is not valid.' using errcode = '22023';
  end if;
  if inv.revoked_at is not null then
    raise exception 'This invitation has been revoked.' using errcode = '22023';
  end if;
  if inv.accepted_at is not null then
    raise exception 'This invitation has already been used.' using errcode = '22023';
  end if;
  if inv.expires_at <= now() then
    raise exception 'This invitation has expired.' using errcode = '22023';
  end if;

  select * into target from public.profiles where id = p_user;
  if not found then
    raise exception 'There is no account to attach this invitation to.'
      using errcode = '22023';
  end if;
  if lower(coalesce(target.email, '')) is distinct from inv.email then
    raise exception 'This invitation was sent to a different email address.'
      using errcode = '22023';
  end if;
  if target.role <> 'client' then
    raise exception 'That account already has a staff role.' using errcode = '22023';
  end if;

  update public.profiles set role = inv.role where id = p_user;

  update public.invitations
     set accepted_at = now(),
         accepted_by = p_user
   where id = inv.id;

  -- 015's profiles trigger already logs `role_changed`; this records the reason.
  perform public.log_user_activity(
    p_user,
    'invitation_accepted',
    jsonb_build_object('invitation_id', inv.id, 'role', inv.role),
    inv.invited_by
  );

  return inv.role;
end;
$$;

revoke all on function public.redeem_invitation(text, uuid) from public;
revoke all on function public.redeem_invitation(text, uuid) from anon;
revoke all on function public.redeem_invitation(text, uuid) from authenticated;
grant execute on function public.redeem_invitation(text, uuid) to service_role;
