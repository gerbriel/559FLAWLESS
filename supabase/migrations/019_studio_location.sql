-- ============================================================
-- 559 Flawless — 019: studio location
--
-- Coordinates for the map and the directions links. Kept in site_content with
-- the rest of the contact details so the studio can correct them from the
-- dashboard without a deploy — a pin that is one suite off is exactly the kind
-- of thing you want to fix in thirty seconds.
--
-- Geocoded from OpenStreetMap's Nominatim for 285 W Shaw Ave, Fresno CA 93704.
-- The building is a salon-suites address, so the pin is the building centroid
-- rather than a neighbouring tenant's own entry.
-- ============================================================

update public.site_content
set value = value
  || jsonb_build_object(
       'postal', '93704',
       'lat', 36.80828,
       'lon', -119.79670,
       -- What the directions links send to Google and Apple. Written out in
       -- full so the map pin and the directions target can never disagree.
       'directions_query', '285 W Shaw Ave, Fresno, CA 93704'
     )
where key = 'contact';

-- Seed it if the row does not exist yet (fresh database).
insert into public.site_content (key, value, label)
select 'contact', jsonb_build_object(
    'phone', '(559) 477-2999',
    'email', '',
    'address', '285 W Shaw Ave',
    'city', 'Fresno',
    'state', 'CA',
    'postal', '93704',
    'instagram', '559Flawless',
    'note', 'Private salon near Fig Garden Village. By appointment only.',
    'lat', 36.80828,
    'lon', -119.79670,
    'directions_query', '285 W Shaw Ave, Fresno, CA 93704'
  ), 'Contact details'
where not exists (select 1 from public.site_content where key = 'contact');
