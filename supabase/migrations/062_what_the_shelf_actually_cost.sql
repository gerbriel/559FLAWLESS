-- ============================================================
-- 559 Flawless — 062: what the shelf actually cost
--
-- `products.cost_cents` has been 0 for every row since 007 created it. Nothing
-- has ever filled it: 012 and 017 seeded the catalogue without a cost, and 059
-- filled the retail price and left cost alone. Everything downstream that needs
-- a wholesale figure has been running on that zero —
--
--   * the Inventory report blanks "Value at cost" and warns that the stock
--     valuation is understated by whatever the unpriced rows are worth
--     (`src/lib/reports/inventory.ts`),
--   * the Retail Sales report has no margin to show,
--   * `profit_summary()` in 033 computes COGS as zero, so every dollar of
--     product revenue reads as pure profit,
--   * and 043's trigger has been snapshotting that same zero onto every
--     `order_items` row as it is sold, freezing the error into history.
--
-- The source is the vendor's own order forms — the Rhonda Allison June 2026
-- price increase, revised 7/1 and 7/9/2026 — which list wholesale cost and
-- suggested retail per product code and size.
--
-- ── How a sheet row was tied to a catalogue row ──
--
-- The catalogue holds ONE row per product, priced at its smallest size (059).
-- The sheets list every size separately. So the retail price is what identifies
-- WHICH size a catalogue row stands for: where a sheet row's suggested retail
-- equals `price_cents`, that is the size on the shelf, and its wholesale cost
-- is the cost of the thing being sold. 129 of the 134 rows below matched that
-- way exactly. The rest are named in the comment beside them.
--
-- Three rules were applied, and each one refuses rather than guesses:
--
--   1. A cost is never seeded above the shelf price. A catalogue row priced
--      $49.00 against a sheet row costing $58.00 is not that size, whatever
--      the name says.
--   2. Where a product has several sizes and none of them is priced like the
--      catalogue row, nothing is written. Those rows are almost all 10ml minis
--      that the sheets only sell inside a six-pack.
--   3. Petite bundles are divided. The sheet prices "AGE Less Set of 6" at
--      $99.00 wholesale against $39.00 retail — that is six units at $16.50,
--      not one unit sold at a loss. MT659 and MT660 sit in the same table
--      without the words: $132.00 cannot be one 10ml when the 30ml costs
--      $58.00, and $132.00 / 6 = $22.00 exactly.
--
-- Every resulting margin lands between 46% and 70%, median 59% — the markup
-- these sheets carry throughout. Nothing here is an outlier.
--
-- 18 of the 152 catalogue rows are deliberately left at 0 and are listed at the
-- foot of this file. The Inventory report already names unpriced products in
-- its own warning block, so they surface in the dashboard rather than passing
-- as free stock.
--
-- Idempotent: only touches `cost_cents = 0`, so a figure the studio has set by
-- hand is never overwritten and a second run changes nothing.
-- ============================================================

comment on column public.products.cost_cents is
  'Wholesale — what the studio pays for one unit of the size that '
  '`price_cents` sells, in cents. Staff-only: the storefront queries select '
  'explicit columns so it never reaches a public payload. 0 means "not on '
  'file", not "free" — reports exclude those rows from value totals and say '
  'so, rather than counting them as zero.';

