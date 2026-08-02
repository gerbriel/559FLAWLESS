-- ============================================================
-- 559 Flawless — 033: money going out
--
-- Everything up to here records revenue. `payments` is the ledger for money in,
-- `orders` and `appointments` are what it was for, and 025 closed the last gap
-- in it. Nothing anywhere records the studio paying for anything, so "how did
-- the month go" has only ever been answerable as a gross takings figure — which
-- for a single-room studio paying suite rent, a Rhonda Allison wholesale
-- account, insurance and a licence renewal is not a number that means much.
--
-- This adds the other half: what was spent, on what, when, and whether it is
-- deductible — plus the two report helpers that turn both halves into a profit
-- figure without double-counting stock. See the note on `is_cogs` below; that
-- is the one genuinely subtle thing in this file.
--
-- Re-runnable in full. Every object is guarded, because a migration you cannot
-- apply twice is a migration you cannot recover a half-applied deploy with.
-- ============================================================

-- ── What day is it, in the studio's zone? ────────────────────
--
-- The SQL counterpart of `dateKeyInTimeZone(new Date(requestNow()), tz)`. The
-- database server runs in UTC, so `current_date` rolls over at 4pm or 5pm local
-- and an expense entered on a Tuesday evening would be booked to Wednesday.
-- The zone is read from `booking_settings` — the same single row the booking
-- engine derives wall-clock from, so the two can never disagree about which day
-- it is.
create or replace function public.studio_today()
returns date language sql stable security definer set search_path = public as $$
  select (now() at time zone coalesce(
    (select b.timezone from public.booking_settings b where b.id = 1),
    'America/Los_Angeles'
  ))::date;
$$;

-- ── Categories ───────────────────────────────────────────────
--
-- Seeded with what this business actually spends on, because an empty category
-- list is the reason expense tracking gets abandoned in week two. The studio can
-- add their own; nothing here is closed.
--
-- `is_cogs` is the load-bearing column. A case of wax bought in March is a cash
-- outflow in March, but its *cost of goods* lands in whichever month the service
-- that consumed it was performed — and that second figure is already derivable
-- from `order_items` against `products.cost_cents`. Add both into one "expenses"
-- total and the stock is counted twice. So stock purchases are flagged here,
-- `profit_summary()` reports them on their own line, and the net figure uses the
-- derived COGS rather than the purchase. Removing this flag silently makes every
-- margin figure in the app wrong, which is why it is a column and not a
-- convention.
create table if not exists public.expense_categories (
  id          bigserial primary key,
  name        text not null,
  slug        text not null unique,
  description text,

  is_cogs     boolean not null default false,
  -- The tick the entry form starts on. Almost everything a studio buys is
  -- deductible; the exceptions (an owner's draw, a personal charge on the
  -- business card) are exactly the ones worth making someone untick.
  default_deductible boolean not null default true,

  sort_order  int not null default 0,
  is_active   boolean not null default true,
  created_at  timestamptz not null default now()
);

insert into public.expense_categories (slug, name, description, is_cogs, sort_order) values
  ('product-stock',   'Product & back-bar stock',
   'Retail inventory and professional product consumed during treatments.', true, 10),
  ('disposables',     'Disposables',
   'Gloves, sticks, strips, table paper, cotton, sanitising supplies.', false, 20),
  ('rent',            'Rent',
   'Suite rent and any common-area charge.', false, 30),
  ('utilities',       'Utilities',
   'Electricity, water, internet, phone.', false, 40),
  ('insurance',       'Insurance',
   'Professional liability, general liability, contents.', false, 50),
  ('licensing',       'Licensing & continuing education',
   'Esthetician and establishment licences, certifications, classes.', false, 60),
  ('software',        'Software & subscriptions',
   'Booking, accounting, hosting, design tools.', false, 70),
  ('marketing',       'Marketing & advertising',
   'Ads, print, photography, promotional product.', false, 80),
  ('processing-fees', 'Card processing fees',
   'Stripe and terminal fees. Not netted out of revenue anywhere else, so they '
   'belong here or they vanish.', false, 90),
  ('equipment',       'Equipment',
   'Steamers, lamps, beds, sterilisers, and their repair.', false, 100),
  ('laundry',         'Laundry & linens',
   'Towels, sheets, laundry service.', false, 110),
  ('professional',    'Professional services',
   'Bookkeeper, accountant, legal.', false, 120),
  ('other',           'Other',
   'Anything that does not fit — review these when they pile up.', false, 900)
