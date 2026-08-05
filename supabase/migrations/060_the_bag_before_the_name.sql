-- ============================================================
-- 559 Flawless — 060: the bag before the name
--
-- The cart lives in the browser — a zustand store in localStorage, product
-- ids and quantities, nothing more. The server first hears about it at
-- checkout, which means the one moment the studio could act on an abandoned
-- bag is exactly the moment it knows nothing: most bags belong to people the
-- studio cannot yet name, and the bags that never reach checkout are the
-- ones worth asking about.
--
-- So: `cart_snapshots`. One row per analytics session — the current contents
-- of that visitor's bag, overwritten in place. A snapshot, not a log:
-- yesterday's version of the bag is worthless once today's exists, so there
-- is nothing to append and nothing to mine. Front desk reads it on the
-- client record ("she had the serum in her bag on Tuesday"), which is
-- asked-for and actionable. What staff do NOT get is a browsing trail —
-- that line was drawn deliberately, and this table is shaped so it cannot
-- drift across it: ids and quantities are the only facts here.
--
-- ── One door in, and what it refuses ─────────────────────────
--
-- Writes go through `upsert_cart_snapshot()` only — 057's shape. The table
-- has no INSERT or UPDATE policy for anyone; anon must be able to EXECUTE
-- the function because a stranger's bag is the point. The function is
-- therefore an anon-writable path into a jsonb column, and an anon-writable
-- jsonb column without a size cap is a free storage service, so it caps
-- everything: session id at 64 chars (the app's ids are 36-char UUIDs),
-- the payload must be a jsonb ARRAY, at most 50 elements, at most ~4KB
-- serialized. For calibration, `analytics_events` has accepted uncapped
-- anonymous inserts since 009; this table is strictly narrower than the
-- precedent it sits beside.
--
-- Every refusal is a silent RETURN, never a raise. A bag snapshot is a
-- nicety riding along on a browsing session; the moment it can throw, it
-- can break a page for a customer in exchange for nothing. Garbage in means
-- no row, not an error.
--
-- An EMPTY array deletes the row instead of storing it. An empty bag is not
-- a fact worth keeping — retention should not have to age out a row that
-- says nothing, and "they emptied their bag" is not something the studio
-- needs on file.
--
-- Identity is never taken from the wire: `client_id := auth.uid()` when a
-- session is signed in, and stays whatever it was when not. There is no
-- parameter for it, so a browser cannot claim to be somebody.
--
-- ── Retention: 30 days, self-sweeping ────────────────────────
--
-- Session-keyed behavioural data. This studio has already treated an
-- identifier leaving the building as an incident (the ipify disclosure, cut
-- in 057's telling), and a month-old abandoned bag is not marketing signal,
-- it is surface area. So the write path sweeps its own table — rows older
-- than 30 days, on roughly 1% of calls (random() is fine here: database
-- plumbing, not app code under the determinism rules). No cron, nothing to
-- forget to schedule. 057 and 058 established the pattern.
--
-- ── The cascade ──────────────────────────────────────────────
--
-- `client_id references profiles(id) on delete cascade` — cascade, not set
-- null, deliberately. 030 draws the line for account deletion: records the
-- studio is obliged to keep survive anonymisation; behavioural residue does
-- not, which is why 030 deletes the analytics trail outright rather than
-- blanking its owner column. A bag snapshot is exactly that residue — a
-- de-linked bag is still a behavioural fact about a person who asked to be
-- forgotten, so when the profile row itself goes (056's purge of an empty
-- profile, an admin removing an auth user) the snapshot goes with it. 030's
-- anonymise predates this table and leaves the profiles row standing; on
-- that path the 30-day sweep is the cleanup — nothing here outlives a month
-- regardless.
--
-- ── The stitch: claim_browsing_session() ─────────────────────
--
-- Sign-in is where the name arrives. The app calls this once, with the
-- session id from localStorage, and the anonymous trail joins the account:
-- `analytics_events.user_id` and `cart_snapshots.client_id` are filled in
-- WHERE THEY ARE NULL — only null rows, ever. Rows that already belong to
-- someone are never reassigned.
--
-- The pollution question, out loud: any signed-in user can call this with
-- any session id they know or invent. What can they take? Nothing that
-- belongs to anyone else — the null guard excludes every owned row, so the
-- ceiling of the attack is attaching some stranger's ANONYMOUS pageviews to
-- the attacker's OWN profile. That is noise in their own record,
-- self-inflicted, and nothing they could not equally fabricate by browsing
-- the site themselves. It cannot move another account's history and it
-- cannot take another account's bag.
--
-- One person, one bag: if the claimer already owns a snapshot from some
-- other session (another device, an earlier visit), the freshest row by
-- updated_at wins and the rest are deleted. Idempotent — a second call
-- finds no null rows and one bag, and changes nothing.
--
-- ── And one policy on analytics_events ───────────────────────
--
-- The account area shows the signed-in client their own interests, read
-- from their own events. 009 gave the table a manager read; this adds
-- "client reads own events" ALONGSIDE it, not instead — policies OR.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

create table if not exists public.cart_snapshots (
  /** The analytics session id — the same value ClientAnalytics writes to
   *  analytics_events.session_id. One row per session: a snapshot, not a log. */
  session_id text primary key,
  /** Stamped from auth.uid() inside the function, never from a parameter.
   *  CASCADE on purpose — see the header: a deleted person's bag is
   *  behavioural residue, not a record. */
  client_id  uuid references public.profiles(id) on delete cascade,
  /** [{productId, qty}] — ids and quantities ONLY. No prices, no titles,
   *  nothing the server would otherwise have to distrust (rule 2). */
  lines      jsonb not null,
  updated_at timestamptz not null default now()
);

comment on table public.cart_snapshots is
  'The current contents of a visitor''s shopping bag, one row per analytics '
  'session, overwritten in place. Reached only through upsert_cart_snapshot() '
  '— no insert/update policies on purpose. Staff-read. Product ids and '
  'quantities only. Sweeps itself at 30 days; the write function does it.';

-- Front desk opens a client record and asks "what is in their bag" — that
-- lookup is by client, not by session. Partial: anonymous rows are only ever
-- fetched by their primary key.
create index if not exists cart_snapshots_client_idx
  on public.cart_snapshots (client_id)
  where client_id is not null;

alter table public.cart_snapshots enable row level security;

-- Staff read bags on the client record. No client SELECT: the client already
-- holds the bag itself — it lives in their browser — and self-serve shopping
-- insights were explicitly not part of the deal. No INSERT/UPDATE/DELETE
-- policies for anyone: the function below is the door.
drop policy if exists "staff reads bags" on public.cart_snapshots;
create policy "staff reads bags" on public.cart_snapshots
  for select to authenticated using (public.is_staff());

revoke all on public.cart_snapshots from public, anon, authenticated;
grant select on public.cart_snapshots to authenticated;

create or replace function public.upsert_cart_snapshot(
  p_session text,
  p_lines   jsonb
) returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  -- Refusals return rather than raise, all the way down: a bag snapshot must
  -- never be the reason a browsing session sees an error. Garbage in, no row.
  if p_session is null
     or length(p_session) > 64
     or length(trim(p_session)) = 0 then
    return;
  end if;

  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    return;
  end if;

  -- An empty bag is not a fact worth keeping — delete the row rather than
  -- store a statement that says nothing.
  if jsonb_array_length(p_lines) = 0 then
    delete from public.cart_snapshots where session_id = p_session;
    return;
  end if;

  -- The caps that keep an anon-writable jsonb column from being a free
  -- storage service. The real cart maxes out far below both: 99 per line,
  -- and a line is ~40 bytes of id and quantity.
  if jsonb_array_length(p_lines) > 50 then
    return;
  end if;
  if length(p_lines::text) > 4096 then
    return;
  end if;

  insert into public.cart_snapshots as cs (session_id, client_id, lines, updated_at)
  values (p_session, v_uid, p_lines, now())
  on conflict (session_id) do update
    set lines      = excluded.lines,
        -- Identity comes from auth, never the wire. Signed in: the row is
        -- theirs. Signed out on the same device: the bag changes hands to
        -- nobody — whoever owned it still does.
        client_id  = coalesce(v_uid, cs.client_id),
        updated_at = now();

  -- Opportunistic retention, 057's pattern: ~1% of writes sweep everything
  -- past 30 days. random() is fine here — database plumbing, not app code
  -- under the determinism rules.
  if random() < 0.01 then
    delete from public.cart_snapshots
     where updated_at < now() - interval '30 days';
  end if;
end;
$$;

comment on function public.upsert_cart_snapshot(text, jsonb) is
  'The one write path into cart_snapshots. Anon-callable on purpose — a '
  'stranger''s bag is the point. Caps the session id, the element count and '
  'the serialized size, refusing by silent return, never by raise. An empty '
  'array deletes the row. client_id is stamped from auth.uid(), never from a '
  'parameter. Sweeps 30-day retention itself.';

revoke all on function public.upsert_cart_snapshot(text, jsonb) from public;
grant execute on function public.upsert_cart_snapshot(text, jsonb)
  to anon, authenticated, service_role;

create or replace function public.claim_browsing_session(
  p_session text
) returns void
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  -- The whole function is "attach this trail to ME"; without a me it has no
  -- meaning, and raising here is a programming error surfacing, not a
  -- customer-facing failure.
  if v_uid is null then
    raise exception 'claim_browsing_session: authentication required';
  end if;

  -- A nonsense session id claims nothing; the sign-in flow it rides on must
  -- not break over it.
  if p_session is null or length(p_session) = 0 or length(p_session) > 64 then
    return;
  end if;

  -- ONLY null rows. Rows that already belong to an account are never
  -- reassigned — this is the guard that makes the function safe to expose:
  -- the worst a hostile caller can do is attach anonymous noise to their
  -- own profile (see the header).
  update public.analytics_events
     set user_id = v_uid
   where session_id = p_session
     and user_id is null;

  update public.cart_snapshots
     set client_id = v_uid
   where session_id = p_session
     and client_id is null;

  -- One person, one bag. Sign-in is where snapshots from different devices
  -- and earlier sessions meet; keep the freshest by updated_at and drop the
  -- rest. On a second call this finds one bag and deletes nothing —
  -- idempotent by construction.
  delete from public.cart_snapshots cs
   where cs.client_id = v_uid
     and cs.session_id <> (
       select s.session_id
         from public.cart_snapshots s
        where s.client_id = v_uid
        order by s.updated_at desc, s.session_id
        limit 1
     );
end;
$$;

comment on function public.claim_browsing_session(text) is
  'Called once after sign-in: stitches the anonymous trail (analytics_events, '
  'cart_snapshots) for one session id to the calling account. Moves ONLY rows '
  'with a null owner — never reassigns anything that belongs to someone — and '
  'collapses the caller''s snapshots to the freshest one. Idempotent. '
  'Authenticated only.';

revoke all on function public.claim_browsing_session(text) from public, anon;
grant execute on function public.claim_browsing_session(text) to authenticated;

-- ── analytics_events: the client's own trail is theirs to read ──
-- The /account interest card reads the signed-in user's OWN events through
-- their own session. 009's manager read stays; this sits beside it.
drop policy if exists "client reads own events" on public.analytics_events;
create policy "client reads own events" on public.analytics_events
  for select to authenticated using (user_id = auth.uid());
