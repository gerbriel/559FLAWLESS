-- ============================================================
-- 559 Flawless — 059: the rest of the shelf, and prices at last
--
-- Pulled from the studio's own authorized storefront,
-- https://ramarketplace.com/store/559flawless — the same source 017 scraped
-- for the original 47, read the same way: listed for discovery here, bought
-- on the marketplace there, so every row carries external_url and the
-- marketplace stays the authority on fulfilment.
--
-- What this does, in order:
--
--   1. INSERTS the 110 products the storefront carries that this
--      database does not, each with its description, ingredient list, usage
--      directions, photograph, category and price. `on conflict (slug) do
--      nothing`, so a product added by hand since this was written is left
--      exactly as the studio made it.
--
--   2. PRICES the seeded catalogue. Every product 017 seeded has sat at
--      price_cents = 0 since it landed — the till refuses them and the shop
--      shows no number. Filled from the storefront, and ONLY where the price
--      is still zero: a price someone has set by hand is never overwritten.
--
--   3. FILLS the blanks on existing rows — description, ingredients, usage,
--      photo, link — through coalesce, so only NULL columns change.
--
-- Prices are integer cents parsed from the dollar strings without ever
-- touching a float. Multi-size products carry their SMALLEST size's price —
-- the storefront's own listing shows the range and the marketplace charges
-- the real figure at checkout; what this column feeds is the shop tile.
--
-- Re-runnable: inserts skip existing slugs, price updates only touch zeros,
-- fills only touch NULLs. A second run changes nothing.
-- ============================================================

-- ── 1. Products the storefront has and this database does not ──

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-ACNE-ROSACEA-SENSITIVE-SKIN-HOME-PEEL', $ra059$Clear &amp; Strengthen Home Peel System$ra059$, 'acne-rosacea-sensitive-skin-home-peel', (select id from public.product_categories where slug = 'systems-collections'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$System Includes:
Beta Green Tea Cleanser (30mL)

Cherry Jubilee Enzyme (15mL)

Mandelic Arginine Serum (15mL)

Skin Refine Gel (15mL)

Salicylic Serum (30mL)

Creamy Milk Cleanser (30mL)

Cucumber Spritz (30mL)

Growth Factor Serum (10mL)

Infuse 7 (15mL)$ra059$, null, null,
     'https://ramarketplace.com/media/products/_mainPhoto/HOME-PEELS-Acne.jpg', 20050, 'https://ramarketplace.com/store/559flawless/product/acne-rosacea-sensitive-skin-home-peel', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-ANTIOXIDANT-BETA-CLEANSE', $ra059$Antioxidant Beta Cleanse$ra059$, 'antioxidant-beta-cleanse', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Antioxidant Beta Cleanse is an antioxidant, texture-softening cleanser that will give skin a more youthful complexion, while reducing inflammation and bacteria.

A powerful, pro-youth cleanser suited for all skin types, even the most sensitive.


TIP: Alternate with Gentle Peptide Cleanse during drier month or for drier skin types.$ra059$, $ra059$Aqua (Water), Cocamidopropyl Betaine, Sodium C14-16 Olefin Sulfonate, Disodium Laureth Sulfosuccinate, Salicylic Acid, Mandelic Acid (L), Glycerin, Sodium Lauryl Sulfoacetate, Sodium Cocoamphoacetate, Coco-Glucoside, Leuconostoc/Radish Root Ferment Filtrate, Cocamidopropyl Hydroxysultaine, Sodium Hydroxide, Sodium Gluconate, Caprylhydroxamic Acid, Camellia Sinensis (Green Tea) Leaf Extract, Melia Azadirachta (Neem) Leaf Extract, Melia Azadirachta (Neem) Flower Extract, Corallina Officinalis Extract, Coccinia Indica Fruit Extract, Solanum Melongena (Eggplant) Fruit Extract, Amber Powder, Ocimum Sanctum Leaf Extract, Curcuma Longa (Turmeric) Leaf Extract, Moringa Oleifera Seed Oil, Epigallocatechin Gallate, Propanediol, Citric Acid, Glycol Distearate, Benzyl Alcohol, Alcohol Denat., Fragrance/Parfum (natural)$ra059$, $ra059$Shake well prior to dispensing. Dispense 1 pump into dampened hands; add water for more lather. Massage into face and neck for several minutes. Remove with warm water and cloth. Pat skin dry.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/ANTIOXIDANT_BETA_CLEANSE_30ml_W.png', 1450, 'https://ramarketplace.com/store/559flawless/product/antioxidant-beta-cleanse', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-ATHLETE-ON-THE-GO', $ra059$Athlete On The Go$ra059$, 'athlete-on-the-go', (select id from public.product_categories where slug = 'systems-collections'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This lifestyle-friendly travel system is perfect for athletes on the go! Keep skin cleansed, protected and hydrated no matter where you are. Throw in your backpack or gym bag for fast maintenance on oily, sweaty skin after a hard workout or long day at school to keep skin healthy-looking and clear.

SYSTEM INCLUDES:

All Purpose Tonic Pads
Hyaluronic Tonic
Hydrating Relief Serum
Zinc Relief$ra059$, null, $ra059$Post Workout – Cleanse skin with All Purpose Tonic Pads. For drier skin, dilute pad with a little water before swiping over skin. Spritz skin with Hyaluronic Tonic, let product absorb into skin. Finish with 1-2 pumps Hydrating Relief Serum and/or Zinc Relief, depending on amount of hydration needed.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/ATHLETE_ON_THE_GO_TVL5_8438fe75-fa6d-47bd-85ab-20326f0ea6fb.jpg', 8300, 'https://ramarketplace.com/store/559flawless/product/athlete-on-the-go', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-BERRY-WINE-TONIC', $ra059$Berry  Wine Tonic$ra059$, 'berry-wine-tonic', (select id from public.product_categories where slug = 'toners'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Smoothing, oil-balancing and antibacterial lactic and salicylic acids combine with firming and tightening malic and tartaric acids for a potent, pro-youth toner; provides powerful antioxidant protection from resveratrol and raspberry extract.

Firms & Tones Skin
Reduces Bacteria
Smoothes Texture

TIP: Add 1 pump into Gentle Peptide Cleanse$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Butyrospermum Parkii (Shea) Butter, Glycerin, Resveratrol (Wine) Extract, Alcohol, Rubus Idaeus (Raspberry) Fruit Extract, Allantoin, Salicylic Acid, Citric Acid, Lactic Acid (L), Menthol (L), Glucuronolactone (D), Tartaric Acid (L), Malic Acid (L), Aloe Barbadensis Leaf Juice Powder, Benzyl Alcohol$ra059$, $ra059$Shake well before using. Dispense 1 pump onto gauze or cotton pad and apply to clean, dry skin. Let product absorb. Use every other day or as directed by licensed professional.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/BERRY_WINE_TONIC_30ml_W.png', 1800, 'https://ramarketplace.com/store/559flawless/product/berry-wine-tonic', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-BIO-53-MATRIX', $ra059$Bio 53 Matrix$ra059$, 'bio-53-matrix', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Restore skin’s youthful complexion with this powerful dose of epidermal growth factors. This warm, silky serum will encourage the development of strong, healthy cells, reduce fine lines and wrinkles and increase skin health.
Promotes Tissue Strengthening Strengthens New Cells Protects Against Degradation
TIP: Combine with Vita 10 Complex$ra059$, $ra059$Glycerin, Aqua (Water), rh-Oligopeptide-1 (EGF), Glycyrrhiza Glabra (Licorice) Root Extract, Alcohol, Hamamelis Virginiana (Witch Hazel) Water, Fumaric Acid, Superoxide Dismutase, Citrus Aurantium Dulcis (Orange) Peel Oil, Benzyl Alcohol, Phospholipid$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or layer under your favorite Pro Youth moisturizer. May experience a warming sensation.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/BIO_53_MATRIX_50ml_T.png', 4250, 'https://ramarketplace.com/store/559flawless/product/bio-53-matrix', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-BIO-53-MATRIX-PLUS', $ra059$Bio 53 Matrix Plus$ra059$, 'bio-53-matrix-plus', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Epidermal growth factors help strengthen and increase collagen while antioxidants and chondroitin assist in healing and reducing inflammation and free radical damage. Give skin a boost with this elegant, soothing, cooling serum.
Renews and Fortifies Skin Reduces Inflammation Works well for those using prescription strength topicals
TIP:Partner with the skin-strengthening benefits of Mandelic Rejuvenator$ra059$, $ra059$Aqua (Water), Glycerin, Propylene Glycol, Squalane, Chlorophyll, rh-Oligopeptide-1 (EGF), Sodium Chondroitin Sulfate, Carbomer, Benzyl Alcohol, Leuconostoc/Radish Root Ferment Filtrate, Fragrance/Parfum+, Acacia Senegal Gum, Sodium Hydroxide, Ricinus Communis (Castor) Seed Oil*, , Allantoin, Sodium Gluconate, Caprylhydroxamic Acid, Bisabolol (L-alpha), Glycyrrhiza Glabra (Licorice), Rhizome/Root Extract, Glucuronolactone (D), Phospholipids, Aloe Barbadensis Leaf Juice Powder, Camellia Oleifera (Green Tea) Leaf Extract, Hamamelis Virginiana (Witch Hazel) Water, Citric Acid,Crocus Chrysanthus Bulb Extract, Alcohol Denat., Fullerene, Xanthan Gum, Fragrance/Parfum +, Mentha Piperita (Peppermint) Oil$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or layer under your favorite Pro Youth moisturizer.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/BIO_53_MATRIX_PLUS_15ml.png', 4500, 'https://ramarketplace.com/store/559flawless/product/bio-53-matrix-plus', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-BRIGHTENING-PIGMENT-TONIC', $ra059$Brightening Pigment Tonic$ra059$, 'brightening-pigment-tonic', (select id from public.product_categories where slug = 'toners'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This effective treatment toner is designed to increase cellular turnover, allowing natural brightening ingredients like daisy flower extract to penetrate deep into the skin. Provides UV protection, anti-inflammatory benefits and collagen support.$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Polysorbate 20, Bellis Perennis (Daisy) Flower Extract, Hydrolyzed Rice (Peptide) Protein, Potassium Azeloyl Diglycinate, Thermus Thermophilus Ferment, Glycerin, Lactic Acid (L), Aminobutyric Acid (GABA), Citrus Grandis (Pink Grapefruit) Peel Oil, Zingiber Ocinale (Ginger) Root Oil, Citrus Sinensis (Orange) Fruit Extract, Alcohol$ra059$, $ra059$Dispense 1 pump onto gauze or cotton pad and apply to clean, dry skin or use to spot treat. Let absorb. May use daily or as directed by a licensed professional.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/BRIGHTENING_PIGMENT_TONIC_30ml_W.png', 1800, 'https://ramarketplace.com/store/559flawless/product/brightening-pigment-tonic', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-BRIGHTENING-SCRUB', $ra059$Brightening Scrub$ra059$, 'brightening-scrub', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Polish away impurities and dead skin cells for a deeper cleanse. Packed with powerful antioxidants, antibacterials, hydrating shea butter and healing vitamin E. Brightening Scrub gently exfoliates the skin while brightening actives supply potent melanin-suppressant action, leaving skin with a beautiful, luminous glow.$ra059$, $ra059$Aqua (Water), Bambusa Arundinacea (Bamboo) Stem Extract, Jojoba Esters (Beads), Glycerin, Caprylic/Capric Triglyceride, Stearic Acid, Sodium Ascorbyl Phosphate, Cetyl Alcohol, Bellis Perennis (Daisy) Flower Extract, Glycol Distearate, Cocamidopropyl Betaine, Sodium C14-16 Olefin Sulfonate, Disodium Laureth Sulfosuccinate, Acrylates Copolymer, Potassium Azeloyl Diglycinate, Cocamidopropyl Hydroxysultaine, Sodium Cocoamphoacetate, Sodium Lauryl Sulfoacetate, Leuconostoc/Radish Root Ferment Filtrate, Propanediol, Titanium Dioxide, Kojic Acid, Dipalmitate, Lonicera Japonica (Honeysuckle) Flower Extract, 1,2-Hexanediol, Caprylyl Glycol, Lonicera Caprifolium (Honeysuckle) Flower Extract, Sodium Gluconate, Succinoglycan, Aminobutyric Acid (GABA), Mentha Arvensis (Cornmint) Leaf Oil, Carbomer, Caprylhydroxamic Acid, Lavandula Angustifolia (Lavender) Oil, Citrus Aurantifolia (Lime) Oil, Hamamelis Virginiana (Witch Hazel) Water, Citrus Aurantium Bergamia (Bergamot) Fruit Oil, Citrus Aurantium Dulcis (Orange) Peel Oil, Citrus Limon (Lemon) Peel Oil, Lavandula Hybrida (Lavandin) Oil, Tropolone, Alcohol, Diglucosyl Gallic Acid, Allantoin, Calcium Pantothenate (D), Lysine HCI, Cysteine (L), Butyrospermum Parkii (Shea) Butter, Pogostemon Cablin (Patchouli) Oil, Citrus Reticulata (Tangerine) Leaf Oil, Cymbopogon Martini (Palmarosa) Oil, Cinnamomum Camphora (Camphor) Bark Oil, Sodium Hydroxide, Citric Acid, Xanthan Gum$ra059$, $ra059$Dispense small amount into damp hands; apply to face and neck. Gently massage into skin or allow to sit on skin for several minutes. Rinse thoroughly with warm water. Pat skin dry. Recommend using 1-2x a week.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/BRIGHTENING_SCRUB_60ml_SQ_d63a2c31-6949-43ad-bbba-08b7e4801df6.png', 3800, 'https://ramarketplace.com/store/559flawless/product/brightening-scrub', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-C-PEPTIDE-COMPLEX', $ra059$C-Peptide Complex$ra059$, 'c-peptide-complex', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A potent blend of 20% vitamin C and firming peptides, this age-defying complex delivers powerful collagen support while increasing antioxidant protection and boosting skin immunity for healthier-looking skin. Reducing fine lines and wrinkles, this is a must-have for all pro-youth skin, delivering stellar anti-aging results and luminous skin.

Boosts Skin Immunity
Fights Free Radicals
Increases Collagen

TIP: Mix with Antiox 18 Complex for a boost in protection$ra059$, $ra059$Hamamelis Virginiana (Witch Hazel) Water, Ascorbic Acid (L), Glycerin, Alcohol, Aqua (Water), Magnesium Ascorbyl Phosphate, Palmitoyl Tripeptide-5, Citrus Medica Limonum (Lemon) Peel Oil, Citrus Sinensis (Sweet Orange) Oil, Lecithin, Fructooligosaccharides (D-Beta), Xanthan Gum$ra059$, $ra059$Recommended for AM use. Apply 1-2 pumps to clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/C-PEPTIDE_COMPLEX_15ml.png', 8000, 'https://ramarketplace.com/store/559flawless/product/c-peptide-complex', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-C-STEM-CELL', $ra059$C-Stem Cell$ra059$, 'c-stem-cell', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A hydrating, yet powerful vitamin C strengthening the immunity health of the skin, delivering antioxidants and increasing collagen for even the most sensitive pro-youth skin!

Boosts Skin Immunity
Plant Stem Cell Therapy
Barrier Repair
Brighter Complexion

TIP: Recommend pairing with Stem Cell A for a powerful Pro-Youth Duo$ra059$, $ra059$Aqua (Water), Glycerin, Sodium Hyaluronate (L), Leuconostoc/Radish Root Ferment Filtrate, Magnesium Ascorbyl Phosphate, Leontopodium Alpinum Meristem Cell Culture, Gardenia Jasminoides Callus Culture, Honey (Mel), Tocopheryl (D-Alpha), Phospholipids, Sphingolipids, Hyaluronic Acid, Xanthan Gum, Trisodium Ethylenediamine Disuccinate, Citric Acid, Sclerotium Gum, O-cymen-5-OL$ra059$, $ra059$Recommended for AM use. Apply 1-2 pumps to clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/C-STEM_CELL_15ml_2026-05-06-213514_fxox.png', 8350, 'https://ramarketplace.com/store/559flawless/product/c-stem-cell', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-CHRONOPEPTIDE-A', $ra059$ChronoPeptide A$ra059$, 'chronopeptide-a', (select id from public.product_categories where slug = 'correctives'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Using an encapsulated vitamin A and formulated with collagen-synthesizing peptides and superior antioxidants, this powerful anti-aging complex reduces wrinkles and promotes firmer, brighter, younger-looking skin.

Repair Barrier Function
Increase Natural Lipids
Rich Vitamin B Complex
Boosts Cellular Function

TIP: Pair with Peptide 38 to reduce fine lines, wrinkles and boost firmness in the skin!$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Alcohol, Glycerin, Niacinamide, Cyclodextrin, Gluconolactone, Polyglyceryl-4 Caprate, Glucosamine HCl, Sodium Benzoate, Laminaria Digitata Extract, Saccharomyces Cerevisiae Extract, Urea, Sodium Hydroxide, Retinal (Retinaldehyde), Rubus Chamaemorus (Cloud Berry) Seed Oil, Santalum Austrocaledonicum (Sandalwood) Wood Oil, Caprylic/Capric Triglyceride, Pentylene Glycol, Withania Somnifera (Indian Ginseng) Root Extract, Mentha Piperita (Peppermint) Oil, Mangostin, Glutamylamidoethyl Imidazole, Vanillin, Lonicera Japonica (Honeysuckle) Flower Extract, Citric Acid, Cinnamomum Camphora (Camphor) Bark Oil, Lonicera Caprifolium (Honeysuckle) Flower Extract, Xanthan Gum$ra059$, $ra059$PM only. Apply to clean, dry skin. For first time vitamin A users, start 3x per week and increase as directed by licensed professional. May layer favorite RA serum or moisturizer overtop. Wear SPF for daytime protection.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/CHRONOPEPTIDE_A_30ml_T.png', 4900, 'https://ramarketplace.com/store/559flawless/product/chronopeptide-a', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-COCOA-BERRY-C-MASK', $ra059$Cocoa Berry C Mask$ra059$, 'cocoa-berry-c-mask', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A therapeutic mask delivering potent antioxidants from cocoa extract, cranberry and camu camu. This decadent, tingling experience will leave skin revitalized and replenished.$ra059$, $ra059$Aqua (Water), Glycerin, Caprylic/Capric Triglyceride, Stearic Acid, Glyceryl Stearate, Cetyl Alcohol, Caramel, Gluconolactone, Rubus Chamaemorus (Cloud Berry) Seed Oil, Sodium Benzoate, Cetearyl Alcohol, Polysorbate 60, Theobroma Cacao (Cocoa) Extract, Oxycoccus Palustris (Arctic Cranberry) Seed Oil, Glycol Distearate, Olea Europaea (Olive) Fruit Oil, Prunus Amygdalus Dulcis (Sweet Almond) Oil, Xanthan Gum, Caprylyl Glycol, Phenoxyethanol, Glycine Soja (Soybean) Oil, Tocopheryl Acetate (D-Alpha), Dimethicone, Hamamelis Virginiana (Witch Hazel) Water, Allantoin, Retinyl Palmitate, Helianthus Annuus (Sunflower) Seed Oil, Carbomer, Citrus Aurantium Dulcis (Orange) Peel Oil, Althaea Officinalis (Marshmallow) Root Extract, Vanilla Planifolia Fruit Oil, Trisodium Ethylenediamine Disuccinate, Potassium Sorbate, Euterpe Oleracea (Acai) Fruit Extract, Aloe Barbadensis Leaf Juice Powder, Myrciaria Dubia (Camu Camu) Fruit Extract, Alcohol, Anthemis Nobilis (Chamomile) Flower Extract, Passiflora Incarnata (Passionflower) Flower Extract, Daucus Carota Sativa (Carrot) Seed Extract, Titanium Dioxide$ra059$, $ra059$Apply thin layer to clean, dry skin – avoid eye area. Leave on for 5-10 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow up with your favorite Pigmentation Solutions serums and moisturizer. Use once per week.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/COCOA_BERRY_C_MASK_50ml_W_b32fd7de-92b5-4615-9477-7970cab33f9c.png', 1750, 'https://ramarketplace.com/store/559flawless/product/cocoa-berry-c-mask', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-COLLAGEN-BOOST', $ra059$Collagen Boost$ra059$, 'collagen-boost', (select id from public.product_categories where slug = 'systems-collections'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Merging a potent blend of 18 powerful antioxidants and cutting-edge peptides to increase collage production, this is age management at its best. Have skin looking and staying years younger as our pro youth collection promotes hydrated, smoother-looking skin.

SYSTEM INCLUDES:

Gentle Peptide Cleanse 120ml
Antiox 18 Complex 50ml
Amino Peptide Hydration 50ml$ra059$, null, $ra059$AM – Cleanse with Gentle Peptide Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps Antiox 18 Complex, massage into skin. Finish with 1-2 pumps Amino Peptide Hydration.

PM - Cleanse with Gentle Peptide Cleanse, remove with warm water and soft cloth, pat skin dry. Apply RA Corrective recommended by RA Professional. Finish with 1-2 pumps Amino Peptide Hydration.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/COLLAGEN_BOOST_ESS_2026-07-13-034751_cxtq.png', 15900, 'https://ramarketplace.com/store/559flawless/product/collagen-boost', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-COOLING-RELIEF-MASK', $ra059$Cooling Relief Mask$ra059$, 'cooling-relief-mask', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Providing calming, soothing hydration, Cooling Relief Mask is perfect for dry, inflamed, acne-prone skin. Excellent to mix with Wasabi Mask or Perfection Clay.$ra059$, $ra059$Aqua (Water), Glycerin, Caprylic/Capric Triglyceride, Stearic Acid, Cetyl Alcohol, Colostrum, Titanium Dioxide, Hamamelis Virginiana (Witch Hazel) Water, Xanthan Gum, Allantoin, Tocopherol (D-Alpha), Glycine Soja (Soybean) Oil, Benzyl Alcohol, Mentha Piperita (Peppermint) Oil, Dimethicone, Alcohol$ra059$, $ra059$Apply a thin layer to clean, dry skin – avoid eye area. Leave on for 10-15 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow up with your favorite serums and moisturizer. Use 1-2 times per week.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/COOLING_RELIEF_MASK_50ml_W.png', 1300, 'https://ramarketplace.com/store/559flawless/product/cooling-relief-mask', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-CYSTIC-RELIEF', $ra059$Cystic Relief$ra059$, 'cystic-relief', (select id from public.product_categories where slug = 'systems-collections'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Especially suited for thicker, oily, more problematic skin, Cystic Relief is a comprehensive system that decreases surface oils and acne breakouts, reduces bacteria and inflammation and provides healing, rejuvenating support using the power of glycolic and salicylic acids, EGF, totarol and detoxifying clays to draw out impurities for clear, healthy-looking skin.

SYSTEM INCLUDES:

Herbal AHA Cleanse
Antiox AHA Tonic
Blemish Serum
Vital Repair Gel
Vita E Therapy
Perfection Clay$ra059$, null, $ra059$AM – Cleanse with Herbal AHA Cleanse, remove with warm water and soft cloth, pat skin dry. Apply Antiox AHA Tonic with a cotton round, let product absorb into skin. Spot treat blemishes with Blemish Serum. Finish with 1-2 pumps Vital Repair Gel and eZinc.

PM - Cleanse with Herbal AHA Cleanse, remove with warm water and soft cloth, pat skin dry. Spot treat blemishes with Blemish Serum. Finish with 1-2 pumps Vital E Therapy.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/CYSTIC_RELIEF_TVL5_6107d4fe-cb62-4138-a35a-1a2ce8560a55.jpg', 12500, 'https://ramarketplace.com/store/559flawless/product/cystic-relief', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-DERMA-ZYME', $ra059$Derma-Zyme$ra059$, 'derma-zyme', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A weekly gommage exfoliation with pineapple and papaya enzymes that gently dissolves cellular buildup to reveal smooth, soft, glowing skin. Safe for even the most sensitive pro youth skin.

Increases Product Penetration
Support between Professional Treatments

TIP: Use on hands once a week but don't forget our Sun Reflect line!$ra059$, $ra059$Aloe Barbadensis (Aloe Vera) Leaf Extract, Butylene Glycol, Carbomer, Hyaluronic Acid, Papain, Carica Papaya Extract, Symphytum Officinale (Comfrey) Extract, Echinacea Angustifolia Extract, Citrus Grandis (Grapefruit) Seed Extract, Citrus Medica Limonum (Lemon) Extract, Citrus Aurantium Dulcis (Orange) Extract, Ananas Sativus (Pineapple) Extract, Glycerin, Retinyl Palmitate, Tocopheryl Acetate, Ascorbic Acid (L), Cholecalciferol, Sodium PCA, Panthenol, Citrus Grandis (Grapefruit) Oil, Citrus Aurantium Dulcis (Orange) Oil, Sodium Hydroxide, Phenoxyethanol, Caprylyl Glycol, Sorbic Acid$ra059$, $ra059$Apply thin layer to clean, dry skin. Gently massage until product liquefies and begins to ball-up. Leave on for 5-10 minutes. Rinse with cool water and soft cloth. Pat skin dry and follow with your favorite pro youth mask, serums and/or moisturizer. Use once per week.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/DERMA_ZYME_15ml.png', 1500, 'https://ramarketplace.com/store/559flawless/product/derma-zyme', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-DNAGE-REVERSAL', $ra059$DNAge Reversal$ra059$, 'dnage-reversal', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Strengthen and protect from environmental damage and stress with oceanic ingredients to boost mitochondria protection, apple stem cells to repair damaged tissue and CoQ10 to protect from free radicals.

Reduction in Fine Lines
Increase in Oxygenation
Decrease in Inflammation
Stimulation of Fibroblasts

TIP: Use with Stem Cell A and C-Stem Cell for a powerful repair regimen$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Thermus Thermophillus Ferment, Alcohol, Polysorbate 20, Squalane, Pseudoalteromonas Ferment Extract, Butyrospermum Parkii (Shea) Butter, Zea Mays (Corn) Starch, Hydrolyzed Corn Starch Octenylsuccinate, Phenyl t-Butylnitrone (Spin Trap), Acetyl Carnitine HCl (L), Thioctic (R-Lipoic) Acid, Polysorbate 80, Adenine, Ubiquinone (CoQ10), Malus Domestica (Apple) Fruit Cell Culture Extract, Potassium Sorbate, Lecithin, Citrus Sinensis (Orange) Fruit Extract, Citrus Tangerina (Tangerine) Peel Oil, Citrus Reticulata (Tangerine) Leaf Oil, Zingiber Officinale (Ginger) Root Oil, Phenethyl Alcohol, Acrylates/C10-30 Alkyl Acrylate Crosspolymer, Caprylyl Glycol, Alteromonas Ferment Extract, Xanthan Gum, Phenoxyethanol$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/DNAGE_REVERSAL_30ml_T.png', 3500, 'https://ramarketplace.com/store/559flawless/product/dnage-reversal', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-ELITE-LUXE-HYDRATION', $ra059$Elite Luxe Hydration$ra059$, 'elite-luxe-hydration', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This supercharged moisturizer combines the collagen-stimulating benefits of growth factors, peptides and free radical-fighting goji berries to deliver potent pro youth support.

All-in-one moisturizer
Reduces Fine Lines and Wrinkles
Increase in Firmness and Elasticity

