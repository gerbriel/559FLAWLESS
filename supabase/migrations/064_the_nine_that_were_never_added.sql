-- ============================================================
-- 559 Flawless — 064: the nine products the scrape wrote over
--
-- 063 repaired eight catalogue rows that carried another product's name, photo
-- or price. This adds the nine products those values were TAKEN FROM, none of
-- which is in the catalogue at all.
--
-- The two facts are the same fact. Where the storefront's listing card was
-- blank, 059 wrote the neighbouring product's values into that slug — so the
-- neighbour's content landed on a row it did not belong to, and the neighbour's
-- own row was never inserted. Every bogus value 063 removed traces to exactly
-- one of these nine, to the cent:
--
--   $241.00 on ultra-replenish-cream    was Unveil Your Beauty's
--   $100.00 on clear-bright-zyme        was Clear Relief's
--    $66.00 on pineapple-cleanse        was Polished Glow Facial's
--    $56.00 on pumpkin-lactic-cleanse   was Pumpkin Parfait Enzyme's
--    $56.50 on hydra-glow-facial        was Hydra Relief's
--    $42.00 on skin-brightening-enzyme  was Skin Repair Complex's
--    $40.00 on melasma-travel           was Moisture Eye-Zyme's
--    $16.00 on grape-seed-antiox-mask   was Grape Seed Glow's
--
-- That is eight; the ninth, Brighten & Glow Facial, is itself a blank card, so
-- nothing was copied from it and nothing pointed at it. It was simply skipped.
--
-- ── Sources ──
--
-- Copy: each product's own page on the storefront, verbatim.
-- Photographs: the marketplace's own listing images, except Brighten & Glow
-- Facial, which has none — that one comes from the brand CDN, checked for a 200
-- and opened to confirm the label reads "BRIGHTEN & GLOW".
-- Prices: the studio's storefront, which publishes a figure for eight of the
-- nine. Brighten & Glow Facial has none, so it takes the June 2026 suggested
-- retail (SPPSF1, $66.00) — the same figure its sibling Polished Glow Facial
-- already carries from the storefront.
-- Costs: the June 2026 order forms, on 062's rule — the size whose suggested
-- retail matches the shelf price. Margins land 52% to 63%.
--
-- Grape Seed Glow is the one exception and keeps cost_cents = 0. Its shelf
-- price, $16.00, is the 10ml, and the sheets sell that size only inside a kit,
-- so there is no unit cost to take. Same reason as the ten rows 062 left alone.
--
-- Categories follow each product's existing siblings rather than a fresh
-- opinion: the eye products sit at NULL because eye-lift and eye-revitalizer
-- do, and the eye kits sit in 'enzymes-masks' because revitalize-your-eyes and
-- firm-eyefect do. That taxonomy is worth settling in one pass one day; this is
-- not that pass.
--
-- Stock is left at 0. These are real products on a real shelf, but what is on
-- it is a count, not something a migration can know.
--
-- Idempotent: `on conflict (slug) do nothing`, so a product the studio has
-- since added by hand is left exactly as she made it.
-- ============================================================

-- Brighten & Glow Facial — its own card is the ninth blank one, so price and photo come from the sheet and the brand CDN. Priced SPPSF1.
insert into public.products
  (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
   image_url, price_cents, cost_cents, external_url, is_retail, is_professional, is_active)
values
  ('RA-BRIGHTEN-GLOW-FACIAL', $ra064$Brighten & Glow Facial$ra064$, 'brighten-glow-facial',
   (select id from public.product_categories where slug = 'at-home-facials'),
   (select id from public.brands where slug = 'rhonda-allison'),
   $ra064$Powerful lightening agents combined with digestive enzymes leave skin soft and brighter. Rich cocoa and cranberry extracts combined with nourishing grape seed oil replenishes skin with antioxidants and hydration. Skin is polished and radiant!$ra064$,
   null,
   $ra064$STEP 1: CLEANSE
Cleanse skin with our de-pigment, all-purpose Skin Brightening Cleanse for a thorough, deep-pore cleanse. Dispense 1-2 pumps and massage into skin for several minutes (don’t rush this step). Remove with warm water and soft cloth then pat skin dry.
STEP 2: ENZYME
Deliver natural brightening support with our de-pigment Skin Brightening Enzyme. Apply a thin, even layer to clean, dry skin. Avoid eye area. Leave on for 5-10 minutes. Rinse thoroughly with cool water and soft cloth or gauze then pat skin dry.
STEP 3: MASK
Apply a thin, even layer of our replenishing Cocoa Berry C Mask to dry face and neck. Avoid eye area. Let remain on skin for 10-15 minutes. Remove with tepid water and soft cloth or gauze then pat skin dry. Mask may create a stimulating sensation which is normal. For additional antioxidant protection, apply a few drops of Grape Seed Glow to skin prior to mask application.
STEP 4: HYDRATE & PROTECT
Finish with Grape Seed Glow for deep hydration and antioxidant support. Dispense 1-2 pumps onto fingertips and apply to clean, dry skin. Let absorb and remain on skin.$ra064$,
   'https://cdn.shopify.com/s/files/1/0079/2828/3249/files/BRIGHTEN_GLOW_HF.png', 6600, 2750,
   'https://ramarketplace.com/store/559flawless/product/brighten-glow-facial', true, false, true)
