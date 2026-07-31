-- ============================================================
-- 559 Flawless — 010: seed
--
-- The real service menu, taken from the studio's own posted pricing.
-- Prices marked `price_is_starting` render as "from $65", matching the
-- studio's "65+" convention — the final quote depends on hair density, skin
-- condition, and how long the appointment actually runs.
--
-- PRICES NOT SUPPLIED BY THE STUDIO are marked with a  -- ESTIMATE  comment.
-- Those are placeholders to be corrected in Dashboard → Settings before the
-- site goes live. Everything without that marker is the studio's real price.
--
-- Idempotent: safe to re-run.
-- ============================================================

-- ── Categories ───────────────────────────────────────────────
-- image_url points at files in /public/images/services. Swap for real studio
-- photography by replacing the file, or repoint at the `site` storage bucket
-- from the dashboard. See public/images/ATTRIBUTION.md.
insert into public.service_categories (name, slug, description, image_url, is_intimate, sort_order) values
  ('Facials',        'facials',
   'Customizable corrective facials — enzymes, steam, dermaplaning, and high frequency, chosen for your skin on the day.',
   '/images/services/facials.jpg', false, 1),
  ('Chemical Peels', 'chemical-peels',
   'Rhonda Allison superficial and mid-depth peels. Resurfaces, boosts collagen, and evens tone.',
   '/images/services/chemical-peels.jpg', false, 2),
  ('Skin Lightening','skin-lightening',
   'Hyperpigmentation treatment for underarms, inner thighs, and intimate areas, on a protocol built for your skin. 18 and over.',
   '/images/services/skin-lightening.jpg', true, 3),
  ('Waxing',         'waxing',
   'Hard and soft wax hair removal for face and body.',
   '/images/services/waxing.jpg', false, 4),
  ('Nails',          'nails',
   'Hard gel overlays, pedicures, and gel pedicures.',
   '/images/services/nails.jpg', false, 5)
on conflict (slug) do nothing;

-- ── Facials ──────────────────────────────────────────────────
insert into public.services
  (category_id, name, slug, description, details, aftercare,
   duration_minutes, price_cents, price_is_starting, buffer_minutes,
   deposit_cents, sort_order)
select c.id, v.name, v.slug, v.description, v.details, v.aftercare,
       v.dur, v.price, true, 15, v.deposit, v.ord
from public.service_categories c,
(values
  ('Custom Corrective Facial', 'custom-corrective-facial',
   'Built around your skin that day rather than a fixed routine.',
$$Every facial here is customizable. Depending on what your skin needs, the session can use enzymes that break the bonds between dead skin cells, steam, dermaplaning, high frequency, extractions, and a finishing mask.

You will be told what is being used and why before it goes on your skin. Nothing is added to run up the price.$$,
$$Leave the skin alone for the rest of the day where you can. No retinoids, acids, or physical scrubs for 3 to 5 days. Sunscreen every morning, without exception — freshly exfoliated skin burns easily.$$,
   60, 9500, 2500, 1),  -- ESTIMATE: price not supplied by the studio

  ('Acne & Congestion Facial', 'acne-congestion-facial',
   'For active breakouts, dry acne, and congestion. Decongesting, thorough extractions, and a plan to take home.',
$$Dry acne behaves differently from oily acne — the barrier is usually compromised, so stripping it further makes it worse. This session focuses on gently loosening congestion with enzymes, extracting what is ready, calming inflammation, and rebuilding the barrier with serums and peptides.

You will leave with a home-care plan. Acne does not clear in one visit, and anyone who tells you otherwise is selling something.$$,
$$Do not pick. Expect some purging in the first two weeks as congestion surfaces. Keep the routine simple and stick to it.$$,
   75, 11000, 2500, 2),  -- ESTIMATE: price not supplied by the studio

  ('Dermaplaning Facial', 'dermaplaning-facial',
   'Manual exfoliation with a surgical blade, followed by a treatment mask. Makeup sits noticeably smoother afterward.',
$$Dermaplaning uses a 10R surgical blade held at a 45-degree angle to lightly shave the outermost layer of skin. The purpose is exfoliation; removing the fine peach fuzz is a bonus, not the point.

The hair grows back exactly as it was — finer facial hair does not become coarse from dermaplaning. That is a myth.$$,
$$No acids, retinoids, or sun exposure for 3 days. Sunscreen daily.$$,
   60, 12000, 3000, 3)  -- ESTIMATE: price not supplied by the studio
) as v(name, slug, description, details, aftercare, dur, price, deposit, ord)
where c.slug = 'facials'
on conflict (slug) do nothing;