TIP: Mix with BIO 53 Matrix Plus for a potent dose of EGT$ra059$, $ra059$Aqua (Water), Glycerin, Helianthus Annuus (Sunflower) Seed Oil, Caprylic/Capric Triglyceride, Squalane, Cetearyl Olivate, Ribes Nigrum (Black Currant) Seed Oil, Cetearyl Alcohol, Polysorbate 60, Rosa Canina (Rose Hip) Fruit Oil, C18-36 Acid Triglyceride, Sorbitan Olivate, Simmondsia Chinensis (Jojoba) Seed Oil, PCA (L-Pyroglutamic Acid), Butylene Glycol, Ethoxydiglycol, Dimethylacrylamide/Acrylic Acid/Polystyrene Ethyl Methacrylate Copolymer, Palmitoyl Hexapeptide-14, Lycium Barbarum (Goji Berry) Extract, Sodium Benzoate, Phenoxyethanol, Palmitoyl Tripeptide-5, Gluconolactone, rh-Oligopeptide-1 (EGF), Tocopheryl Acetate (D-Alpha), Prasterone (DHEA), Glucosamine HCl, Algae Extract, Saccharomyces Cerevisiae Extract, Urea, Quercetin, Astaxanthin, Xanthan Gum, Alcohol Denat., Phospholipids$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or layer over your favorite pro youth serum.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/ELITE_LUXE_HYDRATION_15ml.png', 4000, 'https://ramarketplace.com/store/559flawless/product/elite-luxe-hydration', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-ESSENTIAL-SPOT-RX', $ra059$Essential Spot Rx$ra059$, 'essential-spot-rx', (select id from public.product_categories where slug = 'correctives'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Natural anti-bacterial ingredients, Salicylic Acid and Totarol, help fight bacteria. Safe to apply to skin twice daily, without over drying, making it an excellent choice for those occasional blemishes!

Works Well for Hormonal Acne
Spot Treat or Full Face
Will Not Cause Irritation
Contains Heart of Green Tea$ra059$, $ra059$Alcohol Denat., Hamamelis Virginiana (Witch Hazel) Water, Propanediol, Alcohol, Salicylic Acid, Aqua (Water), Fomes Officinalis (Mushroom) Extract, Resorcinol, Hydroxypropyl Methylcellulose, Butylene Glycol, 1,2-Hexanediol, Caprylyl Glycol, Eucalyptus Globulus Leaf Oil, Pyridoxine HCl, Citrus Aurantifolia (Lime) Oil, Citrus Limon (Lemon) Peel Oil, Niacinamide, Glycerin, Panthenol (D), Camellia Sinensis (Green Tea) Leaf Extract, Hydrolyzed Yeast Protein, Tropolone, Threonine, Totarol, Biotin, Epigallocatechin Gallate, Citric Acid, Sodium Hydroxide, Allantoin, Melaleuca Alternifolia (Tea Tree) Leaf Oil$ra059$, $ra059$Dispense 1-2 pumps onto fingertips; massage into clean, dry skin morning and/or evening. May use to spot treat blemishes. Layer moisturizer or SPF overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/ESSENTIAL_SPOT_RX_15ml.png', 2500, 'https://ramarketplace.com/store/559flawless/product/essential-spot-rx', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-EYE-LIFT', $ra059$Eye Lift$ra059$, 'eye-lift', null,
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A fast absorbing peptide complex that instantly firms for a light lift; brightens skin tone, reduces wrinkles, smoothes tissue and enhances hydration.$ra059$, $ra059$Aqua (Water), Caprylic/Capric Triglyceride, Stearic Acid, Glyceryl Stearate, Glycerin, Dipeptide Diaminobutyroyl Benzylamide Diacetate, Cetearyl Alcohol, Polysorbate 60, Acetyl Tetrapeptide-5, Chrysin, Steareth-20, Palmitoyl Tripeptide-1, Palmitoyl Tetrapeptide-7, N-Hydroxysuccinimide, Cetyl Alcohol, Persea Gratissima (Avocado) Oil, Olea Europaea (Olive) Fruit Oil, Glycine Soja (Soybean) Oil, Tocopheryl Acetate (D-alpha), Prunus Amygdalus Dulcis (Sweet Almond) Oil, Retinyl Palmitate, Zea Mays (Corn) Oil, Lavandula Angustifolia (Lavender) Oil, Menthyl Lactate (L), Citric Acid, Aloe Barbadensis Leaf Juice Powder, Pelargonium Graveolens (Geranium) Flower Oil, Potassium Sorbate, Allantoin, Trisodium Ethylenediamine Disuccinate, Caprylyl Glycol, Phenethyl Alcohol$ra059$, $ra059$Gently massage 1 pump around eye area. May be applied AM or PM.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/EYE_LIFT_15ml_7f5bad2f-e8d1-474c-9222-ec50d3d053bf.png', 6800, 'https://ramarketplace.com/store/559flawless/product/eye-lift', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-EYE-LIP-RENEW-SERUM', $ra059$Eye &amp; Lip Renew Serum$ra059$, 'eye-lip-renew-serum', null,
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A powerful must-have, pro-youth treatment serum using spin trap, ascorbic acid and cholesterol liquid to reduce wrinkles and plump tissue for serious age-reduction.$ra059$, $ra059$Cholesteryl Oleyl Carbonate, Cholesteryl Stearate, Cholesteryl Nonanoate, Zea Mays (Corn) Silk Extract, Phenyl t-Butylnitrone (Spin Trap), Retinol, Ascorbic Acid (L), Citrus Aurantium Bergamia (Bergamot) Fruit Oil, Pelargonium Graveolens (Geranium) Flower Oil$ra059$, $ra059$Warm 1 pump between fingertips. Gently stipple around eye area nightly. Serum feels slightly tacky on skin.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/EYE_LIP_RENEW_SERUM_15ml_53ef0087-a233-471d-8060-8d4f9a1c0922.png', 12000, 'https://ramarketplace.com/store/559flawless/product/eye-lip-renew-serum', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-EYE-REVITALIZER', $ra059$Eye Revitalizer$ra059$, 'eye-revitalizer', null,
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Enhanced with a “freezing” peptide to reduce signs of aging; provides instant firming action, reduces puffiness and instantly cools and soothes tired eyes.$ra059$, $ra059$Aqua (Water), Glycerin, Whey Protein, Acetyl Hexapeptide-8, Cassia Angustifolia Seed Polysaccharide, Squalane, Ruscus Aculeatus (Butcher’s Broom) Root Extract, Centella Asiatica (Gotu Kola) Leaf Extract, Panthenol (D), Calendula Ocinalis Flower Extract, Hydrolyzed Yeast Protein, Aesculus Hippocastanum (Horse Chestnut) Bark Extract, Aloe Barbadensis Leaf Juice Powder, Menthyl Lactate (L), Mica, Allantoin, Glucuronolactone (D), Limonene, Bisabolol (L-Alpha), Citrus Aurantium Bergamia (Bergamot) Fruit Oil, Citrus Grandis (Grapefruit) Peel Oil, Xanthan Gum$ra059$, $ra059$Gently massage 1 pump around eye area. For a quick pick-me-up, apply over makeup throughout the day.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/EYE_REVITALIZER_15ml_cef18d2e-2c7d-48e1-af51-34b3a8a279c7.png', 3500, 'https://ramarketplace.com/store/559flawless/product/eye-revitalizer', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-FIRM-EYEFECT', $ra059$Firm EyeFect$ra059$, 'firm-eyefect', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Firm the eye area and reflect a more youthful appearance with our unique wrinkle minimizer and specialty “freezing” peptide filler. Provide delicate eye tissue superior antioxidant support with a powerful complex of peptides and stem cell technology to reduce puffiness, brighten eye tissue and minimize wrinkles.

SYSTEM INCLUDES:
Peptide 3-N-1 Eye Cream
Eye & Lip Renew Serum$ra059$, null, null,
     'https://ramarketplace.com/media/products/_mainPhoto/FIRM_EYEFECT_DUO.jpg', 18800, 'https://ramarketplace.com/store/559flawless/product/firm-eyefect', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-FRUIT-ACID-TONIC', $ra059$Fruit Acid Tonic$ra059$, 'fruit-acid-tonic', (select id from public.product_categories where slug = 'toners'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This potent, liquid dose of pure salicylic and glycolic acids clears-out congested, cystic, excessively oily breakouts to reveal a smoother complexion.$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Alcohol, Glycolic Acid, Salicylic Acid, Rosmarinus Ocinalis (Rosemary) Leaf Oil, Origanum Majorana (Marjoram) Leaf Oil, Pelargonium Graveolens (Geranium) Flower Oil$ra059$, $ra059$Dispense 1 pump onto gauze or cotton pad and apply to clean, dry skin. Let product absorb. Spot treat 1-2 times per week or as directed by a licensed professional.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/FRUIT_ACID_TONIC_30ml_W_2026-02-25-235459_zdmb.png', 1800, 'https://ramarketplace.com/store/559flawless/product/fruit-acid-tonic', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-GENTLE-JOJOBA-BEADS', $ra059$Gentle Jojoba Beads$ra059$, 'gentle-jojoba-beads', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$An all-in-one cleansing exfoliant that helps gently reduce cellular buildup and softening texture.

3-in-1 Cleanse-Exfoliate-Hydrate
Revives Dull Complexions
Calming and Hydrating Aloe Base

TIP: Boost with Pumpkin Lactic Cleanse$ra059$, $ra059$Aqua (Water), Jojoba Esters, Sodium C14-16 Olefin Sufanate, Disodium Cocoamphodipropionate, Sodium Hydroxide, Aloe Barbadensis Leaf Juice, Carbomer, Disodium EDTA, Phenoxyethanol, Ethylhexylglycerin$ra059$, $ra059$Squeeze small amount into damp hands; apply to face and neck. Massage in gently for several minutes; add water if needed. Rinse thoroughly with warm water. Pat skin dry. May use up to three times a week depending on skin type.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/GENTLE_JOJOBA_BEADS_60ml_SQ_2026-07-13-033128_njgz.png', 2500, 'https://ramarketplace.com/store/559flawless/product/gentle-jojoba-beads', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-GENTLE-PEPTIDE-CLEANSE', $ra059$Gentle Peptide Cleanse$ra059$, 'gentle-peptide-cleanse', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This gentle milk cleanser works well for both dry and normal skin types, infusing vitamins and minerals for that pro-youth result. Peptides support healthy collagen while yogurt extract and milk proteins offer hydration and nourishment.

Peptides for Healthy Collagen Support
Yogurt Extract + Goat Milk for Hydration

TIP: To increase antioxidants, mix with Pumpkin Lactic Cleanse$ra059$, $ra059$Aqua (Water), Glycerin, Sodium Methyl Cocoyl Taurate, Polyglyceryl-4 Caprate, Glycol Distearate, Behenyl Alcohol, Cetyl Alcohol, Sodium Cocoyl Hydrolyzed Amaranth Protein, Yogurt Extract, Goat Milk, Magnesium Hydroxide, Olea Europaea (Olive) Leaf Extract, Althaea Officinalis (Marshmallow) Root Extract, Cucumis Sativus (Cucumber) Oil, Cucumis Sativus (Cucumber) Fruit Extract, Betula Alba (Birch) Bark Extract, Phenoxyethanol, Caprylyl Glycol, Citric Acid, Hamamelis Virginiana (Witch Hazel) Water, Alcohol$ra059$, $ra059$Dispense 1 pump into dampened hands; add water for more lather. Massage into face and neck for several minutes. Remove with warm water and cloth. Pat skin dry.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/GENTLE_PEPTIDE_CLENASE_30ml_W.png', 1450, 'https://ramarketplace.com/store/559flawless/product/gentle-peptide-cleanse', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-GRAPE-SEED-ANTIOX-MASK', $ra059$Grape Seed Glow$ra059$, 'grape-seed-antiox-mask', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This buttery mask gently infuses wine extracts for vital antioxidant support. While firming and strengthening skin, you will be left with a soft moisturized finish.

Protects Collagen and Elastin
Boosts Hydration Support
Firms and Tones

TIP: Add a drop of Pure Grape Seed Elixir for more hydration$ra059$, $ra059$Aqua (Water), Glycerin, Bentonite, Kaolin, Hamamelis Virginiana (Witch Hazel) Water, Butyrospermum Parkii (Shea) Butter, Caprylic/Capric Triglyceride, Stearic Acid, Cetyl Alcohol, Glycol Distearate, Limnanthes Alba (Meadowfoam) Seed Oil, Squalane, Vitis Vinifera (Grape) Seed Extract, Calamine, Dimethicone, Titanium Dioxide, Wine Extract (Resveratrol), Alcohol Denat., Glycerol Ricinoleate, Simmondsia Chinensis (Jojoba) Seed Oil, Allantoin, Tocopheryl Acetate (D-Alpha), Glycine Soja (Soybean) Oil, Alcohol, Xanthan Gum, Citrus Aurantium Dulcis (Orange) Oil, Tsunga Canadensis (Hemlock) Oil, Eucalyptus Globulus Leaf Oil, Eugenia Caryophyllus (Clove) Leaf Oil, Benzyl Alcohol$ra059$, $ra059$Apply a thin layer to clean, dry skin – avoid eye area. Leave on for 10-15 minutes. Rinse well with cool water and soft cloth. Pat skin dry and finish with your favorite serums and moisturizer. Use once per wee$ra059$,
     'https://ramarketplace.com/media/products/_listing/8db9da68-263d-4541-88c1-b4e49b62dc4c.png', 1600, 'https://ramarketplace.com/store/559flawless/product/grape-seed-antiox-mask', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-GREEN-TEA-HYDRATE', $ra059$Green Tea Hydrate$ra059$, 'green-tea-hydrate', null,
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A lightweight, daily protection cream with a sun protection factor equivalent to SPF 15 that soothes skin, reduces inflammation and supplies antimicrobial benefits while defending skin against damaging UV rays. Balancing excess oil and delivering non-comedogenic, water-binding moisture support, this is an ideal hydrator for thick, more oily, congested skin.$ra059$, null, null,
     'https://ramarketplace.com/media/products/_mainPhoto/GREEN_TEA_HYDRATE_30ml_W.jpg', 3300, 'https://ramarketplace.com/store/559flawless/product/green-tea-hydrate', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-GREEN-TEA-TONIC', $ra059$Green Tea Tonic$ra059$, 'green-tea-tonic', (select id from public.product_categories where slug = 'toners'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Formulated with salicylic acid to reduce bacteria and excess sebum and the heart of green tea to reduce inflammation and redness; a treatment toner that supports congested, oily, breakout-prone skins.$ra059$, $ra059$Aqua (Water), Alcohol Denat., Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Salicylic Acid, Lactic Acid (L), Ascorbic Acid (L), Epigallocatechin Gallate (EGCG), Uric Acid, Glutathione (L), Chlorophyll, Actinidia Chinensis (Kiwi) Fruit Extract, Pelargonium Graveolens Flower Oil, Benzyl Alcohol, Alcohol$ra059$, $ra059$Dispense 1 pump onto gauze or cotton pad and apply to clean, dry skin. Let product absorb. May be used to spot treat on lesions or as directed by a licensed professional$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/GREEN_TEA_TONIC_30ml_W_2026-02-25-235549_madw.png', 1800, 'https://ramarketplace.com/store/559flawless/product/green-tea-tonic', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-HA-CLEAR-CONCENTRATE', $ra059$HA Clear Concentrate$ra059$, 'ha-clear-concentrate', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Pure hyaluronic acid in a light serum base to increase moisture levels in breakout-prone skins. Pair with Cucumber Spritz for faster, more efficient results.$ra059$, $ra059$Aqua (Water), Polysorbate 20, Glycerin, Sodium Hyaluronate (L), Lonicera Japonica (Honeysuckle) Flower Extract, Hamamelis Virginiana (Witch Hazel) Water, Lonicera Caprifolium (Honeysuckle) Flower Extract, Citric Acid, Lavandula Hybrida (Lavandin) Oil, O-cymen-5-OL, Alcohol, Cinnamomum Camphora (Camphor) Bark Oil, Squalane, Rosa Canina Seed Oil*, Sodium Hydroxide$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin morning and/or night. Let serum absorb.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/HA_CLEAR_CONCENTRATE_30ml_T.png', 4150, 'https://ramarketplace.com/store/559flawless/product/ha-clear-concentrate', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-HA-HYDRA-MIST', $ra059$HA Hydra Mist$ra059$, 'ha-hydra-mist', (select id from public.product_categories where slug = 'toners'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Does your skin need a drink of water?

Cucumber extract, hyaluronic acid and additional humectants instantly cool and re-hydrated dull, depleted, dry skin.

Reduce Trans Epidermal Water Loss
Sooth and Cool
Attract and Hold Moisture

TIP: Keep cool and give skin a refreshing drink of water on hot summer days!$ra059$, $ra059$Hamamelis Virginiana (Witch Hazel) Water, Aqua (Water), Alcohol, Deuterium Oxide (Heavy Water), Glycerin, Sodium PCA, Borago Ocinalis Seed Oil, Phospholipids, Honey (Mel), Sphingolipids, Hyaluronic Acid, Arginine (L), Fructooligosaccharides (D-Beta), Glucosamine HCl (D), Cucumis Sativus (Cucumber) Fruit Oil, Cocos Nucifera (Coconut) Oil$ra059$, $ra059$Shake Well Before Using. Spritz on clean, dry skin and let absorb. Excellent to set mineral makeup. May also mist skin throughout the day for added hydration.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/HA_HYDRA_MIST_30ml_W.png', 1500, 'https://ramarketplace.com/store/559flawless/product/ha-hydra-mist', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-HAND-DUO', $ra059$Hand Duo$ra059$, 'hand-duo', (select id from public.product_categories where slug = 'duos'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$System Includes:


Pro Youth Regenerating Cream (15mL)


Uses a blend of epidermal growth factors and antioxidants in an ultra-rich cream to nourish hands.


Pro Youth Pumpkin E Serum (30mL)


Combine with Regenerating Cream for an added boost of healing hydration to leave skin feeling restored and protected.$ra059$, null, $ra059$Combine Pumpkin E Serum with Vita Age Defy Cream for an added boost of healing hydration to leave skin feeling restored and protected.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/HAND_DUO_2026-07-13-043752_uglm.png', 8550, 'https://ramarketplace.com/store/559flawless/product/hand-duo', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-HEALTHY-AGING-CREAM', $ra059$Healthy Aging Cream$ra059$, 'healthy-aging-cream', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This lightweight moisturizer contains therapeutic extracts from rhodiola rosea and mirifica root to stimulate collagen synthesis, boost antioxidant protection, restore balance and reduce moisture loss.


Decreses Stress in the Skin
Slows Down Aging
Increases Hydration
Healthy Tissue Growth

TIP: Spritz HA Hydra Mist prior to applying to cool menopausal skin$ra059$, $ra059$Aqua (Water), Caprylic/Capric Triglyceride, Cetearyl Olivate, Sorbitan Olivate, Cholesteryl Oleyl Carbonate, Cholesteryl Nonanoate, Cholesteryl Stearate, Cocos Nucifera (Coconut) Fruit Juice, Rhodiola Rosea Root Extract, Octyldodecanol, Hydrogenated Coco-Glycerides, Helianthus Annus (Sunflower) Extract, Tocopheryl Acetate (D-Alpha), Glycine Soja (Soybean) Oil, Trifolium Pratense (Red Clover) Flower Extract, Pueraria Mirifica Root Extract, Carnosine (L), Phenyl t-Butylnitrone (Spin Trap), Oryza Sativa (Rice) Bran Oil, Zea Mays (Corn) Silk Extract, Glycerin, Cinnamomum Camphora (Camphor) Bark Oil, Santalum Austrocaledonicum (Sandalwood) Wood Oil, Bisabolol (L-Alpha), Triticum Vulgare (Wheat) Germ Oil, Simmondsia Chinensis (Jojoba) Seed Oil, Gluconolactone, Squalane, Xanthan Gum, Sodium Hydroxymethylglycinate, Carbomer, Guaiazulene, Mentha Piperita (Peppermint) Oil, Sodium Hyaluronate (L), Phenethyl Alcohol, Caprylyl Glycol, Alcohol Denat., Copper Gluconate, Thioctic (R-Lipoic) Acid, Pentylene Glycol, Sodium Benzoate, Potassium Sorbate$ra059$, $ra059$Dispense 1-2 pumps into fingertips and gently massage into clean, dry skin or layer over your favorite pro youth serum.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/HEALTHY_AGING_CREAM_15ml.png', 3050, 'https://ramarketplace.com/store/559flawless/product/healthy-aging-cream', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-HERBAL-AHA-CLEANSE', $ra059$Herbal AHA Cleanse$ra059$, 'herbal-aha-cleanse', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This powerful glycolic acid and rosemary extract cleanser breaks down cellular buildup, giving skin a deep-pore cleanse. Skin will feel clarified and softened.$ra059$, $ra059$Aqua (Water), Decyl Glucoside, Cocamidopropyl Betaine, Glycerin, Glycolic Acid, Polyacrylate-1, Crosspolymer, Sodium Lauroyl Lactylate, Glycol Distearate, Sodium Hydroxide, Cocamidopropyl Hydroxysultaine, Gluconolactone, Rosmarinus Ocinalis (Rosemary) Leaf Oil, Origanum Majorana (Marjoram) Leaf Oil, Lauryl Glucoside, Sodium Cocoamphoacetate, Hydroxyethylcellulose, Sodium Cocoyl Glutamate, Sodium Lauryl Glucose Carboxylate, Sodium Benzoate$ra059$, $ra059$Dispense 1 pump into dampened (or dry) hands; add water for more lather. Massage into face and neck for several minutes. Remove with warm water and cloth. Pat skin dry.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/HERBAL_AHA_CLEANSE_30ml_W_2026-02-25-235634_zbpl.png', 1450, 'https://ramarketplace.com/store/559flawless/product/herbal-aha-cleanse', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-HOME-REJUVENATION-PEEL', $ra059$Rejuvenating &amp; Brightening Home Peel System$ra059$, 'home-rejuvenation-peel', (select id from public.product_categories where slug = 'systems-collections'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$System Includes:
Pumpkin Cleanser (30mL)

Pumpkin Parfait Enzyme (15mL)

Mandelic Arginine Serum (15mL)

Skin Smoothing Gel (15mL)

Retinol Supreme (15mL)

Creamy Milk Cleanser (30mL)

Cucumber Spritz (30mL)

Growth Factor Serum (10mL)

Infuse 7 (15mL)$ra059$, null, $ra059$HOME PEEL DIRECTIONS

Step 1: Cleanse skin with the brightening essence of Pumpkin Lactic Cleanse for an exfoliating, deep-pore cleanse. Dispense 1-2 pumps into dampened hands and massage into skin for several minutes (don’t rush this step). Remove with warm water and soft cloth then pat skin dry.

Step 2: Apply a thin, even layer of Pumpkin Parfait Enzyme to clean, dry skin. Let remain on skin for 10 minutes. Rinse with tepid water and 4x4 gauze or cloth. Gently pat skin dry.

Step 3: Apply Mandelic Rejuvenator, a strengthening serum that increases cellular energy for renewed, healthy-looking skin. Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let product absorb and remain on skin.

Step 4: Dispense 1-2 pumps of Skin Smoothing Gel onto fingertips and apply over Mandelic Rejuvenator. Let product absorb and remain on skin.

Step 5: Dispense 2-3 pumps of Retinol Supreme onto fingertips and apply over Skin Smoothing Gel. Let product absorb and remain on skin overnight. If skin feels too dry, apply Omega 7 Complex overtop.

POST-PEEL DIRECTIONS – Apply these products/steps only for the next 5-7 days AM and PM.

Gently cleanse with our soothing Calming Milk Cleanse. Remove with tepid water and soft cloth then pat skin dry. Next, promote healthy cell renewal using potent EGF. Dispense 1-2 pumps of Growth Factor Serum onto fingertips and apply to clean, dry skin. Skin may experience a warming sensation which will subside in a few minutes. Restore elasticity and renew skin with our ultra-hydrating, pro-youth replenish serum. Dispense 1-2 pumps of Omega 7 Complex onto fingertips and smooth onto skin. Let product absorb and remain on skin. Use AM and/or PM as needed.

Give your skin a much needed “drink of water” using HA2O Spritz, an all-natural, moisture-binding hydrator that will leave skin cool and relieved. Mist throughout the day as needed to relieve tightness and sensitivities. Store in refrigerator for additional cooling relief.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/HOME-PEELS-ProYouth.jpg', 26750, 'https://ramarketplace.com/store/559flawless/product/home-rejuvenation-peel', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-HORMONAL-BALANCE', $ra059$Hormonal Balance$ra059$, 'hormonal-balance', (select id from public.product_categories where slug = 'duos'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Bring about balance to hormonally-challenged skin. This impactful duo uses a combination of non-comedogenic, refined grape seed oil and wild yam to provide light hydration, balance skin and reduce inflammation as well as mandelic acid and L-arginine to reduce bacteria, gently exfoliate and provide potent rejuvenation for acne-prone skins.

SYSTEM INCLUDES:
Balancing Cocktail
Mandelic Clear Complex$ra059$, null, $ra059$AM and PM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Mandelic Clear Complex. Finish with 1-2 pumps of Balancing Cocktail and your favorite Sun Reflect product.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/HORMONAL_BALANCE_DUO.png', 9700, 'https://ramarketplace.com/store/559flawless/product/hormonal-balance', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-HYALURONIC-CONCENTRATE', $ra059$Hyaluronic Concentrate$ra059$, 'hyaluronic-concentrate', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Hyaluronic acid restores a youthful, plump complexion. With this lightweight serum, parched skin is instantly quenched, firmed and strengthened.

Increases Hydration
Smooths Fine Lines
Boosts Volume
Decreases Trans Epidermal Water Loss

TIP: Spritz skin with HA Hydra Mist to enhance results prior to applying$ra059$, $ra059$Aqua (Water), Polysorbate 20, Glycerin, Sodium Hyaluronate (L), Lonicera Japonica (Honeysuckle) Flower Extract, Hamamelis Virginiana (Witch Hazel) Water, Lonicera Caprifolium (Honeysuckle) Flower Extract, Citric Acid, Lavandula Hybrida (Lavandin) Oil, O-cymen-5-OL, Alcohol, Cinnamomum Camphora (Camphor) Bark Oil, Squalane, Rosa Canina Seed Oil*, Sodium Hydroxide$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or layer under your favorite pro youth moisturizer. To enhance results, pair with our HA Hydra Mist.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/HYALURONIC_CONCENTRATE_30ml_T.png', 4150, 'https://ramarketplace.com/store/559flawless/product/hyaluronic-concentrate', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-HYALURONIC-TONIC', $ra059$Hyaluronic Tonic$ra059$, 'hyaluronic-tonic', (select id from public.product_categories where slug = 'toners'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Refresh and hydrate! Hyaluronic Tonic is formulated with hyaluronic acid and cucumber extract to give skin a needed drink of water.$ra059$, $ra059$Hamamelis Virginiana (Witch Hazel) Water, Aqua (Water), Alcohol, Deuterium Oxide (Heavy Water), Glycerin, Sodium PCA, Borago Ocinalis Seed Oil, Phospholipids, Honey (Mel), Sphingolipids, Hyaluronic Acid, Arginine (L), Fructooligosaccharides (D-Beta), Glucosamine HCl (D), Cucumis Sativus (Cucumber) Fruit Oil, Cocos Nucifera (Coconut) Oil$ra059$, $ra059$Shake Well Before Using. Spritz on clean, dry skin for use as a toner or moisturizer and let product absorb. May also be used to set mineral makeup and throughout the day for cooling hydration.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/HYALURONIC_TONIC_30ml_W_2026-02-25-235707_ejkj.png', 1500, 'https://ramarketplace.com/store/559flawless/product/hyaluronic-tonic', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-HYDRA-GLOW-FACIAL', $ra059$Hydra Relief$ra059$, 'hydra-glow-facial', (select id from public.product_categories where slug = 'at-home-facials'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Our unique gommage enzyme with pineapple and papaya extracts gently buffs away skin, revealing a softer complexion. Skin is infused with antioxidants and a luxe grape seed oil. Give your skin a dewy, hydrated glow!$ra059$, null, $ra059$STEP 1: CLEANSE

