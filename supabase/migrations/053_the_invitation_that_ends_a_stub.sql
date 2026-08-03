-- ============================================================
-- 559 Flawless — 053: the invitation that ends a stub
--
-- 051 gave the studio somewhere to put a client it knows but cannot sign up:
-- `client_stubs`, `invitations.client_stub_id`, and `claim_client_stub()`,
-- which ties the stub to the account that finally accepts the link. Everything
-- that migration promised is there. What it left open — deliberately, because
-- they are decisions about the flow rather than about the table — is what the
-- flow now needs the database to hold on its behalf. Three small things.
--
-- ── 1. An invitation aimed at a stub is an invitation to be a client ────────
--
-- A stub is a contact on the studio's client list. Pointing a `provider` or
-- `admin` invitation at one would make `claim_client_stub()` copy a client's
-- phone number onto a staff profile and mark the studio's own list "claimed"
-- by someone who was never on it. Nothing in the UI offers that, which is
-- exactly why it belongs here: the rules the UI keeps by habit are the ones
-- that quietly stop being true.
--
-- ── 2. One live invitation per stub ─────────────────────────────────────────
--
-- 031 already holds "at most one live invitation per email address", and
-- supersedes the old one on insert so that re-sending a link revokes the
-- previous one. A stub adds a second way for two live invitations to describe
-- the same person: send one to maria@old, then — after she says that address
-- is gone — send another to maria@new. Two different addresses, so 031's index
-- is content, and both links point at the same stub. Whoever opens the second
-- one gets `claim_client_stub`'s refusal, which is correct and arrives far too
-- late to be useful.
--
-- So the same rule, said the other way round. The route revokes the earlier
-- invitation before issuing the new one, the way 031's trigger does for an
-- address; this index is what makes that true rather than customary.
--
-- ── 3. Somewhere to put "how did you hear about us" ─────────────────────────
--
-- The claim is the one moment the studio has a half-known client's attention
-- and can ask the things only they can answer. Most of it is `profiles`, which
-- a client may update for themselves. Attribution is not: it lives in
-- `client_records.referral_source`, and 005 gives a client SELECT on that row
-- and nothing more — for good reason, since the columns beside it are
-- allergies, medications and medical notes.
--
-- Widening that policy to UPDATE would hand every client an edit box onto
-- their own clinical record, which AGENTS.md forbids and which no answer to
-- "how did you hear about us" is worth. Column privileges cannot help either:
-- a GRANT is per role, not per policy, and `authenticated` is also every staff
-- member who must keep writing the rest of the row.
--
-- One narrow SECURITY DEFINER function instead. It writes one column, on the
-- caller's own row, and cannot be argued into touching anyone else's — there
-- is no client id parameter to pass. Same shape as `subscribe_newsletter`,
-- which the profile form already calls from the browser.
--
-- Every statement is guarded. Running this twice does nothing the second time.
-- ============================================================

-- ── 1 ────────────────────────────────────────────────────────
alter table public.invitations drop constraint if exists invitations_stub_is_a_client;
alter table public.invitations
  add constraint invitations_stub_is_a_client
  check (client_stub_id is null or role = 'client');

comment on constraint invitations_stub_is_a_client on public.invitations is
  'A stub is somebody on the client list. An invitation that claims one can '
  'only ever create a client account.';

-- ── 2 ────────────────────────────────────────────────────────
create unique index if not exists invitations_one_live_per_stub
  on public.invitations (client_stub_id)
  where client_stub_id is not null
    and accepted_at is null
    and revoked_at is null;

-- ── 3 ────────────────────────────────────────────────────────
/**
 * Record how a client found the studio.
 *
 * Marketing attribution, not clinical history — 030 already draws that line
 * when it scrubs `referral_source` on account deletion while keeping the
 * treatment record. The client is the only person who knows the answer, so
 * they are the one who gets to write it, and this is the whole of what they
 * may write.
 *
 * Takes no client id: the row is `auth.uid()`'s or it is nobody's. An empty
 * answer is not an answer and clears nothing — someone who skips the question
 * has not withdrawn what they said last time.
 */
create or replace function public.record_referral_source(p_source text)
returns void language plpgsql security definer set search_path = public as $$
declare
  caller uuid := auth.uid();
  value  text := nullif(btrim(coalesce(p_source, '')), '');
begin
  if caller is null then
    raise exception 'Sign in before answering that.' using errcode = '42501';
  end if;

  if value is null then
    return;
  end if;

  -- Staff have no referral source; the column is on the client record.
  if not exists (
    select 1 from public.profiles where id = caller and role = 'client'
  ) then
    return;
  end if;

  insert into public.client_records (client_id, referral_source)
  values (caller, left(value, 120))
  on conflict (client_id) do update set referral_source = left(value, 120);
end;
$$;

revoke all on function public.record_referral_source(text) from public, anon;
grant execute on function public.record_referral_source(text) to authenticated;

comment on function public.record_referral_source(text) is
  'Let a client say how they heard about the studio without granting them '
  'UPDATE on client_records, whose other columns are their clinical record.';
