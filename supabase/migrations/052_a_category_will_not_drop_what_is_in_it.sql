-- ============================================================
-- 559 Flawless — 052: a category will not drop what is in it
--
-- The studio asked for a categories screen under the catalogue, and said the
-- part that matters in the same breath: if one is deleted, whatever was filed
-- under it has to be routed somewhere else. Not tidied up afterwards — routed,
-- as part of the deletion.
--
-- Half of that already exists and half of it is impossible, and the two halves
-- are not the halves anyone would guess.
--
-- ── Service categories: already right ────────────────────────
--
-- 002 wrote the FK as
--
--     category_id bigint not null references public.service_categories(id)
--       on delete restrict
--
-- so the database refuses to delete a category anything is filed under, and 022
-- opened writes to managers. /dashboard/services/categories was built on top of
-- that: it counts what is filed here, offers "move these N services to …", and
-- only shows a delete once the count is zero. The 23503 it still catches is for
-- the race where somebody files a service into the category while the screen is
-- open. Nothing about that needs changing.
--
-- ── Product categories: nobody can touch them, and a delete
--    would quietly uncategorise every product in one ─────────
--
-- 007 gave `product_categories` exactly one policy:
--
--     create policy "public reads product categories"
--       on public.product_categories
--       for select to anon, authenticated using (is_active or public.is_staff());
--
-- One policy, and it is a SELECT. RLS denies by default, so there is no INSERT,
-- no UPDATE and no DELETE for anybody — not a manager, not the owner logged in
-- as an admin. The categories the studio has are the eleven 010 seeded, and the
-- only way to add a twelfth, rename one, or reorder them is the SQL editor.
-- That is the first finding, and on its own it would be a one-line fix.
--
-- The second finding is why this migration is not one line. 007 wrote the other
-- side of the FK differently from 002:
--
--     category_id bigint references public.product_categories(id)
--       on delete set null
--
-- Nullable, and SET NULL. So the moment a write policy is added — which is all
-- the studio asked for — deleting a category succeeds, silently, and every
-- product that was in it lands with `category_id = null`. Nothing errors,
-- nothing is logged, no screen says anything. The products do not disappear;
-- /shop still lists them, because that page filters on is_active/is_retail and
-- never on the category. They just stop being anywhere in particular, and the
-- only way to find out which ones they were is to remember.
--
-- That is precisely the outcome the request was written to prevent, and adding
-- the policy without touching the FK would have delivered it.
--
-- ── 1. Who may maintain them ─────────────────────────────────
--
-- Manager and above, which is what 022 chose for service categories.
--
-- The threshold is not a fresh judgement, it is the one already made twice for
-- the same kind of object. 022 opened service categories to managers because
-- the menu's shape is not a safety gate — it kept age gates and deposits admin-
-- only with a trigger and let the headings go. 021 drew the same line on the
-- other side of the catalogue in so many words: creating and deleting a product
-- "is still a manager decision — that is catalogue shape, not day-to-day
-- counting", while any staff member may update one.
--
-- A product category is catalogue shape. It is a heading on /shop and a filter
-- chip; it carries no price, no gate, and no clinical meaning. Governing it at
-- a different level from the service category next to it would mean the studio
-- has to remember two answers to "who renames a heading", and there is no
-- reason for the second answer to exist.
--
-- ── 2. Why RESTRICT and not a trigger ────────────────────────
--
-- The refusal could be a BEFORE DELETE trigger that counts products and raises.
-- It is not, for three reasons, all of which are really the same reason.
--
-- A trigger would be a second implementation of a rule Postgres already
-- implements. "Does any row still reference this one" is the entire job of a
-- foreign key; writing it again in plpgsql means an index-backed check the
-- planner maintains is replaced by a count somebody has to keep correct.
--
-- A trigger would make the two categories behave alike by coincidence rather
-- than by construction. 002 chose RESTRICT. If service categories are refused
-- by an FK and product categories by a trigger, the two agree today because two
-- separate pieces of code happen to say the same thing, and they stay agreed
-- only as long as nobody edits one of them. Same rule, same mechanism.
--
-- And a trigger would raise P0001, which is the SQLSTATE of every plpgsql
-- `raise exception` in this schema. A screen switching on it cannot tell "this
-- category still has products in it" from any other refusal, so it would have
-- to match on the message text. RESTRICT raises 23503 — foreign_key_violation,
-- specific, stable, and already the code ServiceCategoryManager translates:
--
--     case '23503':
--       return 'Something is still filed under this category, so the database
--               refused to delete it. …'
--
-- The raw message names `products_category_id_fkey` and is no use to anyone
-- reading it, which is the point: the code is the seam, and the sentence is the
-- screen's to write. The product categories screen switches on the same three
-- codes and says the same three things for the same three reasons — 23503 for
-- "something is still in it", 23505 for a duplicate web address, 42501 for
-- "your account cannot change categories".
--
-- ── What this does NOT do ────────────────────────────────────
--
-- `products.category_id` stays nullable. RESTRICT answers the question the
-- owner asked — a delete cannot orphan anything — and NOT NULL answers a
-- different one, that every product must always be in a category. Back-bar
-- stock (gloves, strips, cleaning supplies) is a product row that no shopper
-- ever sees and that no /shop heading applies to, and the CSV importer
-- (src/lib/csv/apply.ts) matches a category by name and leaves the column null
-- when the sheet does not name one. Uncategorised on purpose is a legitimate
-- state; uncategorised because a category was deleted underneath it is not.
-- This migration forbids the second and leaves the first alone.
--
-- No column is added either. `product_categories` already carries everything a
-- CRUD screen needs — name, slug, description, image_url, sort_order,
-- is_active — and the two columns `service_categories` has that it lacks are
-- both right to lack. `is_intimate` gates an 18+ attestation at booking, and
-- nothing is booked here. `updated_at` would need a touch trigger to stay true
-- and no screen reads it; a column maintained for nobody is a column that will
-- eventually be wrong.
-- ============================================================