on conflict (slug) do nothing;

-- ── Recurring templates ──────────────────────────────────────
--
-- WHY a separate table rather than `expenses.is_recurring` plus a generator:
--
--  1. A row in `expenses` is evidence that money left the account. A recurring
--     rule is an intention about money that has not left it yet. Putting both
--     in one table means every read has to remember which kind it is looking
--     at, and every sum has to filter — which is precisely the mistake that
--     makes a total wrong once and quietly wrong forever after.
--
--  2. Rent goes up. With a flag, "the rent is now $1,400" either rewrites the
--     eleven rows already posted at $1,325 or forks into an unrelated second
--     flagged row with no link to the first. With a template, you edit the
--     template: history stays as it was paid, and next month posts at the new
--     figure. That is the behaviour a bookkeeper expects.
--
--  3. Generation has to be idempotent, and idempotency needs a stable identity
--     for "this rule, this period". A flag gives you nothing to key on — you
--     would be matching on (category, vendor, amount, roughly this date), which
--     breaks the first time the amount changes. The template's id plus the
--     scheduled date is a real key, and it is enforced by a unique index below,
--     so `generate_recurring_expenses()` can be run by a cron, by hand, and
--     twice in the same minute without ever posting rent twice.
--
-- No `interval_count` ("every 2 months"): four cadences cover suite rent,
-- software, quarterly insurance and an annual licence, which is the whole of
-- this business. Arbitrary intervals would double the date arithmetic to
-- support a case that does not exist here.
create table if not exists public.recurring_expenses (
  id          bigserial primary key,
  description text not null,
  amount_cents int not null check (amount_cents <> 0),
  category_id bigint not null references public.expense_categories(id) on delete restrict,

  -- A known supplier from 007, or just a name for the ones not worth a record.
  vendor_id   bigint references public.vendors(id) on delete set null,
  vendor_name text,

  payment_method text not null default 'card'
    check (payment_method in ('card', 'cash', 'check', 'ach', 'autopay', 'other')),
  note        text,
  is_tax_deductible boolean not null default true,

  cadence     text not null default 'monthly'
    check (cadence in ('weekly', 'monthly', 'quarterly', 'yearly')),
  -- The first occurrence. Every later one is derived from it, never stored, so
  -- there is no `next_due_on` to drift out of step with what was actually posted.
  starts_on   date not null,
  ends_on     date,
  is_active   boolean not null default true,

  created_by  uuid references public.profiles(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),

  constraint recurring_expenses_window check (ends_on is null or ends_on >= starts_on)
);

create index if not exists recurring_expenses_active_idx
  on public.recurring_expenses (starts_on) where is_active;

-- ── The expenses themselves ──────────────────────────────────
create table if not exists public.expenses (
  id           bigserial primary key,

  -- A date, deliberately not a timestamptz. An expense has no time of day —
  -- rent is due on the 1st, not at midnight in some zone — and storing an
  -- instant would invent a precision the receipt does not have and then make
  -- every month boundary a timezone question. Rule 3 governs scheduling, where
  -- the instant is the fact; here the calendar day is the fact.
  incurred_on  date not null default public.studio_today(),

  -- Negative is a vendor credit — a returned case, a refunded subscription.
  -- Zero is not a transaction. Same reasoning as record_payment() in 025.
  amount_cents int not null check (amount_cents <> 0),

  category_id  bigint not null references public.expense_categories(id) on delete restrict,
  description  text not null check (length(btrim(description)) > 0),

  vendor_id    bigint references public.vendors(id) on delete set null,
  -- The corner shop, a one-off contractor: real vendors get a `vendors` row,
  -- everything else gets a name and that is fine.
  vendor_name  text,

  payment_method text not null default 'card'
    check (payment_method in ('card', 'cash', 'check', 'ach', 'autopay', 'other')),

  -- Two different things, both optional. `reference` is what is printed on the
  -- paper — invoice number, check number, the last four. `receipt_path` is an
  -- object key in the private `receipts` bucket, served only through a
  -- short-lived signed URL, same rule as treatment photography.
  reference    text,
  receipt_path text,

  -- 007 already models a wholesale order properly, with vendor, lines and
  -- received quantities. Paying for one is not a second kind of purchase order;
  -- it is this expense pointing at that record. The unique index below is the
  -- point: a PO can be expensed once, so the classic "paid it, then paid it
  -- again from the statement" cannot happen silently.
  purchase_order_id bigint references public.purchase_orders(id) on delete set null,

  is_tax_deductible boolean not null default true,
  note         text,

  -- Set when this row was posted from a template, together with the scheduled
  -- date it was posted *for*. The two are separate because `incurred_on` is
  -- editable — rent paid late on the 4th is still the 1st's rent — and the
  -- generator keys off the schedule, not off when the cheque cleared.
  recurring_id     bigint references public.recurring_expenses(id) on delete set null,
  recurring_period date,

  recorded_by  uuid references public.profiles(id) on delete set null default auth.uid(),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),

  constraint expenses_recurring_pair
    check ((recurring_id is null) = (recurring_period is null))
);