-- ── Chemical peels ───────────────────────────────────────────
insert into public.services
  (category_id, name, slug, description, details, aftercare,
   duration_minutes, price_cents, price_is_starting, buffer_minutes,
   deposit_cents, patch_test_hours, requires_consultation, sort_order)
select c.id, v.name, v.slug, v.description, v.details, v.aftercare,
       v.dur, v.price, true, 15, v.deposit, v.patch, v.consult, v.ord
from public.service_categories c,
(values
  ('Superficial Chemical Peel', 'superficial-chemical-peel',
   'A Rhonda Allison superficial peel selected for your skin type and goal.',
$$Boosts collagen, resurfaces, evens tone, and leaves the skin looking refreshed rather than raw. Superficial peels work on the outermost layers, so downtime is light — expect some flaking for a few days.

The peel chosen depends on your skin type, your history, and what you are treating. There is no single peel that suits everyone.$$,
$$Expect light flaking for 3 to 5 days. Do not pull at peeling skin — let it release on its own. No sun, no heat, no acids, no retinoids until the flaking has finished. Sunscreen every single morning.$$,
   45, 13500, 4000, 24, false, 1),  -- ESTIMATE: price not supplied by the studio

  ('Mid-Depth Baby Boomer Peel', 'mid-depth-baby-boomer-peel',
   'A deeper resurfacing peel paired with melanin suppressants to even out tone.',
$$This is a significant step up from a superficial peel. It removes more of the skin''s outer layers and reaches deeper, and it is paired with melanin suppressants to work on uneven tone at the same time.

It usually follows a few superficial peels, though not always — that depends on how your skin has handled prior work. A consultation and a patch test are required first.

Downtime is real. Plan for visible peeling and do not book this in the week before an event.$$,
$$Expect several days of noticeable peeling. Do not pick or pull. No sun, heat, exercise-level sweating, acids, or retinoids until fully healed. Sunscreen is not optional — new skin pigments easily, and skipping it undoes the treatment.$$,
   90, 25000, 7500, 48, true, 2)  -- ESTIMATE: price not supplied by the studio
) as v(name, slug, description, details, aftercare, dur, price, deposit, patch, consult, ord)
where c.slug = 'chemical-peels'
on conflict (slug) do nothing;

-- ── Skin lightening ("Hello Kitties") ────────────────────────
-- 18+, consent and intake required, longer buffer for privacy. Individual
-- areas are consultation-first by design: the studio builds the protocol per
-- skin type rather than running one fixed system, so a fixed price would be
-- misleading.
insert into public.services
  (category_id, name, slug, description, details, aftercare,
   duration_minutes, price_cents, price_is_starting, buffer_minutes, deposit_cents,
   is_intimate, requires_age_verification, requires_intake,
   requires_consultation, patch_test_hours, sort_order)
select c.id, v.name, v.slug, v.description, v.details, v.aftercare,
       v.dur, v.price, v.starting, 20, v.deposit,
       v.intimate, true, true, v.consult, v.patch, v.ord