on conflict (slug) do nothing;

-- Clear Relief — Priced AR1.
insert into public.products
  (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
   image_url, price_cents, cost_cents, external_url, is_retail, is_professional, is_active)
values
  ('RA-CLEAR-RELIEF', $ra064$Clear Relief$ra064$, 'clear-relief',
   (select id from public.product_categories where slug = 'systems-collections'),
   (select id from public.brands where slug = 'rhonda-allison'),
   $ra064$Provide clear relief, spot treat stubborn blemishes and bring back balance to acne-prone skin. Reducing bacteria without over drying the skin, this system uses the exfoliating support of salicylic acid, the anti-inflammatory benefits of green tea and aloe vera and the healing power of epidermal growth factors to improve the overall appearance of skin for a healthy-looking complexion.
SYSTEM INCLUDES:
Green Tea Beta Cleanse
Green Tea Tonic
Blemish Serum
Vital Repair Gel
Aloe Matte Moisture Cream$ra064$,
   null,
   $ra064$AM – Cleanse with Green Tea Beta Cleanse, remove with warm water and soft cloth, pat skin dry. Apply Green Tea Tonic with a cotton round, let product absorb into skin. Spot treat blemishes with Blemish Serum. Finish with 1-2 pumps Aloe Matte Moisture Cream.
PM - Cleanse with Green Tea Beta Cleanse, remove with warm water and soft cloth, pat skin dry. Spot treat blemishes with Blemish Serum. Finish with 1-2 pumps Vital Repair Gel.$ra064$,
   'https://ramarketplace.com/media/products/_listing/CLEAR_RELIEF_TVL5_a5ce6566-f919-489b-be6c-1d33259a386b.jpg', 10000, 4200,
   'https://ramarketplace.com/store/559flawless/product/clear-relief', true, false, true)
on conflict (slug) do nothing;

-- Grape Seed Glow — shelf price is the 10ml, which the sheets sell only inside a kit — no unit cost, so cost stays 0. Priced PS342.
insert into public.products
  (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
   image_url, price_cents, cost_cents, external_url, is_retail, is_professional, is_active)
values
  ('RA-GRAPE-SEED-GLOW', $ra064$Grape Seed Glow$ra064$, 'grape-seed-glow',
   (select id from public.product_categories where slug = 'building-strengthening'),
   (select id from public.brands where slug = 'rhonda-allison'),
   $ra064$A refined grape seed oil that reduces free radical damage and inflammation, protects healthy collagen and leaves the skin hydrated and nourished.$ra064$,
   $ra064$Vitis Vinifera (Grape) Seed Oil, Citrus Aurantium Dulcis (Orange) Oil, Tsunga Canadensis (Hemlock) Oil, Eugenia Caryophyllus (Clove) Leaf Oil, Cinnamomum (Cinnamon) Cassia Leaf Oil, Vitis Vinifera (Grape) Seed Extract$ra064$,
   $ra064$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin morning and/or night.$ra064$,
   'https://ramarketplace.com/media/products/_listing/8db9da68-263d-4541-88c1-b4e49b62dc4c.png', 1600, 0,
   'https://ramarketplace.com/store/559flawless/product/grape-seed-glow', true, false, true)
on conflict (slug) do nothing;

-- Hydra Relief — Priced ARD4.
insert into public.products
  (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
   image_url, price_cents, cost_cents, external_url, is_retail, is_professional, is_active)
values
  ('RA-HYDRA-RELIEF', $ra064$Hydra Relief$ra064$, 'hydra-relief',
   (select id from public.product_categories where slug = 'duos'),
   (select id from public.brands where slug = 'rhonda-allison'),
   $ra064$Provide hydrating relief to dry acne skin. This soothing duo combines the water-binding essence of hyaluronic acid with the power of heavy water and cucumber to give skin a much needed “drink of water”. Reduces heat and inflammation while keeping skin cool and refreshed without clogging pores.
SYSTEM INCLUDES:
Hyaluronic Tonic
HA Clear Concentrate$ra064$,
   null,
   $ra064$AM – After cleansing with RA Cleanser appropriate for your skin, spritz skin with Hyaluronic Tonic, let product absorb into skin. Apply 1-2 pumps of HA Clear Concentrate. Finish with your Sun Reflect product.
PM – After cleansing with RA Cleanser appropriate for your skin, spritz skin with Hyaluronic Tonic, let product absorb into skin. Apply RA Corrective recommended by your RA Professional. Finish with your favorite Acne Remedies hydrator.$ra064$,
   'https://ramarketplace.com/media/products/_listing/HYDRA_RELIEF_DUO_a80f280b-90f2-47ea-bd4f-9cbbbbe62088.jpg', 5650, 2350,
   'https://ramarketplace.com/store/559flawless/product/hydra-relief', true, false, true)
