-- ============================================================
-- 559 Flawless — 040: the barcode that is already on the bottle
--
-- `sku` is the studio's own name for a product. It is chosen here, it is
-- unique here, and it means nothing to anyone else. A UPC/EAN is the opposite:
-- the manufacturer assigned it, it is printed on the packaging, and it is the
-- only string a £20 scanner will ever hand us. Rhonda Allison bottles carry
-- real ones, so the two are not interchangeable and one column cannot be both.
--
-- Nullable on purpose. Plenty of back-bar stock is decanted, relabelled, or
-- simply has no readable code, and a product without a barcode is a normal
-- product — it is just one you have to find by name.
-- ============================================================

alter table public.products add column if not exists barcode text;

comment on column public.products.barcode is
  'The GTIN printed on the packaging (UPC-A, EAN-13, EAN-8, ITF-14), digits '
  'only. Assigned by the manufacturer, not by the studio — that is `sku`. '
  'Null when the product has no scannable code.';

-- ── Normalise on the way in ──────────────────────────────────
--
-- A keyboard-wedge scanner types its digits and presses Enter, and depending on
-- how it is configured it may bracket them with spaces, a tab, or a stray
-- carriage return. Stripping that here rather than in the browser means the
-- column holds one canonical form no matter which client wrote it — the till,
-- the inventory page, a CSV import, or psql.
create or replace function public.product_normalize_barcode()
returns trigger language plpgsql as $$
begin
  new.barcode := nullif(regexp_replace(coalesce(new.barcode, ''), '[^0-9]', '', 'g'), '');
  return new;
end;
$$;

drop trigger if exists products_normalize_barcode on public.products;
create trigger products_normalize_barcode
  before insert or update of barcode on public.products
  for each row execute function public.product_normalize_barcode();

-- Every GTIN in circulation is 8, 12, 13 or 14 digits. The range is written as
-- 8–14 rather than an enumeration because scanners occasionally emit a
-- zero-padded variant of the same number, and refusing to store what the
-- hardware actually reports helps nobody.
alter table public.products drop constraint if exists products_barcode_format;
alter table public.products add constraint products_barcode_format
  check (barcode is null or barcode ~ '^[0-9]{8,14}$');

-- Unique WHERE NOT NULL: two products may both lack a barcode, but no two may
-- claim the same one — a scan has to resolve to exactly one thing on the shelf.
create unique index if not exists products_barcode_key
  on public.products (barcode)
  where barcode is not null;

/**
 * Resolve a scanned code to a product id.
 *
 * The app looks products up through its own RLS-protected query; this exists so
 * the same answer is available to SQL — an import script checking for a clash,
 * or a report reconciling a scan log — without every caller re-deriving which
 * zero-padded renderings of a GTIN count as the same number.
 *
 * A scanner set to emit UPC-A sends 12 digits; the same product read by a
 * scanner set to EAN-13 sends the same digits with a leading zero. Both are the
 * same GTIN, so both must find the same row.
 */
-- Deliberately NOT security definer: RLS is the security boundary, and the
-- products policy already says what each role may see. Running as the caller
-- means a client asking about a back-bar code gets nothing, which is the
-- correct answer rather than one this function has to remember to give.
create or replace function public.product_id_for_barcode(p_code text)
returns bigint language sql stable set search_path = public as $$
  select id from public.products
  where barcode is not null
    and ltrim(barcode, '0') = ltrim(regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g'), '0')
    and ltrim(regexp_replace(coalesce(p_code, ''), '[^0-9]', '', 'g'), '0') <> ''
    and archived_at is null
  order by id
  limit 1;
$$;

revoke all on function public.product_id_for_barcode(text) from public;
grant execute on function public.product_id_for_barcode(text) to authenticated;