from public.service_categories c,
(values
  ('Hello Kitties + Underarms', 'hello-kitties-underarms',
   'The full intimate lightening package, including underarms. Currently $300, reduced from $350.',
$$"Hello Kitties" is the studio''s name for intimate area lightening. This package covers the intimate area and both underarms.

Not all lightening systems are equal. A low percentage of glycolic acid will lighten some skin and do nothing at all for other skin. The pubis and labia in particular can be resilient and often need stronger acids and enzymes than the underarms do. One protocol does not fit every skin type, which is why the protocol here is built for your skin rather than pulled off a shelf.

Darkening in these areas is normal. It is usually caused by friction, hair removal, hormones, or genetics — it is not a hygiene problem, and this treatment is purely cosmetic.

Results build over a series of sessions and are gradual. If the skin is still dark after treatment, the old pigmented layer may need to be waxed off to reveal the newer, lighter skin underneath — a Brazilian can be added for $50 in that case.

A consultation and a 48-hour patch test are required before the first session.$$,
$$No friction, heat, tight clothing, swimming, or sweating for 48 hours. No shaving or waxing the treated area unless your esthetician tells you to. Sunscreen on any area that sees sun. Use only the home-care products you were given — random actives on freshly treated intimate skin cause burns.$$,
   60, 30000, false, 10000, true, false, 48, 1),

  ('Underarm Lightening', 'underarm-lightening',
   'Pigment correction for the underarms, on a protocol built for your skin.',
$$Underarm darkening is almost always friction and hair removal rather than anything you have done wrong. Deodorant, shaving, and tight sleeves all contribute.

Underarm skin generally responds faster than intimate skin, but the right protocol still depends on your skin type and how much pigment there is. Priced at consultation, after your skin has been assessed.$$,
$$No deodorant for 24 hours, no shaving for 48. Avoid heat and heavy sweating for two days.$$,
   45, 0, false, 0, false, true, 48, 2),

  ('Inner Thigh Lightening', 'inner-thigh-lightening',
   'Pigment correction for the inner thighs.',
$$Inner thigh darkening is friction pigmentation — it is extremely common and has nothing to do with weight or hygiene.

The protocol and the number of sessions depend on your skin type and how established the pigment is, so this is priced at consultation.$$,
$$No friction, tight clothing, or heavy sweating for 48 hours. Sunscreen if the area sees sun.$$,
   45, 0, false, 0, false, true, 48, 3),

  ('Intimate Lightening Consultation', 'intimate-lightening-consultation',
   'A private assessment before any lightening work begins, including a patch test.',
$$Before any lightening treatment, your skin is assessed in person and a patch test is placed. This is where the protocol gets decided — which acids, which enzymes, how many sessions, and whether waxing needs to happen first.

You will get a straight answer about what is realistic for your skin. If lightening is not going to give you the result you are hoping for, you will be told that rather than sold a series.$$,
   null,
   30, 0, false, 0, true, true, 0, 4)
) as v(name, slug, description, details, aftercare, dur, price, starting, deposit, intimate, consult, patch, ord)
where c.slug = 'skin-lightening'
on conflict (slug) do nothing;

-- ── Waxing ───────────────────────────────────────────────────
-- Brazilian sits in the general waxing menu (as the studio lists it) but
-- carries its own intimate + 18-plus flags.
insert into public.services
  (category_id, name, slug, description, details, aftercare,
   duration_minutes, price_cents, price_is_starting, buffer_minutes, deposit_cents,
   is_intimate, requires_age_verification, sort_order)
select c.id, v.name, v.slug, v.description, v.details, v.aftercare,
       v.dur, v.price, v.starting, v.buffer, v.deposit, v.intimate, v.intimate, v.ord
from public.service_categories c,
(values
  ('Full Brazilian', 'full-brazilian',
   'Full hair removal, front to back, with underarms included.',
$$Performed privately by a licensed esthetician using hard wax, which is gentler on intimate skin than strip wax. Underarms are included in the price.

First-time clients are walked through the whole process beforehand and can stop at any point, for any reason, without explaining. You may ask for another person to be present.

Please arrive freshly showered. Hair should be about a quarter inch long — roughly two weeks of growth. Not performed on broken skin, during an active infection, or within 7 days of retinoid use.$$,
$$Expect redness and small bumps for up to 48 hours. No heat, friction, swimming, sun, or heavy sweating for 24 to 48 hours. Start gentle exfoliation after 3 days to keep ingrowns down. Loose cotton underwear helps.$$,
   45, 6500, true, 20, 2000, true, 1),

  ('Full Leg Wax', 'full-leg-wax',
   'Hip to ankle.', null,
$$Redness for a few hours is normal. No heat, sun, or heavy sweating for 24 hours. Exfoliate gently from day 3.$$,
   75, 20000, true, 15, 0, false, 2),

  ('Half Leg Wax', 'half-leg-wax',
   'Knee to ankle, or thigh.', null,
$$Redness for a few hours is normal. No heat, sun, or heavy sweating for 24 hours.$$,
   45, 6000, true, 10, 0, false, 3),

  ('Full Arm Wax', 'full-arm-wax',
   'Shoulder to wrist.', null, null,
   45, 7000, true, 10, 0, false, 4),

  ('Half Arm Wax', 'half-arm-wax',
   'Elbow to wrist, or shoulder to elbow.', null, null,
   30, 5000, true, 10, 0, false, 5),

  ('Back Wax', 'back-wax',
   'Full back and shoulders.', null,
$$No heat, sun, or heavy sweating for 24 hours. Exfoliate gently from day 3 to prevent ingrowns.$$,
   45, 8000, true, 10, 0, false, 6),

  ('Chest Wax', 'chest-wax',
   'Full chest.', null, null,
   45, 8000, true, 10, 0, false, 7),

  ('Full Face Wax', 'full-face-wax',
   'Brows, lip, chin, cheeks, and sides.', null,
$$Facial skin stays pink for a few hours. No makeup on the waxed area for the rest of the day where possible, and no acids or retinoids for 48 hours.$$,
   40, 6000, true, 10, 0, false, 8),

  ('Eyebrow Wax', 'eyebrow-wax',
   'Shaped to your bone structure, not a stencil.', null, null,
   20, 3000, false, 10, 0, false, 9)
) as v(name, slug, description, details, aftercare, dur, price, starting, buffer, deposit, intimate, ord)
where c.slug = 'waxing'
on conflict (slug) do nothing;