Cleanse skin with the all-natural, probiotic essence of Gentle Peptide Cleanse for a thorough, deep-pore cleanse. Dispense 1-2 pumps into dampened hands and massage into skin for several minutes (don’t rush this step). Remove with warm water and soft cloth then pat skin dry.

STEP 2: ENZYME

Dispense 2-3 pumps of Derma - Zyme onto fingertips and apply evenly to skin. Avoid eye area. This papaya/pineapple enzyme will lift away dead skin cells and leave skin smooth and hydrated. Begin circular massage on face and neck until fine granules begin to form then let enzyme remain on skin for 5 - 10 minutes. Rinse with warm water and soft cloth or gauze. Pat skin dry.

STEP 3: MASK

Apply a thin, even layer of Grape Seed Antiox Mask to dry face and neck. Avoid eye area. This pro-youth, antioxidant-rich cream will firm and nourish while providing deep hydration. Leave on skin for 15-20 minutes. Remove with warm water and soft cloth. This is a great step to do in a steamy shower or bath.

STEP 4: HYDRATE & PROTECT

Finish with Grape Seed Glow for deep hydration and antioxidant support. Dispense 1-2 pumps onto fingertips and apply to clean, dry skin. Let absorb and remain on skin.$ra059$,
     'https://ramarketplace.com/media/products/_listing/HYDRA_RELIEF_DUO_a80f280b-90f2-47ea-bd4f-9cbbbbe62088.jpg', 5650, 'https://ramarketplace.com/store/559flawless/product/hydra-glow-facial', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-HYDRATING-RELIEF-SERUM', $ra059$Hydrating Relief Serum$ra059$, 'hydrating-relief-serum', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Light hydration for dry acne skin to reduce inflammation, strengthen and bring about healing. The delightful aroma will keep you coming back for more.$ra059$, $ra059$Vitis Vinifera (Grape) Seed Oil, Citrus Aurantium Dulcis (Orange) Oil, Tsunga Canadensis (Hemlock) Oil, Eugenia Caryophyllus (Clove) Leaf Oil, Cinnamomum (Cinnamon) Cassia Leaf Oil, Vitis Vinifera (Grape) Seed Extract$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or into your favorite RA serum morning and/or night.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/HYDRATING_RELIEF_SERUM_10ml.png', 1600, 'https://ramarketplace.com/store/559flawless/product/hydrating-relief-serum', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-INFLAMMATORY-ESSENTIALS', $ra059$Inflammatory Essentials$ra059$, 'inflammatory-essentials', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Reduce post- inflammatory hyperpigmentation (PIH) – a type of pigmentation that occurs when inflammation triggers excessive melanin production during the healing process. Treat skin at the root of the problem, reducing inflammation and increasing cellular rejuvenation, using powerful antioxidants, plant stem cells and retinal to lighten skin and maintain a brighter, more even complexion.

SYSTEM INCLUDES:
Beta Bright Cleanse
Grape Seed Glow
"A" Renew +$ra059$, null, null,
     'https://ramarketplace.com/media/products/_mainPhoto/INFLAMMATORY_ESS-v1623268332.png', 20100, 'https://ramarketplace.com/store/559flawless/product/inflammatory-essentials', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-INFLAMMATORY-TRAVEL', $ra059$Inflammatory Travel$ra059$, 'inflammatory-travel', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Reduce post- inflammatory hyperpigmentation (PIH) – a type of pigmentation that occurs when inflammation triggers excessive melanin production during the healing process. This highly specialized lightening system treats skin at the root of the problem, reducing inflammation and increasing cellular rejuvenation, using powerful antioxidants, plant stem cells, growth factors and retinal to lighten and brighten for a more even complexion and healthy-looking skin.

SYSTEM INCLUDES:
Beta Bright Cleanse
Mandelic Bright
Radiant Renew Serum
Grape Seed Glow
"A" Renew +$ra059$, null, $ra059$AM – Cleanse with Beta Bright Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps Mandelic Bright, massage into skin. Finish with 1-2 pumps Radiant Renewal Serum and Daytime Defense.

PM - Cleanse with Beta Bright Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps “A” Renew +, massage into skin. Finish with 1-2 pumps Radiant Renewal Serum.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/INFLAMMATORY_TRAVEL_TVL5.png', 19600, 'https://ramarketplace.com/store/559flawless/product/inflammatory-travel', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-INFUSE-7', $ra059$Infuse 7$ra059$, 'infuse-7', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$The ultimate pro youth hydrating serum. A blend of 7 essential nutrients including omegas, vitamin E, avocado and macadamia oils to heal, replenish, improve elasticity, increase collagen, boost antioxidants and restore skin.

Highly Absorbable
Restoring and Hydrating
Tissue Regenerating
Boosts Elasticity

TIP: Apply over serums to increase penetration and create a barrier on the skin$ra059$, $ra059$Linoleic Acid, Oleic Acid, Tocopherol (D-Alpha), *Organic Avocado Oil, *Organic Macadamia Nut Oil, Lavandula Angustifolia (Lavender) Oil, Vitis Vinifera (Grape) Seed Oil, Citrus Bergamia (Bergamot) Essential Oil, Cananga Odorata var. Genuina (Ylang Ylang II) Essential Oil, Citrus Aurantium Dulcis (Sweet Orange) Peel Essential Oil, Citrus Medica Limonum (Lemon) Peel Essential Oil

*Certified USDA Organic$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into skin. Apply over any serum(s) as last step in regimen.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/INFUSE_7_15ml.png', 2000, 'https://ramarketplace.com/store/559flawless/product/infuse-7', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-INSTANT-LIFT-MASK', $ra059$Instant Lift Mask$ra059$, 'instant-lift-mask', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$An organic, protein-based powder that firms and tightens the skin. This intense, stimulating mask improves the appearance of fine lines, wrinkles and sagging skin to reveal the ultimate pro youth glow. The perfect mini face-lift mask.

*Must be activated by RA's Lactic Renew Tonic or HA Hydra Mist

TIP : Add Peptide 38 to the mask to increase firming results$ra059$, $ra059$Albumen, Zea Mays (Corn) Starch, Acacia, Beta Glucan, Ascorbic Acid (L).$ra059$, $ra059$Safe for all skins. Mix 1 tsp powder with 4 pumps Lactic Renew Tonic. Apply thin layer to clean, dry skin with firm brush. Leave on for 30 minutes – mask becomes very tight, often producing pulsing sensations, which is normal. Remove with a gentle Pro Youth -10 cleanser; wipe with warm, wet cloth. Will take a few rinses to remove.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/INSTANT_LIFT_MASK_50ml_W.png', 3800, 'https://ramarketplace.com/store/559flawless/product/instant-lift-mask', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-INSTANT-LIFT-MASK-SET', $ra059$Instant Lift Mask Set$ra059$, 'instant-lift-mask-set', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A complete set - everything you need for the Natural Lift Masque treatment, an organic, protein-based mask that provides intense stimulation for facial muscles.


Set includes:

Lactic Renew Tonic 120ml
Instant Lift Mask 50ml
RA Square Brush and Mixing Jar$ra059$, null, $ra059$Safe for all skins. Mix 1 tsp powder with 4 pumps Lactic Renew Tonic. Apply thin layer to clean, dry skin with firm brush. Leave on for 30 minutes – mask becomes very tight, often producing pulsing sensations, which is normal. Remove with a gentle Pro Youth -10 cleanser; wipe with warm, wet cloth. Will take a few rinses to remove.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/INSTANT_LIFT_MASK_SET_2026-07-13-035925_faiy.png', 7500, 'https://ramarketplace.com/store/559flawless/product/instant-lift-mask-set', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-LACTIC-RENEW-TONIC', $ra059$Lactic Renew Tonic$ra059$, 'lactic-renew-tonic', (select id from public.product_categories where slug = 'toners'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$L-lactic acid promotes a smoother texture while aloe vera and hyaluronic acid soothe, plump and hydrate the skin as a daily toner.

Texture Softening
Plumps Skin
Firming and Hydrating

Tip: Use as a catalyst to activate our Instant Lift Mask$ra059$, $ra059$Aloe Barbadensis (Aloe Vera) Leaf Extract, Glycerin, Sodium PCA, Urea, Trehalose, Polyquaternium-51, Sodium Hyaluronate, Polysorbate-20, Ethoxydiglycol, Lactic Acid, Hyaluronic Acid, Hydrolyzed Wheat Protein, Echinacea Angustifolia Extract, Cucumis Sativus (Cucumber) Extract, Anthemis Nobilis (Chamomile) Flower Extract, Vitis Vinifera (Grape) Seed Extract, Camellia Sinensis (Green Tea) Leaf Extract, Rosmarinus Officinalis (Rosemary) Leaf Extract, Retinyl Palmitate, Cholecalciferol, Tocopheryl Acetate, Allantoin, Citrus Grandis (Grapefruit) Oil, Citrus Aurantium Bergamia (Bergamot) Fruit Oil, Sodium Benzoate, Potassium Sorbate$ra059$, $ra059$Dispense 1 pump onto gauze or cotton pad and apply to clean, dry skin. Let product absorb. Use daily or as directed by licensed professional.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/LACTIC_RENEW_TONIC_30ml_W.png', 1500, 'https://ramarketplace.com/store/559flawless/product/lactic-renew-tonic', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-LASH-EYEFECT', $ra059$Lash EyeFect$ra059$, 'lash-eyefect', null,
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Formulated specifically for eyelash extensions, our unique cleansing gel safely removes makeup and mascara without depleting or irritating even the most sensitive skin and eyes, including contact lens wearers. Enriched with age-reducing actives and anti-inflammatory botanicals, skin and eyes will be soothed and refreshed. Partnered with our “freezing” peptide serum to instantly cool tired eyes, this revitalizing formula will firm tissue and reduce puffiness for a brightened, rejuvenated, youthful look.

System Includes:

Makeup Remover 30ml
Eye Revitalizer 15ml$ra059$, null, null,
     'https://ramarketplace.com/media/products/_mainPhoto/LASH_EYEFECT_DUO.jpg', 5300, 'https://ramarketplace.com/store/559flawless/product/lash-eyefect', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-LIFT-EYEFECT', $ra059$Lift EyeFect$ra059$, 'lift-eyefect', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Sculpt Line:Eyes to sheer perfection with a light lift and powerful wrinkle minimizer. Using special peptide complexes, potent antioxidants and valuable hydrators, the results will be clear for everyone to see. Eye tissue will instantly have a firmer, restored appearance as fine lines fade away.

SYSTEM INCLUDES:
Eye Lift
Eye & Lip Renew$ra059$, null, null,
     'https://ramarketplace.com/media/products/_mainPhoto/LIFT_EYEFECT_DUO.jpg', 18800, 'https://ramarketplace.com/store/559flawless/product/lift-eyefect', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-LIPOSOME-HONEY-CLEANSE', $ra059$Liposome Honey Cleanse$ra059$, 'liposome-honey-cleanse', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$The perfect gentle cleansing cloth using liposomal technology to deliver ingredients deep into the skin for a quick removal of makeup, dirt, and debris. These easy to use and convenient cleansing pads are ideal for post workout with excellent ingredients like L-mandelic acid, honey and heart of green tea extracts.

Soften Skin Texture
Reduces Inflammation
Balances Lipids
Boost Antioxidants

TIP: Pair with Mandelic Rejuvenator and Ultra Replenish Cream for a simple regimen.$ra059$, $ra059$Aqua (Water), Polyglyceryl-4 Caprate, Glycerin, Propanediol, Alcohol Denat., Mandelic Acid (L), Polyglyceryl-4 Caprylate/Caprate, Polyglyceryl-4 Laurate/Sebacate, Caprylyl Glycol, Leuconostoc/Radish Root Ferment Filtrate, Succinic Acid Zymomonas Ferment Extract, Camellia Oleifera (Green Tea) Leaf Extract, Epigallocatechin Gallate, Lecithin, Sodium Hydroxide, Ascorbyl Glucoside, Sodium Gluconate, Oxidized Glutathione, Sclerotium Gum, Pullulan, Honey Extract, Sodium Lactate, Opuntia Ficus-Indica (Cactus) Stem Extract, Xanthan Gum, Hamamelis Virginiana (Witch Hazel) Water, Citric Acid$ra059$, $ra059$Remove 1 pad from jar and gently massage across the face and neck with firm pressure. Rinse pad with water and smooth across face and neck a second time to remove solution. Let skin dry and continue with your RA regimen.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/29619/PY_LIPOSOME_HONEY_CLEANSE_PADS_2026-06-10-031931_rvke.png', 3800, 'https://ramarketplace.com/store/559flawless/product/liposome-honey-cleanse', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-LUMINOUS-BALANCING-SERUM', $ra059$Luminous Balancing Serum$ra059$, 'luminous-balancing-serum', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Refined grape seed oil and wild yam extract help balance menopausal skin while delivering lightweight hydration and antioxidant support.

Balance Hormonal Skin with Natural Progesterone
Antioxidant Protection
Increases Ciruclation
Decrease Inflammation

TIP: Pairs well with Resveratrol B3 Gel for its cooling benefits$ra059$, $ra059$Vitis Vinifera (Grape) Seed Oil, Alcohol Denat., Dioscorea Villosa (Wild Yam) Root Extract, Phytonadione (K1), 1,2-Hexanediol, Caprylyl Glycol, Cupressus Sempervirens (Cypress) Leaf/Nut/Stem Oil, Mentha Piperita (Peppermint) Oil, Salvia Sclarea (Clary) Oil, Propanediol, Santalum Austrocaledonicum (Sandalwood) Wood Oil, Glycerin, Tropolone,$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/LUMINOUS_BALANCING_SERUM_15ml.png', 3000, 'https://ramarketplace.com/store/559flawless/product/luminous-balancing-serum', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-LUMINOUS-WINE-GEL', $ra059$Luminous Wine Gel$ra059$, 'luminous-wine-gel', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A soothing, cooling moisture gel packed with hydrating antioxidants and skin-strengthening nutrients to restore tissue, prevent damage and reduce inflammation for a firmer, brighter complexion. Excellent for melasma.$ra059$, $ra059$Aqua (Water), Glycerin, Whey Protein, Cassia Angustifolia Seed Polysaccharide, Aloe Barbadensis Leaf Juice Powder, Squalane, Menthyl Lactate (L), Ruscus Aculeatus (Butcher’s Broom) Root Extract, Centella Asiatica (Gotu Kola) Extract, Panthenol (D), Calendula Officinalis Flower Extract, Hydrolyzed Yeast Protein, Aesculus Hippocastanum (Horse Chestnut) Bark Extract, Vitis Vinifera (Grape) Seed Oil, Citrus Grandis (Grapefruit) Peel Oil, Niacinamide, Bisabolol (L-Alpha), Allantoin, Wine Extract (Resveratrol), Glucuronolactone (D), Limonene, Beta Vulgaris (Beet) Root Extract, Mica, Benzyl Alcohol$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or over your favorite RA serum. Use daily. May feel cooling sensation.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/LUMINOUS_WINE_GEL_15ml_99bd78a6-6b7b-4e54-8bc9-b8ed1007f84d.png', 2000, 'https://ramarketplace.com/store/559flawless/product/luminous-wine-gel', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MAKEUP-REMOVER', $ra059$Makeup Remover$ra059$, 'makeup-remover', null,
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Formulated for eyelash extensions, this gentle cleanser removes makeup and mascara without depleting or irritating even the most sensitive skin and eyes, including contact lens wearers. Enriched with nourishing, anti-inflammatory botanicals and age-reducing, tissue-plumping actives, skin and eyes will be refreshed and soothed.$ra059$, $ra059$Aqua (Water), Glycerin, Decyl Glucoside, Hydroxypropyl Methylcellulose, Camellia Oleifera (Green Tea) Leaf Extract, Sodium Lauroyl Lactylate, Phenoxyethanol, Sodium Hydroxymethylglycinate, Caprylyl Glycol, Lactic Acid (L), Chamomilla Recutita (Matricaria) Flower Extract, Vaccinium Myrtillus (Bilberry) Fruit Extract, Allantoin, Ascorbic Acid (L), Tocopherol (D-Alpha), Phytic Acid, Glycine Soja (Soybean) Oil, Sodium Hyaluronate (L), Phenethyl Alcohol, Beta-Glucan (D), Potassium Sorbate$ra059$, $ra059$Gently massage 1-2 pumps over lashes, around eye area and over entire face. Remove with warm water and soft cloth. Pat skin dry.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/MAKEUP_REMOVER_30ml_2df7249c-d0dc-4c8a-9622-8111703c9640.png', 1800, 'https://ramarketplace.com/store/559flawless/product/makeup-remover', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MANDELIC-BRIGHT', $ra059$Mandelic Bright$ra059$, 'mandelic-bright', (select id from public.product_categories where slug = 'correctives'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A lifestyle-friendly, powerhouse, rejuvenating serum that provides brightening support, an increase in cellular energy and antioxidant protection. Effective, yet gentle enough for year-round use.$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Alcohol Denat., Propanediol, Mandelic Acid (L), Arginine (L), Alcohol, Hydroxypropyl Methylcellulose, Lonicera Japonica (Honeysuckle) Flower Extract, Pyruvic Acid, 1,2-Hexanediol, Caprylyl Glycol, Phytic Acid, Lonicera Caprifolium (Honeysuckle) Flower Extract, Sodium Gluconate, Sodium Hydroxide, Citric Acid$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and apply to clean, dry skin either AM or PM. Let serum absorb. May layer moisturizer overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/MANDELIC_BRIGHT_15ml_26b7f859-d758-4f4f-9652-7b6fa94df2ce.png', 5500, 'https://ramarketplace.com/store/559flawless/product/mandelic-bright', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MANDELIC-CLAY-CLEANSE', $ra059$Mandelic Clay Cleanse$ra059$, 'mandelic-clay-cleanse', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A unique cleanser that combines the cellular exfoliation properties from AHA’s and BHA’s
with the ability to draw out impurities using clay extracts. All while soothing inflammation and promoting healing of tissue through potent botanical extracts and stem cells. A must-have for impure acne skins.$ra059$, $ra059$Aqua (Water), Sodium C14-16 Olefin Sulfonate, Propanediol, Kaolin, Glycerin,

Glyceryl Stearate SE, Isopentyldiol, Glyceryl Stearate, Sodium Cocoamphoacetate, Cocamidopropyl
Hydroxysultaine, Polyglyceryl-6 Palmitate/Succinate, Salicylic Acid, Lonicera Japonica (Honeysuckle)
Flower Extract, Caprylyl Glycol, Dimethyl Isosorbide, Mandelic Acid (L), Glycolic Acid, Lonicera
Caprifolium (Honeysuckle) Flower Extract, Magnesium Aluminum Silicate, Totarol, Acetyl Zingerone,
Maltodextrin, Syringa Vulgaris (Lilac) Leaf Cell Culture Extract, Cetearyl Alcohol, Xanthan Gum, Citric
Acid, Sodium Hydroxide$ra059$, $ra059$Dispense 1 pump into dampened hands and massage into face and
neck for several minutes; add water for more lather. Remove with warm water and gauze or soft
cloth. Pat skin dry.


Caution: Salicylic acid can be associated with an aspirin allergy.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/MANDELIC_CLAY_CLEANSE_120ml_2026-02-25-235838_qcep.png', 2100, 'https://ramarketplace.com/store/559flawless/product/mandelic-clay-cleanse', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MANDELIC-CLEAR-COMPLEX', $ra059$Mandelic Clear Complex$ra059$, 'mandelic-clear-complex', (select id from public.product_categories where slug = 'correctives'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$An impactful serum that reduces bacteria, increases gentle exfoliation and triggers cellular energy while providing powerful wound healing — all extremely valuable for any acne skin.$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Alcohol Denat., Propanediol, Mandelic Acid (L), Arginine (L), Alcohol, Hydroxypropyl Methylcellulose, Lonicera Japonica (Honeysuckle) Flower Extract, Pyruvic Acid, 1,2-Hexanediol, Caprylyl Glycol, Phytic Acid, Lonicera Caprifolium (Honeysuckle) Flower Extract, Sodium Gluconate, Sodium Hydroxide, Citric Acid$ra059$, $ra059$Dispense 1-2 pumps onto fingertips; massage into clean, dry skin morning and/or evening. Let serum absorb. May layer moisturizer or SPF overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/MANDELIC_CLEAR_COMPLEX_30ml_T_2026-02-25-235909_hmdp.png', 5500, 'https://ramarketplace.com/store/559flawless/product/mandelic-clear-complex', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MANDELIC-PERFECTING-POLISH', $ra059$Mandelic Perfecting Polish$ra059$, 'mandelic-perfecting-polish', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This weekly treatment scrub helps eliminate cellular buildup and bacteria, smoothing texture, reducing inflammation and the risk of post-inflammatory hyperpigmentation through a combination of granual exfoliations and acids. Ideal for all acne skin and can be used as a treatment mask for those with pustules or drier acne skin.$ra059$, $ra059$Aqua (Water), Diatomaceous Earth, Cellulose Acetate, Glycerin, Alcohol Denat., Caprylic/Capric Triglyceride, Behenyl Alcohol, Kaolin, Niacinamide, Papaver Somniferum (Poppy) Seed, Mandelic Acid (L), Stearic Acid, Dicaprylyl Ether, Cetyl Alcohol, Lonicera Japonica (Honeysuckle) Flower Extract, Salicylic Acid, Cocamidopropyl Betaine, Sodium C14-16 Olefin Sulfonate, Disodium Laureth Sulfosuccinate, Acrylates Copolymer, Bellis Perennis (Daisy) Flower Extract, Potassium Azeloyl Diglycinate, Cocamidopropyl Hydroxysultaine, Sodium Cocoamphoacetate, Sodium Lauryl Sulfoacetate, Leuconostoc/Radish Root Ferment Filtrate, Aloe Barbadensis Leaf Juice Powder, Glyceryl Stearate SE, Glycol Distearate, Titanium Dioxide, Sodium Stearoyl Glutamate, Lonicera Caprifolium (Honeysuckle) Flower Extract, Allantoin, Dimethicone, Phenethyl Alcohol, Bisabolol (L-alpha), Totarol, Potassium Sorbate, Caprylyl Glycol, Sodium Hydroxide, Tocopheryl Acetate (D-alpha), Hamamelis Virginiana (Witch Hazel) Water, Carbomer, Phytic Acid, Camellia Sinensis (Green Tea) Leaf Extract, Alcohol, Trisodium Ethylenediamine Disuccinate, Passiflora Incarnata (Passionflower) Flower Extract, Sodium Chloride, Propanediol, Benzyl Alcohol, Sodium Gluconate, Caprylhydroxamic Acid, Cinnamomum Camphora (Camphor) Bark Oil, Pogostemon Cablin (Patchouli) Oil, Kojic Acid, Aminobutyric Acid (GABA), Calcium Pantothenate (D), Lysine HCI, Cysteine (L), Citrus Aurantium Bergamia (Bergamot) Fruit Oil, Citrus Paradisi (White Grapefruit) Peel Oil, Citrus Limon (Lemon) Peel Oil, Citrus Aurantium Dulcis (Orange) Peel Oil*, Citric Acid, Butyrospermum Parkii (Shea) Butter, Xanthan Gum$ra059$, $ra059$Squeeze a small amount into damp hands; work into face and neck. Allow polish to sit on skin for 2-3 minutes. Add water and begin to rinse thoroughly with warm water. Pat skin dry and brush away any excess beads. May use 2 times a week depending on skin type.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/MANDELIC_PERFECTING_POLISH_60ml_SQ.png', 3700, 'https://ramarketplace.com/store/559flawless/product/mandelic-perfecting-polish', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MANDELIC-PURIFYING-TONIC', $ra059$Mandelic Purifying Tonic$ra059$, 'mandelic-purifying-tonic', (select id from public.product_categories where slug = 'toners'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Mandelic acid and powerhouse antioxidants give problematic skin antibacterial support, rejuvenating benefits and protection from free radical damage.$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Mandelic Acid (L), Uric Acid, Ascorbic Acid (L), Glutathione (L), Superoxide Dismutase, Alcohol, Tocopherol (D-Alpha), Helianthus Annuus (Sunflower) Seed Oil, Glycerin, Pelargonium Graveolens (Geranium) Flower Oil, Citrus Grandis (Grapefruit) Peel Oil, Melissa Ocinalis Extract, Sodium Hydroxide$ra059$, $ra059$Dispense 1 pump onto gauze or cotton pad and apply to clean, dry skin. Let product absorb. Spot treat on lesions or use full face. May use daily as needed.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/MANDELIC_PURIFYING_TONIC_30ml_W_2026-02-26-000000_trxd.png', 1800, 'https://ramarketplace.com/store/559flawless/product/mandelic-purifying-tonic', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MANDELIC-REJUVENATOR', $ra059$Mandelic Rejuvenator$ra059$, 'mandelic-rejuvenator', (select id from public.product_categories where slug = 'correctives'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This multi-functional corrective improves your skin on a cellular level, without drying or flaking. By increasing cellular energy, this serum achieves healthy wound healing and repairability, while also increasing firming and toning, leaving skin softer and soother.
Boosts ATP Energy Addresses Loss of Elasticity Antioxidant and Brightening Support Promotes Healthy Wound Healing
TIP: Layer under ChronoPeptide A to boost rejuvenation$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Alcohol Denat., Propanediol, Mandelic Acid (L), Arginine (L), Alcohol, Hydroxypropyl Methylcellulose, Lonicera Japonica (Honeysuckle) Flower Extract, Pyruvic Acid, 1,2-Hexanediol, Caprylyl Glycol, Phytic Acid, Lonicera Caprifolium (Honeysuckle) Flower Extract, Sodium Gluconate, Sodium Hydroxide, Citric Acid$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and apply to clean, dry skin. May be applied AM or PM.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/MANDELIC_REJUVENATOR_15ml.png', 5500, 'https://ramarketplace.com/store/559flawless/product/mandelic-rejuvenator', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MANDELIC-REPLENISH', $ra059$Mandelic Replenish$ra059$, 'mandelic-replenish', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A daily, lightweight cream hydrator with mandelic acid and vitamin E to moisturize, heal and provide antibacterial support for acne skins.$ra059$, $ra059$Aqua (Water), Glyceryl Stearate, Cetearyl Alcohol, Mandelic Acid (L), Glycerin, Olea Europaea (Olive) Fruit Oil, Colostrum, Squalane, Tocopherol (D-Alpha), Aloe Barbadensis Leaf Juice Powder, Retinol, Helianthus Annuus (Sunflower) Seed Oil, Prunus Amygdalus Dulcis (Sweet Almond) Oil, Allantoin, Daucus Carota Sativa (Carrot) Root Extract, Chamomilla Recutita (Matricaria) Flower Extract, Althaea Officinalis (Marshmallow) Root Extract, Glycine Soja (Soybean) Oil, Hamamelis Virginiana (Witch Hazel) Water, Cetyl Alcohol, Citrus Grandis (Grapefruit) Peel Oil, Mentha Piperita (Peppermint) Oil, Citric Acid, Alcohol, Benzyl Alcohol$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or over your favorite RA serum AM and/or PM.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/MANDELIC_REPLENISH_15ml.png', 2100, 'https://ramarketplace.com/store/559flawless/product/mandelic-replenish', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MANDELIC-TRANSFIRMATION', $ra059$Mandelic TransFIRMation$ra059$, 'mandelic-transfirmation', (select id from public.product_categories where slug = 'systems-collections'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Reduce the visible signs of aging and maintain a healthy glow year-round. Our Pro Youth -10 system uses the power of mandelic acid and peptides to reduce fine lines and wrinkles and gently rejuvenate the skin - the transFIRMation will have skin looking years younger in no time.