create index if not exists expenses_date_idx     on public.expenses (incurred_on desc);
create index if not exists expenses_category_idx on public.expenses (category_id, incurred_on desc);
create index if not exists expenses_vendor_idx   on public.expenses (vendor_id) where vendor_id is not null;

-- The idempotency guarantee for recurring generation, stated as an index so it
-- holds against a concurrent second run and not merely against a careful one.
create unique index if not exists expenses_recurring_period_idx
  on public.expenses (recurring_id, recurring_period)
  where recurring_id is not null;

-- One purchase order, one expense.
create unique index if not exists expenses_purchase_order_idx
  on public.expenses (purchase_order_id)
  where purchase_order_id is not null;

drop trigger if exists expenses_touch on public.expenses;
create trigger expenses_touch before update on public.expenses
  for each row execute function public.touch_updated_at();

drop trigger if exists recurring_expenses_touch on public.recurring_expenses;
create trigger recurring_expenses_touch before update on public.recurring_expenses
  for each row execute function public.touch_updated_at();

-- Linking an expense to a purchase order but naming a different supplier is
-- always a mistake, and it is the kind that only surfaces a year later when the
-- vendor totals do not match the statements. Fill it from the PO instead of
-- asking, and correct it if it disagrees.
create or replace function public.expense_inherit_po_vendor()
returns trigger language plpgsql security definer set search_path = public as $$
declare po_vendor bigint;
begin
  if new.purchase_order_id is null then
    return new;
  end if;
  select po.vendor_id into po_vendor
  from public.purchase_orders po where po.id = new.purchase_order_id;
  if po_vendor is not null then
    new.vendor_id := po_vendor;
  end if;
  return new;
end;
$$;

drop trigger if exists expenses_inherit_po_vendor on public.expenses;
create trigger expenses_inherit_po_vendor
  before insert or update of purchase_order_id on public.expenses
  for each row execute function public.expense_inherit_po_vendor();

-- Deleting a template must not delete the rent that was already paid under it,
-- so the FK is ON DELETE SET NULL — but that clears `recurring_id` and leaves
-- `recurring_period` behind, which the pair constraint rejects, and the delete
-- fails with a check-constraint error that names neither table the studio was
-- looking at. (Postgres 15 could declare SET NULL over both columns; this has to
-- work on 14.) Detaching first is also the honest outcome: with no rule left,
-- those rows are ordinary expenses that happen to have been posted for a month,
-- and nothing can ever re-post them.
create or replace function public.recurring_expense_detach()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.expenses
  set recurring_id = null, recurring_period = null
  where recurring_id = old.id;
  return old;
end;
$$;

drop trigger if exists recurring_expenses_detach on public.recurring_expenses;
create trigger recurring_expenses_detach
  before delete on public.recurring_expenses
  for each row execute function public.recurring_expense_detach();

-- ── Recurring generation ─────────────────────────────────────