-- ── Nails ────────────────────────────────────────────────────
insert into public.services
  (category_id, name, slug, description, duration_minutes, price_cents,
   price_is_starting, buffer_minutes, sort_order)
select c.id, v.name, v.slug, v.description, v.dur, v.price, true, 10, v.ord
from public.service_categories c,
(values
  ('Hard Gel Nail Overlay', 'hard-gel-nail-overlay',
   'Hard gel applied over the natural nail for strength and length retention.', 75, 6500, 1),
  ('Pedicure', 'pedicure',
   'Soak, shaping, cuticle care, callus work, massage, and polish.',           60, 6000, 2),
  ('Gel Pedicure', 'gel-pedicure',
   'Full pedicure finished with gel polish.',                                  75, 7000, 3)
) as v(name, slug, description, dur, price, ord)
where c.slug = 'nails'
on conflict (slug) do nothing;

-- ── Add-ons ──────────────────────────────────────────────────
insert into public.service_addons (name, slug, description, price_cents, duration_minutes, sort_order) values
  ('Brazilian with Lightening', 'addon-brazilian-lightening',
   'Added to a lightening session to remove the old pigmented layer and reveal newer skin.', 5000, 45, 1),
  ('Dermaplaning',    'addon-dermaplaning',   'Manual exfoliation with a surgical blade before your mask.', 4000, 20, 2),
  ('High Frequency',  'addon-high-frequency', 'Calms inflammation and helps with active breakouts.',        2500, 15, 3),
  ('Extra Extractions','addon-extractions',   'Fifteen additional minutes of extractions.',                 2500, 15, 4),
  ('Enzyme Treatment','addon-enzyme',         'An additional enzyme layer for stubborn congestion.',        3000, 15, 5),
  ('Peptide Serum Finish', 'addon-peptide',   'A peptide serum sealed in at the end of your facial.',       2000, 10, 6),
  ('Underarm Wax',    'addon-underarm-wax',   'Added to any waxing appointment.',                           2500, 15, 7)
on conflict (slug) do nothing;

-- Which add-ons are offered with which service.
insert into public.service_addon_links (service_id, addon_id)
select s.id, a.id
from public.services s, public.service_addons a
where (s.slug in ('custom-corrective-facial', 'acne-congestion-facial', 'dermaplaning-facial')
       and a.slug in ('addon-dermaplaning','addon-high-frequency','addon-extractions','addon-enzyme','addon-peptide'))
   or (s.slug in ('superficial-chemical-peel')
       and a.slug in ('addon-high-frequency','addon-peptide'))
   or (s.slug = 'hello-kitties-underarms'
       and a.slug = 'addon-brazilian-lightening')
   or (s.slug in ('full-leg-wax','half-leg-wax','full-arm-wax','half-arm-wax','back-wax','chest-wax')
       and a.slug = 'addon-underarm-wax')
on conflict do nothing;

-- ── Retail: brand + product categories ───────────────────────
-- Retail runs through the studio's authorized Rhonda Allison marketplace
-- storefront, which takes payment and ships. Products listed here with an
-- external_url link out to that store; anything stocked in the salon itself is
-- added without one and checks out through Stripe.
--
-- Categories mirror the RA marketplace so the two menus line up.
insert into public.brands (name, slug) values
  ('Rhonda Allison', 'rhonda-allison')