System Includes:

Gentle Peptide Cleanser 30ml
Antiox Defense Tonic 30ml
Antiox 18 Complex 10ml
Mandelic Rejuvenator 15ml
Amino Peptide Hydration 15ml$ra059$, null, $ra059$AM – Cleanse with Gentle Peptide Cleanse, remove with warm water and soft cloth, pat skin dry. Apply Antiox Defend Tonic with a cotton round, let product absorb into skin. Apply 1-2 pumps Antiox 18 Complex, massage into skin. Finish with 1-2 pumps Amino Peptide Hydration.

PM - Cleanse with Gentle Peptide Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps Mandelic Rejuvenator, massage into skin. Finish with 1-2 pumps Amino Peptide Hydration.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/MANDELIC_TRANSFIRMATION_TVL5_2026-07-13-035048_qlwz.png', 12600, 'https://ramarketplace.com/store/559flawless/product/mandelic-transfirmation', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MELASMA-ESSENTIALS', $ra059$Melasma Essentials$ra059$, 'melasma-essentials', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Melasma is a common skin problem that causes dark, discolored patches on your skin. Using products with superior lightening ingredients, such as kojic acid, mandelic acid and daisy flower extract, maintain a brighter, more even tone and minimize the appearance of discoloration for glowing, beautiful skin.

System Includes:

Skin Brightening Cleanse 120ml
Mandelic Bright 30ml
Luminous Wine Gel 50ml$ra059$, null, $ra059$AM – Cleanse with Skin Brightening Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps Mandelic Bright, massage into skin. Finish with 1-2 pumps Luminous Wine Gel and Daytime Defense.

PM - Cleanse with Skin Brightening Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps Mandelic Bright, massage into skin. Finish with 1-2 pumps Luminous Wine Gel.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/MELASMA_ESS_c0534fad-0a3f-4e0c-8fde-8767555e2bdf.jpg', 16800, 'https://ramarketplace.com/store/559flawless/product/melasma-essentials', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MELASMA-TRAVEL', $ra059$Moisture Eye-Zyme$ra059$, 'melasma-travel', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Melasma is a common skin problem that causes dark, discolored patches on your skin. Using products with superior lightening ingredients, such as kojic acid, alpha arbutin, daisy flower extract, ascorbic acid (L) and azelaic acid, this advanced brightening system will minimize the appearance of discoloration for a more even skin tone and glowing, beautiful skin.

SYSTEM INCLUDES:
Skin Brightening Cleanser
MVC Serum
Blushed Wine Gel
Mandelic Arginine Serum
Skin Brightening Enzyme$ra059$, null, $ra059$AM – Cleanse with Skin Brightening Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps Vita-Bright Elixir, massage into skin. Finish with 1-2 pumps Luminous Wine Gel and Daytime Defense.


**For more hydration add a pump of Grape Seed Glow to the Vita-Bright Elixir**

PM - Cleanse with Skin Brightening Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps Mandelic Bright, massage into skin. Finish with 1-2 pumps Luminous Wine Gel or Grape Seed Glow if more hydration is needed.

Weekly – Incorporate Skin Brightening Enzyme once a week to boost brightening results. After cleansing, apply a thin layer and leave on skin for 8-10 minutes. Remove with cool water several times to ensure thorough removal. Pat skin dry and apply 1-2 pumps of Grape Seed Glow.$ra059$,
     'https://ramarketplace.com/media/products/_listing/MOISTURE_EYE-ZYME_15ml_360fd40f-0738-42c7-b318-935f7038aca1.png', 4000, 'https://ramarketplace.com/store/559flawless/product/melasma-travel', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-MOISTURE-FIRM', $ra059$Moisture Firm$ra059$, 'moisture-firm', (select id from public.product_categories where slug = 'duos'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Tone and hydrate with our Minus 10 Moisture Firm system. A powerful duo combining the firming action of resveratrol with potent antioxidant hydrators to provide strong pro-youth benefits while giving skin a fresh, iridescent glow. Not just for dry skin, the fast absorbing action of Blush Wine Gel makes this an excellent choice for oily skins as well.

SYSTEM INCLUDES:
Resveratrol B3 Gel
Pure Grape Seel Elixir$ra059$, null, $ra059$AM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Pure Grape Seed Elixir and massage into skin. Finish with Resveratrol B3 Gel and your favorite RA Sun Reflect product.

PM – After cleansing with RA Cleanser appropriate for your skin, apply RA Corrective recommended by RA Professional. Finish with Pure Grape Seed Elixir.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/MOISTURE_FIRM_DUO_2026-07-13-042626_ykjz.png', 4300, 'https://ramarketplace.com/store/559flawless/product/moisture-firm', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-NATURALE-MEGA-BRIGHTENING-SERUM', $ra059$Naturale Mega Brightening Serum$ra059$, 'naturale-mega-brightening-serum', (select id from public.product_categories where slug = 'correctives'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A unique, powerful, spot-treatment serum for age (brown) spots and melasma. Formulated with daisy flower extract and kojic acid to deliver brightening and lightening support, naturally.$ra059$, $ra059$Aqua (Water), Alcohol Denat., Butylene Glycol, Alpha-Arbutin, Bellis Perennis (Daisy) Flower Extract, Polysorbate 20, Kojic Acid, Hamamelis Virginiana (Witch Hazel) Water, Propylene Glycol, Azelaic Acid, Thermus Thermophillus Ferment, Lactic Acid (L), Camellia Sinensis (Green Tea) Leaf Extract, Aminobutyric Acid (GABA), Sodium Ascorbyl Phosphate, Hydroxypropyl Methylcellulose, Glycerin, Sodium Hydroxide, Fragrance/Parfum, Glycyrrhiza Glabra (Licorice) Root Extract, Retinol, Citrus Aurantium Dulcis (Orange) Peel Oil, Ursolic Acid, Epilobium Angustifolium Flower/Leaf/Stem Extract, Oleanolic Acid, Salvia Officinalis (Sage) Leaf Extract, Pelargonium Graveolens (Geranium) Flower Oil, Lavandula Angustifolia (Lavender) Oil, Pogostemon Cablin (Patchouli) Oil, Lavandula Hybrida (Lavandin) Oil, Cananga Odorata (Ylang Ylang) Flower Oil, Caprylic/Capric Triglyceride, Jasminum Officinale (Jasmine) Flower Extract, Epigallocatechin Gallate, Tetrasodium EDTA, Xanthan Gum, Citric Acid$ra059$, $ra059$Spot treat every other night to every third night. Dispense 1-2 pumps onto fingertips and apply to clean, dry skin. Let absorb. Use product for up to 3 months then stop use for a minimum of 3 months.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/NATURALE_MEGA_BRIGHTENING_SERUM_15ml_4b5102b4-5859-470c-a00b-af33ade1223e.png', 3000, 'https://ramarketplace.com/store/559flawless/product/naturale-mega-brightening-serum', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-OCEANIC-VITALITY-SERUM', $ra059$Oceanic Vitality Serum$ra059$, 'oceanic-vitality-serum', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A potent pigment-reducing vitality serum using the power of brown algae to inhibit tyrosinase and melanocyte activity and bisabolol to infuse skin with antioxidant protection and lightening support for younger-looking, radiant skin.$ra059$, $ra059$Aqua (Water), Glycerin, Alcohol Denat., Bisabolol (L-alpha), Leuconostoc/Radish Root Ferment Filtrate, Sodium Stearoyl Glutamate, Hydrolyzed Verbascum Thapsus Flower, Plantago Lanceolata Leaf Extract, Ascophyllum Nodosum Extract, Sodium Gluconate, Succinoglycan, Caprylhydroxamic Acid, Marrubium (Horehound) Vulgare Extract, Citrus Limon (Lemon) Peel Oil, Citrus Reticulata (Tangerine) Peel Oil, Jasminum Officinale (Jasmine) Oil, Sodium Hydroxide, Benzyl Alcohol, Xanthan Gum, Citric Acid, Polysorbate 20$ra059$, $ra059$Recommend daytime use. Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb and remain on skin. May layer your favorite RA moisturizer and SPF overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/OCEANIC_VITALITY_SERUM_30ml_T_28035edc-88f8-4685-b923-5c11af6d6f67.png', 8500, 'https://ramarketplace.com/store/559flawless/product/oceanic-vitality-serum', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PAPAYA-TANGERINE-ENZYME', $ra059$Papaya Tangerine Enzyme$ra059$, 'papaya-tangerine-enzyme', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Let the enticing aromas of papaya and tangerine begin your spa-at-home experience. This gentle exfoliant offers the combination of both an enzyme and a scrub in one product! Remove dull, cellular buildup while the milk protein leaves skin hydrated and nourished.

Gently Lift Away Skin Cells
Reveal Softer Texture

TIP: Great to mix with a small amount of Cherry Jubilee Enzyme to enhance the results.$ra059$, $ra059$Aqua (Water), Glycerin, Goat Milk, Albumen, Cetyl Alcohol, Squalane, Caprylic/Capric Triglyceride, Kojic Dipalmitate, Alcohol Denat., Stearic Acid, Glycol Distearate, Hamamelis Virginiana (Witch Hazel) Water, Olea Europaea (Olive) Fruit Oil, Papain, Diatomaceous Earth, Kaolin, Tartaric Acid (L), Rutin, Colostrum (Mare’s Milk), Allantoin, Tocopheryl Acetate (D-Alpha), Bisabolol (L-Alpha), Superoxide Dismutase, Glycine Soja (Soybean) Oil, Passiflora Incarnata (Passionflower) Flower Extract, Citrus Tangerina (Tangerine) Peel Oil, Vanillin, Magnesium Aluminum Silicate, Carbomer, Caprylyl Glycol, Citric Acid, Lonicera Caprifolium (Honeysuckle) Flower Extract, Lonicera Japonica (Honeysuckle) Flower Extract, Potassium Sorbate, Gluconolactone, Glyceryl Stearate, Sodium Benzoate, Alcohol, Polysorbate 60, 1,2-Hexanediol, Tropolone, Ceteareth-20, Cetearyl Alcohol$ra059$, $ra059$Gently massage a thin layer into clean, dry skin – avoid eye area. Recommend using light pressure when massaging into skin. Leave on 5-10 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow with your favorite pro youth mask, serums and/or moisturizer. Use once per week.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PAPAYA_TANGERINE_ENZYME_15ml_P.png', 1800, 'https://ramarketplace.com/store/559flawless/product/papaya-tangerine-enzyme', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PEPTIDE-3-N-1-EYE-CREAM', $ra059$Peptide 3-N-1 Eye Cream$ra059$, 'peptide-3-n-1-eye-cream', null,
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Provides superior antioxidant support with a powerful complex of peptides and stem cell technology to reduce puffiness, brighten eye tissue and minimize wrinkles.$ra059$, $ra059$Aqua (Water), Glycerin, Butyrospermum Parkii (Shea) Butter, Caprylic/ Capric Triglyceride, Hamamelis Virginiana (Witch Hazel) Water, Stearic Acid, Glyceryl Stearate, Ascorbic Acid (L), C12-15 Alkyl Benzoate, Helianthus Annuus (Sunflower) Seed Oil, Rosa Canina (Rose Hip) Fruit Oil, Cetyl Alcohol, Acetyl Octapeptide-3, Hesperidin Methyl Chalcone, Steareth-20, Dipeptide-2, Palmitoyl Tetrapeptide-7, Tribehenin, Ceramide NG, PEG-10 Rapeseed Sterol, Palmitoyl Hexapeptide-12, Palmitoyl Tetrapeptide-1, N-Hydroxysuccinimide, Chrysin, Olea Europaea (Olive) Fruit Oil, Plantago Lanceolata Leaf Extract, Hibiscus Rosa-Sinensis Leaf Extract, Cucumis Sativus (Cucumber) Fruit Extract, Oenothera Biennis (Evening Primrose) Oil, Aloe Barbadensis Leaf Juice Powder, Squalane, Cetearyl Alcohol, Polysorbate 60, Cetearyl Olivate, Sorbitan Olivate, Phyllantus Emblica Fruit Extract, Ribes Nigrum (Black Currant) Seed Oil, Simmondsia Chinensis (Jojoba) Seed Oil, C18-36 Acid Triglyceride, Gluconolactone, Sodium Benzoate, Retinol, Tocopheryl Acetate (D-Alpha), Prunus Amygdalus Dulcis (Sweet Almond) Oil, Allantoin, Lecithin, Daucus Carota Sativa (Carrot) Root Extract, Anthemis Nobilis Flower Extract, Althaea Ocinalis (Marshmallow) Root Extract, Xanthan Gum, Citrus Paradisi (White Grapefruit) Peel Oil, Rosmarinus Ocinalis (Rosemary) Leaf Oil, Benzyl Alcohol, Alcohol, Glycine Soja (Soybean) Oil$ra059$, $ra059$Gently massage 1 pump around eye area. May be applied AM or PM.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PEPTIDE_3-N-1_EYE_CREAM_15ml_fdf8b841-1ec1-43e4-865e-9d34e307970f.png', 6800, 'https://ramarketplace.com/store/559flawless/product/peptide-3-n-1-eye-cream', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PEPTIDE-BRIGHT-C', $ra059$Peptide Bright-C$ra059$, 'peptide-bright-c', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A potent blend of 20% vitamin C, combined with the collagen stimulating power of peptides, this is must have for sun induced pigmentation. Can be used on its own or cocktailed with Vita-Bright Elixir for the ultimate antioxidant, skin immunity boosting protection.$ra059$, $ra059$Hamamelis Virginiana (Witch Hazel) Water, Ascorbic Acid (L), Glycerin, Alcohol, Aqua (Water), Magnesium Ascorbyl Phosphate, Palmitoyl Tripeptide-5, Citrus Medica Limonum (Lemon) Peel Oil, Citrus Sinensis (Sweet Orange) Oil, Lecithin, Fructooligosaccharides (D-Beta), Xanthan Gum$ra059$, $ra059$Recommended for AM use. Apply 1-2 pumps to clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PEPTIDE_BRIGHT_C_15ml_9a02eb44-48a5-4682-b001-1352f4ca5ff0.png', 8000, 'https://ramarketplace.com/store/559flawless/product/peptide-bright-c', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PEPTIDE-POWER', $ra059$Peptide Power$ra059$, 'peptide-power', (select id from public.product_categories where slug = 'duos'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Harness the power of peptides for instant firming and wrinkle-reducing action. Stimulating collagen production and offering continued regeneration support, skin will immediately feel plump, buoyant, stronger and look years younger.

SYSTEM INCLUDES:
Antiox 18 Complex
Peptide 38$ra059$, null, $ra059$AM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Antiox 18 Complex and massage into skin. Finish with your favorite RA Hydrator and Sun Reflect product.

PM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Peptide 38 and massage into skin. Next, apply RA Corrective recommended by RA Professional. Finish with your favorite RA Hydrator.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PEPTIDE_POWER_DUO_2026-07-13-042830_wbht.png', 15300, 'https://ramarketplace.com/store/559flawless/product/peptide-power', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PERFECTION-CLAY', $ra059$Perfection Clay$ra059$, 'perfection-clay', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This treatment mask is a powerful spot treatment with added sulfur to draw out impurities and minimize cystic or congested breakouts.$ra059$, $ra059$Aqua (Water), Salicylic Acid, Glycerin, Bentonite, Kaolin, Sulfur, Alcohol Denat., Glyceryl Ricinoleate, Resorcinol, Cistus Ladaniferus (Labdanum) Resin, Stearic Acid, Glycol Distearate, Titanium Dioxide, Totarol, Melaleuca Alternifolia (Tea Tree) Leaf Oil, Calendula Officinalis Flower Extract, Chamomilla Recutita (Matricaria) Flower Extract, Disodium Laureth Sulfosuccinate, Hamamelis Virginiana (Witch Hazel) Water, Alcohol, Resveratrol Dimethyl Ether, Fragrance/Parfum (Natural)$ra059$, $ra059$Apply a thin layer to clean, dry skin or areas of concern to spot treat – avoid eye area. Leave on for 10-15 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow up with your favorite Acne Remedies serum and/or moisturizer. Use once per week only.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PERFECTION_CLAY_50ml_W.png', 1800, 'https://ramarketplace.com/store/559flawless/product/perfection-clay', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PUMPKIN-E-SERUM', $ra059$Pumpkin E Serum$ra059$, 'pumpkin-e-serum', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Revive tired, dull, dry, lifeless skin with this concentrated blend of vitamin E and pumpkin seed oil. Boost oxygenation and increase cell protection and antioxidant support to reveal healthy, radiant skin. This weekly serum takes pro-youth skin to a whole new level.

Decreases Wrinkling
Reduces Photo-Aging
Ultra Hydrating
Supports Healing

TIP: Mix with Vita Age Defy Cream and use on hands and feet$ra059$, $ra059$Cucurbita Pepo (Pumpkin) Seed Oil, Tocopheryl (D-alpha), Glutathione (L), Cananga Odorata (Ylang Ylang) Flower Oil, Lavandula Angustifolia (Lavender) Oil, Citrus Aurantium Bergamia (Bergamot) Fruit Oil, 1,2-Hexanediol, Caprylyl Glycol, Hamamelis Virginiana (Witch Hazel) Water, Jasminum Officinale (Jasmine) Oil, Citrus Grandis (Grapefruit) Peel Oil, Cinnamomum Camphora (Camphor) Bark Oil, Tropolone, Polygonum Cuspidatum (Giant Knotweed) Extract, Alcohol Denat.,$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb. Recommend using 1x per week. May layer moisturizer overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PUMPKIN_E_SERUM_30ml_T_2026-05-12-224528_gevc.png', 2350, 'https://ramarketplace.com/store/559flawless/product/pumpkin-e-serum', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PUMPKIN-POWER', $ra059$Pumpkin Power$ra059$, 'pumpkin-power', (select id from public.product_categories where slug = 'systems-collections'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Let the power of pumpkin work for you to plump away fine lines and hydrate for vibrant, younger-looking skin. Nature’s own “collagen therapy”, the valuable benefits of pumpkin are well known, providing a higher content of vitamin A and beta carotene, two powerhouse antioxidants that protect skin from sun-aging. With the added benefits of anti-glycation ingredients, powerful stem cells and age-defying peptides, skin will look brighter, firmer and more youthful.

SYSTEM INCLUDES:
Pumpkin Lactic Cleanse
Pumpkin Tonic
AGE less
Pumpkin E Serum
Elite Luxe Hydration$ra059$, null, $ra059$AM – Cleanse with Pumpkin Lactic Cleanse, remove with warm water and soft cloth, pat skin dry. Apply Pumpkin Tonic with a cotton round, let product absorb into skin. Apply 1-2 pumps AGE less, massage into skin. Finish with 1-2 pumps Elite Luxe Hydration.

PM - Cleanse with Pumpkin Lactic Cleanse, remove with warm water and soft cloth, pat skin dry. Apply RA Corrective recommended by RA Professional. Finish with 1-2 pumps Elite Luxe Hydration.

Weekly – Before applying Elite Luxe Hydration, apply 1-2 pumps of Pumpkin E Serum as part of a weekly treatment.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PUMPKIN_POWER_TVL5_2026-07-13-035258_ueob.png', 15400, 'https://ramarketplace.com/store/559flawless/product/pumpkin-power', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PUMPKIN-TONIC', $ra059$Pumpkin  Tonic$ra059$, 'pumpkin-tonic', (select id from public.product_categories where slug = 'toners'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Hydrate and nourish depleted, pro-youth skin. Pumpkin extract, L-ascorbic acid and beta carotene infuse skin with vitamins while hyaluronic acid, honey and humectants balance moisture, leaving skin plump and radiant!

Boosts protection from free radicals
Supports Lipid Barrier
Reduces Trans Epidermal Water Loss

Tip: During the fall season, create an entire pumpkin regimen for normal, depleted skin. Pumpkin Lactic Cleanse, Pumpkin E Serum$ra059$, $ra059$Aqua (Water), Cucurbita Pepo (Pumpkin), Alcohol Denat., Glycerin, Honey, Phospholipids, Sphingolipids, Sodium Hyaluronate (L), Ascorbic Acid (L), Beta- Carotene (D), Tsunga Canadensis (Hemlock) Oil, Cinnamomum Cassia Leaf Oil, Eugenia Caryophyllus (Clove) Leaf Oil, Zingiber Ocinale (Ginger) Root Oil$ra059$, $ra059$Shake well before using. Dispense 1 pump onto gauze or cotton pad and apply to clean, dry skin. Let absorb. Use daily or as directed by licensed professional.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PUMPKIN_TONIC_30ml_W.png', 1700, 'https://ramarketplace.com/store/559flawless/product/pumpkin-tonic', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PURE-GRAPE-SEED-ELIXIR', $ra059$Pure Grape Seed Elixir$ra059$, 'pure-grape-seed-elixir', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Grape seed extract is a potent organic oil loaded with benefits! From protecting healthy collagen and elastin, to reducing inflammation, this extract leaves skin feeling hydrated and nourished!

Improves Elasticity
Strengthen Skin
Promote Cell Renewal
Deep Hydration

TIP: Apply before Resveratrol B3 Gel$ra059$, $ra059$Vitis Vinifera (Grape) Seed Oil, Citrus Aurantium Dulcis (Orange) Oil, Tsunga Canadensis (Hemlock) Oil, Eugenia Caryophyllus (Clove) Leaf Oil, Cinnamomum (Cinnamon) Cassia Leaf Oil, Vitis Vinifera (Grape) Seed Extract$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PURE_GRAPE_SEED_ELIXIR_15ml_2026-05-12-224746_qank.png', 2300, 'https://ramarketplace.com/store/559flawless/product/pure-grape-seed-elixir', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PURIFY-POWER-ZYME', $ra059$Purify Power Zyme$ra059$, 'purify-power-zyme', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A powerful enzyme packed with pumpkin extracts designed to break down pustular blemishes, bring oxygen to the cells and soften texture. Ideal for extremely oily, pustular skin. Use as a weekly treatment.$ra059$, $ra059$Cucurbita Pepo (Pumpkin), Cucurbita Pepo (Pumpkin) Seed Oil, Lactobacillus/Pumpkin Fruit Ferment Filtrate, Fructooligosaccharides (D-Beta), Cinnamomum Cassia Leaf Oil, Eugenia Caryophyllus (Clove) Leaf Oil, Zingiber Officinale (Ginger) Root Oil, Aqua (Water), Glycerin, Hydroxypropyl Methylcellulose, Gluconic Acid (D)$ra059$, $ra059$Apply a thin layer to clean, dry skin; avoid eye area. Leave on for 5-10 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow with your favorite RA mask, serum(s) and/or moisturizer. Use once per week only. **Do not use with heated compress or steam**$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PURIFY_POWER_ZYME_50ml_W_2026-02-26-000139_dzbj.png', 2300, 'https://ramarketplace.com/store/559flawless/product/purify-power-zyme', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PURIFYING-GEL-CLEANSE', $ra059$Purifying Gel Cleanse$ra059$, 'purifying-gel-cleanse', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This daily, all-purpose foaming cleanser will purify breakout-prone skins, leaving it squeaky clean. Zeolite mineral traps and removes toxins while essential oils provide a refreshing citrus scent.$ra059$, $ra059$Aqua (Water), Decyl Glucoside, Sodium Lauroyl Lactylate, Cocamidopropyl Hydroxysultaine, Butyrospermum Parkii (Shea) Butter, Glycerin, Sodium Chloride, Zeolite, Menthol (L), Citrus Aurantium Dulcis (Orange) Oil, Citrus Medica Limonum (Lemon) Peel Oil, Citrus Grandis (Grapefruit) Peel Oil, Citrus Reticulata Leaf Oil, Cananga Odorata Flower Oil, Mentha Piperita (Peppermint) Oil, Benzyl Alcohol$ra059$, $ra059$Dispense 1 pump into dampened hands; add water for more lather. Massage into face and neck for several minutes. Remove with warm water and cloth. Pat skin dry.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PURIFYING_GEL_CLEANSE_30ml_W_2026-02-26-000208_gdgh.png', 1450, 'https://ramarketplace.com/store/559flawless/product/purifying-gel-cleanse', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-PURIFYING-PUMPKIN-FACIAL', $ra059$Purifying Pumpkin Facial$ra059$, 'purifying-pumpkin-facial', (select id from public.product_categories where slug = 'at-home-facials'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A potent enzyme that smells like pumpkin pie reduces cellular buildup and pustular blemishes. Next, skin is stimulated and oxygen increased through the use of wasabi root extract. Our nourishing antioxidant and skin-healing grape seed serum gives a clearer, radiant complexion.$ra059$, null, $ra059$STEP 1: CLEANSE

Cleanse skin with our purifying Purifying Gel Cleanse for a thorough, deep-pore cleanse. Dispense 1-2 pumps into dampened hands and massage into skin for several minutes (don’t rush this step). Remove with warm water and soft cloth then pat skin dry.

STEP 2: ENZYME

Packed with potent vitamins and redness-reducing support, apply a thin, even layer of our cell-digesting Purifying Power Zyme to clean, dry skin. Avoid eye area. Let remain on skin for 5 - 10 minutes. Rinse with tepid water and soft cloth or gauze then skin dry.

STEP 3: MASK

For powerful healing, antibacterial support, apply a thin, even layer of Wasabi Mask to clean, dry skin. Avoid eye area. Leave on for 5 – 10 minutes. Remove with tepid water and soft cloth or gauze. May cause a slight tingling sensation that subsides in a few minutes. If mask is too stimulating, buffer skin with several drops of Hydrating Relief Serum to skin prior to mask application.

STEP 4: HYDRATE & PROTECT

Finish with Hydrating Relief Serum for non-comedogenic, antioxidant support. Dispense 1-2 pumps onto fingertips and apply to clean, dry skin. Let absorb and remain on skin.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/PURIFYING_PUMPKIN_HF_2026-05-12-230309_ngjc.png', 6850, 'https://ramarketplace.com/store/559flawless/product/purifying-pumpkin-facial', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-RA-SQUARE-BRUSH', $ra059$RA Square Brush$ra059$, 'ra-square-brush', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     null, null, null,
     'https://ramarketplace.com/media/products/_mainPhoto/Brush3-Camera.png', 2000, 'https://ramarketplace.com/store/559flawless/product/ra-square-brush', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-RADIANT-BAMBOO-POLISH', $ra059$Radiant Bamboo Polish$ra059$, 'radiant-bamboo-polish', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Soften and refine the texture of skin, while brightening dull complexions. With a blend of natural exfoliants plus brightening agents, this cleanser has become a go-to in the Pro Youth Collection.

Smoothes Texture
Refines Fine Lines and Wrinkles
Leaves Skin with Luminous Glow

