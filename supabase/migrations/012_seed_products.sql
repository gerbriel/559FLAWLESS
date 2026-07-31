-- ============================================================
-- 559 Flawless — 012: seed retail products (Rhonda Allison)
--
-- These are RETAIL, EXTERNALLY FULFILLED products. Each carries an
-- `external_url`, so per the storefront rules in 007_inventory.sql:
--   • the shop links out instead of entering the local cart
--   • no local price or stock is authoritative (both stay 0 — the
--     products_external_has_no_stock CHECK requires stock_qty = 0)
--   • the "Add to cart" button opens the URL below in a new tab
--
-- Every product points at the studio's authorized Rhonda Allison
-- marketplace CART so a tap on "Add to cart" lands the client there.
-- If the marketplace later exposes per-item deep links, replace the
-- shared cart URL below with each product's own add-to-cart URL — the
-- app already renders whatever `external_url` holds.
--
-- Idempotent: `on conflict (slug) do nothing`. Safe to re-run.
-- ============================================================

insert into public.products
  (sku, name, slug, category_id, brand_id, description, external_url,
   is_retail, is_professional, is_featured, sort_order)
select
  v.sku,
  v.name,
  v.slug,
  (select id from public.product_categories where slug = v.category_slug),
  (select id from public.brands where slug = 'rhonda-allison'),
  v.description,
  'https://ramarketplace.com/store/559flawless/cart',
  true,   -- is_retail
  false,  -- is_professional
  v.is_featured,
  v.sort_order
from (values
  -- sku, name, slug, category_slug, description, is_featured, sort_order
  ('RA-BETA-GREEN', 'Beta Green Cleanser', 'beta-green-cleanser', 'cleansers-scrubs',
   'A gentle daily gel cleanser with green tea and beta-glucan that lifts debris without stripping the barrier.', true, 1),
  ('RA-PUMPKIN-CLNS', 'Pumpkin Cleanser', 'pumpkin-cleanser', 'cleansers-scrubs',
   'Enzyme-forward cleanser that softens and smooths dull, congested skin as it cleans.', false, 2),
  ('RA-CRAN-SCRUB', 'Cranberry Tocopherol Scrub', 'cranberry-tocopherol-scrub', 'cleansers-scrubs',
   'A fine physical polish with cranberry seed and vitamin E to refine texture between treatments.', false, 3),

  ('RA-ROSE-TONER', 'Rose Petal Refining Toner', 'rose-petal-refining-toner', 'toners',
   'Alcohol-free rose water toner that rebalances pH and preps skin to absorb what follows.', true, 4),
  ('RA-BETA-TONER', 'Beta Hydroxy Complex', 'beta-hydroxy-complex', 'toners',
   'A leave-on toning solution with salicylic acid to keep pores clear and skin smooth.', false, 5),

  ('RA-C-SERUM', 'C-Stem Vitamin C Serum', 'c-stem-vitamin-c-serum', 'correctives',
   'Stabilized vitamin C with stem-cell support to brighten tone and defend against daily stressors.', true, 6),
  ('RA-BRIGHT-DROPS', 'Brighten Drops', 'brighten-drops', 'correctives',
   'Targeted correctives for uneven pigment and post-treatment discoloration.', false, 7),
  ('RA-RETINALDE', 'Retinaldehyde Serum', 'retinaldehyde-serum', 'correctives',
   'A gentler-than-retinoid vitamin A serum for texture, tone, and fine lines.', false, 8),

  ('RA-GROWTH-FACT', 'Growth Factor Serum', 'growth-factor-serum', 'building-strengthening',
   'Barrier-building serum that supports resilience in compromised, reactive skin.', false, 9),
  ('RA-DBL-DEF', 'Bio Lift Firming Serum', 'bio-lift-firming-serum', 'building-strengthening',
   'Strengthening serum that firms and supports skin recovering from over-exfoliation.', false, 10),

  ('RA-DROPLET', 'Drop of Essence Oil', 'drop-of-essence-oil', 'moisturizers-hydrators',
   'A lightweight nourishing facial oil to seal in hydration and calm tight skin.', true, 11),
  ('RA-HYDRA-CREAM', 'Hydra Complex Moisturizer', 'hydra-complex-moisturizer', 'moisturizers-hydrators',
   'Everyday hydrating cream that softens without heaviness for most skin types.', false, 12),
  ('RA-SHEA-MENDER', 'Skin Mender Balm', 'skin-mender-balm', 'moisturizers-hydrators',
   'Rich occlusive balm for dry patches and post-treatment recovery.', false, 13),

  ('RA-PUMPKIN-ENZ', 'Pumpkin Enzyme Mask', 'pumpkin-enzyme-mask', 'enzymes-masks',
   'An at-home enzyme mask to keep skin smooth and glowing between facials.', true, 14),
  ('RA-HONEY-MASK', 'Herbal Green Mask', 'herbal-green-mask', 'enzymes-masks',
   'Calming clay-and-herb mask that decongests without over-drying.', false, 15),

  ('RA-PEPT-EYE', 'Peptide Eye Firming Gel', 'peptide-eye-firming-gel', 'peptides',
   'Peptide gel that firms and depuffs the delicate eye area.', false, 16),
  ('RA-PEPT-SERUM', 'Peptide 3 Firming Serum', 'peptide-3-firming-serum', 'peptides',
   'A concentrated peptide serum targeting firmness and repair.', true, 17),

  ('RA-SPF30', 'Sheer Tint SPF 30', 'sheer-tint-spf-30', 'sun-protection',
   'A daily mineral-based tinted SPF 30 — non-negotiable after any exfoliation or peel.', true, 18),
  ('RA-SPF-CLEAR', 'Daytime Defense SPF 30', 'daytime-defense-spf-30', 'sun-protection',
   'Lightweight untinted broad-spectrum SPF 30 for everyday wear.', false, 19),

  ('RA-HOME-FACIAL', 'At-Home Facial Kit', 'at-home-facial-kit', 'at-home-facials',
   'A guided kit — cleanse, enzyme, serum, mask — to extend your results between visits.', true, 20),

  ('RA-SYS-CLARIFY', 'Clarifying System', 'clarifying-system', 'systems-collections',
   'A complete routine built around clarity and control for congested skin.', false, 21),
  ('RA-SYS-BRIGHT', 'Brightening System', 'brightening-system', 'systems-collections',
   'A full pigment-focused routine to even tone over a series.', false, 22),

  ('RA-DUO-AM-PM', 'AM / PM Essentials Duo', 'am-pm-essentials-duo', 'duos',
   'A paired morning and evening set meant to be used together for balanced daily care.', false, 23),
  ('RA-DUO-REPAIR', 'Repair & Protect Duo', 'repair-protect-duo', 'duos',
   'Barrier serum plus daily SPF — the two things skin most needs, together.', false, 24)
) as v(sku, name, slug, category_slug, description, is_featured, sort_order)
on conflict (slug) do nothing;