on conflict (slug) do nothing;

insert into public.product_categories (name, slug, description, sort_order) values
  ('Cleansers & Scrubs',       'cleansers-scrubs',       'Barrier-respecting cleansers and gentle physical exfoliants.', 1),
  ('Toners',                   'toners',                 'Post-cleanse balancing and prep.',                            2),
  ('Correctives',              'correctives',            'Targeted actives for pigment, acne, and texture.',             3),
  ('Building & Strengthening', 'building-strengthening', 'Barrier repair and resilience for compromised skin.',          4),
  ('Moisturizers & Hydrators', 'moisturizers-hydrators', 'Finishing creams, hydrators, and occlusives.',                 5),
  ('Enzymes & Masks',          'enzymes-masks',          'At-home enzymes and treatment masks.',                         6),
  ('Peptides',                 'peptides',               'Peptide serums for firmness, repair, and support.',            7),
  ('Sun Protection',           'sun-protection',         'Daily SPF. Non-negotiable after any exfoliation or peel.',     8),
  ('At Home Facials',          'at-home-facials',        'Guided kits to extend your results between visits.',           9),
  ('Systems & Collections',    'systems-collections',    'Complete routines built around one concern.',                 10),
  ('Duos',                     'duos',                   'Paired products meant to be used together.',                  11)
on conflict (slug) do nothing;

-- ── Consent templates ────────────────────────────────────────
insert into public.consent_forms (slug, version, title, body, category_ids, revalidate_after_days)
select 'general-treatment', 1, 'General Treatment Consent',
$$I confirm that the information I have provided about my health, medications, and skin history is accurate and complete to the best of my knowledge, and I will inform my esthetician of any changes before each visit.

I understand that esthetic services are cosmetic, not medical, and that my esthetician does not diagnose or treat medical conditions. Nothing performed here is a substitute for care from a physician or dermatologist.

I understand that individual results vary and that no specific outcome has been promised to me. Some services require a series before results are visible.

I understand that temporary redness, sensitivity, swelling, flaking, or minor irritation are normal after many treatments, and that less common reactions including breakouts, prolonged redness, or changes in pigmentation are possible.

I agree to follow the aftercare instructions I am given, and to contact the studio promptly if I experience an unexpected reaction.

I may withdraw my consent and stop any service at any time, for any reason, without explanation.$$,
  array(select id from public.service_categories), 365
on conflict (slug, version) do nothing;

insert into public.consent_forms (slug, version, title, body, category_ids, revalidate_after_days)
select 'waxing', 1, 'Waxing Consent',
$$I understand that waxing removes hair from the root and that temporary redness, bumps, and sensitivity are normal for up to 48 hours afterward.

I confirm that I am not currently using Accutane/isotretinoin and have not within the past 6 months, and that I have not used a topical retinoid, glycolic or salicylic acid, or a prescription exfoliant on the area to be waxed within the past 7 days. I understand these can cause the skin to lift during waxing.

I confirm that the area to be waxed has no open cuts, sunburn, active rash, cold sores, or recent cosmetic procedures.

I understand that lifting, bruising, or ingrown hairs can occur, and that I should avoid heat, friction, swimming, and sun exposure on the area for 24 to 48 hours.

I will tell my esthetician immediately if anything is uncomfortable, and I understand I can ask to stop at any time.$$,
  array(select id from public.service_categories where slug in ('waxing', 'skin-lightening')), 365
on conflict (slug, version) do nothing;

insert into public.consent_forms (slug, version, title, body, category_ids, revalidate_after_days)
select 'chemical-peel', 1, 'Chemical Peel Consent',
$$I understand that a chemical peel removes layers of skin using acids, and that stinging, redness, tightness, darkening, and visible peeling are expected parts of the process.

I confirm that I am not pregnant or breastfeeding, have not used Accutane/isotretinoin in the past 6 months, and have stopped retinoids and acid exfoliants for the period I was told.

I confirm I have had no significant sun exposure, tanning, or sunburn in the last two weeks, and I understand that treating recently sun-exposed skin risks burns and pigment change.

I understand that I must not pick, pull, or scrub peeling skin, and that doing so can cause scarring and post-inflammatory pigmentation.