TIP: Mix with Gentle Peptide Cleanse to reduce exfoliation on more sensitive skin.$ra059$, $ra059$Aqua (Water), Bambusa Arundinacea (Bamboo) Stem Extract, Jojoba Esters (Beads), Glycerin, Caprylic/Capric Triglyceride, Stearic Acid, Sodium Ascorbyl Phosphate, Cetyl Alcohol, Bellis Perennis (Daisy) Flower Extract, Glycol Distearate, Cocamidopropyl Betaine, Sodium C14-16 Olefin Sulfonate, Disodium Laureth Sulfosuccinate, Acrylates Copolymer, Potassium Azeloyl Diglycinate, Cocamidopropyl Hydroxysultaine, Sodium Cocoamphoacetate, Sodium Lauryl Sulfoacetate, Leuconostoc/Radish Root Ferment Filtrate, Propanediol, Titanium Dioxide, Kojic Acid, Dipalmitate, Lonicera Japonica (Honeysuckle) Flower Extract, 1,2-Hexanediol, Caprylyl Glycol, Lonicera Caprifolium (Honeysuckle) Flower Extract, Sodium Gluconate, Succinoglycan, Aminobutyric Acid (GABA), Mentha Arvensis (Cornmint) Leaf Oil, Carbomer, Caprylhydroxamic Acid, Lavandula Angustifolia (Lavender) Oil, Citrus Aurantifolia (Lime) Oil, Hamamelis Virginiana (Witch Hazel) Water, Citrus Aurantium Bergamia (Bergamot) Fruit Oil, Citrus Aurantium Dulcis (Orange) Peel Oil, Citrus Limon (Lemon) Peel Oil, Lavandula Hybrida (Lavandin) Oil, Tropolone, Alcohol, Diglucosyl Gallic Acid, Allantoin, Calcium Pantothenate (D), Lysine HCI, Cysteine (L), Butyrospermum Parkii (Shea) Butter, Pogostemon Cablin (Patchouli) Oil, Citrus Reticulata (Tangerine) Leaf Oil, Cymbopogon Martini (Palmarosa) Oil, Cinnamomum Camphora (Camphor) Bark Oil, Sodium Hydroxide, Citric Acid, Xanthan Gum$ra059$, $ra059$Dispense small amount into damp hands; apply to face and neck. Gently massage into skin or allow to sit on skin for several minutes. Rinse thoroughly with warm water. Pat skin dry. Recommend using 1-2x a week.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/RADIANT_BAMBOO_POLISH_60ml_SQ.png', 3800, 'https://ramarketplace.com/store/559flawless/product/radiant-bamboo-polish', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-RADIANT-RENEWAL-SERUM', $ra059$Radiant Renewal Serum$ra059$, 'radiant-renewal-serum', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Fortified with tissue-rejuvenating properties, this hydrating, nutrient-rich serum restores collagen, reduces inflammation and inhibits the damaging elements and free radicals that lead to hyperpigmentation.$ra059$, $ra059$Glycerin, Aqua (Water), rh-Oligopeptide-1 (EGF), Glycyrrhiza Glabra (Licorice) Root Extract, Alcohol, Hamamelis Virginiana (Witch Hazel) Water, Fumaric Acid, Superoxide Dismutase, Citrus Aurantium Dulcis (Orange) Peel Oil, Benzyl Alcohol, Phospholipids$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. May apply your favorite RA moisturizer overtop. A warming sensation is normal.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/RADIANT_RENEWAL_SERUM_15ml.png', 4250, 'https://ramarketplace.com/store/559flawless/product/radiant-renewal-serum', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-RESVERATROL-B3-GEL', $ra059$Resveratrol B3 Gel$ra059$, 'resveratrol-b3-gel', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This cooling, lightweight, hydrating gel delivers key antioxidants while instantly firming and toning skin. All the benefits from grape extracts will leave skin glowing and radiant!


Cooling Sensation
Reduces Fine Lines
Boosts Circulation
Firming and Toning

TIP: Increase firming benefits by applying Peptide 38 or Antiox 18 Complex first.$ra059$, $ra059$Aqua (Water), Glycerin, Whey Protein, Cassia Angustifolia Seed Polysaccharide, Aloe Barbadensis Leaf Juice Powder, Squalane, Menthyl Lactate (L), Ruscus Aculeatus (Butcher’s Broom) Root Extract, Centella Asiatica (Gotu Kola) Extract, Panthenol (D), Calendula Officinalis Flower Extract, Hydrolyzed Yeast Protein, Aesculus Hippocastanum (Horse Chestnut) Bark Extract, Vitis Vinifera (Grape) Seed Oil, Citrus Grandis (Grapefruit) Peel Oil, Niacinamide, Bisabolol (L-Alpha), Allantoin, Wine Extract (Resveratrol), Glucuronolactone (D), Limonene, Beta Vulgaris (Beet) Root Extract, Mica, Benzyl Alcohol$ra059$, $ra059$Gently massage into clean, dry skin or layer over your favorite pro youth serum. Pairs well with Pure Grape Seed Elixir.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/RESVERATROL_B3_GEL_15ml_2026-05-12-224852_ylue.png', 2000, 'https://ramarketplace.com/store/559flawless/product/resveratrol-b3-gel', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-RESVERATROL-DEFENSE', $ra059$Resveratrol Defense$ra059$, 'resveratrol-defense', (select id from public.product_categories where slug = 'duos'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Protect skin from sun-induced hyperpigmentation and melasma. This powerful duo combines the firming, brightening action of resveratrol with potent antioxidant hydrators to defend skin from free radical damage while providing a fresh, iridescent glow.

System Includes:

Grape Seed Glow 30ml
Luminous Wine Gel 15ml$ra059$, null, $ra059$AM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Grape Seed Glow and massage into skin. Finish with Luminous Wine Gel and your favorite RA Sun Reflect product.

PM – After cleansing with RA Cleanser appropriate for your skin, apply RA Corrective recommended by RA Professional. Finish with Grape Seed Glow.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/RESVERATROL_DEFENSE_DUO.png', 5500, 'https://ramarketplace.com/store/559flawless/product/resveratrol-defense', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-RESVERATROL-GLOW', $ra059$Resveratrol Glow$ra059$, 'resveratrol-glow', (select id from public.product_categories where slug = 'systems-collections'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Looking for that pro-youth glow? Discover the benefits of resveratrol – a powerhouse antioxidant with age-reversal support and the ability to reduce inflammation. Slow down the skin-aging process with the added benefits of green tea, refined grape seed oil and multi-vitamin nourishment for toned, luminous, younger-looking skin.

System Includes:

Antioxidant Beta Cleanse 30ml
HA Hydra Spritz 30ml
Vita 10 Complex 10ml
Pure Grape Seed Elixir 15ml
Resveratrol B3 Gel 15ml$ra059$, null, $ra059$AM – Cleanse with Antioxidant Beta Cleanse, remove with warm water and soft cloth, pat skin dry. Spritz HA Hydra Mist and let absorb into skin. Apply 1-2 pumps Vita 10 Complex, massage into skin. Finish with 1-2 pumps Resveratrol B3 Gel. For more hydration, cocktail with 1 pump of Pure Grape Seed Elixir with Resveratrol B3 Gel.

PM - Cleanse with Antioxidant Beta Cleanse, remove with warm water and soft cloth, pat skin dry. Apply RA Corrective recommended by RA Professional. Finish with 1-2 pumps Pure Grape Seed Elixir.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/RESVERATROL_GLOW_TVL5_2026-07-13-035425_iokg.png', 9850, 'https://ramarketplace.com/store/559flawless/product/resveratrol-glow', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-RETINAL-CLEAR', $ra059$Retinal Clear$ra059$, 'retinal-clear', (select id from public.product_categories where slug = 'correctives'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A strengthening blend of vitamin A and stem cells to reduce inflammation and bacteria, promote healing and increase cell turnover. Powerful for sensitive acne skin.$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Alcohol Denat., Mandelic Acid (L), Alcohol, Cyclodextrin, Caprylic/Capric Triglyceride, Butylene Glycol, Sodium Hydroxide, Gluconolactone, Polyglyceryl-4 Caprate, Glucamine, Globularia Cordifolia Callus Culture Extract, Beta-Glucan (D,, Rubus Chamaemorus (Cloud Berry) Seed Oil, Trisodium Ethylenediamine Disuccinate, Retinal (Retinaldehyde), Pentylene Glycol, Caprylhydroxamic Acid, Santalum Austrocaledonicum (Sandalwood) Wood Oil, Syringa Vulgaris (Lilac) Leaf Cell Culture Extract, Withania Somnifera (Indian Ginseng) Root Extract, Mentha Piperita (Peppermint) Oil, Epilobium Angustifolium Flower/Leaf/Stem Extract, Teprenone, Rosmarinyl Glucoside, Gallyl Glucoside, Caffeyl Glucoside, Rosmarinus Officinalis (Rosemary) Leaf Extract, Mangostin, Hydroxyethylcellulose, Caprylyl Glycol, Lonicera Japonica (Honeysuckle) Flower Extract, Mirabilis Jalapa Flower/Leaf/Stem Extract, Glutamylamidoethyl Imidazole, Vanillin, Lonicera Caprifolium (Honeysuckle) Flower Extract, Citric Acid, Cinnamomum Camphora (Camphor) Bark Oil, Acetyl Tetrapeptide-40, Aloe Barbadensis Leaf Juice Powder, Camellia Sinensis (Green Tea) Leaf Extract, Boswellia Serrata Extract,) Benzyl Alcohol, Xanthan Gum, Maltodextrin, Propanediol, Sodium Benzoate$ra059$, $ra059$Dispense 1-2 pumps onto fingertips; massage into clean, dry skin every other night for the first week and then move into nightly use as skin allows.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/RETINAL_CLEAR_10ml_2026-02-26-000231_kbru.png', 4900, 'https://ramarketplace.com/store/559flawless/product/retinal-clear', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-RETINOL-SUPREME', $ra059$Retinol Supreme$ra059$, 'retinol-supreme', (select id from public.product_categories where slug = 'correctives'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A powerful blend of encapsulated retinol and lactic acid help breakdown rough, leathery, photo-aged skin. This blend will soften texture, reduce cellular buildup and give the dermal layer the nutrients it needs to stimulate collagen.

Alpha Hydroxy Acids
Reduces Cellular Buildup
Decreases Fine Lines
Softens Texture

Recommend using in conjunction with ChronoPeptide A or Stem Cell A as this product is not recommended more than 3 nights per week.$ra059$, $ra059$Hamamelis Virginiana (Witch Hazel) Water, Aqua (Water), Glycerin, Alcohol, Squalane, Lactic Acid (L), Retinol, Carnitine (L), Polysorbate 20, Algae Extract, Xanthan Gum$ra059$, $ra059$PM only. Apply to clean, dry skin 1-3x per week or as directed by licensed professional. May cause dryness and flaking. Layer serum or moisturizer overtop. Wear SPF for daytime protection.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/RETINOL_SUPREME_15ml_2026-05-12-225021_gbny.png', 6300, 'https://ramarketplace.com/store/559flawless/product/retinol-supreme', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-REVITALIZE-YOUR-EYES', $ra059$Revitalize Your Eyes$ra059$, 'revitalize-your-eyes', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Instantly firm, awaken and restore vitality to tired, crepey-looking eye tissue using powerful peptide complexes. With our enzymatic eye mask and tissue-plumping, antioxidant makeup remover, eyes will maintain that youthful, glowing look.

System Includes:
Eye Revitalizer
Eye Lift
Moisture Eye-Zyme
Makeup Remover$ra059$, null, null,
     'https://ramarketplace.com/media/products/_mainPhoto/REVITALIZE_YOUR_EYES_TVL4_99015b19-72a6-45ea-9a6c-34b4d0cdabc7.png', 16100, 'https://ramarketplace.com/store/559flawless/product/revitalize-your-eyes', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-RX-EYEFECT', $ra059$Rx EyeFect$ra059$, 'rx-eyefect', (select id from public.product_categories where slug = 'duos'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Incorporating an eye mask into your weekly skincare regimen can be the perfect prescription for a beautiful, younger-looking appearance. Our pomegranate/lactic eye mask gently rejuvenates eye tissue, softening texture, reducing puffiness and minimizing crepey tissue and crow’s feet. Partner with our “freezing” peptide to instantly soothe tired Line:Eyes and reduce the signs of aging for a luminous sparkle.

SYSTEM INCLUDES:
Eye Revitalizer
Moisture EyeZyme$ra059$, null, null,
     'https://ramarketplace.com/media/products/_mainPhoto/RX_EYEFECT_DUO.png', 7500, 'https://ramarketplace.com/store/559flawless/product/rx-eyefect', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-SALICYLIC-A-SERUM', $ra059$Salicylic &quot;A&quot; Serum$ra059$, 'salicylic-a-serum', (select id from public.product_categories where slug = 'correctives'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A potent dose of salicylic acid and vitamin A to relieve congested, impacted breakouts and promote vital skin strengthening and proper cell turnover.$ra059$, $ra059$Hamamelis Virginiana (Witch Hazel) Water, Alcohol Denat., Propanediol, Alcohol, Retinyl Propionate, Salicylic Acid, Carbomer, 1,2-Hexanediol, Caprylyl Glycol, Cyclodextrin, Polysorbate 20, Aqua (Water), Retinol, Tropolone, Citric Acid, Sodium Hydroxide, Xanthan Gum$ra059$, $ra059$Dispense 1-2 pumps onto fingertips; massage into clean, dry skin in the evening (2 times per week or as directed). Let serum absorb then apply moisturizer.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/SALICYLIC_A_SERUM_30ml_T_2026-02-26-000302_gqhm.png', 5600, 'https://ramarketplace.com/store/559flawless/product/salicylic-a-serum', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-SILKY-LAVENDER-CLEANSER', $ra059$Silky Lavender Cleanser$ra059$, 'silky-lavender-cleanser', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Remove heavy makeup and mascara. This oil-based gel, nutrient-rich cleanser provides soothing, hydrating, antioxidant support without depleting delicate eye tissue. May also be used as a moisturizing cleanser for the whole face.$ra059$, $ra059$Glycerin, Aqua (Water), Sodium Lauroyl Sarcosinate, Sucrose Laurate, Sucrose Myristate, Organic Grape Seed Oil, Lavender Essential Oil, Alcohol Denat., Caprylhydroxamic Acid, Benzyl Alcohol$ra059$, $ra059$Dispense 1 pump into dampened hands and massage into face and neck and over eyes and lashes for several minutes; add water for more lather. Remove with lukewarm water and cloth. Pat skin dry.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/SILKY_LAVENDER_CLEANSE_30ml_W.png', 1500, 'https://ramarketplace.com/store/559flawless/product/silky-lavender-cleanser', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-SKIN-BRIGHTENING-CLEANSE', $ra059$Skin Brightening Cleanse$ra059$, 'skin-brightening-cleanse', (select id from public.product_categories where slug = 'cleansers-scrubs'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This foaming, brightening cleanser is formulated with daisy flower extract, a natural, safe, powerful, plant-derived lightener. An antioxidant-packed cleanser that suppresses melanin production while providing a deep-pore cleanse.
Boosts Brightening Renews Radiance & Even Tone Deep Cleansing Action
TIP - Mix with a small amount of Skin Brightening Enzyme as a boost$ra059$, $ra059$Aqua (Water), Cocamidopropyl Betaine, Sodium C14-16 Olefin Sulfonate, Disodium Laureth Sulfosuccinate, Acrylates Copolymer, Bellis Perennis (Daisy) Flower Extract, Potassium Azeloyl Diglycinate, Cocamidopropyl Hydroxysultaine, Sodium Cocoamphoacetate, Sodium Lauryl Sulfoacetate, Leuconostoc/Radish Root Ferment Filtrate, Sodium Chloride, Sodium Hydroxide, Glycerin, Sodium Gluconate, Caprylhydroxamic Acid, Cinnamomum Camphora (Camphor) Bark Oil, Pogostemon Cablin (Patchouli) Oil, Kojic Acid, Aminobutyric Acid (GABA), Calcium Pantothenate (D), Lysine HCI, Cysteine (L), Citrus Aurantium Bergamia (Bergamot) Fruit Oil, Citrus Paradisi (White Grapefruit) Peel Oil, Citrus Limon (Lemon) Peel Oil, Citrus Aurantium Dulcis (Orange) Peel Oil*, Citric Acid, Butyrospermum Parkii (Shea) Butter, Propanediol, Benzyl Alcohol, Fragrance/Parfum+$ra059$, $ra059$Dispense 1 pump into dampened hands and massage into face and neck for several minutes; add water for more lather. Remove with warm water and cloth. Pat skin dry.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/SKIN_BRIGHTENING_CLEANSE_30ml_W.png', 1450, 'https://ramarketplace.com/store/559flawless/product/skin-brightening-cleanse', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-SKIN-BRIGHTENING-ENZYME', $ra059$Skin Repair Complex$ra059$, 'skin-brightening-enzyme', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A potent brightening agents combined with digestive enzymes will give skin a polished, glowing, more even complexion. Reduces inflammation and promotes exfoliation to deliver natural brightening support; an effective weekly treatment for melasma and age spots.
Suppresses Melanin Production Digests Unwanted Cellular Buildup Provides Radiant Tone & Smooth Texture
TIP: Cycle with Naturale Mega Brightening Serum to keep skin responding$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Alcohol Denat., Caprylic/Capric Triglyceride, Stearic Acid, Propanediol, Cetyl Alcohol, Zeolite, Salicylic Acid, Glycol Distearate, Alcohol, Titanium Dioxide, Gaultheria Procumbens (Wintergreen) Leaf Oil, Pepsin, Alpha-Arbutin, Kojic Acid, Leuconostoc/Radish Root Ferment Filtrate, Azelaic Acid, Menthyl Lactate (L), Allantoin, Tocopheryl Acetate (D-alpha), Carbomer, Papain, Sodium Hydroxide, Melia Azadirachta (Neem) Leaf Extract, Sodium Gluconate, Melia Azadirachta (Neem) Flower Extract, Daucus Carota Sativa (Carrot) Root Extract, Corallina Officinalis Extract, Coccinia Indica Fruit Extract, O-cymen-5-Ol, Decyl Glucoside, Aloe Barbadensis Flower Extract, Solanum Melongena (Eggplant) Fruit Extract, Cucumis Sativus (Cucumber) Fruit Extract, Ocimum Sanctum Leaf Extract, Ocimum Basilicum (Basil) Flower/Leaf Extract, Curcuma Longa (Turmeric) Root Extract, Passiflora Incarnata (Passionflower) Flower Extract, Tetrasodium EDTA, Lauryl Glucoside, Citric Acid, Dimethicone, Caprylyl Glycol, Xanthan Gum$ra059$, $ra059$Apply thin layer to clean, dry skin; avoid eye area. Leave on for 5-10 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow with your favorite RA mask, serums and moisturizer. Use once weekly.$ra059$,
     'https://ramarketplace.com/media/products/_listing/SKIN_REPAIR_COMPLEX_30ml_T_2026-02-26-000322_liiy.png', 4200, 'https://ramarketplace.com/store/559flawless/product/skin-brightening-enzyme', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-SKIN-RESTORE', $ra059$Skin Restore$ra059$, 'skin-restore', (select id from public.product_categories where slug = 'systems-collections'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Build your confidence and restore healthy-looking skin. Providing just the right balance of purifying, antiseptic support using salicylic acid, the rejuvenating benefits of mandelic acid and the healing, antioxidant protection of EGF and green tea, this daily maintenance system is perfect for keeping acne-prone skin clear and radiant.

System Includes:

Green Tea Beta Cleanse 120ml
Mandelic Clear Complex 30ml
Vita Relief Gel 30ml$ra059$, null, $ra059$AM – Cleanse with Green Tea Beta Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps Mandelic Clear Complex, massage into skin. Finish with 1-2 pumps Vital Repair Gel and eZinc.

PM - Cleanse with Green Tea Beta Cleanse, remove with warm water and soft cloth, pat skin dry. Apply 1-2 pumps Mandelic Clear Complex. Finish with 1-2 pumps Vital Repair Gel.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/SKIN_RESTORE_ESS.png', 16300, 'https://ramarketplace.com/store/559flawless/product/skin-restore', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-SKIN-SMOOTHING-GEL', $ra059$Skin Smoothing Gel$ra059$, 'skin-smoothing-gel', (select id from public.product_categories where slug = 'correctives'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Reduce the signs of aging. This active AHA blend interacts with the skin’s natural polymers, elastin and collagen to smooth fine lines and wrinkles and improve the overall texture of the skin.

Reduces rough skin texture
Increases exfoliation
Adresses Acne-Scarring

TIP: Mix into moisturizer to use more often$ra059$, $ra059$Hamamelis Virginiana (Witch Hazel) Water, Propanediol, Aqua (Water), Lactic Acid (L), Glycolic Acid, Alcohol, Sodium Hydroxide, Dimethyl Lauramide/Myristamide, Caprylyl Glycol, Hydroxypropyl Methylcellulose, Glycerin, Trisodium Ethylenediamine Disuccinate, Chondrus Crispus (Carrageenan) Extract, Hydrolyzed Soy Flour, Glucosamine HCl, Fructooligosaccharides (D-beta), Phenethyl Alcohol, Sodium Hyaluronate (L), Citric Acid$ra059$, $ra059$PM only. Apply to clean, dry skin 1-3x per week or as directed by licensed professional. May cause dryness and flaking. Layer serum or moisturizer overtop. Wear SPF for daytime protection.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/SKIN_SMOOTHING_GEL_15ml.png', 3200, 'https://ramarketplace.com/store/559flawless/product/skin-smoothing-gel', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-SPICED-PUMPKIN-CREAM', $ra059$Spiced Pumpkin Cream$ra059$, 'spiced-pumpkin-cream', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Skin experiences deep hydration from this nutrient-rich moisturizer loaded with botanical moisturizing ingredients and the powerful properties from pumpkin extracts. The aroma tantalizes the senses, and skin is left feeling nourished, protected, and hydrated.$ra059$, $ra059$Aqua (Water), Caprylic/Capric Triglyceride, Propanediol, Glycerin, Butyrospermum Parkii (Shea) Butter, Helianthus Annuus (Sunflower) Seed Wax, Coco-Caprylate/Caprate, Cetearyl Alcohol, Cetearyl Glucoside, Phytosteryl Macadamiate, Glyceryl Stearate, Dicaprylyl Ether, Cucurbita Pepo (Pumpkin) Powder, Glyceryl Stearate Citrate, Lactobacillus/Pumpkin Ferment Extract, Cucurbita Pepo (Pumpkin) Seed Oil, Lonicera Japonica (Honeysuckle) Flower Extract, Polyglyceryl-3 Stearate, Benzyl Alcohol, Hydrogenated Lecithin, Isomalt, Eugenia Caryophyllus (Clove) Leaf Oil, Lonicera Caprifolium (Honeysuckle) Flower Extract, Sodium Gluconate, Succinoglycan, Caprylhydroxamic Acid, Dipteryx Odorata Bean Extract, Myristica Fragrans (Nutmeg) Kernel Oil, Vanillin, Lactobacillus Ferment Lysate Filtrate, Canola Oil, Capsicum Annuum (Paprika) Extract, Zingiber Officinale (Ginger) Root Oil, Cinnamomum Cassia (Cinnamon) Leaf Oil, Saponaria Pumila Callus Culture Extract, Lecithin, Citrus Aurantium Dulcis (Orange) Peel Oil*, Xanthan Gum$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or over your favorite RA serum.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/SPICED_PUMPKIN_CREAM_15ml_2026-05-12-225249_xwxz.png', 3500, 'https://ramarketplace.com/store/559flawless/product/spiced-pumpkin-cream', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-STEM-BRIGHT-C', $ra059$Stem Bright-C$ra059$, 'stem-bright-c', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Formulated with potent plant-based stem cells and a stable form of 20% vitamin C, this formulation addresses skin immunity, repairs damage to skin cells, brightens complexion, and increases hydration in one, lightweight gel.$ra059$, $ra059$Aqua (Water), Glycerin, Sodium Hyaluronate (L), Leuconostoc/Radish Root Ferment Filtrate, Magnesium Ascorbyl Phosphate, Leontopodium Alpinum Meristem Cell Culture, Gardenia Jasminoides Callus Culture, Honey (Mel), Tocopheryl (D-Alpha), Phospholipids, Sphingolipids, Hyaluronic Acid, Xanthan Gum, Trisodium Ethylenediamine Disuccinate, Citric Acid, Sclerotium Gum, O-cymen-5-OL$ra059$, $ra059$AM use. Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/STEM_BRIGHT_C_15ml_2023-06-05-115757_ksau.png', 8350, 'https://ramarketplace.com/store/559flawless/product/stem-bright-c', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-STEM-CELL-A', $ra059$Stem Cell A$ra059$, 'stem-cell-a', (select id from public.product_categories where slug = 'correctives'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$An encapsulated vitamin A with reparative stem cells. Increases collagen and elastin, reduces wrinkles and firms to slow down skin aging. A lifestyle-friendly, must-have for pro-youth skin.

Reduces Fine Lines and Wrinkles
Strengthens SKin
Reduces Inflammation
Stem Cell therapy

Tip: Combine with Bio 53 Matrix$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Alcohol Denat., Mandelic Acid (L), Alcohol, Cyclodextrin, Caprylic/Capric Triglyceride, Butylene Glycol, Sodium Hydroxide, Gluconolactone, Polyglyceryl-4 Caprate, Glucamine, Globularia Cordifolia Callus Culture Extract, Beta-Glucan (D,, Rubus Chamaemorus (Cloud Berry) Seed Oil, Trisodium Ethylenediamine Disuccinate, Retinal (Retinaldehyde), Pentylene Glycol, Caprylhydroxamic Acid, Santalum Austrocaledonicum (Sandalwood) Wood Oil, Syringa Vulgaris (Lilac) Leaf Cell Culture Extract, Withania Somnifera (Indian Ginseng) Root Extract, Mentha Piperita (Peppermint) Oil, Epilobium Angustifolium Flower/Leaf/Stem Extract, Teprenone, Rosmarinyl Glucoside, Gallyl Glucoside, Caffeyl Glucoside, Rosmarinus Officinalis (Rosemary) Leaf Extract, Mangostin, Hydroxyethylcellulose, Caprylyl Glycol, Lonicera Japonica (Honeysuckle) Flower Extract, Mirabilis Jalapa Flower/Leaf/Stem Extract, Glutamylamidoethyl Imidazole, Vanillin, Lonicera Caprifolium (Honeysuckle) Flower Extract, Citric Acid, Cinnamomum Camphora (Camphor) Bark Oil, Acetyl Tetrapeptide-40, Aloe Barbadensis Leaf Juice Powder, Camellia Sinensis (Green Tea) Leaf Extract, Boswellia Serrata Extract,) Benzyl Alcohol, Xanthan Gum, Maltodextrin, Propanediol, Sodium Benzoate$ra059$, $ra059$PM only. Apply to clean, dry skin. For first-time vitamin A users, start 3x per week and increase as directed by licensed professional. May layer favorite RA serum or moisturizer overtop. Wear SPF for daytime protection.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/STEM_CELL_A_30ml_T_2026-05-12-225408_hjyd.png', 4900, 'https://ramarketplace.com/store/559flawless/product/stem-cell-a', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-SUN-INDUCED-ESSENTIALS', $ra059$Sun Induced Essentials$ra059$, 'sun-induced-essentials', (select id from public.product_categories where slug = 'systems-collections'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Maintain your skin’s natural glow with powerful brightening ingredients that illuminate and balance skin tone. Using the advanced cell regeneration power of EGF and powerful lighteners such as daisy flower extract, kojic acid and licorice root, this specialized system targets sun-induced hyperpigmentation for a more even skin tone and radiant complexion.

