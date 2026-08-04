-- ============================================================
-- 559 Flawless — 055: the account nobody ever signed into
--
-- `api/admin/clients/create` makes a real account for a walk-in, deliberately
-- without a password, and says so in its own comment: "the client can claim it
-- later with 'email me a sign-in link'". 051 makes the other kind of half-known
-- client — the stub with no account at all — and the whole of that migration is
-- about how a stub stops being one.
--
-- Between them sits a population nothing in this app can see. A profile whose
-- person has never signed in is, on the Clients roster, indistinguishable from
-- a regular of eight years: same row, same badges, same lifetime value of $0
-- that could equally mean "new" as "never got in". The studio's own question —
-- "who do I still need to get onto the system" — is answerable for stubs, on
-- their own screen, and unanswerable for the accounts staff created for people
-- in the room.
--
-- The fact that answers it lives in `auth.users`, and `last_sign_in_at` appears
-- nowhere in this codebase because there is nowhere it could: PostgREST does
-- not expose the `auth` schema, and it must not start. That table holds every
-- account's email, its confirmation tokens, its recovery tokens and its
-- password hash. Widening the API to reach one nullable timestamp on it would
-- be the single largest change to this project's attack surface, in exchange
-- for a badge.
--
-- ── So: a keyhole, not a door ────────────────────────────────
--
-- One SECURITY DEFINER function that answers exactly the two questions the
-- screen asks, as booleans, keyed by profile id:
--
--     has this account ever been signed into
--     is there an invitation outstanding for it
--
-- No row from auth.users leaves this function. No email address — the caller
-- already has those from `profiles`, under RLS, which is the correct place to
-- get them. And no timestamp: "never signed in" is a yes or a no, and a date
-- would be a fact about somebody's login history that no part of this feature
-- asked for and every future reader of the response would be entitled to log.
-- The narrowest thing that answers the question is the thing to return.
--
-- ── What "unclaimed" means, and what it deliberately does not ─
--
-- Two candidate tests, and they are nearly the same population:
--
--     u.last_sign_in_at is null       — never got in
--     u.encrypted_password is null    — no password set
--
-- This uses the first, alone. The second is a fact about one credential rather
-- than about whether the person ever arrived, and the two come apart in a case
-- this studio actually has: 023 wired up Google sign-in. A client who signed up
-- with Google has no password and never will. Testing for a password would put
-- "Never signed in" on her row and offer to re-invite a client who has been
-- booking through the site for a year, which is worse than saying nothing —
-- it is confidently wrong about somebody the studio can see is active.
--
-- It comes apart the other way too, and harmlessly: an account created by
-- signup with a password but never confirmed has a password and no sign-in.
-- That person has not got in either, and a sign-in link is exactly what they
-- need, so the sign-in test wants them included and does include them.
--
-- The staff-created account is caught by both tests, which is why they look
-- interchangeable from where this feature starts. They are not, and only one of
-- them is about the thing being asked.
--
-- ── Why the invitation half is here too ──────────────────────
--
-- 031 holds at most one live invitation per email address. An account that
-- already has one outstanding must not be handed a second, competing link —
-- and an outstanding invitation for an address that already has an account is
-- itself a thing staff should be able to see rather than trip over. Same read,
-- same round trip, and it is the difference between "we have not asked them
-- yet" and "we asked and they have not acted".
--
-- ── Who may ask ──────────────────────────────────────────────
--
-- 044's `scheduled_job_status()` raises on `not is_manager() and auth.uid() is
-- not null`; 051's `claim_client_stub()` is granted to service_role alone and
-- to nobody else. The second shape is for functions called by a route that has
-- already proved a token — this one is read by a staff SCREEN, so service_role
-- would put it out of the screen's reach entirely.
--
-- So 044's shape, at front desk rather than manager. Front desk is the floor
-- because of what this function can be asked with `p_ids => null`: the whole
-- client roster's claim status in one call. Front desk and above already read
-- every client profile under RLS, so that is no widening for them. A PROVIDER
-- does not — 005 gives her the clients she treats — and a SECURITY DEFINER
-- function that handed her a row per client in the studio would quietly undo
-- that, one boolean at a time. Inviting is front-desk work in every other part
-- of this app (see the gate on /dashboard/clients/stubs); this matches it.
--
-- `auth.uid() is null` means the service role, a scheduled job or the SQL
-- editor — already privileged, and the same exemption 044 and 045 make. It is
-- not a hole for `anon`: the grants below give anon no EXECUTE at all, so an
-- anonymous caller is refused before the body runs.
--
-- ── One thing to check after applying ────────────────────────
--
-- 030 records that on a hosted project the `auth` schema belongs to
-- supabase_auth_admin and this migration's role may not be able to WRITE to it,
-- so its scrub treats that as best-effort. Reading is the other case: `postgres`
-- holds SELECT on `auth.users` in a Supabase project, which is what makes a
-- SECURITY DEFINER function the supported way to ask this. The probe at the
-- bottom says so out loud at apply time rather than leaving the first person to
-- open the Clients screen to discover it.
--
-- Every statement is guarded. Running this twice does nothing the second time.
-- This adds no table and no column; `src/types/database.ts` gains the function
-- signature and nothing else.
-- ============================================================

create or replace function public.client_claim_status(p_ids uuid[] default null)
returns table (
  profile_id         uuid,
  has_signed_in      boolean,
  invitation_pending boolean
)
language plpgsql
stable
security definer
-- `auth` is deliberately NOT on the path: the one table read from it below is
-- schema-qualified, so nothing here can be resolved out from under this
-- function by a schema that shadows it.
set search_path = public
as $$
begin
  if not public.is_front_desk() and auth.uid() is not null then
    raise exception 'Only the front desk can see who has not claimed their account'
      using errcode = '42501';
  end if;

  return query
  select
    p.id,
    u.last_sign_in_at is not null,
    -- 031 normalises `invitations.email` to lower case and a CHECK holds it
    -- there, so the comparison is against the bare column and the partial
    -- unique index on it is usable.
    exists (
      select 1
      from public.invitations i
      where i.email = lower(btrim(p.email))
        and i.accepted_at is null
        and i.revoked_at is null
        and i.expires_at > now()
    )
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.role = 'client'
    -- Clients only. Whether an admin has ever signed in is a real question and
    -- a different one, asked on a different screen by somebody else; this
    -- function is what the Clients roster reads and it answers about clients.
    and (p_ids is null or p.id = any (p_ids));
end;
$$;

-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, so the revoke is not
-- decoration — it is the only thing standing between anon and the body.
revoke all on function public.client_claim_status(uuid[]) from public, anon;
grant execute on function public.client_claim_status(uuid[]) to authenticated, service_role;

comment on function public.client_claim_status(uuid[]) is
  'Has this client ever signed in, and is an invitation outstanding for them. '
  'Booleans keyed by profile id — no row, address or timestamp from auth.users '
  'crosses this boundary. Null p_ids means the whole client roster. Front desk '
  'and above: with null it answers for every client, which a provider may not '
  'see under RLS.';

-- ── Can this migration's role actually read auth.users ───────
--
-- A warning, not a failure. The function is created either way and the app
-- degrades quietly if it cannot answer — no badge, no filter, no Invite button
-- — but the person applying the migration should hear about it now rather than
-- from a screen that is merely missing something.
do $$
begin
  begin
    perform 1 from auth.users limit 1;
    raise notice 'auth.users is readable — client_claim_status() can answer.';
  exception when others then
    raise warning
      'This role cannot read auth.users (%). client_claim_status() is created '
      'but will raise when called, and the Clients screen will show no claim '
      'status. Grant select on auth.users to the owner of that function and '
      're-run.', sqlerrm;
  end;
end $$;