I understand that daily sunscreen is required during and after the peel series, and that failing to use it can leave me darker than when I started.

I understand that deeper peels usually require a series, that results are gradual, and that no specific outcome has been guaranteed to me.$$,
  array(select id from public.service_categories where slug in ('chemical-peels', 'facials')), 180
on conflict (slug, version) do nothing;

insert into public.consent_forms (slug, version, title, body, category_ids, revalidate_after_days)
select 'intimate-services', 1, 'Intimate Service Consent',
$$I confirm that I am 18 years of age or older.

I understand that this service involves the intimate areas of my body, that it will be performed by a licensed esthetician in a private treatment room, and that I may request that another person be present.

I understand exactly which areas will be treated, because they were described to me before the service began, and I consent to that specific scope. I understand I may narrow that scope or stop the service at any point, and that I do not need to give a reason.

I confirm that the area is free of open skin, active infection, and recent waxing within two weeks unless my esthetician has told me otherwise.

I understand that no photograph of any intimate area will be taken unless I give separate written consent, and that I may withdraw that consent at any time.$$,
  array(select id from public.service_categories where slug in ('skin-lightening', 'waxing')), 180
on conflict (slug, version) do nothing;

insert into public.consent_forms (slug, version, title, body, category_ids, revalidate_after_days)
select 'skin-lightening', 1, 'Skin Lightening Consent',
$$I understand that this is a cosmetic treatment for hyperpigmentation using acids and enzymes, and that it is not a medical procedure.

I understand that darkening of the underarms, inner thighs, and intimate areas is normal and is most commonly caused by friction, hair removal, hormones, or genetics.

I understand that no specific degree of lightening has been promised to me, that results are gradual, that they require a series of sessions, and that my skin may respond differently from someone else''s. I understand that skin type determines the protocol and that a protocol that worked for another person may not suit me.

I confirm that I am not pregnant or breastfeeding, and that the area is free of open skin, active infection, rash, or recent waxing within two weeks unless instructed otherwise.

I confirm I have completed a patch test and understand why it was required.

I understand that stinging, redness, dryness, and temporary darkening before lightening are all possible, and that hair removal may be needed to reveal newer skin beneath the pigmented layer.

I understand that I must use only the home care I was given on the treated area, that friction and heat must be avoided after treatment, and that failing to follow aftercare can worsen pigmentation rather than improve it.

I may stop treatment at any point, and I may decline any part of it without giving a reason.$$,
  array(select id from public.service_categories where slug = 'skin-lightening'), 180
on conflict (slug, version) do nothing;

insert into public.consent_forms (slug, version, title, body, category_ids, revalidate_after_days)
select 'photo-release', 1, 'Photography Release',
$$I consent to my esthetician taking clinical before-and-after photographs of the treated area for my own treatment record.

I understand these photographs are stored securely, are visible only to me and to the staff who treat me, and are never used for any other purpose without my separate written permission.

Marketing use is a separate choice. My photographs will not appear on the studio''s website, social media, or any promotional material unless I tick the marketing box below, and I may withdraw that permission at any time.

I understand I may decline photography entirely and still receive my treatment, and that I may request deletion of my photographs at any time.$$,
  '{}', 365
on conflict (slug, version) do nothing;