update public.products p
set cost_cents = v.cost_cents
from (values
    ('2x2-gauze-pads-200-count',              700,   'E09 box'           ),
    ('4x4-gauze-pads-200-count',              1200,  'E08 box'           ),
    ('acne-rosacea-sensitive-skin-home-peel', 10800, 'SP2004-2'          ),
    ('age-reversal-system-normal-to-dry-skin',15350, 'MTT4'              ),
    ('age-reversal-system-sensitive-skin',    11600, 'MTT5'              ),
    ('ageless',                               1650,  'MT682 10ml, per six'),
    ('aha-refine-gel',                        1300,  'AR218 15ml'        ),
    ('all-purpose-cleansing-pads',            900,   'AR178 30ct'        ),
    ('aloe-matte-moisture-cream',             850,   'AR262 15ml'        ),
    ('aloe-zyme',                             600,   'AR281 15ml'        ),
    ('amino-peptide-hydration',               700,   'MT133 15ml'        ),
    ('amino-peptide-serum',                   1050,  'MT686 10ml, per six'),
    ('antiox-18-complex',                     875,   'MT676 10ml, per six'),
    ('antiox-aha-tonic',                      850,   'AR197 30ml'        ),
    ('antiox-defend-tonic',                   850,   'MT35 30ml'         ),
    ('antioxidant-beta-cleanse',              600,   'MT06 30ml'         ),
    ('antioxidant-glow-facial',               2650,  'SPMTF3'            ),
    ('athlete-on-the-go',                     3350,  'AR3'               ),
    ('berry-wine-tonic',                      850,   'MT39 30ml'         ),
    ('beta-bright-cleanse',                   600,   'PS303 30ml'        ),
    ('bha-refine-gel',                        1200,  'AR219 15ml'        ),
    ('bio-53-matrix',                         1600,  'MT115 15ml'        ),
    ('bio-53-matrix-plus',                    1700,  'MT117 15ml'        ),
    ('brighten-clear-facial',                 2675,  'SPARF2'            ),
    ('brightening-cream-enhanced',            3300,  'PS358 50ml'        ),
    ('brightening-pigment-tonic',             850,   'PS313 30ml'        ),
    ('brightening-scrub',                     1700,  'PS305 60ml'        ),
    ('c-peptide-complex',                     3200,  'MT77 15ml'         ),
    ('c-stem-cell',                           3700,  'MT78 15ml'         ),
    ('cherry-jubilee-enzyme',                 800,   'MT149 15ml'        ),
    ('chocolate-antiox-mask',                 700,   'MT155 15ml'        ),
    ('chronopeptide-a',                       2200,  'MT659 10ml, per six'),
    ('cocoa-berry-c-mask',                    700,   'PS369 15ml'        ),
    ('collagen-boost',                        6700,  'MTL1'              ),
    ('collagen-snap-back',                    9000,  'MTD1'              ),
    ('cystic-relief',                         5150,  'AR2'               ),
    ('daily-dose',                            3800,  'MTD5'              ),
    ('daytime-defense',                       1350,  'RF2 30ml'          ),
    ('derma-zyme',                            600,   'MT145 15ml'        ),
    ('dnage-reversal',                        1400,  'MT680 10ml, per six'),
    ('drop-of-essence',                       800,   'MT121 15ml'        ),
    ('eliminate-hydrate',                     1600,  'ARD1'              ),
    ('elite-luxe-hydration',                  1300,  'MT119 15ml'        ),
    ('enzymatic-cleanse',                     800,   'AR169 30ml'        ),
    ('essential-spot-rx',                     1000,  'MT55 15ml'         ),
    ('eye-lift',                              3000,  'EC3 15ml'          ),
    ('eye-lip-renew-serum',                   5500,  'EC4 15ml'          ),
    ('eye-revitalizer',                       1500,  'EC1 15ml'          ),
    ('ezinc-protection',                      1300,  'RF4 30ml'          ),
    ('ezinc-protection-spf-22',               1300,  'AR267 30ml'        ),
    ('fade-glow',                             2850,  'PSD1'              ),
    ('firm-eyefect',                          8500,  'ECD1'              ),
    ('fruit-acid-tonic',                      850,   'AR199 30ml'        ),
    ('gentle-jojoba-beads',                   1000,  'MT16 60ml'         ),
    ('gentle-peptide-cleanse',                600,   'MT02 30ml'         ),
    ('green-tea-beta-cleanse',                600,   'AR173 30ml'        ),
    ('green-tea-hydrate',                     1650,  'RF6 30ml'          ),
    ('green-tea-tonic',                       850,   'AR195 30ml'        ),
    ('ha-clear-concentrate',                  1750,  'AR260 30ml'        ),
    ('ha-hydra-mist',                         600,   'MT31 30ml'         ),
    ('hand-duo',                              3600,  'SP2004-1'          ),
    ('healthy-aging-cream',                   1300,  'MT131 15ml'        ),
    ('herbal-aha-cleanse',                    600,   'AR175 30ml'        ),
    ('home-rejuvenation-peel',                11050, 'SP2004-2'          ),
    ('hormonal-balance',                      4000,  'ARD2'              ),
    ('hyaluronic-concentrate',                1750,  'MT134 30ml'        ),
    ('hyaluronic-tonic',                      600,   'AR191 30ml'        ),
    ('hylamega-silk',                         1200,  'MT137 15ml'        ),
    ('inflammatory-essentials',               8850,  'PSL3'              ),
    ('inflammatory-travel',                   7850,  'PST3'              ),
    ('infuse-7',                              800,   'MT123 15ml'        ),
    ('instant-lift-mask',                     1800,  'MT156 40g'         ),
    ('instant-lift-mask-set',                 4000,  'MTS1'              ),
    ('kojic-clear-mask',                      800,   'AR293 15ml'        ),
    ('lactic-renew-tonic',                    600,   'MT33 30ml'         ),
    ('lash-eyefect',                          2300,  'ECD6'              ),
    ('lift-eyefect',                          8500,  'ECD5'              ),
    ('luminous-balancing-serum',              1400,  'MT90 15ml'         ),
    ('luminous-wine-gel',                     850,   'PS357 15ml'        ),
    ('luxe-cleansing-balm',                   750,   'MT20 30ml'         ),
    ('makeup-remover',                        800,   'EC6 30ml'          ),
    ('mandelic-bright',                       2000,  'PS322 15ml'        ),
    ('mandelic-clay-cleanse',                 850,   'AR167 30ml'        ),
    ('mandelic-clear-complex',                2000,  'AR213 15ml'        ),
    ('mandelic-perfecting-polish',            1600,  'AR177 60ml'        ),
    ('mandelic-purifying-tonic',              850,   'AR193 30ml'        ),
    ('mandelic-rejuvenator',                  2000,  'MT54 15ml'         ),
    ('mandelic-replenish',                    900,   'AR264 15ml'        ),
    ('mandelic-transfirmation',               5025,  'MTT1'              ),
    ('melasma-essentials',                    6650,  'PSL2'              ),
    ('moisture-firm',                         1800,  'MTD2'              ),
    ('naturale-mega-brightening-serum',       1250,  'PS324 15ml'        ),
    ('oceanic-vitality-serum',                3400,  'PS346 30ml'        ),
    ('papaya-tangerine-enzyme',               900,   'MT147 15ml'        ),
    ('peptide-3-n-1-eye-cream',               3000,  'EC2 15ml'          ),
    ('peptide-38',                            2000,  'MT688 10ml, per six'),
    ('peptide-bright-c',                      3200,  'PS340 15ml'        ),
    ('peptide-mito-protect',                  1800,  'MT684 10ml, per six'),
    ('peptide-power',                         6650,  'MTD3'              ),
    ('perfection-clay',                       700,   'AR291 15ml'        ),
    ('pumpkin-e-serum',                       1000,  'MT694 10ml, per six'),
    ('pumpkin-power',                         6500,  'MTT2'              ),
    ('pumpkin-tonic',                         750,   'MT37 30ml'         ),
    ('pure-grape-seed-elixir',                950,   'MT92 15ml'         ),
    ('purify-power-zyme',                     950,   'AR285 15ml'        ),
    ('purifying-gel-cleanse',                 600,   'AR171 30ml'        ),
    ('purifying-pumpkin-facial',              2725,  'SPARF1'            ),
    ('ra-square-brush',                       1000,  'E13 ea'            ),
    ('radiant-bamboo-polish',                 1700,  'MT18 60ml'         ),
    ('radiant-renewal-serum',                 1600,  'PS355 15ml'        ),
    ('resveratrol-b3-gel',                    850,   'MT127 15ml'        ),
    ('resveratrol-defense',                   2300,  'PSD2'              ),
    ('resveratrol-glow',                      4100,  'MTT3'              ),
    ('retinol-supreme',                       2800,  'MT52 15ml'         ),
    ('revitalize-your-eyes',                  6800,  'ECT2'              ),
    ('rx-eyefect',                            3000,  'ECD4'              ),
    ('salicylic-a-serum',                     2800,  'AR212 30ml'        ),
    ('silky-lavender-cleanser',               750,   'EC7 30ml'          ),
    ('skin-brightening-cleanse',              600,   'PS301 30ml'        ),
    ('skin-restore',                          6300,  'ARL1'              ),
    ('skin-smoothing-gel',                    1300,  'MT58 15ml'         ),
    ('spiced-pumpkin-cream',                  1200,  'MT135 15ml'        ),
    ('stem-bright-c',                         3700,  'PS341 15ml'        ),
    ('stem-cell-a',                           2200,  'MT660 10ml, per six'),
    ('sun-induced-essentials',                7350,  'PSL1'              ),
    ('sun-induced-travel',                    4850,  'PST1'              ),
    ('teen-prevention-collection',            4450,  'AR4'               ),
    ('vibrant-eyez',                          2000,  'EC8 15ml'          ),
    ('vita-10-complex',                       1100,  'MT696 10ml, per six'),
    ('vita-age-defy-cream',                   1600,  'MT113 15ml'        ),
    ('vital-energy',                          3800,  'MTD4'              ),
    ('wasabi-mask',                           625,   'AR289 15ml'        ),
    ('wound-repair',                          3700,  'ARD3'              ),
    ('youth-eyefect',                         7000,  'ECD2'              )
) as v(slug, cost_cents, sheet_ref)
where p.slug = v.slug
  -- Never overwrite a cost already on file.
  and p.cost_cents = 0;

