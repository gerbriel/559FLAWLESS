-- ============================================================
-- 559 Flawless — 063: the eight rows the storefront never filled in
--
-- 062 could not cost eight catalogue rows, and the reason turned out to be the
-- same for all of them. On the studio's marketplace storefront, nine product
-- cards publish NO photograph and NO price — the <img> renders with src="" and
-- the price element renders as a bare "$". Every other card carries both.
--
-- 059 scraped that listing. Where a card was blank it did not write a blank: it
-- wrote another product's values. Eight of those nine cards are rows in this
-- database, and they broke in two different ways —
--
--   * five took the wrong product's NAME, description, photograph and price,
--     so the slug says one thing and the page shows another. A client opening
--     /shop/ultra-replenish-cream is shown Unveil Your Beauty, and the till
--     rings up $241.00 for a $19.00 cream.
--   * three kept their own name and photograph (017 had already seeded those
--     from the brand's CDN) and took only a wrong price. Pineapple Cleanse has
--     been priced $66.00 against a shelf price of $15.00.
--
-- Both are live money bugs, which is why this is a repair and not a note.
--
-- ── Where the replacement values come from ──
--
-- Names, descriptions, ingredients and directions: each product's own page on
-- the storefront, which is correct — it is only the listing CARD that is blank.
-- Copied verbatim, with two defects in the source repaired and recorded below.
--
-- Photographs: the brand's own CDN, the same source 017 used, each URL checked
-- for a 200 and each image opened and read to confirm the label matches the
-- product. Melasma Travel has no photograph anywhere and is set to NULL —
-- better an empty frame than another product's jar.
--
-- Prices and costs: the June 2026 order forms, smallest size, the basis 062
-- documents. The storefront publishes no price for these eight, so this is the
-- vendor's suggested retail rather than the studio's own figure — every margin
-- lands between 50% and 65%, in line with the rest of the shelf, but these are
-- the eight prices most worth her confirming.
--
-- ── The two source defects ──
--
--   * Ultra Replenish Cream's description begins "his velvety" on the
--     storefront. The dropped capital is restored.
--   * Grape Seed Antiox Mask's directions end mid-word, "Use once per wee".
--     Completed to "Use once per week." — its sibling enzymes all read
--     "Use once weekly."
--
-- Idempotent, and narrowly so: each statement names the broken value it is
-- repairing. If the studio has already corrected a row by hand, that statement
-- matches nothing and leaves her version alone.
-- ============================================================

-- ── 1. Rows showing another product entirely ──

-- Grape Seed Antiox Mask — the row still reads "Grape Seed Glow". Priced MT153 15ml.
update public.products set
  name        = $ra063$Grape Seed Antiox Mask$ra063$,
  description = $ra063$This buttery mask gently infuses wine extracts for vital antioxidant support. While firming and strengthening skin, you will be left with a soft moisturized finish.
Protects Collagen and Elastin
Boosts Hydration Support
Firms and Tones
TIP: Add a drop of Pure Grape Seed Elixir for more hydration$ra063$,
  ingredients = $ra063$Aqua (Water), Glycerin, Bentonite, Kaolin, Hamamelis Virginiana (Witch Hazel) Water, Butyrospermum Parkii (Shea) Butter, Caprylic/Capric Triglyceride, Stearic Acid, Cetyl Alcohol, Glycol Distearate, Limnanthes Alba (Meadowfoam) Seed Oil, Squalane, Vitis Vinifera (Grape) Seed Extract, Calamine, Dimethicone, Titanium Dioxide, Wine Extract (Resveratrol), Alcohol Denat., Glycerol Ricinoleate, Simmondsia Chinensis (Jojoba) Seed Oil, Allantoin, Tocopheryl Acetate (D-Alpha), Glycine Soja (Soybean) Oil, Alcohol, Xanthan Gum, Citrus Aurantium Dulcis (Orange) Oil, Tsunga Canadensis (Hemlock) Oil, Eucalyptus Globulus Leaf Oil, Eugenia Caryophyllus (Clove) Leaf Oil, Benzyl Alcohol$ra063$,
  how_to_use  = $ra063$Apply a thin layer to clean, dry skin – avoid eye area. Leave on for 10-15 minutes. Rinse well with cool water and soft cloth. Pat skin dry and finish with your favorite serums and moisturizer. Use once per week.$ra063$,
  image_url   = 'https://cdn.shopify.com/s/files/1/0079/2828/3249/files/GRAPE_SEED_ANTIOX_MASK_50ml_W.png',
  price_cents = 1700,
  cost_cents  = 600
where slug = 'grape-seed-antiox-mask'
  and name = $ra063$Grape Seed Glow$ra063$;

-- Hydra Glow Facial — the row still reads "Hydra Relief". Priced SPMTF2.
update public.products set
  name        = $ra063$Hydra Glow Facial$ra063$,
  description = $ra063$Our unique gommage enzyme with pineapple and papaya extracts gently buffs away skin, revealing a softer complexion. Skin is infused with antioxidants and a luxe grape seed oil. Give your skin a dewy, hydrated glow!$ra063$,
  ingredients = null,
  how_to_use  = $ra063$STEP 1: CLEANSE
Cleanse skin with the all-natural, probiotic essence of Gentle Peptide Cleanse for a thorough, deep-pore cleanse. Dispense 1-2 pumps into dampened hands and massage into skin for several minutes (don’t rush this step). Remove with warm water and soft cloth then pat skin dry.
STEP 2: ENZYME
Dispense 2-3 pumps of Derma - Zyme onto fingertips and apply evenly to skin. Avoid eye area. This papaya/pineapple enzyme will lift away dead skin cells and leave skin smooth and hydrated. Begin circular massage on face and neck until fine granules begin to form then let enzyme remain on skin for 5 - 10 minutes. Rinse with warm water and soft cloth or gauze. Pat skin dry.
STEP 3: MASK
Apply a thin, even layer of Grape Seed Antiox Mask to dry face and neck. Avoid eye area. This pro-youth, antioxidant-rich cream will firm and nourish while providing deep hydration. Leave on skin for 15-20 minutes. Remove with warm water and soft cloth. This is a great step to do in a steamy shower or bath.
STEP 4: HYDRATE & PROTECT
Finish with Grape Seed Glow for deep hydration and antioxidant support. Dispense 1-2 pumps onto fingertips and apply to clean, dry skin. Let absorb and remain on skin.$ra063$,
  image_url   = 'https://cdn.shopify.com/s/files/1/0079/2828/3249/files/HYDRA_GLOW_HF.png',
  price_cents = 6250,
  cost_cents  = 2350
where slug = 'hydra-glow-facial'
  and name = $ra063$Hydra Relief$ra063$;

-- Melasma Travel — the row still reads "Moisture Eye-Zyme". Priced PST2.
update public.products set
  name        = $ra063$Melasma Travel$ra063$,
  description = $ra063$Melasma is a common skin problem that causes dark, discolored patches on your skin. Using products with superior lightening ingredients, such as kojic acid, alpha arbutin, daisy flower extract, ascorbic acid (L) and azelaic acid, this advanced brightening system will minimize the appearance of discoloration for a more even skin tone and glowing, beautiful skin.
SYSTEM INCLUDES:
Skin Brightening Cleanser
MVC Serum
Blushed Wine Gel
Mandelic Arginine Serum
Skin Brightening Enzyme$ra063$,
  ingredients = null,
  how_to_use  = $ra063$AM – Cleanse with Skin Brightening Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps Vita-Bright Elixir, massage into skin. Finish with 1-2 pumps Luminous Wine Gel and Daytime Defense.
**For more hydration add a pump of Grape Seed Glow to the Vita-Bright Elixir**
PM - Cleanse with Skin Brightening Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps Mandelic Bright, massage into skin. Finish with 1-2 pumps Luminous Wine Gel or Grape Seed Glow if more hydration is needed.
Weekly – Incorporate Skin Brightening Enzyme once a week to boost brightening results. After cleansing, apply a thin layer and leave on skin for 8-10 minutes. Remove with cool water several times to ensure thorough removal. Pat skin dry and apply 1-2 pumps of Grape Seed Glow.$ra063$,
  image_url   = null,
  price_cents = 16850,
  cost_cents  = 6900
where slug = 'melasma-travel'
  and name = $ra063$Moisture Eye-Zyme$ra063$;

-- Skin Brightening Enzyme — the row still reads "Skin Repair Complex". Priced PS367 15ml.
update public.products set
  name        = $ra063$Skin Brightening Enzyme$ra063$,
  description = $ra063$A potent brightening agents combined with digestive enzymes will give skin a polished, glowing, more even complexion. Reduces inflammation and promotes exfoliation to deliver natural brightening support; an effective weekly treatment for melasma and age spots.
Suppresses Melanin Production
Digests Unwanted Cellular Buildup
Provides Radiant Tone & Smooth Texture
TIP: Cycle with Naturale Mega Brightening Serum to keep skin responding$ra063$,
  ingredients = $ra063$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Alcohol Denat., Caprylic/Capric Triglyceride, Stearic Acid, Propanediol, Cetyl Alcohol, Zeolite, Salicylic Acid, Glycol Distearate, Alcohol, Titanium Dioxide, Gaultheria Procumbens (Wintergreen) Leaf Oil, Pepsin, Alpha-Arbutin, Kojic Acid, Leuconostoc/Radish Root Ferment Filtrate, Azelaic Acid, Menthyl Lactate (L), Allantoin, Tocopheryl Acetate (D-alpha), Carbomer, Papain, Sodium Hydroxide, Melia Azadirachta (Neem) Leaf Extract, Sodium Gluconate, Melia Azadirachta (Neem) Flower Extract, Daucus Carota Sativa (Carrot) Root Extract, Corallina Officinalis Extract, Coccinia Indica Fruit Extract, O-cymen-5-Ol, Decyl Glucoside, Aloe Barbadensis Flower Extract, Solanum Melongena (Eggplant) Fruit Extract, Cucumis Sativus (Cucumber) Fruit Extract, Ocimum Sanctum Leaf Extract, Ocimum Basilicum (Basil) Flower/Leaf Extract, Curcuma Longa (Turmeric) Root Extract, Passiflora Incarnata (Passionflower) Flower Extract, Tetrasodium EDTA, Lauryl Glucoside, Citric Acid, Dimethicone, Caprylyl Glycol, Xanthan Gum$ra063$,
  how_to_use  = $ra063$Apply thin layer to clean, dry skin; avoid eye area. Leave on for 5-10 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow with your favorite RA mask, serums and moisturizer. Use once weekly.$ra063$,
  image_url   = 'https://cdn.shopify.com/s/files/1/0079/2828/3249/files/SKIN_BRIGHTENING_ENZYME_50ml_W.png',
  price_cents = 1800,
  cost_cents  = 900
where slug = 'skin-brightening-enzyme'
  and name = $ra063$Skin Repair Complex$ra063$;

-- Ultra Replenish Cream — the row still reads "Unveil Your Beauty". Priced MT129 15ml.
update public.products set
  name        = $ra063$Ultra Replenish Cream$ra063$,
  description = $ra063$This velvety, whipped moisturizer is ideal for dry, depleted, pro youth skin using hyaluronic acid to hydrate, plump fine lines and enhance collagen synthesis. Skin will look radiant and dewy.
Rich in Humectants
Replaces Vital Moisture
Anti-Inflammatory Support
TIP: Apply over Hyaluronic Concentrate for fast results.$ra063$,
  ingredients = $ra063$Aqua (Water), Caprylic/Capric Triglyceride, Coco-Caprylate/Caprate, Glycerin, Glyceryl Stearate, Cetearyl Alcohol, Cetearyl Glucoside, Glyceryl Stearate Citrate, Helianthus Annuus (Sunflower) Seed Wax, Polyglyceryl-3 Stearate, Dicaprylyl Ether, Caprylyl Glycol, Hydrogenated Lecithin, Lonicera Japonica (Honeysuckle) Flower Extract, Xanthan Gum, Lonicera Caprifolium (Honeysuckle) Flower Extract, Glucuronolactone (D), Succinoglycan, Sodium Gluconate, Citrus Aurantium Bergamia (Bergamot) Fruit Oil, Sodium Hyaluronate (L), Cassia Angustifolia Seed Polysaccharide, Fructooligosaccharides (D-beta), Pogostemon Cablin (Patchouli) Oil, Citrus Limon (Lemon) Peel Oil, Potassium Sorbate, Hamamelis Virginiana (Witch Hazel) Water, Cinnamomum Camphora (Camphor) Bark Oil, Canola Oil, Citric Acid, Capsicum Annuum (Paprika) Extract, Alcohol, Sodium Hydroxide, Phenethyl Alcohol, Fragrance/Parfum+$ra063$,
  how_to_use  = $ra063$Dispense 1-2 pumps and gently massage into clean, dry skin or layer over your favorite pro youth serum. For a dewy complexion, apply HA Hydra Mist before cream.$ra063$,
  image_url   = 'https://cdn.shopify.com/s/files/1/0079/2828/3249/files/ULTRA_REPLENISH_CREAM_50ml_T.png',
  price_cents = 1900,
  cost_cents  = 800
where slug = 'ultra-replenish-cream'
  and name = $ra063$Unveil Your Beauty$ra063$;

-- ── 2. Rows with the right name and the wrong price ──

-- Clear Bright Zyme — name and photo are 017's and correct; only the price was scraped
-- from the blank card. Repriced AR283 15ml.
update public.products set price_cents = 1800, cost_cents = 900
where slug = 'clear-bright-zyme'
  and price_cents = 10000
  and cost_cents = 0;

-- Pineapple Cleanse — name and photo are 017's and correct; only the price was scraped
-- from the blank card. Repriced MT08 30ml.
update public.products set price_cents = 1500, cost_cents = 700
where slug = 'pineapple-cleanse'
  and price_cents = 6600
  and cost_cents = 0;

-- Pumpkin Lactic Cleanse — name and photo are 017's and correct; only the price was scraped
-- from the blank card. Repriced MT04 30ml.
update public.products set price_cents = 1800, cost_cents = 800
where slug = 'pumpkin-lactic-cleanse'
  and price_cents = 5600
  and cost_cents = 0;

-- ============================================================
-- Not touched
--
-- The ninth blank card, "brighten-glow-facial", is not in this catalogue at
-- all — it is one of nine products the storefront lists and this database does
-- not. Worth a look, but adding products is not this migration's job.
--
-- Categories are left alone. melasma-travel sits in 'enzymes-masks' where a
-- kit arguably belongs in 'systems-collections', but so do inflammatory-travel,
-- sun-induced-travel and melasma-essentials. That is one inconsistent taxonomy
-- to settle in one pass, not a thing to half-fix here.
-- ============================================================