on conflict (slug) do nothing;

-- Moisture Eye-Zyme — Priced EC5 15ml.
insert into public.products
  (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
   image_url, price_cents, cost_cents, external_url, is_retail, is_professional, is_active)
values
  ('RA-MOISTURE-EYE-ZYME', $ra064$Moisture Eye-Zyme$ra064$, 'moisture-eye-zyme',
   null,
   (select id from public.brands where slug = 'rhonda-allison'),
   $ra064$Keep eyes vibrant and hydrated with this weekly eye treatment using pomegranate, lactic acid and retinol to firm and reduce puffiness, crow’s feet and crepey skin for younger-looking eyes.$ra064$,
   $ra064$Aqua (Water), Glycerin, Decyl Glucoside, Hydroxypropyl Methylcellulose, Camellia Oleifera (Green Tea) Leaf Extract, Sodium Lauroyl Lactylate, Phenoxyethanol, Sodium Hydroxymethylglycinate, Caprylyl Glycol, Lactic Acid (L), Chamomilla Recutita (Matricaria) Flower Extract, Vaccinium Myrtillus (Bilberry) Fruit Extract, Allantoin, Ascorbic Acid (L), Tocopherol (D-Alpha), Phytic Acid, Glycine Soja (Soybean) Oil, Sodium Hyaluronate (L), Phenethyl Alcohol, Beta-Glucan (D), Potassium Sorbat$ra064$,
   $ra064$Gently massage 1-2 pumps over lashes, around eye area and over entire face. Remove with warm water and soft cloth. Pat skin dry.$ra064$,
   'https://ramarketplace.com/media/products/_listing/MOISTURE_EYE-ZYME_15ml_360fd40f-0738-42c7-b318-935f7038aca1.png', 4000, 1500,
   'https://ramarketplace.com/store/559flawless/product/moisture-eye-zyme', true, false, true)
on conflict (slug) do nothing;

-- Polished Glow Facial — Priced SPMTF1.
insert into public.products
  (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
   image_url, price_cents, cost_cents, external_url, is_retail, is_professional, is_active)
values
  ('RA-POLISHED-GLOW-FACIAL', $ra064$Polished Glow Facial$ra064$, 'polished-glow-facial',
   (select id from public.product_categories where slug = 'at-home-facials'),
   (select id from public.brands where slug = 'rhonda-allison'),
   $ra064$Papaya extracts gently buff and soften skin texture while rich chocolate and nourishing grape seed oil replenishes pro youth skin with antioxidants and hydration. Skin is smooth and radiant!$ra064$,
   null,
   $ra064$STEP 1: CLEANSE
Cleanse skin with the all-natural, probiotic essence of Gentle Peptide Cleanse for a thorough, deep-pore cleanse. Dispense 1-2 pumps into dampened hands and massage into skin for several minutes (don’t rush this step). Remove with warm water and soft cloth then pat skin dry.
STEP 2: ENZYME
Apply Papaya Tangerine Enzyme evenly to skin and massage in for several minutes. Avoid eye area. Let remain on skin for 10 -15 minutes. This is a good step to do in a steamy shower or bath. Remove with warm water and soft cloth or gauze then pat skin dry.
STEP 3: MASK
Apply a thin, even layer of our replenishing, pro-youth Chocolate Antiox Mask to dry face and neck. Avoid eye area. Let remain on skin for 10-15 minutes. Remove with tepid water and soft cloth or gauze then pat skin dry. Mask may create a stimulating sensation which is normal. For additional antioxidant benefits, apply a few drops of Pure Grape Seed Elixir to skin prior to mask application.
STEP 4: HYDRATE & PROTECT
Finish with Pure Grape Seed Elixir for deep hydration and antioxidant support. Dispense 1-2 pumps onto fingertips and apply to clean, dry skin. Let absorb and remain on skin.$ra064$,
   'https://ramarketplace.com/media/products/_listing/POLISHED_GLOW_HF.png', 6600, 2750,
   'https://ramarketplace.com/store/559flawless/product/polished-glow-facial', true, false, true)
on conflict (slug) do nothing;

-- Pumpkin Parfait Enzyme — Priced MT150 50ml.
insert into public.products
  (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
   image_url, price_cents, cost_cents, external_url, is_retail, is_professional, is_active)