/**
 * Every date a rule falls due from its start through `p_through`.
 *
 * IMMUTABLE and parameterised rather than reading the rule itself, so the
 * dashboard can preview a schedule for a template nobody has saved yet.
 *
 * Occurrence n is `starts_on + n × step`, computed from the start every time,
 * and NOT `generate_series(start, stop, interval)` — which was the obvious way
 * to write this and is wrong at month end. generate_series steps from the value
 * it last produced, so a rule due on the 31st goes 31 Jan → 28 Feb → 28 Mar and
 * stays on the 28th forever after: February permanently reschedules the rent.
 * Measuring each occurrence from the start instead gives 31 Jan → 28 Feb →
 * 31 Mar → 30 Apr, which is what "due on the 31st" means to the landlord.
 *
 * The upper bound on n divides by the SHORTEST possible span for the cadence
 * (28 days for a month, 89 for a quarter — Feb–May in a common year), so it can
 * only ever overshoot; the `<= stop` filter trims the tail.
 */
create or replace function public.recurring_expense_dates(
  p_starts_on date,
  p_cadence   text,
  p_ends_on   date,
  p_through   date
) returns setof date language sql immutable as $$
  with span as (
    select
      least(p_through, coalesce(p_ends_on, p_through)) as stop,
      case p_cadence
        when 'weekly'    then interval '1 week'
        when 'monthly'   then interval '1 month'
        when 'quarterly' then interval '3 months'
        else                  interval '1 year'
      end as step,
      case p_cadence
        when 'weekly'    then 7
        when 'monthly'   then 28
        when 'quarterly' then 89
        else                  365
      end as shortest_days
  )
  select occurrence.d::date
  from span s
  cross join generate_series(
    0, greatest((s.stop - p_starts_on) / s.shortest_days, 0)) g(n)
  cross join lateral (select p_starts_on + (g.n * s.step)) occurrence(d)
  where occurrence.d::date <= s.stop;
$$;

/**
 * Post every occurrence that has come due and is not already on the books.
 *
 * Returns how many rows it actually wrote, so "nothing to post" and "posted
 * four" are distinguishable — running it twice returns 4 then 0, which is the
 * observable form of the idempotency the unique index enforces.
 *
 * SECURITY DEFINER with an explicit manager check, matching announcement_stats
 * in 028: the function needs to write past RLS, so it has to state for itself
 * who is allowed to call it. A null auth.uid() is the service role, a migration
 * or a scheduled job — all already privileged.
 */