-- ── Intake form ──────────────────────────────────────────────
insert into public.intake_forms (slug, version, title, questions, category_ids)
select 'health-intake', 1, 'Health & Skin History',
$$[
  {"id":"accutane","label":"Have you used Accutane or isotretinoin in the last 6 months?","type":"boolean","flag_when":true},
  {"id":"retinoid_7d","label":"Have you used a retinoid, Retin-A, tretinoin, or a prescription exfoliant in the last 7 days?","type":"boolean","flag_when":true},
  {"id":"pregnant","label":"Are you pregnant or breastfeeding?","type":"boolean","flag_when":true},
  {"id":"cold_sore","label":"Do you get cold sores, or have one now?","type":"boolean","flag_when":true},
  {"id":"recent_peel","label":"Have you had a peel, laser, or microneedling in the last 4 weeks?","type":"boolean","flag_when":true},
  {"id":"blood_thinner","label":"Do you take a blood thinner?","type":"boolean","flag_when":true},
  {"id":"keloid","label":"Do you scar easily or form keloids?","type":"boolean","flag_when":true},
  {"id":"sun_48h","label":"Have you had significant sun exposure, tanning, or a sunburn in the last 2 weeks?","type":"boolean","flag_when":true},
  {"id":"antibiotics","label":"Are you currently taking antibiotics?","type":"boolean","flag_when":true},
  {"id":"autoimmune","label":"Do you have an autoimmune or skin condition (eczema, psoriasis, rosacea, lupus)?","type":"boolean","flag_when":true},
  {"id":"latex","label":"Do you have a latex allergy?","type":"boolean","flag_when":true},
  {"id":"hydroquinone","label":"Are you using hydroquinone or any prescription lightening cream?","type":"boolean","flag_when":true},
  {"id":"recent_wax","label":"Have you waxed the area you want treated in the last 2 weeks?","type":"boolean","flag_when":true},
  {"id":"allergies","label":"List any allergies (products, ingredients, medications).","type":"text"},
  {"id":"medications","label":"List any medications or supplements you take.","type":"text"},
  {"id":"skin_concerns","label":"What are your main skin concerns?","type":"multiselect","options":["Acne","Dry acne","Congestion","Dryness","Dullness","Fine lines","Hyperpigmentation","Melasma","Redness","Scarring","Sensitivity","Texture","Ingrown hairs","Underarm darkening","Inner thigh darkening","Intimate area darkening"]},
  {"id":"current_products","label":"What do you currently use on your skin?","type":"text"},
  {"id":"fitzpatrick","label":"How does your skin usually react to sun?","type":"select","options":["Always burns, never tans","Burns easily, tans minimally","Burns sometimes, tans gradually","Burns rarely, tans easily","Rarely burns, tans deeply","Never burns, deeply pigmented"]},
  {"id":"goals","label":"What would you like to get out of your visit?","type":"text"}
]$$::jsonb,
  array(select id from public.service_categories)
on conflict (slug, version) do nothing;

-- ── Site copy ────────────────────────────────────────────────
insert into public.site_content (key, value, label) values
  ('hero', '{
     "eyebrow": "Licensed Esthetician — Fresno, CA",
     "heading": "Skin that looks like itself, only better.",
     "sub": "A private studio near Fig Garden Village. Corrective facials, chemical peels, hard-wax hair removal, skin lightening, and nails — with an honest read on your skin and a protocol built for it.",
     "cta": "Book an appointment"
   }'::jsonb, 'Homepage hero'),

  ('about', '{
     "heading": "About the studio",
     "body": "559 Flawless is a private, single-room salon on West Shaw in Fresno. You will not be rushed, handed off, or sold a package you did not ask about. Every service starts with a look at your skin that day and a straight answer about what will actually help."
   }'::jsonb, 'About section'),

  ('policies', '{
     "cancellation": "Please give at least 24 hours notice to cancel or reschedule. Cancellations inside 24 hours forfeit the deposit.",
     "late": "After 15 minutes late, your service may need to be shortened or rescheduled so the next client is not affected.",
     "deposits": "Deposits go toward your service total and are only kept for late cancellations or no-shows.",
     "intimate": "Intimate waxing and skin lightening are for clients 18 and older, are performed privately by a licensed esthetician, and can be stopped at any point without explanation."
   }'::jsonb, 'Policies'),

  ('contact', '{
     "phone": "(559) 477-2999",
     "email": "",
     "address": "285 W Shaw Ave",
     "city": "Fresno",
     "state": "CA",
     "instagram": "559Flawless",
     "note": "Private salon near Fig Garden Village. By appointment only."
   }'::jsonb, 'Contact details'),

  ('shop', '{
     "external_store_url": "https://ramarketplace.com/store/559flawless",
     "external_store_name": "Rhonda Allison",
     "heading": "The products I actually use on you.",
     "body": "Home care runs through my authorized Rhonda Allison store. You buy and it ships directly to you — same professional line I use in treatment, not a drugstore version of it.",
     "cta": "Shop the full Rhonda Allison store"
   }'::jsonb, 'Shop — external store')
on conflict (key) do nothing;

-- ── Hours ────────────────────────────────────────────────────
-- PLACEHOLDER: the studio's real hours were not supplied. Edit in the
-- dashboard, or update public.business_hours directly.
insert into public.business_hours (day_of_week, opens_at, closes_at, is_closed) values
  (0, null, null, true),
  (1, '10:00', '18:00', false),
  (2, '10:00', '18:00', false),
  (3, '10:00', '19:00', false),
  (4, '10:00', '19:00', false),
  (5, '09:00', '17:00', false),
  (6, '09:00', '15:00', false)