values
  ('RA-PUMPKIN-PARFAIT-ENZYME', $ra064$Pumpkin Parfait Enzyme$ra064$, 'pumpkin-parfait-enzyme',
   (select id from public.product_categories where slug = 'enzymes-masks'),
   (select id from public.brands where slug = 'rhonda-allison'),
   $ra064$This powerful, nutrient-dense enzyme is powerful! Pumpkin extract dissolves cellular build-up, smoothing texture and delivers strong antioxidents. Skin is left renewed and vibrant.
Stimulate Collagen Synthese
Boost Antioxidant Support
Addresses Thick, Photo-Aged Skin
TIP: Apply a light layer of Pumpkin E Serum before enzyme$ra064$,
   $ra064$Cucurbita Pepo (Pumpkin), Cucurbita Pepo (Pumpkin) Seed Oil, Lactobacillus/Pumpkin Fruit Ferment Filtrate, Fructooligosaccharides (D-Beta), Cinnamomum Cassia Leaf Oil, Eugenia Caryophyllus (Clove) Leaf Oil, Zingiber Officinale (Ginger) Root Oil, Aqua (Water), Glycerin, Hydroxypropyl Methylcellulose, Gluconic Acid (D)$ra064$,
   $ra064$Apply thin layer to clean, dry skin – avoid eye area. Leave on for 5-10 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow up with your favorite pro youth mask, serums and moisturizer. Use once per week.$ra064$,
   'https://ramarketplace.com/media/products/_listing/PUMPKIN_PARFAIT_ENZYME_50ml_W_2026-05-12-224705_wvjr.png', 5600, 2700,
   'https://ramarketplace.com/store/559flawless/product/pumpkin-parfait-enzyme', true, false, true)
on conflict (slug) do nothing;

-- Skin Repair Complex — Priced AR238 30ml.
insert into public.products
  (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
   image_url, price_cents, cost_cents, external_url, is_retail, is_professional, is_active)
values
  ('RA-SKIN-REPAIR-COMPLEX', $ra064$Skin Repair Complex$ra064$, 'skin-repair-complex',
   (select id from public.product_categories where slug = 'building-strengthening'),
   (select id from public.brands where slug = 'rhonda-allison'),
   $ra064$Birch bark and sea buckthorn oil defend reactive, problematic skin against inflammatory triggers; reduces bacteria and redness while repairing barrier function.$ra064$,
   $ra064$Aqua (Water), Glycerin, Caprylic/Capric Triglyceride, Alcohol Denat., Dipropylene Glycol, Butylene Glycol, Caprylyl Glycol, Leuconostoc/Radish Root Ferment Filtrate, Olea Europaea (Olive) Leaf Extract*, Polysorbate 20, Polyacrylamide, Propanediol, C13-14 Isoparaffin, Asiatic Acid, Hippophae Rhamnoides Fruit Oil*, Scrofularia Nodosa (Figwort) Extract, Betula Alba (Birch) Bark Extract, Laureth-7, Glycyrrhetinic Acid, Totarol, Rutin, Mirabilis Jalapa Flower/Leaf/Stem Extract, Hamamelis Virginiana (Witch Hazel) Water, Citric Acid, Sodium Hydroxide, Xanthan Gum, Alcohol$ra064$,
   $ra064$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin morning or night. Let serum absorb. May layer moisturizer overtop.$ra064$,
   'https://ramarketplace.com/media/products/_listing/SKIN_REPAIR_COMPLEX_30ml_T_2026-02-26-000322_liiy.png', 4200, 1700,
   'https://ramarketplace.com/store/559flawless/product/skin-repair-complex', true, false, true)
on conflict (slug) do nothing;

-- Unveil Your Beauty — Priced ECT1.
insert into public.products
  (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
   image_url, price_cents, cost_cents, external_url, is_retail, is_professional, is_active)
values
  ('RA-UNVEIL-YOUR-BEAUTY', $ra064$Unveil Your Beauty$ra064$, 'unveil-your-beauty',
   (select id from public.product_categories where slug = 'enzymes-masks'),
   (select id from public.brands where slug = 'rhonda-allison'),
   $ra064$Customized for the most delicate skin tissue, this age-defying eye system uses powerful peptides and stem cell technology to minimize fine lines, crow’s feet and dark circles, brighten tissue, provide deep hydration, reduce puffiness and restore elasticity for younger-looking Line:Eyes.
System Includes:
Eye Revitalizer
Peptide 3-N-1 Eye Cream
Eye & Lip Renew Serum
Makeup Remover$ra064$,
   null,
   null,
   'https://ramarketplace.com/media/products/_listing/UNVEIL_YOUR_BEAUTY_TVL4_2023-06-07-105554_dopo.jpg', 24100, 10800,
   'https://ramarketplace.com/store/559flawless/product/unveil-your-beauty', true, false, true)
on conflict (slug) do nothing;