System Includes:

Skin Brightening Cleanse 120ml
Brightening Pigment Tonic 120ml
Radiant Renewal Serum 50ml$ra059$, null, $ra059$AM – Cleanse with Skin Brightening Cleanse, remove with warm water and soft cloth, pat skin dry. Apply Brightening Pigment Tonic with a cotton round, let product absorb into skin. Apply 1-2 pumps Radiant Renewal Serum, massage into skin. Finish with Daytime Defense.

PM - Cleanse with Skin Brightening Cleanse, remove with warm water and soft cloth, pat skin dry. Apply RA Corrective recommended by RA Professional. Finish with 1-2 pumps Radiant Renewal Serum.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/SUN_INDUCED_ESS.png', 18600, 'https://ramarketplace.com/store/559flawless/product/sun-induced-essentials', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-SUN-INDUCED-TRAVEL', $ra059$Sun Induced Travel$ra059$, 'sun-induced-travel', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Bring out your skin’s natural glow with powerful brighteners that illuminate and balance skin tone. Using advanced rejuvenators and powerful lightening ingredients such as daisy flower extract, kojic acid, licorice root and growth factors, this specialized system targets sun-induced hyperpigmentation for a more even skin tone and radiant complexion.

SYSTEM INCLUDES:
Skin Brightening Cleanse
Brightening Pigment Tonic
Naturalé Mega Brightening Serum
Radiant Renewal Serum$ra059$, null, $ra059$AM – Cleanse with Skin Brightening Cleanse, remove with warm water and soft cloth, pat skin dry. Apply Brightening Pigment Tonic with a cotton round, let product absorb into skin. Apply 1-2 pumps Grape Seed Glow, massage into skin. Finish with Daytime Defense.

PM - Cleanse with Skin Brightening Cleanse, remove with warm water and soft cloth, pat skin dry. Spot treat with Naturale Mega Brightening Serum over pigmented areas. Finish with 1-2 pumps Radiant Renewal Serum.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/SUN_INDUCED_TRAVEL_TVL5_030b6380-a73b-48ea-a0b1-96fae39df380_2023-06-05-131340_wicf.jpg', 12100, 'https://ramarketplace.com/store/559flawless/product/sun-induced-travel', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-TEEN-PREVENTION-COLLECTION', $ra059$Teen Prevention Collection$ra059$, 'teen-prevention-collection', (select id from public.product_categories where slug = 'systems-collections'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Taking care of the skin should be a no-brainer like brushing teeth – we know even this can be hard for some teens!! But truly, this can make all the difference for the skin's long-term health, preventing higher grades of acne and eliminating scarring in most cases.

Take advantage of the beautiful package and easy steps to get your mom clients to consider early skin care for their kids. Pre-teen can start as young as 10.

Collection Includes:
Purifying Gel Cleanse 30ml
Hyaluronic Tonic 30ml Mandelic Clear Complex 15ml Vita E Therapy 30ml$ra059$, $ra059$KEY INGREDIENTS

Zeolite – a natural mineral that detoxifies the skin by trapping impurities and bacteria, rinsing them away.

L-Mandelic Acid – a chirally-corrected acid that gently exfoliates, while introducing antibacterial support to the skin.

D-Alpha Tocopherol – the chirally-corrected form of this ingredient delivers more healing and antioxidant properties.

Hyaluronic Acid – provides excellent moisture-binding properties, balancing hydration in the skin$ra059$, null,
     'https://ramarketplace.com/media/products/_mainPhoto/Unknown.png', 11450, 'https://ramarketplace.com/store/559flawless/product/teen-prevention-collection', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-ULTRA-REPLENISH-CREAM', $ra059$Unveil Your Beauty$ra059$, 'ultra-replenish-cream', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$his velvety, whipped moisturizer is ideal for dry, depleted, pro youth skin using hyaluronic acid to hydrate, plump fine lines and enhance collagen synthesis. Skin will look radiant and dewy.
Rich in Humectants Replaces Vital Moisture Anti-Inflammatory Support
TIP: Apply over Hyaluronic Concentrate for fast results.$ra059$, $ra059$Aqua (Water), Caprylic/Capric Triglyceride, Coco-Caprylate/Caprate, Glycerin, Glyceryl Stearate, Cetearyl Alcohol, Cetearyl Glucoside, Glyceryl Stearate Citrate, Helianthus Annuus (Sunflower) Seed Wax, Polyglyceryl-3 Stearate, Dicaprylyl Ether, Caprylyl Glycol, Hydrogenated Lecithin, Lonicera Japonica (Honeysuckle) Flower Extract, Xanthan Gum, Lonicera Caprifolium (Honeysuckle) Flower Extract, Glucuronolactone (D), Succinoglycan, Sodium Gluconate, Citrus Aurantium Bergamia (Bergamot) Fruit Oil, Sodium Hyaluronate (L), Cassia Angustifolia Seed Polysaccharide, Fructooligosaccharides (D-beta), Pogostemon Cablin (Patchouli) Oil, Citrus Limon (Lemon) Peel Oil, Potassium Sorbate, Hamamelis Virginiana (Witch Hazel) Water, Cinnamomum Camphora (Camphor) Bark Oil, Canola Oil, Citric Acid, Capsicum Annuum (Paprika) Extract, Alcohol, Sodium Hydroxide, Phenethyl Alcohol, Fragrance/Parfum+$ra059$, $ra059$Dispense 1-2 pumps and gently massage into clean, dry skin or layer over your favorite pro youth serum. For a dewy complexion, apply HA Hydra Mist before cream.$ra059$,
     'https://ramarketplace.com/media/products/_listing/UNVEIL_YOUR_BEAUTY_TVL4_2023-06-07-105554_dopo.jpg', 24100, 'https://ramarketplace.com/store/559flawless/product/ultra-replenish-cream', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-VIBRANT-EYEZ', $ra059$Vibrant-EyeZ$ra059$, 'vibrant-eyez', null,
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Our potent blend of botanical extracts and peptides quickly improve dark circles and puffiness while increasing antioxidant protection, collagen and elastin synthesis.$ra059$, $ra059$Water, Aloe Barbadensis Leaf Juice, N-Hydroxysuccinimide, Chrysin, Zerumbone,
Palmitoyl Tripeptide-1, Palmitoyl Tetrapeptide-7, Hesperidin Methyl Chalcone, Dipeptide-2, Niacinamide,
Butylene Glycol, Acetyl Tetrapeptide-5, Alpha-Arbutin, Propanediol, Pentylene Glycol, Glycerin,
Steareth-20, Sodium Hyaluronate, Xanthan Gum, Caffeine, Sodium Benzoate, Potassium Sorbate$ra059$, $ra059$Add this serum under your current AM regimen. Layer under Peptide 3-n-1 Eye Cream or Eye Lift. For quicker results, use both AM and PM under your eye care product.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/VIBRANT_EYEZ_15ml.png', 4600, 'https://ramarketplace.com/store/559flawless/product/vibrant-eyez', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-VITA-10-COMPLEX', $ra059$Vita 10 Complex$ra059$, 'vita-10-complex', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Give skin a daily dose of vitamins. A multi-vitamin concentrate that nourishes and brightens while revitalizing and restoring skin cells.

Soothes and Hydrates
Essential Vitamins and Amino Acids
Increases Healthy Elastin
Strengthens Collagen

TIP: Pair with Antiox 18 Complex$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Alcohol, Polysorbate 80, Benzyl Alcohol, PEG/PPG-18/18 Dimethicone, Ascorbic Acid (L), Phytonadione (K1), Squalane, Propanediol, Xanthan Gum, Panthenol (D), Lonicera Japonica (Honeysuckle) Flower Extract, Fragrance/Parfum, Alcohol Denat., Ribes Nigrum (Black Currant) Seed Oil, Borago Officinalis Seed Oil*, Honey (Mel), Sodium Lactate, Phospholipids, Lonicera Caprifolium (Honeysuckle) Flower Extract, Sodium Gluconate, Tocopheryl Acetate (D-alpha), Sodium PCA, Caprylhydroxamic Acid, Cassia Angustifolia Seed Polysaccharide, Sorbitol, Citrus Reticulata (Tangerine) Peel Oil, Proline (L), Wine Extract, Citrus Limon (Lemon) Peel Oil, Sphingolipids, Aloe Barbadensis Leaf Juice Powder, Fructooligosaccharides (D-beta), Allantoin, Carnosine (L), Glucosamine HCl, Ursolic Acid, Crataegus Monogyna (Hawthorn Berry) Fruit, Peumus Boldus Leaf Extract, Citrus Grandis (Grapefruit) Peel Oil, Hyaluronic Acid, Gluconolactone, Yeast Extract, Pyridoxine HCl, Thiamine HCI, Oleanolic Acid, Salvia Officinalis (Sage) Leaf Extract, Citrus Aurantium Dulcis (Orange) Peel Oil, Quercetin, Sodium Benzoate, Superoxide Dismutase, Citric Acid, Potassium Sorbate, Selenium, Sodium Hydroxide$ra059$, $ra059$Recommended for AM use. Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/VITA_10_COMPLEX_10ml.png', 2400, 'https://ramarketplace.com/store/559flawless/product/vita-10-complex', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-VITA-AGE-DEFY-CREAM', $ra059$Vita Age Defy Cream$ra059$, 'vita-age-defy-cream', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$The best of both worlds. This rich, hydrating cream, blended with our age-defying epidermal growth factors, stimulates collagen and creates strong, healthy, new cells. Skin will feel nourished, hydrated and soothed.$ra059$, $ra059$Aqua (Water), Glycerin, Glyceryl Stearate, Cetyl Alcohol, Cetearyl Alcohol, rh-Oligopeptide-1 (EGF), Aloe Barbadensis Leaf Juice Powder, Linoleic Acid, Oleic Acid, Cucurbita Pepo (Pumpkin) Seed Oil, Olea Europaea (Olive) Fruit Oil, Tocopheryl Acetate (D-Alpha), Cassia Angustifolia Seed Polysaccharide, Retinol, Prunus Amygdalus Dulcis (Sweet Almond) Oil, Allantoin, Lecithin, Benzyl Alcohol, Prunus Speciosa (Cherry) Bark Extract, Glycine Soja (Soybean) Oil, Xanthan Gum, Sodium Chloride$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or layer over your favorite Pro Youth serum.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/VITA_AGE_DEFY_CREAM_50ml_T.png', 4550, 'https://ramarketplace.com/store/559flawless/product/vita-age-defy-cream', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-VITA-BRIGHT-ELIXIR', $ra059$Vita-Bright Elixir$ra059$, 'vita-bright-elixir', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Give your skin a daily dose of vitamins. A multi-vitamin concentrate for the skin that promotes nourishing and brightening benefits while providing revitalization and restoration of skin cells.$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Alcohol, Polysorbate 80, Benzyl Alcohol, PEG/PPG-18/18 Dimethicone, Ascorbic Acid (L), Phytonadione (K1), Squalane, Propanediol, Xanthan Gum, Panthenol (D), Lonicera Japonica (Honeysuckle) Flower Extract, Fragrance/Parfum, Alcohol Denat., Ribes Nigrum (Black Currant) Seed Oil, Borago Officinalis Seed Oil*, Honey (Mel), Sodium Lactate, Phospholipids, Lonicera Caprifolium (Honeysuckle) Flower Extract, Sodium Gluconate, Tocopheryl Acetate (D-alpha), Sodium PCA, Caprylhydroxamic Acid, Cassia Angustifolia Seed Polysaccharide, Sorbitol, Citrus Reticulata (Tangerine) Peel Oil, Proline (L), Wine Extract, Citrus Limon (Lemon) Peel Oil, Sphingolipids, Aloe Barbadensis Leaf Juice Powder, Fructooligosaccharides (D-beta), Allantoin, Carnosine (L), Glucosamine HCl, Ursolic Acid, Crataegus Monogyna (Hawthorn Berry) Fruit, Peumus Boldus Leaf Extract, Citrus Grandis (Grapefruit) Peel Oil, Hyaluronic Acid, Gluconolactone, Yeast Extract, Pyridoxine HCl, Thiamine HCI, Oleanolic Acid, Salvia Officinalis (Sage) Leaf Extract, Citrus Aurantium Dulcis (Orange) Peel Oil, Quercetin, Sodium Benzoate, Superoxide Dismutase, Citric Acid, Potassium Sorbate, Selenium, Sodium Hydroxide$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/Vita-Bright.png', 2600, 'https://ramarketplace.com/store/559flawless/product/vita-bright-elixir', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-VITA-E-THERAPY', $ra059$Vita E Therapy$ra059$, 'vita-e-therapy', (select id from public.product_categories where slug = 'building-strengthening'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This lightweight, easily-absorbed daily serum heals, soothes and repairs problematic skins while providing great antioxidant support.$ra059$, $ra059$Hamamelis Virginiana (Witch Hazel) Water, Aqua (Water), Glycerin, Tocopheryl (D-alpha), Alcohol, Leuconostoc/Radish Root Ferment Filtrate , Benzyl Alcohol, Caprylhydroxamic Acid, Sodium Chloride, Cassia Angustifolia Seed Polysaccharide, Glycine Soja (Soybean) Oil, Citric Acid, Sodium Hydroxide Xanthan Gum$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or into your favorite RA serum morning and/or night.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/VITA_E_THERAPY_10ml.png', 1500, 'https://ramarketplace.com/store/559flawless/product/vita-e-therapy', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-VITAL-ENERGY', $ra059$Vital Energy$ra059$, 'vital-energy', (select id from public.product_categories where slug = 'duos'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Is your skin in need of an energy boost? Renew cellular energy and boost collagen support while brightening skin tone and reducing fine lines with the power of mandelic acid. Together with the hydrating benefits from 7 essential nutrients, including omegas, vitamin E and avocado oi, skin will be left revitalized, restored and replenished.

SYSTEM INCLUDES:
Mandelic Rejuvenator
Infuse 7$ra059$, null, $ra059$AM – After cleansing with RA Cleanser appropriate for your skin, apply RA Building & Strengthening serum appropriate for your skin. Finish with a few drops of Infuse 7 or your favorite RA Hydrator and Sun Reflect product.

PM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Mandelic Rejuvenator and massage into skin. Finish with 1-2 pumps of Infuse 7.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/VITAL_ENERGY_DUO.png', 10500, 'https://ramarketplace.com/store/559flawless/product/vital-energy', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-VITAL-REPAIR-GEL', $ra059$Vital Repair Gel$ra059$, 'vital-repair-gel', (select id from public.product_categories where slug = 'moisturizers-hydrators'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$A strengthening, gel-based hydrator for oily, problematic skin that promotes proper wound healing with plant-derived epidermal growth factors.$ra059$, $ra059$Aqua (Water), Glycerin, Propanediol, Phospholipids, Fumaric Acid, rh-Oligopeptide-1 (EGF Carbomer, Leuconostoc/Radish Root Ferment Filtrate, Alcohol, Benzyl Alcohol, Glycyrrhiza Glabra (Licorice) Root Extract, Superoxide Dismutase, Sodium Hydroxide, Allantoin, Sodium Gluconate, Caprylhydroxamic Acid, Aloe Barbadensis Leaf Juice Powder, Hamamelis Virginiana (Witch Hazel) Water, Citric Acid, Xanthan Gum$ra059$, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or over your favorite RA serum morning and/or night. Let gel absorb.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/VITAL_REPAIR_GEL_10ml.png', 2250, 'https://ramarketplace.com/store/559flawless/product/vital-repair-gel', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-WASABI-MASK', $ra059$Wasabi Mask$ra059$, 'wasabi-mask', (select id from public.product_categories where slug = 'enzymes-masks'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$This weekly treatment mask will increase blood flow to oxygenate, decrease inflammation and reduce bacteria while promoting healing for sluggish, oily, acne skin.$ra059$, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Caprylic/Capric Triglyceride, Stearic Acid, Cetyl Alcohol, Titanium Dioxide, Wasabia Japonica (Wasabi) Root Extract, Glycol Distearate, Alcohol, Dimethicone, Camellia Sinensis (Green Tea) Leaf Extract, Allantoin, Tocopheryl Acetate (D-Alpha), Glycine Soja (Soybean) Oil, Xanthan Gum, Rosmarinus Officinalis (Rosemary) Leaf Oil, Tsunga Canadensis (Hemlock) Oil, Cinnamomum Cassia Leaf Oil, Benzyl Alcohol$ra059$, $ra059$Apply a thin layer to clean, dry skin; avoid eye area. Leave on for 5-10 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow with your favorite serum(s) and/or moisturizer. Use 1-2x per week.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/WASABI_MASK_50ml_W.png', 1500, 'https://ramarketplace.com/store/559flawless/product/wasabi-mask', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-WOUND-REPAIR', $ra059$Wound Repair$ra059$, 'wound-repair', (select id from public.product_categories where slug = 'duos'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Start the repair process and bring healing support to wounded acne skin. Decrease sensitivities, provide antibacterial support, strengthen skin and provide inflammation relief using ingredients such as white willow bark, totarol, L-arginine and mandelic acid for overall rejuvenation and clarifying skin transformation.

SYSTEM INCLUDES:
Mandelic Clear Complex
Skin Repair Complex$ra059$, null, $ra059$AM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Skin Repair Complex. Finish with your favorite Acne Remedies hydrator and Sun Reflect product.

PM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Mandelic Clear Complex. Finish with your favorite Acne Remedies hydrator.$ra059$,
     'https://ramarketplace.com/media/products/_mainPhoto/WOUND_REPAIR_DUO_cafc83e0-b84c-429d-b590-2e7b9f769aad_2023-06-06-151103_pcyn.jpg', 9700, 'https://ramarketplace.com/store/559flawless/product/wound-repair', true, false, true)
  on conflict (slug) do nothing;

  insert into public.products
    (sku, name, slug, category_id, brand_id, description, ingredients, how_to_use,
     image_url, price_cents, external_url, is_retail, is_professional, is_active)
  values
    ('RA-YOUTH-EYEFECT', $ra059$Youth EyeFect$ra059$, 'youth-eyefect', (select id from public.product_categories where slug = 'duos'),
     (select id from public.brands where slug = 'rhonda-allison'),
     $ra059$Refresh and revitalize tired-looking eyes for a youthful appearance. Eye tissue will feel immediately cooler, hydrated and tightened with a light iridescence. Combined with our moisture-binding wrinkle minimizer to prevent further aging. Eyes will soon have that youthful, dewy look.

SYSTEM INCLUDES:
Eye Revitalizer
Eye & Lip Renew Serum$ra059$, null, null,
     'https://ramarketplace.com/media/products/_mainPhoto/YOUTH_EYEFECT_DUO_2023-06-07-110355_ujsm.jpg', 15500, 'https://ramarketplace.com/store/559flawless/product/youth-eyefect', true, false, true)
  on conflict (slug) do nothing;

-- ── 2. Prices for the seeded catalogue (only where still zero) ──

  update public.products set price_cents = 1500
    where slug = '2x2-gauze-pads-200-count' and price_cents = 0;

  update public.products set price_cents = 2500
    where slug = '4x4-gauze-pads-200-count' and price_cents = 0;

  update public.products set price_cents = 4900
    where slug = 'a-renew' and price_cents = 0;

  update public.products set price_cents = 36000
    where slug = 'age-reversal-system-normal-to-dry-skin' and price_cents = 0;

  update public.products set price_cents = 28300
    where slug = 'age-reversal-system-sensitive-skin' and price_cents = 0;

  update public.products set price_cents = 3900
    where slug = 'ageless' and price_cents = 0;

  update public.products set price_cents = 3200
    where slug = 'aha-refine-gel' and price_cents = 0;

  update public.products set price_cents = 2000
    where slug = 'all-purpose-cleansing-pads' and price_cents = 0;

  update public.products set price_cents = 2000
    where slug = 'aloe-matte-moisture-cream' and price_cents = 0;

  update public.products set price_cents = 1500
    where slug = 'aloe-zyme' and price_cents = 0;

  update public.products set price_cents = 1600
    where slug = 'amino-peptide-hydration' and price_cents = 0;

  update public.products set price_cents = 3500
    where slug = 'amino-peptide-serum' and price_cents = 0;

  update public.products set price_cents = 2250
    where slug = 'antiox-18-complex' and price_cents = 0;

  update public.products set price_cents = 1800
    where slug = 'antiox-aha-tonic' and price_cents = 0;

  update public.products set price_cents = 1800
    where slug = 'antiox-defend-tonic' and price_cents = 0;

  update public.products set price_cents = 6500
    where slug = 'antioxidant-glow-facial' and price_cents = 0;

  update public.products set price_cents = 1900
    where slug = 'balancing-cocktail' and price_cents = 0;

  update public.products set price_cents = 1450
    where slug = 'beta-bright-cleanse' and price_cents = 0;

  update public.products set price_cents = 3050
    where slug = 'bha-refine-gel' and price_cents = 0;

  update public.products set price_cents = 2250
    where slug = 'blemish-serum' and price_cents = 0;

  update public.products set price_cents = 6700
    where slug = 'brighten-clear-facial' and price_cents = 0;

  update public.products set price_cents = 6800
    where slug = 'brightening-cream-enhanced' and price_cents = 0;

  update public.products set price_cents = 1700
    where slug = 'cherry-jubilee-enzyme' and price_cents = 0;

  update public.products set price_cents = 1750
    where slug = 'chocolate-antiox-mask' and price_cents = 0;

  update public.products set price_cents = 10000
    where slug = 'clear-bright-zyme' and price_cents = 0;

  update public.products set price_cents = 21000
    where slug = 'collagen-snap-back' and price_cents = 0;

  update public.products set price_cents = 9450
    where slug = 'daily-dose' and price_cents = 0;

  update public.products set price_cents = 3300
    where slug = 'daytime-defense' and price_cents = 0;

  update public.products set price_cents = 2000
    where slug = 'drop-of-essence' and price_cents = 0;

  update public.products set price_cents = 4000
    where slug = 'eliminate-hydrate' and price_cents = 0;

  update public.products set price_cents = 1600
    where slug = 'enzymatic-cleanse' and price_cents = 0;

  update public.products set price_cents = 3200
    where slug = 'ezinc-protection' and price_cents = 0;

  update public.products set price_cents = 3200
    where slug = 'ezinc-protection-spf-22' and price_cents = 0;

  update public.products set price_cents = 7250
    where slug = 'fade-glow' and price_cents = 0;

  update public.products set price_cents = 1450
    where slug = 'green-tea-beta-cleanse' and price_cents = 0;

  update public.products set price_cents = 3000
    where slug = 'hylamega-silk' and price_cents = 0;

  update public.products set price_cents = 1800
    where slug = 'kojic-clear-mask' and price_cents = 0;

  update public.products set price_cents = 1500
    where slug = 'luxe-cleansing-balm' and price_cents = 0;

  update public.products set price_cents = 4900
    where slug = 'peptide-38' and price_cents = 0;

  update public.products set price_cents = 4500
    where slug = 'peptide-mito-protect' and price_cents = 0;

  update public.products set price_cents = 6600
    where slug = 'pineapple-cleanse' and price_cents = 0;

  update public.products set price_cents = 5600
    where slug = 'pumpkin-lactic-cleanse' and price_cents = 0;