-- ============================================================
-- Left at 0 on purpose
--
-- ── Priced like a size the sheets do not sell on its own ──
-- Each of these is almost certainly the 10ml mini: the sheets list that size
-- only inside a six-pack or a travel kit, so there is no unit cost to take.
-- Confirming the size on one of the studio's own invoices is what closes them.
--
--   a-renew                    shelf $  49.00   sheet has PS319 30ml @ $130.00
--   balancing-cocktail         shelf $  19.00   sheet has AR240 30ml @ $42.00
--   blemish-serum              shelf $  22.50   sheet has AR215 30ml @ $48.00, AR216 15ml @ $25.00
--   clear-bright-zyme          shelf $ 100.00   sheet has AR282 50ml @ $55.00, AR283 15ml @ $18.00
--   cooling-relief-mask        shelf $  13.00   sheet has AR287 15ml @ $15.00, AR286 50ml @ $50.00
--   hydrating-relief-serum     shelf $  16.00   sheet has AR242 30ml @ $35.00
--   liposome-honey-cleanse     shelf $  38.00   sheet has MT40 25ct @ $36.00
--   pineapple-cleanse          shelf $  66.00   sheet has MT07 120ml @ $38.00, MT08 30ml @ $15.00
--   pumpkin-lactic-cleanse     shelf $  56.00   sheet has MT03 120ml @ $40.00, MT04 30ml @ $18.00
--   retinal-clear              shelf $  49.00   sheet has AR210 30ml @ $130.00, AR209 15ml @ $78.00
--   vita-bright-elixir         shelf $  26.00   sheet has PS344 30ml @ $52.00
--   vita-e-therapy             shelf $  15.00   sheet has AR236 30ml @ $30.00
--   vital-repair-gel           shelf $  22.50   sheet has AR258 30ml @ $45.00
--
-- ── Rows whose content belongs to a different product ──
-- Not a pricing problem: in 059 these five carry the name, description, photo
-- and price of another product entirely, so there is no way to know what the
-- slug is meant to cost. A client opening /shop/<slug> is shown the wrong item.
-- Listed here because these sheets are what made it visible.
--
--   grape-seed-antiox-mask     shows "Grape Seed Glow" at $16.00
--   hydra-glow-facial          shows "Hydra Relief" at $56.50
--   melasma-travel             shows "Moisture Eye-Zyme" at $40.00
--   skin-brightening-enzyme    shows "Skin Repair Complex" at $42.00
--   ultra-replenish-cream      shows "Unveil Your Beauty" at $241.00
-- ============================================================
