-- ============================================================
-- 559 Flawless — 012: seed retail products (Rhonda Allison)
--
-- RETAIL, EXTERNALLY FULFILLED products. Each carries an `external_url`, so per
-- the storefront rules in 007_inventory.sql:
--   • the shop links out instead of entering the local cart
--   • no local price or stock is authoritative (both stay 0 — the
--     products_external_has_no_stock CHECK requires stock_qty = 0)
--   • the "Add to cart" button opens the URL below in a new tab
--
-- These are the REAL products on the studio's authorized marketplace store,
-- and each `external_url` is that product's OWN page on the marketplace
-- (…/store/559flawless/product/<slug>), so a tap lands the client on the exact
-- item rather than a generic cart.
--
-- `description` leads with the Rhonda Allison product line (Pro Youth -10,
-- Acne Remedies, Pigmentation Solutions, Reflect) the item belongs to.
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
  'https://ramarketplace.com/store/559flawless/product/' || v.ra_slug,
  true,   -- is_retail
  false,  -- is_professional
  v.is_featured,
  v.sort_order
from (values
  -- sku, name, slug, category_slug, ra_slug, description, is_featured, sort_order

  -- ── Cleansers & Scrubs ──────────────────────────────
  ('RA-PUMPKIN-LACTIC', 'Pumpkin Lactic Cleanse', 'pumpkin-lactic-cleanse', 'cleansers-scrubs', 'pumpkin-lactic-cleanse',
   'Pro Youth -10 · Enzyme-and-lactic cleanser that softens, smooths, and brightens dull skin.', true, 1),
  ('RA-BETA-BRIGHT', 'Beta Bright Cleanse', 'beta-bright-cleanse', 'cleansers-scrubs', 'beta-bright-cleanse',
   'Pigmentation Solutions · Brightening cleanser for uneven tone and daily buildup.', true, 2),
  ('RA-GREEN-TEA-BETA', 'Green Tea Beta Cleanse', 'green-tea-beta-cleanse', 'cleansers-scrubs', 'green-tea-beta-cleanse',
   'Acne Remedies · Clarifying green-tea cleanser that clears pores without stripping.', false, 3),
  ('RA-LUXE-BALM', 'Luxe Cleansing Balm', 'luxe-cleansing-balm', 'cleansers-scrubs', 'luxe-cleansing-balm',
   'Pro Youth -10 · A melting balm that dissolves makeup and sunscreen while nourishing.', false, 4),
  ('RA-ENZYMATIC-CLNS', 'Enzymatic Cleanse', 'enzymatic-cleanse', 'cleansers-scrubs', 'enzymatic-cleanse',
   'Acne Remedies · Gentle enzymatic cleanser for congested, breakout-prone skin.', false, 5),

  -- ── Toners ──────────────────────────────────────────
  ('RA-ALL-PURPOSE-PADS', 'All Purpose Tonic Pads', 'all-purpose-tonic-pads', 'toners', 'all-purpose-cleansing-pads',
   'Acne Remedies · Pre-soaked tonic pads for on-the-go clarifying and pH balance.', true, 6),
  ('RA-ANTIOX-AHA-TONIC', 'Antiox AHA Tonic', 'antiox-aha-tonic', 'toners', 'antiox-aha-tonic',
   'Acne Remedies · An AHA tonic that refines texture and keeps skin clear.', false, 7),
  ('RA-ANTIOX-DEFEND', 'Antiox Defend Tonic', 'antiox-defend-tonic', 'toners', 'antiox-defend-tonic',
   'Pro Youth -10 · Antioxidant tonic that rebalances and preps skin after cleansing.', false, 8),

  -- ── Correctives ─────────────────────────────────────
  ('RA-A-RENEW', '"A" Renew +', 'a-renew-plus', 'correctives', 'a-renew',
   'Pigmentation Solutions · A vitamin-A renewal serum for tone, texture, and fine lines.', true, 9),
  ('RA-AHA-REFINE', 'AHA Refine Gel', 'aha-refine-gel', 'correctives', 'aha-refine-gel',
   'Acne Remedies · Leave-on AHA gel that smooths and clarifies.', false, 10),
  ('RA-BHA-REFINE', 'BHA Refine Gel', 'bha-refine-gel', 'correctives', 'bha-refine-gel',
   'Acne Remedies · Salicylic BHA gel that keeps pores clear.', false, 11),
  ('RA-BLEMISH-SERUM', 'Blemish Serum', 'blemish-serum', 'correctives', 'blemish-serum',
   'Acne Remedies · Targeted serum for active breakouts and spots.', false, 12),
  ('RA-KOJIC-MASK', 'Kojic Clear Mask', 'kojic-clear-mask', 'correctives', 'kojic-clear-mask',
   'Acne Remedies · Kojic-acid brightening mask for post-breakout discoloration.', false, 13),

  -- ── Building & Strengthening ────────────────────────
  ('RA-BALANCING-CKTL', 'Balancing Cocktail', 'balancing-cocktail', 'building-strengthening', 'balancing-cocktail',
   'Acne Remedies · A calming, rebalancing serum for reactive, congested skin.', false, 14),
  ('RA-AGELESS', 'AgeLess', 'ageless', 'building-strengthening', 'ageless',
   'Pro Youth -10 · A firming, strengthening serum for resilience and repair.', true, 15),
  ('RA-ANTIOX-18', 'Antiox 18 Complex', 'antiox-18-complex', 'building-strengthening', 'antiox-18-complex',
   'Pro Youth -10 · An antioxidant complex that defends and builds barrier strength.', false, 16),
  ('RA-HYLAMEGA', 'HylaMega Silk', 'hylamega-silk', 'building-strengthening', 'hylamega-silk',
   'Pro Youth -10 · A hyaluronic silk serum for plumping, cushioned hydration.', false, 17),

  -- ── Moisturizers & Hydrators ────────────────────────
  ('RA-ALOE-MATTE', 'Aloe Matte Moisture Cream', 'aloe-matte-moisture-cream', 'moisturizers-hydrators', 'aloe-matte-moisture-cream',
   'Acne Remedies · A lightweight matte moisturizer for oily, breakout-prone skin.', false, 18),
  ('RA-AMINO-HYDRA', 'Amino Peptide Hydration', 'amino-peptide-hydration', 'moisturizers-hydrators', 'amino-peptide-hydration',
   'Pro Youth -10 · A peptide hydrator that softens and supports firmness.', false, 19),
  ('RA-BRIGHT-CREAM', 'Brightening Cream Enhanced', 'brightening-cream-enhanced', 'moisturizers-hydrators', 'brightening-cream-enhanced',
   'Pigmentation Solutions · A brightening moisturizer for uneven, sun-affected skin.', true, 20),
  ('RA-DROP-ESSENCE', 'Drop of Essence', 'drop-of-essence', 'moisturizers-hydrators', 'drop-of-essence',
   'Pro Youth -10 · A nourishing facial oil to seal in hydration and calm tightness.', true, 21),

  -- ── Enzymes & Masks ─────────────────────────────────
  ('RA-ALOE-ZYME', 'Aloe-Zyme', 'aloe-zyme', 'enzymes-masks', 'aloe-zyme',
   'Acne Remedies · A soothing enzyme mask that decongests while it calms.', false, 22),
  ('RA-CHERRY-JUBILEE', 'Cherry Jubilee Enzyme', 'cherry-jubilee-enzyme', 'enzymes-masks', 'cherry-jubilee-enzyme',
   'Pro Youth -10 · A brightening enzyme that smooths and refreshes dull skin.', true, 23),
  ('RA-CHOC-ANTIOX', 'Chocolate Antiox Mask', 'chocolate-antiox-mask', 'enzymes-masks', 'chocolate-antiox-mask',
   'Pro Youth -10 · An antioxidant cocoa mask for glow and nourishment.', false, 24),
  ('RA-CLEAR-BRIGHT-ZYME', 'Clear Bright Zyme', 'clear-bright-zyme', 'enzymes-masks', 'clear-bright-zyme',
   'Acne Remedies · A clarifying enzyme for congested, uneven skin.', false, 25),

  -- ── Peptides ────────────────────────────────────────
  ('RA-AMINO-PEPT-SERUM', 'Amino Peptide Serum', 'amino-peptide-serum', 'peptides', 'amino-peptide-serum',
   'Pro Youth -10 · A concentrated peptide serum for firmness and repair.', true, 26),
  ('RA-PEPTIDE-38', 'Peptide 38', 'peptide-38', 'peptides', 'peptide-38',
   'Pro Youth -10 · A multi-peptide serum targeting firmness and fine lines.', false, 27),
  ('RA-PEPT-MITO', 'Peptide Mito-Protect', 'peptide-mito-protect', 'peptides', 'peptide-mito-protect',
   'Pro Youth -10 · A protective peptide serum for cellular support and resilience.', false, 28),

  -- ── Sun Protection ──────────────────────────────────
  ('RA-DAYTIME-DEFENSE', 'Daytime Defense', 'daytime-defense', 'sun-protection', 'daytime-defense',
   'Reflect · Broad-spectrum daily SPF — non-negotiable after any exfoliation or peel.', true, 29),
  ('RA-EZINC-PROTECT', 'Ezinc Protection', 'ezinc-protection', 'sun-protection', 'ezinc-protection',
   'Reflect · A mineral zinc sunscreen for everyday broad-spectrum defense.', false, 30),
  ('RA-ZINC-RELIEF', 'Zinc Relief SPF 22', 'zinc-relief-spf-22', 'sun-protection', 'ezinc-protection-spf-22',
   'Acne Remedies · A calming zinc SPF 22 for sensitive, breakout-prone skin.', false, 31),

  -- ── At Home Facials ─────────────────────────────────
  ('RA-ANTIOX-GLOW-FAC', 'Antioxidant Glow Facial', 'antioxidant-glow-facial', 'at-home-facials', 'antioxidant-glow-facial',
   'Pro Youth -10 · A guided at-home facial kit for a brightening antioxidant glow.', true, 32),
  ('RA-BRIGHTEN-CLEAR-FAC', 'Brighten & Clear Facial', 'brighten-clear-facial', 'at-home-facials', 'brighten-clear-facial',
   'Acne Remedies · A guided at-home facial kit to clarify and even tone.', false, 33),

  -- ── Systems & Collections ───────────────────────────
  ('RA-AGE-REV-NORMAL', 'Age Reversal System — Normal to Dry', 'age-reversal-system-normal-to-dry', 'systems-collections', 'age-reversal-system-normal-to-dry-skin',
   'Pro Youth -10 · A complete anti-aging routine for normal to dry skin.', false, 34),
  ('RA-AGE-REV-SENS', 'Age Reversal System — Sensitive', 'age-reversal-system-sensitive', 'systems-collections', 'age-reversal-system-sensitive-skin',
   'Pro Youth -10 · A complete anti-aging routine formulated for sensitive skin.', false, 35),

  -- ── Duos ────────────────────────────────────────────
  ('RA-COLLAGEN-SNAP', 'Collagen Snap Back', 'collagen-snap-back', 'duos', 'collagen-snap-back',
   'Pro Youth -10 · A firming duo built to restore bounce and support collagen.', true, 36),
  ('RA-DAILY-DOSE', 'Daily Dose', 'daily-dose', 'duos', 'daily-dose',
   'Pro Youth -10 · A daily essentials duo meant to be used together.', false, 37),
  ('RA-ELIM-HYDRATE', 'Eliminate + Hydrate', 'eliminate-hydrate', 'duos', 'eliminate-hydrate',
   'Acne Remedies · A clear-and-hydrate duo for balanced, breakout-prone skin.', false, 38),
  ('RA-FADE-GLOW', 'Fade & Glow', 'fade-glow', 'duos', 'fade-glow',
   'Pigmentation Solutions · A pigment-fading, glow-boosting duo for even tone.', true, 39)
) as v(sku, name, slug, category_slug, ra_slug, description, is_featured, sort_order)
on conflict (slug) do nothing;