-- ── Managers maintain the catalogue's shape ──────────────────
-- `for all` sits alongside 007's SELECT policy rather than replacing it:
-- permissive policies OR together, so anon and authenticated keep exactly the
-- read they had, and a manager additionally gets insert/update/delete.

alter table public.product_categories enable row level security;

drop policy if exists "manager writes product categories" on public.product_categories;
create policy "manager writes product categories" on public.product_categories
  for all using (public.is_manager()) with check (public.is_manager());


-- ── A delete is refused while anything is filed here ─────────
--
-- The constraint is dropped and re-added under its own name. That name is
-- load-bearing beyond Postgres: src/types/database.ts carries
-- Rel<'products_category_id_fkey', ['category_id'], 'product_categories',
-- ['id']> and PostgREST embeds resolve through it, so recreating it as
-- anything else would break `product_categories(name)` in every product query.

alter table public.products drop constraint if exists products_category_id_fkey;
alter table public.products add constraint products_category_id_fkey
  foreign key (category_id) references public.product_categories(id)
  on delete restrict;

-- The only index on this column is 007's `products_category_idx`, which is
-- partial (`where is_active`). A RESTRICT check has to see inactive and
-- archived products too — those are exactly the rows that would have been
-- orphaned quietly and never noticed — so it cannot use that index and would
-- scan the table on every category delete. This one covers the whole column.
create index if not exists products_category_fk_idx
  on public.products (category_id);


comment on constraint products_category_id_fkey on public.products is
  'RESTRICT, matching services.category_id (002). 007 had this as SET NULL, so '
  'deleting a category silently uncategorised every product in it. The delete '
  'is refused with SQLSTATE 23503 and the screen must move the products to '
  'another category first.';

comment on table public.product_categories is
  'Headings on /shop. Read by anon when is_active; written by manager and above '
  '(052), the same threshold 022 set for service_categories, because a category '
  'is catalogue shape rather than a pricing or safety decision. `slug` is unique '
  'and appears in public links as /shop?category=<slug> — changing it is a URL '
  'change, not a rename.';
