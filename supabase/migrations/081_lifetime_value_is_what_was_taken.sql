-- ============================================================
-- 559 Flawless — 081: lifetime value is what was taken
--
-- `client_records.lifetime_value_cents` has always been
-- `sum(appointments.total_cents) where status = 'completed'` — what was
-- BILLED for services. The counter reads it as "what this person is worth",
-- and the two have never been the same number:
--
--   * a deposit paid on a visit that has not happened yet counts for nothing,
--     though the money is in the bank (and since 080 a deposit is the ticket
--     in, so most bookings now carry one);
--   * a balance still owed counts in full, though nobody paid it;
--   * retail is absent entirely — a client who buys product every visit reads
--     the same as one who never does;
--   * membership dues are absent, so the clients on the most reliable money
--     in the studio read as the cheapest;
--   * a refund never comes back off.
--
-- `most-valuable-clients` already says all of this out loud in its
-- reconciliation note and ranks on the ledger instead. This migration moves
-- the stored counter onto the same footing, so the CRM and the report stop
-- disagreeing: lifetime value is now money RECEIVED from this person.
--
-- What counts
--   * `payments`, net of refunds (a refund is a negative row), EXCLUDING
--     redemptions — `method in ('gift_card','package')` spends value the
--     studio already took when the card or the package was sold. Counting
--     both is how a $600 package becomes $1,200 of "revenue"; `method` is the
--     tell, not `kind`, which is the same rule the report applies.
--   * `membership_charges` marked paid, reached through `client_memberships`.
--     050 left membership money out of `payments` deliberately and that
--     boundary stays — widening `payments_kind_check` and `record_payment()`'s
--     "an appointment or an order" rule is a bigger change than this one, and
--     the counter can read two ledgers perfectly well.
--
-- What does NOT change: visits, no-shows, cancellations and the first/last
-- visit dates are still counted from `appointments`, because they are facts
-- about attendance, not money. `Avg visit` on the client page divides the new
-- number by that same visit count — takings per visit, which is the figure
-- the studio actually wants when it asks what someone is worth.
--
-- Money now moves the counter from three directions, so the trigger that
-- maintained it from `appointments` alone is joined by two more. All three
-- call one function, because three copies of this sum would drift.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

-- ── The one implementation ────────────────────────────────────
create or replace function public.client_record_refresh(p_client uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_client is null then return; end if;

  -- A client may be owed a record before they are owed stats: a deposit can
  -- land before the first visit is ever completed.
  --
  -- Guarded on the profile still existing, which is not paranoia. Deleting a
  -- client sets `payments.client_id` to null (008) and that fires the trigger
  -- below for the row's OLD owner — mid-DELETE, with the profile already
  -- going. An unguarded insert would raise a foreign-key violation from
  -- inside the delete and take 074's merge down with it.
  insert into public.client_records (client_id)
  select p_client from public.profiles where id = p_client
  on conflict (client_id) do nothing;

  update public.client_records r
  set first_visit_at = s.first_visit,
      last_visit_at  = s.last_visit,
      visit_count    = s.visits,
      no_show_count  = s.no_shows,
      cancel_count   = s.cancels,
      lifetime_value_cents = coalesce(t.taken, 0) + coalesce(d.dues, 0)
  from (
    select
      min(starts_at) filter (where status = 'completed')   as first_visit,
      max(starts_at) filter (where status = 'completed')   as last_visit,
      count(*)       filter (where status = 'completed')   as visits,
      count(*)       filter (where status = 'no_show')     as no_shows,
      count(*)       filter (where status = 'cancelled')   as cancels
    from public.appointments where client_id = p_client
  ) s
  cross join lateral (
    -- `status = 'succeeded'` is what `record_payment()` writes for everything
    -- that moved, refunds included (a negative row). The Stripe refund path
    -- writes `status = 'refunded'` on its own negative row instead, so that
    -- side is admitted explicitly — and only when negative, so a positive row
    -- later marked refunded can never be added a second time.
    select coalesce(sum(p.amount_cents), 0) as taken
    from public.payments p
    where p.client_id = p_client
      and p.method not in ('gift_card', 'package')
      and (p.status = 'succeeded' or (p.status = 'refunded' and p.amount_cents < 0))
  ) t
  cross join lateral (
    select coalesce(sum(ch.amount_cents), 0) as dues
    from public.membership_charges ch
    join public.client_memberships cm on cm.id = ch.client_membership_id
    where cm.client_id = p_client
      and ch.status = 'paid'
  ) d
  where r.client_id = p_client;
end;
$$;

comment on function public.client_record_refresh(uuid) is
  'Recompute one client''s rolling CRM stats. Attendance is counted from '
  'appointments; lifetime value is money received — payments net of refunds, '
  'less redemptions, plus paid membership dues (081).';

-- ── The three doors onto it ───────────────────────────────────
-- Appointments: attendance. Keeps its 005 name, so the trigger below is the
-- one that has always been there.
create or replace function public.client_record_sync_stats()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.client_record_refresh(new.client_id);
  -- A guest booking matched to an account, or an appointment moved between
  -- two clients, leaves the old record overstating what it holds.
  if tg_op = 'UPDATE' and old.client_id is distinct from new.client_id then
    perform public.client_record_refresh(old.client_id);
  end if;
  return null;
end;
$$;

-- Payments: the money. DELETE matters as much as INSERT — 074's merge moves
-- rows between clients, and a voided row must leave the total it was in.
create or replace function public.payment_sync_client_stats()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op <> 'INSERT' then
    perform public.client_record_refresh(old.client_id);
  end if;
  if tg_op <> 'DELETE' then
    perform public.client_record_refresh(new.client_id);
  end if;
  return null;
end;
$$;

drop trigger if exists payments_sync_client_stats on public.payments;
create trigger payments_sync_client_stats
  after insert or delete or update of amount_cents, status, method, client_id
  on public.payments
  for each row execute function public.payment_sync_client_stats();

-- Membership dues: the other ledger. The client is one hop away, so the
-- lookup is done here rather than in the refresh.
create or replace function public.membership_charge_sync_client_stats()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  target uuid;
begin
  select cm.client_id into target
  from public.client_memberships cm
  where cm.id = coalesce(new.client_membership_id, old.client_membership_id);

  perform public.client_record_refresh(target);
  return null;
end;
$$;

drop trigger if exists membership_charges_sync_client_stats on public.membership_charges;
create trigger membership_charges_sync_client_stats
  after insert or delete or update of amount_cents, status, client_membership_id
  on public.membership_charges
  for each row execute function public.membership_charge_sync_client_stats();

-- ── Backfill ──────────────────────────────────────────────────
-- Everyone who already has a record, plus everyone who has only ever paid —
-- a client whose single transaction was a deposit has no completed visit and
-- so may never have had a row at all.
do $$
declare
  c uuid;
begin
  for c in
    select client_id from public.client_records
    union
    select client_id from public.payments where client_id is not null
    union
    select cm.client_id from public.client_memberships cm
  loop
    perform public.client_record_refresh(c);
  end loop;
end $$;