on conflict (day_of_week) do nothing;

-- ── FAQs ─────────────────────────────────────────────────────
insert into public.faqs (question, answer, category, sort_order) values
  ('How long should my hair be for waxing?',
   'About a quarter inch — roughly two weeks of growth. Shorter than that and the wax cannot grip; much longer and it is more uncomfortable than it needs to be.',
   'Waxing', 1),

  ('Does a Brazilian hurt?',
   'The first one is the most uncomfortable, and it gets noticeably easier after that as the hair grows back finer. Hard wax is used throughout, which is gentler on intimate skin than strip wax. You can ask to pause or stop at any point.',
   'Waxing', 2),

  ('Can I book a Brazilian on my period?',
   'Yes, as long as you are wearing a fresh tampon or cup. The area is more sensitive that week, so some clients prefer to schedule around it.',
   'Waxing', 3),

  ('What is skin lightening, and does it actually work?',
   'It is a cosmetic treatment for hyperpigmentation in the underarms, inner thighs, and intimate areas, using acids and enzymes. Darkening there is normal and is usually caused by friction, hair removal, hormones, or genetics — it is not a hygiene problem. It does work, but gradually and over a series, and how much depends on your skin type. You will get an honest answer at your consultation about what is realistic for you.',
   'Skin Lightening', 4),

  ('Why do I need a consultation and patch test first?',
   'Because one protocol does not fit every skin type. A low percentage of glycolic acid lightens some skin and does nothing at all for other skin, and intimate skin is often more resilient than underarm skin — it needs stronger acids and enzymes. Assessing your skin in person is the only way to build a protocol that will actually work, and the patch test confirms your skin tolerates it.',
   'Skin Lightening', 5),

  ('Why might I need to wax as part of lightening?',
   'Sometimes the pigment sits in the older surface layer. Waxing lifts that layer off and reveals the newer, lighter skin underneath. A Brazilian can be added to a lightening session for $50 when that is what your skin needs.',
   'Skin Lightening', 6),

  ('What is the difference between a superficial and a mid-depth peel?',
   'A superficial peel works on the outer layers — light flaking for a few days and no real downtime. The mid-depth Baby Boomer peel goes deeper, removes considerably more, and is paired with melanin suppressants to even out tone. It usually follows a few superficial peels and it has real downtime, so do not book it the week before an event.',
   'Peels', 7),

  ('Does dermaplaning make facial hair grow back thicker?',
   'No. That is a myth. The hair grows back exactly as it was. Dermaplaning uses a surgical blade at a 45-degree angle to exfoliate the top layer of skin; removing the peach fuzz is a side benefit, not the purpose.',
   'Facials', 8),

  ('I have dry acne, not oily acne. Can you help?',
   'Yes — dry acne is a particular focus here. It behaves differently from oily acne because the barrier is usually already compromised, so the standard strip-it-dry approach makes it worse. Treatment focuses on gently decongesting, calming inflammation, and rebuilding the barrier with serums and peptides.',
   'Facials', 9),

  ('What should I avoid before my appointment?',
   'Skip retinoids and acid exfoliants for a week, avoid sun exposure and tanning for two weeks before any peel, and come with clean skin if you can.',
   'General', 10),

  ('Do you take walk-ins?',
   'Appointments only. It is a private single-room salon, so booking ahead is the only way to guarantee a slot.',
   'General', 11)
on conflict do nothing;

-- ── Announcements ────────────────────────────────────────────
-- Seeded inactive. Turn on and edit dates in Dashboard → Marketing.
insert into public.announcements (title, body, link_url, link_label, variant, is_active) values
  ('New client special — Brazilian $65',
   'Regular Brazilians, female clients, new clients only.',
   '/services/waxing/full-brazilian', 'Book now', 'promo', false),
  ('Hello Kitties + underarms $300, reduced from $350',
   'Add a Brazilian to your lightening session for $50.',
   '/services/skin-lightening/hello-kitties-underarms', 'Learn more', 'promo', false),
  ('Free corrective facial with any 3 supporting products',
   null, '/shop', 'Shop products', 'promo', false)
on conflict do nothing;