create or replace function public.generate_recurring_expenses(p_through date default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  cutoff  date := coalesce(p_through, public.studio_today());
  written int;
begin
  if auth.uid() is not null and not public.is_manager() then
    raise exception 'Only a manager can post recurring expenses';
  end if;

  insert into public.expenses (
    incurred_on, amount_cents, category_id, description,
    vendor_id, vendor_name, payment_method, note, is_tax_deductible,
    recurring_id, recurring_period, recorded_by
  )
  select
    d, r.amount_cents, r.category_id, r.description,
    r.vendor_id, r.vendor_name, r.payment_method, r.note, r.is_tax_deductible,
    r.id, d,
    -- Whoever pressed the button owns the posting; an unattended run has no
    -- auth.uid() and falls back to whoever set the rule up, which is a truer
    -- answer than leaving it blank.
    coalesce(auth.uid(), r.created_by)
  from public.recurring_expenses r
  cross join lateral public.recurring_expense_dates(
    r.starts_on, r.cadence, r.ends_on, cutoff) d
  where r.is_active
  on conflict (recurring_id, recurring_period) where recurring_id is not null
  do nothing;

  get diagnostics written = row_count;
  return written;
end;
$$;

/**
 * The next date this rule falls due that has not been posted yet.
 *
 * "Not posted" rather than "after today" on purpose: a rule created in March
 * with a January start is behind, and the dashboard should say so rather than
 * cheerfully pointing at April. Lookahead is capped at two years so an active
 * rule with no end date still terminates.
 */
create or replace function public.recurring_expense_next_due(p_rule bigint)
returns date language sql stable security definer set search_path = public as $$
  select min(d)
  from public.recurring_expenses r
  cross join lateral public.recurring_expense_dates(
    r.starts_on, r.cadence, r.ends_on,
    (public.studio_today() + interval '2 years')::date) d
  where r.id = p_rule
    and public.is_manager()
    and not exists (
      select 1 from public.expenses e
      where e.recurring_id = r.id and e.recurring_period = d
    );
$$;

-- ── Report helpers ───────────────────────────────────────────
--
-- Both are SECURITY DEFINER and both re-check `is_manager()` in their own body.
-- A view would have been the obvious shape and is the wrong one: a Postgres view
-- runs as its owner unless created `with (security_invoker = on)`, which is how
-- `user_management_list` leaked every client's record until 028 dropped it. A
-- function that states its own authorisation cannot be reintroduced insecurely
-- by a later `create or replace` that forgets a setting.

/** What was spent per category over a date range, newest spend first. */
create or replace function public.expense_totals(p_from date, p_to date)
returns table (
  category_id   bigint,
  category_name text,
  is_cogs       boolean,
  entry_count   bigint,
  total_cents   bigint
) language sql stable security definer set search_path = public as $$
  select
    c.id,
    c.name,
    c.is_cogs,
    count(e.id),
    coalesce(sum(e.amount_cents), 0)::bigint
  from public.expense_categories c
  join public.expenses e
    on e.category_id = c.id
   and e.incurred_on between p_from and p_to
  where public.is_manager()
  group by c.id, c.name, c.is_cogs
  order by coalesce(sum(e.amount_cents), 0) desc;
$$;

/**
 * Revenue, cost of goods and expenses for a period, as integer cents.
 *
 * The reason this is one function and not three queries in the page: the
 * relationship between `stock_purchase_cents` and `cogs_cents` is not obvious
 * and getting it wrong is invisible. They measure the same product twice, from
 * different ends — what was bought, and what was sold — so exactly one of them
 * can be subtracted. `net_cents` uses cogs and reports the purchase figure
 * beside it for cash-flow, clearly labelled, never summed in.
 *
 * Revenue is recognised when the work happened (`appointments.starts_at`) and
 * when the order was paid, not when either was created — a facial booked in
 * March for April is April's revenue.
 *
 * Product revenue is net of sales tax: tax collected is the state's money being
 * held, not takings. Shipping stays in, because the postage it pays for is an
 * expense on the other side of this same report.
 *
 * COGS uses `products.cost_cents` as it stands today, because `order_items`
 * snapshots the price sold at but not the cost paid. That is accurate until a
 * wholesale price changes, and then it restates history. Fixing it properly
 * means a `cost_snapshot_cents` on `order_items` filled at sale time; noted
 * here rather than done, because it is a change to how a sale is written and
 * belongs with that code.
 */
create or replace function public.profit_summary(p_from date, p_to date)
returns table (
  service_revenue_cents   bigint,
  product_revenue_cents   bigint,
  cogs_cents              bigint,
  operating_expense_cents bigint,
  stock_purchase_cents    bigint,
  gross_margin_cents      bigint,
  net_cents               bigint
) language sql stable security definer set search_path = public as $$
  with tz as (
    select coalesce(
      (select b.timezone from public.booking_settings b where b.id = 1),
      'America/Los_Angeles') as zone
  ),
  window_bounds as (
    -- The same calendar days the expense side uses, turned into the instants the
    -- revenue side is stored in. Half-open at the top so the last day is whole
    -- however many hours it has: a DST Sunday is 23 or 25, never 24.
    select
      (p_from::timestamp at time zone t.zone)                        as from_at,
      ((p_to + 1)::timestamp at time zone t.zone)                    as to_at
    from tz t
  ),
  services as (
    select coalesce(sum(a.total_cents), 0)::bigint as cents
    from public.appointments a, window_bounds w
    where a.status = 'completed'
      and a.starts_at >= w.from_at and a.starts_at < w.to_at
  ),
  sold_orders as (
    select o.id, o.total_cents, o.tax_cents
    from public.orders o, window_bounds w
    where o.status in ('paid', 'fulfilling', 'ready_for_pickup', 'shipped', 'completed')
      and coalesce(o.paid_at, o.created_at) >= w.from_at
      and coalesce(o.paid_at, o.created_at) <  w.to_at
  ),
  products_sold as (
    select coalesce(sum(o.total_cents - o.tax_cents), 0)::bigint as cents
    from sold_orders o
  ),
  cogs as (
    select coalesce(sum(oi.qty * p.cost_cents), 0)::bigint as cents
    from sold_orders o
    join public.order_items oi on oi.order_id = o.id
    join public.products p     on p.id = oi.product_id
  ),
  spend as (
    select
      coalesce(sum(e.amount_cents) filter (where not c.is_cogs), 0)::bigint as operating,
      coalesce(sum(e.amount_cents) filter (where c.is_cogs), 0)::bigint     as stock
    from public.expenses e
    join public.expense_categories c on c.id = e.category_id
    where e.incurred_on between p_from and p_to
  )
  select
    s.cents,
    pr.cents,
    cg.cents,
    sp.operating,
    sp.stock,
    (s.cents + pr.cents - cg.cents)               as gross_margin_cents,
    (s.cents + pr.cents - cg.cents - sp.operating) as net_cents
  from services s, products_sold pr, cogs cg, spend sp
  where public.is_manager();
$$;

-- ── Receipts bucket (private) ────────────────────────────────
-- Object keys are `<yyyy-mm>/<uuid>.<ext>`. Nothing about a receipt identifies a
-- client, so unlike the treatment bucket the path carries no authorisation
-- information — the policy is a flat manager check and the file is only ever
-- reached through a signed URL minted server-side.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('receipts', 'receipts', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','application/pdf'])
on conflict (id) do nothing;

drop policy if exists "manager reads receipts" on storage.objects;
create policy "manager reads receipts" on storage.objects
  for select to authenticated using (bucket_id = 'receipts' and public.is_manager());

drop policy if exists "manager writes receipts" on storage.objects;
create policy "manager writes receipts" on storage.objects
  for insert to authenticated with check (bucket_id = 'receipts' and public.is_manager());

drop policy if exists "manager updates receipts" on storage.objects;
create policy "manager updates receipts" on storage.objects
  for update to authenticated using (bucket_id = 'receipts' and public.is_manager());

drop policy if exists "manager deletes receipts" on storage.objects;
create policy "manager deletes receipts" on storage.objects
  for delete to authenticated using (bucket_id = 'receipts' and public.is_manager());

-- ── RLS ──────────────────────────────────────────────────────
--
-- Manager and admin only, for reads as much as writes, on all three tables.
--
-- Front desk is excluded deliberately, and this is the one place in the app
-- where that role does not follow `is_front_desk()`. What the studio pays for
-- rent, what its wholesale margin is, and what it pays a bookkeeper are not
-- operational facts needed to run a day at the desk — they are the terms of the
-- business. Providers see nothing at all, including the category list, because
-- a category list with "Rent" and "Professional services" in it is already a
-- statement about how the business is run.
--
-- No policy mentions `anon`, so anon reads resolve to zero rows under RLS.

alter table public.expense_categories enable row level security;
alter table public.expenses           enable row level security;
alter table public.recurring_expenses enable row level security;

drop policy if exists "manager reads expense categories" on public.expense_categories;
create policy "manager reads expense categories" on public.expense_categories
  for select using (public.is_manager());

drop policy if exists "manager writes expense categories" on public.expense_categories;
create policy "manager writes expense categories" on public.expense_categories
  for all using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager reads expenses" on public.expenses;
create policy "manager reads expenses" on public.expenses
  for select using (public.is_manager());

drop policy if exists "manager writes expenses" on public.expenses;
create policy "manager writes expenses" on public.expenses
  for all using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager reads recurring expenses" on public.recurring_expenses;
create policy "manager reads recurring expenses" on public.recurring_expenses
  for select using (public.is_manager());

drop policy if exists "manager writes recurring expenses" on public.recurring_expenses;
create policy "manager writes recurring expenses" on public.recurring_expenses
  for all using (public.is_manager()) with check (public.is_manager());

comment on column public.expense_categories.is_cogs is
  'Stock purchases. Reported on their own line by profit_summary() and never '
  'added to operating expense, because the same product is already counted as '
  'cost of goods when it sells. Flipping this on a category changes every '
  'margin figure in the app.';

comment on column public.expenses.recurring_period is
  'The scheduled date this row was posted for, as opposed to incurred_on, which '
  'is when it was actually paid and may be edited. The unique index on '
  '(recurring_id, recurring_period) is what stops generate_recurring_expenses() '
  'posting the same month twice.';