-- ── 3. Blanks on existing rows (only where NULL) ──

  update public.products set
    description = coalesce(description, null),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, null),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/Gauze_1-1_2026-04-20-152925_sqzt.jpg'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/2x2-gauze-pads-200-count')
    where slug = '2x2-gauze-pads-200-count';

  update public.products set
    description = coalesce(description, null),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, null),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/Gauze_1-1.jpg'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/4x4-gauze-pads-200-count')
    where slug = '4x4-gauze-pads-200-count';

  update public.products set
    description = coalesce(description, $ra059$A lifestyle-friendly, encapsulated vitamin A formulated with reparative stem cells to synthesize collagen and elastin production, reduce inflammation, increase cellular turnover and repair damaged cells. An effective rebuilding and strengthening serum for lightening and brightening the skin.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Alcohol Denat., Mandelic Acid (L), Alcohol, Cyclodextrin, Caprylic/Capric Triglyceride, Butylene Glycol, Sodium Hydroxide, Gluconolactone, Polyglyceryl-4 Caprate, Glucamine, Globularia Cordifolia Callus Culture Extract, Beta-Glucan (D,, Rubus Chamaemorus (Cloud Berry) Seed Oil, Trisodium Ethylenediamine Disuccinate, Retinal (Retinaldehyde), Pentylene Glycol, Caprylhydroxamic Acid, Santalum Austrocaledonicum (Sandalwood) Wood Oil, Syringa Vulgaris (Lilac) Leaf Cell Culture Extract, Withania Somnifera (Indian Ginseng) Root Extract, Mentha Piperita (Peppermint) Oil, Epilobium Angustifolium Flower/Leaf/Stem Extract, Teprenone, Rosmarinyl Glucoside, Gallyl Glucoside, Caffeyl Glucoside, Rosmarinus Officinalis (Rosemary) Leaf Extract, Mangostin, Hydroxyethylcellulose, Caprylyl Glycol, Lonicera Japonica (Honeysuckle) Flower Extract, Mirabilis Jalapa Flower/Leaf/Stem Extract, Glutamylamidoethyl Imidazole, Vanillin, Lonicera Caprifolium (Honeysuckle) Flower Extract, Citric Acid, Cinnamomum Camphora (Camphor) Bark Oil, Acetyl Tetrapeptide-40, Aloe Barbadensis Leaf Juice Powder, Camellia Sinensis (Green Tea) Leaf Extract, Boswellia Serrata Extract,) Benzyl Alcohol, Xanthan Gum, Maltodextrin, Propanediol, Sodium Benzoate$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin every other night or as directed by licensed professional. PM use only.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/A-Renew.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/a-renew')
    where slug = 'a-renew';

  update public.products set
    description = coalesce(description, $ra059$Reverse and slow the signs of skin aging with the quintessential in pro-youth skin care. RA Age Reversal System for Normal to Dry Skin contains the most cutting-edge, intelligent, result-focused skin care ingredients, such as peptides, stem cells, encapsulated vitamin A, anti-glycation complexes and holistic antioxidants to reduce inflammation and wrinkles, boost collagen synthesis and reverse cellular damage to transform your skin. Increase firmness and elasticity to reveal beautiful skin and a lasting youthful complexion while nourishing omegas and organic oils boost and lock in deep hydration - skin will be left glowing and radiant!

System Includes:

AGE less 30ml
Peptide 38 30ml
ChronoPeptide A 30ml
Infuse 7 15ml$ra059$),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, $ra059$AM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of AGE less and massage into skin. Finish with a few drops of Infuse 7 or your favorite RA Hydrator and Sun Reflect product.

PM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Peptide 38 and massage into skin. Next, apply 1-2 pumps of ChronoPeptide A and massage into skin. Finish with 1-2 pumps of Infuse 7.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/AGE_REVERSAL_TVL4.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/age-reversal-system-normal-to-dry-skin')
    where slug = 'age-reversal-system-normal-to-dry-skin';

  update public.products set
    description = coalesce(description, $ra059$Reverse and slow the signs of skin aging with the quintessential in pro-youth skin care. RA Age Reversal System for Sensitive Skin contains the most soothing, yet cutting-edge, intelligent, pro-youth skin care ingredients to get the results you’re looking for. Transform your skin using holistic antioxidants, strengthening botanicals, life-style friendly vitamin A, stem cells and biopeptides and reduce inflammation and fine lines, increase collagen production, boost cellular energy, tighten skin and increase firmness and elasticity. Nourish and calm sensitive skin with omegas and organic oils, locking in deep hydration, to give you a lasting youthful complexion.

System Includes:

Antiox 18 Complex 30ml
Mandelic Rejuvenator 30ml
Stem Cell A 30ml
Infuse 7 15ml$ra059$),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, $ra059$AM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Antiox 18 Complex and massage into skin. Finish with a few drops of Infuse 7 or your favorite RA Hydrator and Sun Reflect product.

PM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Mandelic Rejuvenator and massage into skin. Next, apply 1-2 pumps of Stem Cell A and massage into skin. Finish with 1-2 pumps of Infuse 7.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/AGE_REVERSAL_SENSITIVE_TVL4.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/age-reversal-system-sensitive-skin')
    where slug = 'age-reversal-system-sensitive-skin';

  update public.products set
    description = coalesce(description, $ra059$It's time to Age less! Our holistic blend of antioxidants reduces damage and inflammation caused from free radicals, while mimosa bark and plantain stem cells strengthen skin, replacing damaged collagen. This powerful serum addresses the negative effects of glycation and brightens skin tone for a vibrant and luminous look.

Anti-Glycation Powerhouse
Brighten Skin Tone
Soften Stiff Proteins
Boost Protection Against UV$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Alcohol, Albizia Julibrissin Bark Extract, Palmitoyl Tetrapeptide-7, Palmitoyl Tripeptide-1, Fructooligosaccharides (D-Beta), Glucosamine HCI (D), Plantago Lanceolata Leaf Extract, Saccharomyces/Xylinum/ Black Tea Ferment, Rosmarinyl Glucoside, Gallyl Glucoside, Caffeyl Glucoside, Ergothioneine (L), Magnolia Grandiflora Bark Extract, Chrysin, Hydroxyethylcellulose, N-Hydroxysuccinimide, Xanthan Gum, Caprylic/Capric Triglyceride, Caprylyl Glycol, Cetearyl Olivate, Steareth-20, Sorbitan Olivate, Alcohol Denat., Phenoxyethanol$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Recommended for AM use. Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/AGE_LESS_10ml.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/ageless')
    where slug = 'ageless';

  update public.products set
    description = coalesce(description, $ra059$A powerful AHA combination of Lactic & Glycolic Acid to enhance the break down of cellular build up for a softened and clear complexion.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Hamamelis Virginiana (Witch Hazel) Water, Propanediol, Aqua (Water), Lactic Acid (L), Glycolic Acid, Alcohol, Sodium Hydroxide, Dimethyl Lauramide/Myristamide, Caprylyl Glycol, Hydroxypropyl Methylcellulose, Glycerin, Trisodium Ethylenediamine Disuccinate, Chondrus Crispus (Carrageenan) Extract, Hydrolyzed Soy Flour, Glucosamine HCl, Fructooligosaccharides (D-beta), Phenethyl Alcohol, Sodium Hyaluronate (L), Citric Acid$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1-2 pumps onto fingertips; massage into clean, dry skin in the evening (2-3 times per week or as directed). Let serum absorb then apply moisturizer.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/AHA_REFINE_GEL_15ml.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/aha-refine-gel')
    where slug = 'aha-refine-gel';

  update public.products set
    description = coalesce(description, $ra059$A blend of salicylic acid and totarol help reduce bacteria, oils and residue from skin. Skin is left feeling refreshed and clean. Perfect to use after workouts or sporting practice.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Alcohol Denat., Alcohol, Salicylic Acid, Menthyl Lactate (L), Mentha Piperita (Peppermint) Oil, Eucalyptus Globulus Leaf Oil, Citrus Grandis (Grapefruit) Peel Oil, Epigallocatechin Gallate (EGCG), Totarol, Camellia Sinensis (Green Tea) Leaf Extract$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Remove one pad from container and smooth across face and neck with firm pressure. Leave solution on skin. For more sensitive skin, rinse pad with water and smooth across face and neck a second time to reduce excess solution. Let skin dry.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/AP_TONIC_PADS_30ct.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/all-purpose-cleansing-pads')
    where slug = 'all-purpose-cleansing-pads';

  update public.products set
    description = coalesce(description, $ra059$A lightweight daily hydrator with aloe and green tea that soothes and protects blemished skin, providing a healthy glow without an oily-looking complexion.

Provides Portent UV Protection Leaves a Mattified Finish Balances Oil with Natural Humectants
TIP: Use under mineral makeup to protect and balance oily skin.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Glycerin, Hamamelis Virginiana (Witch Hazel) Water, Carthamus Tinctorius (Safflower) Oleosomes, Alcohol, Potassium Azeloyl Diglycinate, Leuconostoc/Radish Root Ferment Filtrate, Carbomer, Phenyl t-Butylnitrone (Spin Trap), Sodium Hydroxide, Potassium Sorbate, Sodium Gluconate, Sodium Hyaluronate (L), Caprylhydroxamic Acid, Allantoin, Camellia Sinensis (Green Tea) Leaf Extract, Lavandula Angustifolia (Lavender) Oil, Rosa Damascena Flower Oil, Aloe Barbadensis Leaf Juice Powder, Cinnamomum Camphora (Camphor) Bark Oil, Cananga Odorata (Ylang Ylang) Flower Oil, Lonicera Japonica (Honeysuckle) Flower Extract, Melia Azadirachta (Neem) Leaf Extract, Melia Azadirachta (Neem) Flower Extract, Lonicera Caprifolium (Honeysuckle) Flower Extract, Corallina Officinalis Extract, Acetyl Tributyl Citrate, Bismuth Oxychloride, Amber Powder, Solanum Melongena (Eggplant) Fruit Extract, Coccinia Indica Fruit Extract, Ocimum Sanctum Leaf Extract, Curcuma Longa (Turmeric) Leaf Extract, Moringa Oleifera Seed Oil, Magnesium Stearate, Benzyl Alcohol, Xanthan Gum, Citrus Limon (Lemon) Peel Oil, Citric Acid, Mica, Iron Oxides, Fragrance/Parfum+$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or over your favorite RA serum morning and/or night.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/ALOE_MATTE_MOISTURE_CREAM_15ml.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/aloe-matte-moisture-cream')
    where slug = 'aloe-matte-moisture-cream';

  update public.products set
    description = coalesce(description, $ra059$A weekly exfoliation treatment with pineapple and papaya enzymes that gently dissolves cellular build up to reveal smooth, soft, glowing skin. Safe for the even the most sensitive, acne-prone skin.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aloe Barbadensis (Aloe Vera) Leaf Extract, Butylene Glycol, Carbomer, Hyaluronic Acid, Papain, Carica Papaya Extract, Symphytum Officinale (Comfrey) Extract, Echinacea Angustifolia Extract, Citrus Grandis (Grapefruit) Seed Extract, Citrus Medica Limonum (Lemon) Extract, Citrus Aurantium Dulcis (Orange) Extract, Ananas Sativus (Pineapple) Extract, Glycerin, Retinyl Palmitate, Tocopheryl Acetate, Ascorbic Acid (L), Cholecalciferol, Sodium PCA, Panthenol, Citrus Grandis (Grapefruit) Oil, Citrus Aurantium Dulcis (Orange) Oil, Sodium Hydroxide, Phenoxyethanol, Caprylyl Glycol, Sorbic Acid$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Apply thin layer to clean, dry skin. Gently massage until product liquefies and begins to ball up. Leave on for 5-10 minutes. Rinse with cool water and soft cloth. Pat skin dry and follow with your favorite acne remedies mask, serums and/or moisturizer.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/ALOE_ZYME_50ml_T.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/aloe-zyme')
    where slug = 'aloe-zyme';

  update public.products set
    description = coalesce(description, $ra059$A lightweight, collagen-boosting hydrator that uses peptides and advanced moisturizing complexes to maintain skin’s supple appearance and elasticity.

Assists in Age Prevention
Potent Peptide Blend
Increase in Collagen Synthesis
Boosts Hyaluronic Acid

TIP: Perfect age-prevention moisturizer when paired with Mandelic Rejuvenator$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aloe Barbadensis Leaf Extract, Glycerin, Caprylic/Capric Triglyceride, Cyclomethicone, Ethoxydiglycol, Cetearyl Alcohol, Stearic Acid, Sorbitol, Squalane, Cetyl Alcohol, Ceteareth 20, Butylene Glycol, Sodium Hyaluronate, Lactic Acid, Glycosaminoglycans, Palmitoyl Tripeptide-1, Palmitoyl Tetrapeptide-7, Biosaccharide Gum-1, Echinacea Angustifolia Extract, Camellia Sinensis (Green Tea) Leaf Extract, Vitis Vinifera (Grape) Seed Extract, Anthemis Nobilis (Chamomile) Flower Extract, Retinyl Palmitate, Tocopheryl Acetate, Ascorbic Acid, Cholecalciferol, Sodium PCA, Allantoin, Panthenol, Trehalose, Polysorbate 20, Polyquaternium-51, C12-15 Alkyl Benzoate, Dimethicone, Citrus Grandis (Grapefruit) Oil, Citrus Aurantium Bergamia (Bergamot) Fruit Oil, Urea, Carbomer, Phenoxyethanol, Caprylyl Glycol, Sorbic Acid, Sodium Hydroxide$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or layer over your favorite pro youth serum.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/AMINO_PEPTIDE_HYDRATION_15ml.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/amino-peptide-hydration')
    where slug = 'amino-peptide-hydration';

  update public.products set
    description = coalesce(description, $ra059$Stop fine lines before they start! A potent blend of peptides to increase elasticity and firmness, leaving skin smooth and hydrated.

Reduce Wrinkle Movement
Plump Skin
Repair Damage to UV Exposed Collagen

TIP: Pair with Amino Peptide Hydration$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aloe Barbadensis Leaf Extract, Acetyl Hexapeptide-8, Glycerin, Ethoxydiglycol, Palmitoyl Tripeptide-5, Glycereth 26, Sodium Hyaluronate, Silk Amino Acids, Hydrolyzed, Glycosaminoglycans, Hydrolyzed Wheat Protein, Hydrolyzed Elastin, Cucumis Sativus (Cucumber) Extract, Echinacea Angustifolia Extract, Rosmarinus Officinalis (Rosemary) Leaf Extract, Anthemis Nobilis (Chamomile) Flower Extract, Retinyl Palmitate, Tocopheryl Acetate, Ascorbic Acid, Cholecalciferol, Sodium PCA, Panthenol, Trehalose, Polyquaternium-51, Urea, Carbomer, Xanthan Gum, Polysorbate-20, Triethanolamine, Phenoxyethanol, Caprylyl Glycol, Sorbic Acid$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Recommended for PM use. Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/AMINO_PEPTIDE_SERUM_30ml_T_2026-05-06-212451_eoby.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/amino-peptide-serum')
    where slug = 'amino-peptide-serum';

  update public.products set
    description = coalesce(description, $ra059$One of our first antioxidant formulas, continues to be a Pro-Youth Essential. It contains a blend of 18 powerful antioxidants, including glutathione (L), resveratrol and green tea. Notice firming and toning action within the first 2 weeks using this hydrating, biopeptide formula!

Decrease Free Radicals
Reduce Oxidative Stress - such as toxic environments or UV Exposure
Increase in Firmness
Healthy Glow

TIP: Combine with C-Peptide Complex for additional antioxidant and collagen support$ra059$),
    ingredients = coalesce(ingredients, $ra059$Hamamelis Virginiana (Witch Hazel) Water, Aqua (Water), Propanediol, Alcohol, Glycerin, Tocopheryl (D-alpha), Glycine Soja (Soybean) Protein, Caprylyl Glycol, Lonicera Japonica (Honeysuckle) Flower Extract, Deuterium Oxide (Heavy Water), Citric Acid, 1,2-Hexanediol, Carnosine (L), Glucosamine HCl, Whey Protein, Tropolone, Glutathione (L), Superoxide Dismutase, Peumus Boldus Leaf Extract, Lonicera Caprifolium (Honeysuckle) Flower Extract, Sodium Gluconate, Camellia Sinensis (Green Tea) Leaf Extract, Vitis Vinifera (Grape) Seed Extract, Alcohol Denat., Cassia Angustifolia Seed Polysaccharide, Potassium Sorbate, Santalum Austrocaledonicum (Sandalwood) Wood Oil, Citrus Grandis (Grapefruit) Peel Oil, Wine Extract, Sodium Hydroxide, Xanthan Gum, Fullerenes$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Recommended for AM use. Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/ANTIOX_18_COMPLEX_10ml_2026-05-06-212523_qroz.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/antiox-18-complex')
    where slug = 'antiox-18-complex';

  update public.products set
    description = coalesce(description, $ra059$A treatment toner formulated with salicylic acid and resveratrol to balance, provide antiseptic benefits and fight free radical damage for aging skins prone to hormonal breakouts.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Butyrospermum Parkii (Shea) Butter, Glycerin, Resveratrol (Wine) Extract, Alcohol, Rubus Idaeus (Raspberry) Fruit Extract, Allantoin, Salicylic Acid, Citric Acid, Lactic Acid (L), Menthol (L), Glucuronolactone (D), Tartaric Acid (L), Malic Acid (L), Aloe Barbadensis Leaf Juice Powder, Benzyl Alcohol$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Shake well before using. Dispense 1 pump onto gauze or cotton pad and apply to clean, dry skin. Let product absorb. Use every other day or as directed by a licensed professional.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/ANTIOX_AHA_TONIC_30ml_W_2026-02-25-234859_avys.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/antiox-aha-tonic')
    where slug = 'antiox-aha-tonic';

  update public.products set
    description = coalesce(description, $ra059$Protect pro-youth skin against damaging effects of the environment, with a daily dose of powerful antioxidants. Super oxide dismutase and L-glutathione protect against free-radical damage while mandelic acid softens texture and stimulates collagen.

Reduces Oxidative Stress
Softens Texture
Stimulates Collagen Synthesis

TIP: Pair with Mandelic Rejuvenator to increase benefits$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Mandelic Acid (L), Uric Acid, Ascorbic Acid (L), Glutathione (L), Superoxide Dismutase, Alcohol, Tocopherol (D-Alpha), Helianthus Annuus (Sunflower) Seed Oil, Glycerin, Pelargonium Graveolens (Geranium) Flower Oil, Citrus Grandis (Grapefruit) Peel Oil, Melissa Ocinalis Extract, Sodium Hydroxide$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1 pump onto gauze or cotton pad and apply to clean, dry skin. Let absorb. Use daily or as directed by licensed professional.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/ANTIOX_DEFEND_TONIC_30ml_W.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/antiox-defend-tonic')
    where slug = 'antiox-defend-tonic';

  update public.products set
    description = coalesce(description, $ra059$Let the aroma of cherries and chocolate help you relax and unwind with our Antioxidant Glow Facial At-Home Facial Collection. Soften skin and infuse with vital antioxidants and nutrients, revealing a hydrating glow!$ra059$),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, $ra059$STEP 1: CLEANSE

Cleanse skin with the all-natural, probiotic essence of Gentle Peptide Cleanse for a thorough, deep-pore cleanse. Dispense 1-2 pumps into dampened hands and massage into skin for several minutes (don’t rush this step). Remove with warm water and soft cloth then pat skin dry.



STEP 2: ENZYME

For a strengthening, antioxidant polish and great pro-youth results, apply a thin, even layer of Cherry Jubilee Enzyme to dry face. Avoid eye area. Massage in gently and let remain on skin for 5-10 minutes. Rinse with warm water and soft cloth or gauze then pat skin dry. May create a tingling sensation on skin which is normal.

STEP 3: MASK

Apply a thin, even layer of our replenishing, pro-youth Chocolate Antiox Mask to dry face and neck. Avoid eye area. Let remain on skin for 10-15 minutes. Remove with tepid water and soft cloth or gauze then pat skin dry. Mask may create a stimulating sensation which is normal. For additional antioxidant benefits, apply a few drops of Pure Grape Seed Elixir to skin prior to mask application.

STEP 4: HYDRATE & PROTECT

Finish with Pure Grape Seed Elixir for deep hydration and antioxidant support. Dispense 1-2 pumps onto fingertips and apply to clean, dry skin. Let absorb and remain on skin.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/ANTIOXIDANT_GLOW_HF.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/antioxidant-glow-facial')
    where slug = 'antioxidant-glow-facial';

  update public.products set
    description = coalesce(description, $ra059$A refined blend of grape seed oil combined with wild yam to provide light hydration and reduce inflammation for hormonally challenged skins.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Vitis Vinifera (Grape) Seed Oil, Alcohol Denat., Dioscorea Villosa (Wild Yam) Root Extract, Phytonadione (K1), 1,2-Hexanediol, Caprylyl Glycol, Cupressus Sempervirens (Cypress) Leaf/Nut/Stem Oil, Mentha Piperita (Peppermint) Oil, Salvia Sclarea (Clary) Oil, Propanediol, Santalum Austrocaledonicum (Sandalwood) Wood Oil, Glycerin, Tropolone,$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin morning and/or night. Let serum absorb.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/BALANCING_COCKTAIL_10ml.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/balancing-cocktail')
    where slug = 'balancing-cocktail';

  update public.products set
    description = coalesce(description, $ra059$This anti-inflammatory cleanser provides antioxidants, antibacterial and calming support. Salicylic acid and the heart of green tea softens, protects and provides healing to the skin. Excellent for pigmentation caused by injuries/wounds.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Cocamidopropyl Betaine, Sodium C14-16 Olefin Sulfonate, Disodium Laureth Sulfosuccinate, Salicylic Acid, Mandelic Acid (L), Glycerin, Sodium Lauryl Sulfoacetate, Sodium Cocoamphoacetate, Coco-Glucoside, Leuconostoc/Radish Root Ferment Filtrate, Cocamidopropyl Hydroxysultaine, Sodium Hydroxide, Sodium Gluconate, Caprylhydroxamic Acid, Camellia Sinensis (Green Tea) Leaf Extract, Melia Azadirachta (Neem) Leaf Extract, Melia Azadirachta (Neem) Flower Extract, Corallina Officinalis Extract, Coccinia Indica Fruit Extract, Solanum Melongena (Eggplant) Fruit Extract, Amber Powder, Ocimum Sanctum Leaf Extract, Curcuma Longa (Turmeric) Leaf Extract, Moringa Oleifera Seed Oil, Epigallocatechin Gallate, Propanediol, Citric Acid, Glycol Distearate, Benzyl Alcohol, Alcohol Denat., Fragrance/Parfum (natural)$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Shake well prior to dispensing. Dispense 1 pump into dampened hands; add water for more lather. Massage into face and neck for several minutes. Remove with warm water and cloth. Pat skin dry.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/BETA_BRIGHT_CLEANSE_30ml_W.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/beta-bright-cleanse')
    where slug = 'beta-bright-cleanse';

  update public.products set
    description = coalesce(description, $ra059$A Salicylic Acid/BHA-Alternative, to Glycolic. This powerful corrective reduces cellular buildup, smoothes texture, fights bacteria and inflammation. An active step-up from Blemish Serum for thicker, oily, congested skin.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Alco- hol Denat., Glycerin, Azelaic Acid, Lactic Acid (L), Salicylic Acid, Alcohol, Hydroxypropyl Methylcellulose, Lavandula Angustifolia (Lavender) Oil, Citrus Grandis (Grapefruit) Peel Oil, Mentha Viridis (Spearmint) Leaf Oil, Chondrus Crispus (Carrageenan), Sorbitol, Mannitol, Hydrolyzed Actin, Glucosamine HCl, Sodium Glucuronate, Calcium Gluconate$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1-2 pumps onto fingertips; massage into clean, dry skin in the evening (2-3 times per week or as directed); then apply moisturizer. May spot treat blemishes.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/BHA_REFINE_GEL_15ml.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/bha-refine-gel')
    where slug = 'bha-refine-gel';

  update public.products set
    description = coalesce(description, $ra059$A daily serum with a blend of salicylic acid, totarol and heart of green tea to relieve and reduce blemishes on any skin. Excellent for spot treatment.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Alcohol Denat., Hamamelis Virginiana (Witch Hazel) Water, Propanediol, Alcohol, Salicylic Acid, Aqua (Water), Fomes Officinalis (Mushroom) Extract, Resorcinol, Hydroxypropyl Methylcellulose, Butylene Glycol, 1,2-Hexanediol, Caprylyl Glycol, Eucalyptus Globulus Leaf Oil, Pyridoxine HCl, Citrus Aurantifolia (Lime) Oil, Citrus Limon (Lemon) Peel Oil, Niacinamide, Glycerin, Panthenol (D), Camellia Sinensis (Green Tea) Leaf Extract, Hydrolyzed Yeast Protein, Tropolone, Threonine, Totarol, Biotin, Epigallocatechin Gallate, Citric Acid, Sodium Hydroxide, Allantoin, Melaleuca Alternifolia (Tea Tree) Leaf Oil$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1-2 pumps onto fingertips; massage into clean, dry skin morning and/or evening. May use to spot treat blemishes. Layer moisturizer or SPF overtop.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/BLEMISH_SERUM_15ml.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/blemish-serum')
    where slug = 'blemish-serum';

  update public.products set
    description = coalesce(description, $ra059$Powerful lightening agents combined with digestive enzymes leave skin soft and brighter. Wasabi and green tea extracts combined with a replenishing grape seed serum heals acne blemishes.$ra059$),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, $ra059$STEP 1: CLEANSE

Cleanse skin with our salicylic Green Tea Beta Cleanse for a boost of antibacterial support and a thorough cleanse. Dispense 1-2 pumps into dampened hands and massage into skin for several minutes (don’t rush this step). Remove with warm water and soft cloth then pat skin dry.

STEP 2: ENZYME

Deliver natural anti-redness support with Clear Bright Zyme. Apply a thin, even layer to clean, dry skin. Avoid eye area. Leave on for 5-10 minutes. Rinse thoroughly with cool water and soft cloth or gauze then pat skin dry.

STEP 3: MASK

For powerful healing, antibacterial support, apply a thin, even layer of Wasabi Mask to clean, dry skin. Avoid eye area. Leave on for 5 – 10 minutes. Remove with tepid water and soft cloth or gauze. May cause a slight tingling sensation that subsides in a few minutes. If mask is too stimulating, buffer skin with several drops of Hydrating Relief Serum to skin prior to mask application.

STEP 4: HYDRATE & PROTECT

Finish with Hydrating Relief Serum for non-comedogenic, antioxidant support. Dispense 1-2 pumps onto fingertips and apply to clean, dry skin. Let absorb and remain on skin.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/BRIGHTEN_CLEAR_HF.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/brighten-clear-facial')
    where slug = 'brighten-clear-facial';

  update public.products set
    description = coalesce(description, $ra059$A synergistic blend of natural brightening ingredients to support all forms of pigmentation, including age spots and melasma.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Caprylic/Capric Triglyceride, Glycerin, Isopropyl Myristate, Kojic Dipalmitate, Alcohol, Alcohol Denat., Bellis Perennis (Daisy) Flower Extract, Octadecenedioic Acid, Ethoxydiglycol, Glycol Distearate, Stearic Acid, Cetyl Alcohol, Alpha-Arbutin, Kojic Acid, Lactic Acid (L), Sodium Ascorbyl Phosphate, Hydroxycinnamic Acid, Porphyra Umbilicalis (Red Algae) Extract, Aminobutyric Acid (GABA), Diacetyl-Boldine, Sodium Lactate, Lecithin, Glyceryl Stearate, Xanthan Gum, Cetearyl Alcohol, Olea Europaea (Olive) Fruit Oil, Polysorbate 60, Prunus Amygdalus Dulcis (Sweet Almond) Oil, Tocopheryl Acetate (D-Alpha), Caprylyl Glycol, Sodium Hydroxymethylglycinate, Allantoin, Retinyl Palmitate, Helianthus Annuus (Sunflower) Seed Oil, Althaea Officinalis (Marshmallow) Root Extract, Jasminum Officinale (Jasmine) Oil, Glycine Soja (Soybean) Oil, Aloe Barbadensis Leaf Juice Powder, Chamomilla Recutita (Matricaria) Flower Extract, Daucus Carota Sativa (Carrot) Root Extract, Citrus Aurantium Dulcis (Orange) Oil, Lavandula Angustifolia (Lavender) Oil, Cananga Odorata (Ylang Ylang) Flower Oil, Pogostemon Cablin (Patchouli) Oil, Geranium Maculatum Oil, Potassium Sorbate, Phenoxyethanol$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin or over your favorite RA serum. After product fully absorbs, apply Daytime Defense for sun protection.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/BRIGHTENING_CREAM_ENHANCED_50ml_T_982803ff-6ec4-427d-b2d8-da44b788651d.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/brightening-cream-enhanced')
    where slug = 'brightening-cream-enhanced';

  update public.products set
    description = coalesce(description, $ra059$The tantalizing aroma of wild cherries begins your spa-at-home experience. This potent enzyme contains malic and tartaric acids to firm, tone and refine pro youth skin, leaving it soft, supple, glowing and radiant.

Potent Antioxidant Protection
Firming and Toning
Excellent between visits

TIP: Create a custom home care spa treatment by mixing with Grape Seed Antiox Mask$ra059$),
    ingredients = coalesce(ingredients, $ra059$Prunus Avium (Sweet Cherry) Seed Oil, Glycerin, Lactic Acid (L), Aqua (Water), Tartaric Acid (L), Malic Acid (L), Salicylic Acid, Bromelain, Prunica Granatum (Pomegranate) Extract, Mandelic Acid (L), Wine Extract (Resveratrol), Prunus Serotina (Wild Cherry) Bark Extract, Vitis Vinifera (Grape) Seed Extract, Lycopene, Xanthan Gum, Benzyl Alcohol$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Apply thin layer to clean, dry skin – avoid eye area. Leave on for 5-10 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow with your favorite RA mask, serums and/or moisturizer. Use once per week.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/CHERRY_JUBILEE_ENZYME_15ml_P.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/cherry-jubilee-enzyme')
    where slug = 'cherry-jubilee-enzyme';

  update public.products set
    description = coalesce(description, $ra059$A therapeutic mask delivering potent antioxidants from cocoa extract, cranberry and camu camu. This decadent, tingling experience will leave skin revitalized and replenished.

Protects Against Cell Damage
Detoxifies Skin
Brightens Complexion

TIP: Apply Pure Grape Seed Elixir before mask to reduce stimulating sensations and boost hydration$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Glycerin, Caprylic/Capric Triglyceride, Stearic Acid, Glyceryl Stearate, Cetyl Alcohol, Caramel, Gluconolactone, Rubus Chamaemorus (Cloud Berry) Seed Oil, Sodium Benzoate, Cetearyl Alcohol, Polysorbate 60, Theobroma Cacao (Cocoa) Extract, Oxycoccus Palustris (Arctic Cranberry) Seed Oil, Glycol Distearate, Olea Europaea (Olive) Fruit Oil, Prunus Amygdalus Dulcis (Sweet Almond) Oil, Xanthan Gum, Caprylyl Glycol, Phenoxyethanol, Glycine Soja (Soybean) Oil, Tocopheryl Acetate (D-Alpha), Dimethicone, Hamamelis Virginiana (Witch Hazel) Water, Allantoin, Retinyl Palmitate, Helianthus Annuus (Sunflower) Seed Oil, Carbomer, Citrus Aurantium Dulcis (Orange) Peel Oil, Althaea Officinalis (Marshmallow) Root Extract, Vanilla Planifolia Fruit Oil, Trisodium Ethylenediamine Disuccinate, Potassium Sorbate, Euterpe Oleracea (Acai) Fruit Extract, Aloe Barbadensis Leaf Juice Powder, Myrciaria Dubia (Camu Camu) Fruit Extract, Alcohol, Anthemis Nobilis (Chamomile) Flower Extract, Passiflora Incarnata (Passionflower) Flower Extract, Daucus Carota Sativa (Carrot) Seed Extract, Titanium Dioxide$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Apply thin layer to clean, dry skin – avoid eye area. Leave on for 5-10 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow up with your favorite pro youth serums and moisturizer. Use once per week.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/CHOCOLATE_ANTIOX_MASK_15ml_P_2026-05-06-213641_lxwp.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/chocolate-antiox-mask')
    where slug = 'chocolate-antiox-mask';

  update public.products set
    description = coalesce(description, $ra059$s weekly enzyme utilizes the power of papaya to reduce cellular buildup, along with salicylic acid for antibacterial support.
Azelaic Acid lessens pigmentation Softens Texture & Evens Skin Tone Decreases Bacteria & Inflammation Reduces Cellular Buildup
TIP: For dry acne skin, combine with Cooling Relief Mask for additional hydration.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Alcohol Denat., Caprylic/Capric Triglyceride, Stearic Acid, Propanediol, Cetyl Alcohol, Zeolite, Salicylic Acid, Glycol Distearate, Alcohol, Titanium Dioxide, Gaultheria Procumbens (Wintergreen) Leaf Oil, Pepsin, Alpha-Arbutin, Kojic Acid, Leuconostoc/Radish Root Ferment Filtrate, Azelaic Acid, Menthyl Lactate (L), Allantoin, Tocopheryl Acetate (D-alpha), Carbomer, Papain, Sodium Hydroxide, Melia Azadirachta (Neem) Leaf Extract, Sodium Gluconate, Melia Azadirachta (Neem) Flower Extract, Daucus Carota Sativa (Carrot) Root Extract, Corallina Officinalis Extract, Coccinia Indica Fruit Extract, O-cymen-5-Ol, Decyl Glucoside, Aloe Barbadensis Flower Extract, Solanum Melongena (Eggplant) Fruit Extract, Cucumis Sativus (Cucumber) Fruit Extract, Ocimum Sanctum Leaf Extract, Ocimum Basilicum (Basil) Flower/Leaf Extract, Curcuma Longa (Turmeric) Root Extract, Passiflora Incarnata (Passionflower) Flower Extract, Tetrasodium EDTA, Lauryl Glucoside, Citric Acid, Dimethicone, Caprylyl Glycol, Xanthan Gum$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Apply a thin layer to clean, dry skin; avoid eye area. Leave on for 5-10 minutes. Rinse well with cool water and soft cloth. Pat skin dry and follow with your favorite RA mask, serum(s) and/or moisturizer. Use once per week.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_listing/CLEAR_RELIEF_TVL5_a5ce6566-f919-489b-be6c-1d33259a386b.jpg'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/clear-bright-zyme')
    where slug = 'clear-bright-zyme';

  update public.products set
    description = coalesce(description, $ra059$Snap back youthful skin by capturing the power of vitamins C and A along with pro-youth peptides for 24-hour collagen support. Using the 20% C-power of L-ascorbic acid for AM strengthening and reconstructing retinal for PM rejuvenation, minimize wrinkles and fine lines, plump and firm, increase hydration and brighten skin tone for younger, healthier-looking skin.

SYSTEM INCLUDES:
C-Peptide Complex
ChronoPeptide A$ra059$),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, $ra059$AM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of C-Peptide Complex and massage into skin. Finish with your favorite RA Hydrator and Sun Reflect product.

PM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of ChronoPeptide A and massage into skin. Finish with Bio 53 Matrix or your favorite RA Hydrator.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/COLLAGEN_SNAP_BACK_DUO.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/collagen-snap-back')
    where slug = 'collagen-snap-back';

  update public.products set
    description = coalesce(description, $ra059$Strengthen, renew and return skin’s youthful complexion with a daily dose of vitamins to nourish and brighten dull, depleted skin. With the added benefits of growth factor to rejuvenate strong, healthy cells, skin will look vibrant, revitalized and years younger.

System Includes:

Bio 53 Matrix 15ml
Vita 10 Complex 30ml$ra059$),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, null),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/DAILY_DOSE_DUO.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/daily-dose')
    where slug = 'daily-dose';

  update public.products set
    description = coalesce(description, $ra059$This water-resistant, ultra-clean outdoor topical, with a natural sun protection factor equivalent to an SPF 30, is safe for all skin types, including babies. Daytime Defense provides a natural sun barrier using zinc oxide, shielding skin from harmful UVA and UVB rays. Botanical extracts boost antioxidant protection and antimicrobial support while delivering soothing, healing benefits and reducing epidermal water loss and inflammation.$ra059$),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, null),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/DAYTIME_DEFENSE_120ml.jpg'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/daytime-defense')
    where slug = 'daytime-defense';

  update public.products set
    description = coalesce(description, $ra059$Let the age-defying, healing benefits of omegas nourish and hydrate pro youth skin. This blend of essential fatty acids, vitamin E, lavender and geranium will slow down the aging process, reduce inflammation and leave skin glowing and soft.

Increases Penetration of Active Compounds
Essential for Aging Skin
Must Have for Evening Regimens

TIP: Apply of serums to increase penetration and create a barrier on the skin$ra059$),
    ingredients = coalesce(ingredients, $ra059$Omega 6 EFA (Linoleic and Oleic Acid), Tocopherol (D-Alpha), Geranium Essential Oil, Lavender Essential Oil$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1-2 pumps onto fingertips and gently massage into skin. Apply over any serum(s) as last step in regimen.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/DROP_OF_ESSENCE_15ml.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/drop-of-essence')
    where slug = 'drop-of-essence';

  update public.products set
    description = coalesce(description, $ra059$Eliminate blemishes while keeping skin soothed and hydrated. Blemish Serum is a daily spot treatment with a potent blend of antibacterials and healing ingredients that enhances purity and reduces problematic areas. Partnered with Hyaluronic Tonic a hydrating toner that uses heavy water and cucumber, this powerful duo will keep skin clear and refreshed.

SYSTEM INCLUDES:

Blemish Serum
Hyaluronic Tonic$ra059$),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, $ra059$AM – After cleansing with RA Cleanser appropriate for your skin, spritz skin with Hyaluronic Tonic, let product absorb into skin. Apply 1-2 pumps of Blemish Serum. Finish with your favorite Acne Remedies hydrator and Sun Reflect product.

PM – After cleansing with RA Cleanser appropriate for your skin, spritz skin with Hyaluronic Tonic, let product absorb into skin. Apply 1-2 pumps of Blemish Serum. Finish with your favorite Acne Remedies hydrator.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/ELIMINATE_HYDRATE_DUO_2026-08-03-230456_becv.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/eliminate-hydrate')
    where slug = 'eliminate-hydrate';

  update public.products set
    description = coalesce(description, $ra059$Don’t let the aroma of the tropics fool you. This active cleanser blends pineapple enzymes
and AHA’s to increase cellular exfoliation while reducing inflammation and sebum.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Cocamidopropyl Betaine, Sodium C14-16 Olefin Sulfonate, Disodium Laureth
Sulfosuccinate, Glycerin, Sodium Lauryl Sulfoacetate, Sodium Cocoamphoacetate, Sodium Chloride,
Propanediol, Hamamelis Virginiana (Witch Hazel), Coco-Glucoside, Leuconostoc/Radish Root Ferment
Filtrate, Lactic Acid (L), Ananas Sativus (Pineapple) Fruit Extract Acrylates Copolymer, Allyl Caproate,
Glycolic Acid, Zingiber Officinale (Ginger) Root Extract, Glycol Distearate, 1,2-Hexanediol, Caprylyl Glycol,
Cocamidopropyl Hydroxysultaine, Sodium Gluconate, Hydroxypropyl Methylcellulose, 1,2-Hexanediol,
Caprylic/Capric Triglyceride, Sodium Hydroxide, Fructooligosaccharides (D-beta), Glucosamine HCl (D),
Citric Acid, Sodium Hydroxide, Tropolone, Butyrospermum Parkii (Shea) Butter, Fragrance/Parfum+
(Natural Fragrance)$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1 pump into dampened hands; add water for more lather.
Massage into face and neck for several minutes. Remove with warm water and cloth. Pat skin dry.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/ENZYMATIC_CLEANSE_30ml_W_2026-02-25-235442_hmec.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/enzymatic-cleanse')
    where slug = 'enzymatic-cleanse';

  update public.products set
    description = coalesce(description, $ra059$A fast-absorbing physical block using zinc oxide, eZinc Protection is a highly protective with a natural sun protection factor equivalent to an SPF 22 formula that does not leave skin white or pasty. With powerhouse antioxidants, this soothing mineral emulsion provides skin essential hydration and soothing support. Especially beneficial for thicker, more problematic skin.$ra059$),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, null),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/EZINC_PROTECTION_30ml_W.jpg'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/ezinc-protection')
    where slug = 'ezinc-protection';

  update public.products set
    description = coalesce(description, $ra059$A fast-absorbing physical block using zinc oxide, Zinc Relief is a highly protective, outdoor topical with a natural sun protection factor equivalent to an SPF 22 formula that does not leave skin white or pasty. With powerhouse antioxidants, this soothing mineral emulsion provides skin essential hydration and soothing support. Especially beneficial for thicker, more problematic skin.
Light Healing Hydration Broad Spectrum, FDA Approved SPF22 Exceptional Antioxidant Defense
TIP: Pairs well with Green Tea Beta Cleanse and Blemish Serum for a simple yet effective regimen.$ra059$),
    ingredients = coalesce(ingredients, $ra059$ACTIVE INGREDIENTS : Zinc Oxide 9.4%

Aqua (Water), Caprylic/Capric Triglyceride, Squalane, Cetearyl Alcohol, Cetearyl Glucoside, Glyceryl Stearate, Glycerin, Coco-Caprylate/Caprate, Lactobacillus, Cyclopentasiloxane, Leuconostoc/Radish Root Ferment Filtrate, Alcohol Denat., Porphyra Umbilicalis (Red Algae) Extract, Sodium Lactate, Lecithin, Hedychium Coronarium (White Ginger) Root Extract, Dicaprylyl Ether, Xanthan Gum, Cocos Nucifera (Coconut) Fruit Extract, Citrus Reticulata (Tangerine) Peel Oil, Acrylates/C10-30 Alkyl Acrylate Crosspolymer, Citrus Grandis (Grapefruit) Peel Oil, Citrus Aurantium Dulcis (Orange) Peel Oil, Iron Oxides, Camellia Oleifera (Green Tea) Leaf Extract, Allantoin, Aloe Barbadensis Leaf Juice Powder, Bisabolol (L-Alpha), Citrus Limon (Lemon) Peel Oil, Tetrahydrodemethoxy- diferuloylmethane, Tetrahydrobisdemethoxydiferuloylmethane, Tetrahydrodiferuloylmethane, Fructooligosaccharides (D-Beta), Mica, Bismuth Oxychloride, Magnesium Stearate, Polyhydroxystearic Acid, Glyceryl Isostearate, Alcohol, Citric Acid, Sodium Hydroxide$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$If used as directed with other sun protection measures (see Directions), decreases the risk of skin cancer and early skin aging caused by the sun. Warnings For external use only. Do not use on damaged or broken skin. When using this product keep out of eyes. Rinse with water to remove. Stop use and ask doctor if rash occurs. Keep out of reach of children. If product is swallowed, get medical help or contact a Poison Control Center right away. Directions Apply liberally 15 minutes before sun exposure. Use water resistant sunscreen if swimming or sweating. Reapply at least every 2 hours. Sun Protection Measures: Spending time in the sun increases your risk of skin cancer and early skin aging. To decrease this risk, regularly use a sunscreen with a broad spectrum of 15 or higher and other sun protection measures including: Limit time in the sun (especially between 11am-2pm). Wear long-sleeve shirts, pants, hats and sunglasses. Children under 6 months: Ask a doctor. Other Information Protect this product from excessive heat and direct sun.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/ZINC_RELIEF_30ml_W_2026-02-26-000447_behb.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/ezinc-protection-spf-22')
    where slug = 'ezinc-protection-spf-22';

  update public.products set
    description = coalesce(description, $ra059$Watch melasma, age spots and PIH fade away and leave skin glowing with this potent pigmentation reduction duo. Using a highly effective, non-hydroquinone lightening concentrate to spot treat and the hydrating, cell-strengthening support from epidermal growth factor, skin will be left brighter with a more even complexion and radiant tone.

SYSTEM INCLUDES:
Naturalé Mega Brightening Serum
Radiant Renewal Serum$ra059$),
    ingredients = coalesce(ingredients, null),
    how_to_use  = coalesce(how_to_use, $ra059$AM – After cleansing with RA Cleanser appropriate for your skin, apply RA Building & Strengthening serum appropriate for your skin. Finish with Radiant Renewal Serum and your favorite RA Sun Reflect product.

PM – After cleansing with RA Cleanser appropriate for your skin, apply 1-2 pumps of Naturale Mega Brightening Serum over pigmented areas. Finish with 1-2 pumps of Radiant Renewal Serum.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/FADE_GLOW_DUO_7f048736-c1e2-40c8-81aa-eb92781423f4.jpg'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/fade-glow')
    where slug = 'fade-glow';

  update public.products set
    description = coalesce(description, $ra059$This formulation provides necessary anti-inflammatory, antibacterial and exfoliation benefits without over drying the skin using salicylic acid and the heart of green tea.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Cocamidopropyl Betaine, Sodium C14-16 Olefin Sulfonate, Disodium Laureth Sulfosuccinate, Salicylic Acid, Mandelic Acid (L), Glycerin, Sodium Lauryl Sulfoacetate, Sodium Cocoamphoacetate, Coco-Glucoside, Leuconostoc/Radish Root Ferment Filtrate, Cocamidopropyl Hydroxysultaine, Sodium Hydroxide, Sodium Gluconate, Caprylhydroxamic Acid, Camellia Sinensis (Green Tea) Leaf Extract, Melia Azadirachta (Neem) Leaf Extract, Melia Azadirachta (Neem) Flower Extract, Corallina Officinalis Extract, Coccinia Indica Fruit Extract, Solanum Melongena (Eggplant) Fruit Extract, Amber Powder, Ocimum Sanctum Leaf Extract, Curcuma Longa (Turmeric) Leaf Extract, Moringa Oleifera Seed Oil, Epigallocatechin Gallate, Propanediol, Citric Acid, Glycol Distearate, Benzyl Alcohol, Alcohol Denat., Fragrance/Parfum (natural)$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Shake well prior to dispensing. Dispense 1 pump into dampened hands; add water for more lather. Massage into face and neck for several minutes. Remove with warm water and cloth. Pat skin dry.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/GREEN_TEA_BETA_CLEANSE_30ml_W_2026-02-25-235522_fccw.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/green-tea-beta-cleanse')
    where slug = 'green-tea-beta-cleanse';

  update public.products set
    description = coalesce(description, $ra059$Take hydration to a new level! This silky hydrator delivers the power of omega essential
fatty acids and hyaluronic acid to deeply moisturize skin and slow the aging process. This is a must-have for any dry, pro-
youth evening regimen!$ra059$),
    ingredients = coalesce(ingredients, $ra059$Linoleic Acid, Oleic Acid, Aqua (Water), Caprylic/Capric Triglyceride, Coco-Caprylate/Caprate, Glycerin,
Glyceryl Stearate, Cetearyl Alcohol, Cetearyl Glucoside, Glyceryl Stearate Citrate, Helianthus Annuus (Sunflower) Seed
Wax, Palmitic Acid, Polyglyceryl-3 Stearate, Dicaprylyl Ether, Caprylyl Glycol, Hydrogenated Lecithin, Lonicera Japonica
(Honeysuckle) Flower Extract, Lonicera Caprifolium (Honeysuckle) Flower Extract, Glucuronolactone (D), Succinoglycan,
Sodium Gluconate, Citrus Aurantium Bergamia (Bergamot) Fruit Oil, Sodium Hyaluronate (L), Cassia Angustifolia Seed
Polysaccharide, Fructooligosaccharides (D-beta), Pogostemon Cablin (Patchouli) Oil, Citrus Limon (Lemon) Peel Oil,
Potassium Sorbate, Hamamelis Virginiana (Witch Hazel) Water, Cinnamomum Camphora (Camphor) Bark Oil, Canola Oil,
Citric Acid, Capsicum Annuum (Paprika) Extract, Alcohol, Phenethyl Alcohol, Sodium Hydroxide, Xanthan Gum$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1-2 pumps onto fingertips and gently massage
into clean, dry skin or over your favorite RA serum as the last step in regimen.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/HYLAMEGA_SILK_15ml.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/hylamega-silk')
    where slug = 'hylamega-silk';

  update public.products set
    description = coalesce(description, $ra059$A blend of acids and healing extracts come together to reduce bacteria, soften acne lesions
and textural scarring, plus lighten post-inflammatory pigmentation. This therapeutic mask may be used full-face or as a
spot treat to disperse trapped sebum and reduce inflammation.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Trichloroacetic Acid, Lactic Acid (L), Glycerin, Kojic Acid, Hydroxypropyl Starch Phosphate, Bentonite, Kaolin, Caprylic/Capric Triglyceride, Stearic Acid, Cetyl Alcohol, Nonfat Dry Milk, Glycol Distearate, Titanium Dioxide, Resorcinol, Lecithin, Serum Albumin, Hamamelis Virginiana (Witch Hazel) Water, Leuconostoc/Radish Root Ferment Filtrate, Dimethicone, Tocopheryl Acetate (D-alpha), Sodium Gluconate, Alcohol, Mentha Piperita (Peppermint) Oil, Caprylhydroxamic Acid, Carbomer, Sodium Hydroxide, Cocos Nucifera (Coconut) Fruit Juice, BHT, Salvia Sclarea (Clary) Oil, Pogostemon Cablin (Patchouli) Oil, Passiflora Incarnata (Passionflower) Flower Extract, Chamomilla Recutita (Matricaria) Flower Extract, Calendula Officinalis Flower Extract, Lavandula Angustifolia (Lavender) Oil, Glyceryl Ricinoleate, Caprylyl Glycol, Glucosyl Hesperidin, Cymbopogon Martini (Palmarosa) Oil, O-cymen-5-OL, Citric Acid, Benzyl Alcohol, Allantoin, Xanthan Gum$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Apply a thin layer to clean, dry skin – avoid eye area. Leave on for 10 minutes. Rinse well
with cool water and soft cloth. Pat skin dry. Follow with your favorite RA serums and/or moisturizer. May be used to
spot treat blemishes.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/KOJIC_CLEAR_50ml_W_2026-05-12-225946_fbyk.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/kojic-clear-mask')
    where slug = 'kojic-clear-mask';

  update public.products set
    description = coalesce(description, $ra059$With a silky, almost gel-like feel, this unique cleanser not only gently cleanses and hydrates but nourishes the skin with antioxidant support and soothing botanicals.

Hydrates & Softens Skin
Melts Away Makeup
Uses a Natural Coconut Surfactant
Pro-Youth Benefits that Leave Skin Glowing

Perfect for an initial cleanse to remove makeup and buildup, it also stands alone as an essential hydrating cleanser that will leave skin luminous!$ra059$),
    ingredients = coalesce(ingredients, $ra059$Glycerin, Aqua (Water), Sodium Lauroyl Sarcosinate, Sucrose Laurate, Sucrose Myristate, Organic Grape Seed Oil, Lavender Essential Oil, Alcohol Denat., Caprylhydroxamic Acid, Benzyl Alcohol$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1 pump into dampened hands and massage into face and neck and over eyes and lashes for several minutes; add water for more lather. Remove with lukewarm water and cloth. Pat skin dry.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/LUXE_CLEANSING_BALM_30ml_W.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/luxe-cleansing-balm')
    where slug = 'luxe-cleansing-balm';

  update public.products set
    description = coalesce(description, $ra059$Our most powerful peptide complex. Stimulates collagen and elastin to reduce fine lines and wrinkles and loss of firmness and elasticity. Skin will be transformed, turning back the signs of aging.

Restores Hyaluronic Acid
Addresses Deep Wrinkles
Reduces Elastosis
Powerful Neuropeptide

TIP: Pair with Antiox 18 Complex for a firming/toning duo.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Hamamelis Virginiana (Witch Hazel) Water, Glycerin, Alcohol, Palmitoyl Tripeptide-38, Arginine (L), Acetyl Hexapeptide-30, Caprylyl Glycol, 1,2-Hexanediol, Lycium Barbarum (Goji Berry) Fruit Extract, Glycosaminoglycans, Gluconolactone, Sodium Gluconate, Sodium Benzoate, Lavandula Angustifolia (Lavender) Oil, Pogostemon Cablin (Patchouli) Oil, Hydroxypropyl Cyclodextrin, Santalum Austrocaledonicum (Sandalwood) Wood Oil, Cedrus Atlantica (Cedar) Wood Oil, Citrus Aurantium Dulcis (Orange) Flower Oil, Tropolone, Citrus Aurantium Dulcis (Orange) Peel Oil, , Pelargonium Graveolens (Geranium) Flower Oil, Lavandula Hybrida (Lavandin) Oil, Cananga Odorata (Ylang Ylang) Flower Oil, Sodium Hyaluronate (L), Caprylic/Capric Triglyceride, Jasminum Officinale (Jasmine) Flower Extract, Citric Acid, Xanthan Gum, Sodium Hydroxide$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Recommended for PM use. Dispense 1-2 pumps onto fingertips and gently massage into clean, dry skin. Let serum absorb. May layer moisturizer overtop.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/PEPTIDE_38_30ml_T.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/peptide-38')
    where slug = 'peptide-38';

  update public.products set
    description = coalesce(description, $ra059$This potent, peptide blend fights free-radicals, leaving skin smooth, soft and radiant. With a silky texture, this product acts as a great primer before applying foundation.

Collagen Synthesis
Plumps Fine Lines
Increases Hydration

TIP: Excellent to partner with our RA IllumiColour for a beautiful pro-youth finish!$ra059$),
    ingredients = coalesce(ingredients, $ra059$Cyclopentasiloxane, Dimethicone Crosspolymer, Aqua (Water), Dimethicone, Glycerin, Butylene Glycol, Octyldodecanol, Ubiquinone (CoQ10), Thioctic (R-lipoic) Acid, Olea Europaea (Olive) Fruit Oil*, Palmitoyl Tetrapeptide-7, Silica, Phenethyl Alcohol, Caprylyl Glycol, Hydrogenated Coco-Glycerides, Helianthus Annuus (Sunflower) Seed Extract, Carbomer, Hydrolyzed Rice Protein, Cymbopogon Schoenanthus (Lemongrass) Oil*, Hydrolyzed Collagen, Polysorbate 20, Acetyl Tributyl Citrate, Alcohol Denat., Sodium Hyaluronate (L), Palmitoyl Tripeptide-1, Hamamelis Virginiana (Witch Hazel) Water, , Polyglyceryl-4 Caprate, Glycine Soja (Soybean) Protein, Palmitoyl Tripeptide-5, Potassium Sorbate, Polygonum Cuspidatum (Giant Knotweed) Extract, Alcohol, Phenyl t-Butylnitrone (Spin Trap), Carnitine (L), Butyrospermum Parkii (Shea) Butter, Zea Mays (Corn) Starch, Adenine, Dextran, Caprooyl Tetrapeptide-3, Citric Acid, Citrus Aurantium Dulcis (Orange) Peel Oil*, Sodium Hydroxide$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Recommended for AM use. Apply 1-2 pumps to clean, dry skin. Let serum absorb. May layer moisturizer or foundation overtop for a flawless, primed finish.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_mainPhoto/PEPTIDE_MITO_PROTECT_30ml_T_2026-05-12-224411_ofhb.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/peptide-mito-protect')
    where slug = 'peptide-mito-protect';

  update public.products set
    description = coalesce(description, $ra059$Between the aroma and the enzymatic activity this cleanser will become a staple. A blend of pineapple and ginger extracts gently softens the skin’s texture and boosts antioxidant protection for a glowing deep cleanse.

Gently Exfoliates Skin
Moisturizes Tissue
Reveals a Luminous Complexion
Leaves Skin Nourished and Radiant

TIP: Use as a standalone cleanser or alternate with Antioxidant Beta Cleanse to increase antioxidants.$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Cocamidopropyl Betaine, Sodium C14-16 Olefin Sulfonate, Disodium Laureth Sulfosuccinate, Glycerin, Sodium Lauryl Sulfoacetate, Sodium Cocoamphoacetate, Sodium Chloride, Propanediol, Coco-Glucoside, Leuconostoc/Radish Root Ferment Filtrate, Acrylates Copolymer, Allyl Caproate, Zingiber Officinale (Ginger) Root Extract, Glycol Distearate, 1,2-Hexanediol, Caprylyl Glycol, Cocamidopropyl Hydroxysultaine, Sodium Gluconate, Citric Acid, Caprylic/Capric Triglyceride, Sodium Hydroxide, Ananas Sativus (Pineapple) Fruit Extract, Tropolone, Butyrospermum Parkii (Shea) Butter, Fragrance/Parfum+ (Natural Fragrance)$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1 pump into dampened hands; add water for more lather. Massage into face and neck for several minutes. Remove with warm water and cloth. Pat skin dry.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_listing/POLISHED_GLOW_HF.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/pineapple-cleanse')
    where slug = 'pineapple-cleanse';

  update public.products set
    description = coalesce(description, $ra059$A long-standing pro-youth favorite, this lactic acid-based cleanser increases cell turnover and hydration while smoothing skin’s texture. Great for normal skin.

Lactic Acid Softens Texture
Pumpkin Seed Oil Delivers Antioxidants
Stimulates Collagen Support
Leaves Skin Nourished and Radiant

TIP: Mix with Gentle Peptide Cleanse to reduce dryness$ra059$),
    ingredients = coalesce(ingredients, $ra059$Aqua (Water), Glycerin, Cocamidopropyl Betaine, Sodium Cocoamphoacetate, Lauryl Glucoside, Glycol Distearate, Coco-Glucoside, Glyceryl Oleate, Acrylates Copolymer, Sodium Cocoyl Glutamate, Sodium Lauryl Glucose Carboxylate, Cocamidopropyl Hydroxysultaine, Lactic Acid (L), Beta-Carotene (D), Cucurbita Pepo (Pumpkin) Seed Oil, Zingiber Officinale (Ginger) Root Oil, Eugenia Caryophyllus (Clove) Leaf Oil, Cinnamomum Cassia Leaf Oil, Limnanthes Alba (Meadowfoam) Seed Oil, Hamamelis Virginiana (Witch Hazel) Water, Alcohol, Benzyl Alcohol, Phenoxyethanol, Ethylhexylglycerin, Sodium Hydroxide$ra059$),
    how_to_use  = coalesce(how_to_use, $ra059$Dispense 1 pump into dampened hands; add water for more lather. Massage into face and neck for several minutes. Remove with warm water and cloth. Pat skin dry.$ra059$),
    image_url   = coalesce(image_url, 'https://ramarketplace.com/media/products/_listing/PUMPKIN_PARFAIT_ENZYME_50ml_W_2026-05-12-224705_wvjr.png'),
    external_url = coalesce(external_url, 'https://ramarketplace.com/store/559flawless/product/pumpkin-lactic-cleanse')
    where slug = 'pumpkin-lactic-cleanse';
