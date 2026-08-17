-- ── The word the database kept ───────────────────────────────
--
-- The credential was corrected in the code and the site still said the old one.
-- Not a caching problem and not a deploy problem: the strings that were still
-- wrong are not in the code at all.
--
-- Commit 17667bc fixed "esthetician" by editing 010_seed.sql, which reads like
-- a fix and is not one. 010 ran against this database long ago and its inserts
-- are `on conflict do nothing`; re-running it changes nothing, and editing an
-- applied migration changes nothing twice over. The seed file and the live rows
-- have simply disagreed ever since — the file is right, the database is what
-- gets rendered. This is the migration that should have accompanied that commit.
--
-- What was still wrong, found by rendering every public route against the real
-- database rather than by grepping:
--
--   site_content.hero      the homepage eyebrow, "Licensed Esthetician — Fresno, CA"
--   site_content.policies  the intimate-services paragraph
--   site_settings          the privacy policy and the terms of service
--
-- The two halves are treated differently on purpose. site_content is marketing
-- copy with no version column: it is corrected in place, because there is no
-- past state of it that anyone relied on. The policy documents in site_settings
-- have `version`, `effective_at` and `superseded_at`, and the privacy page
-- deliberately reads the newest ACTIVE row — so those get a new version and the
-- old one is superseded rather than rewritten. Nothing records which version a
-- client read, so the bump costs nothing and buys an honest history.
--
-- The remaining tables are swept for the same reason a fix should not need
-- doing twice. They are clean on this database today; the statements are here so
-- the migration is correct against any environment, including a fresh one.
--
-- Deliberately NOT swept: client_notes, intake_submissions, and
-- consent_signatures.body_snapshot. Those are records of what somebody wrote or
-- agreed to at a moment. Correcting a word in them is not a correction.
-- consent_forms was handled in 065, with the version-vs-edit branch it needed.

-- The replacement, once, so ten call sites cannot drift apart. Order matters:
-- the specific phrasings go first, and the articles are fixed before the bare
-- noun so "an esthetician" does not become "an cosmetologist".
create or replace function public.fix_credential_wording(t text) returns text
language sql immutable as $$
  select replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
    $1,
    'Licensed Estheticians', 'Licensed Cosmetologists'),
    'licensed estheticians', 'Licensed Cosmetologists'),
    'Licensed Esthetician',  'Licensed Cosmetologist'),
    'licensed esthetician',  'Licensed Cosmetologist'),
    'An esthetician',        'A cosmetologist'),
    'an esthetician',        'a cosmetologist'),
    'Estheticians',          'Cosmetologists'),
    'estheticians',          'cosmetologists'),
    'Esthetician',           'Cosmetologist'),
    'esthetician',           'cosmetologist')
$$;

-- ── 1. Site copy: corrected in place ─────────────────────────
-- jsonb out to text and back so every string in the blob is covered whatever
-- its key, and so a hand-edit to some other field survives untouched.
update public.site_content
   set value = public.fix_credential_wording(value::text)::jsonb
 where value::text like '%sthetician%';

-- ── 2. The policy documents: superseded, not rewritten ───────
do $$
declare
  doc    public.site_settings;
  next_v int;
  n      int := 0;
begin
  for doc in
    select * from public.site_settings
    where key in ('privacy_policy', 'terms_of_service')
      and is_active
      and text_value is not null
      and text_value like '%sthetician%'
    order by key
  loop
    select coalesce(max(version), 0) + 1 into next_v
      from public.site_settings where key = doc.key;

    insert into public.site_settings
      (key, type, version, value, text_value, label, description, help_text,
       effective_at, is_active)
    values
      (doc.key, doc.type, next_v, doc.value,
       public.fix_credential_wording(doc.text_value),
       doc.label, doc.description, doc.help_text, now(), true);

    update public.site_settings
       set is_active = false, superseded_at = now()
     where id = doc.id;

    n := n + 1;
    raise notice '%: v% superseded by v%', doc.key, doc.version, next_v;
  end loop;

  raise notice 'policy documents republished: %', n;
end $$;

-- ── 3. The rest of the published copy ────────────────────────
update public.services
   set description = public.fix_credential_wording(description),
       details     = public.fix_credential_wording(details),
       aftercare   = public.fix_credential_wording(aftercare)
 where coalesce(description, '') || coalesce(details, '') || coalesce(aftercare, '')
       like '%sthetician%';

update public.service_categories
   set description = public.fix_credential_wording(description)
 where description like '%sthetician%';

update public.faqs
   set question = public.fix_credential_wording(question),
       answer   = public.fix_credential_wording(answer)
 where question || answer like '%sthetician%';

update public.testimonials
   set body = public.fix_credential_wording(body)
 where body like '%sthetician%';

update public.announcements
   set title = public.fix_credential_wording(title),
       body  = public.fix_credential_wording(body)
 where title || coalesce(body, '') like '%sthetician%';

update public.staff_profiles
   set headline = public.fix_credential_wording(headline),
       bio      = public.fix_credential_wording(bio)
 where coalesce(headline, '') || coalesce(bio, '') like '%sthetician%';

-- specialities and certifications are text[], so each element is rewritten and
-- the original order preserved.
update public.staff_profiles sp
   set certifications = (
         select array_agg(public.fix_credential_wording(x) order by ord)
         from unnest(sp.certifications) with ordinality as u(x, ord))
 where array_to_string(sp.certifications, ' ') like '%sthetician%';

update public.staff_profiles sp
   set specialities = (
         select array_agg(public.fix_credential_wording(x) order by ord)
         from unnest(sp.specialities) with ordinality as u(x, ord))
 where array_to_string(sp.specialities, ' ') like '%sthetician%';

drop function public.fix_credential_wording(text);

-- ── 4. Say what is left ──────────────────────────────────────
-- Not an assertion, a report. The clinical tables are excluded above by choice,
-- and this prints anything else that still holds the word so it is found here
-- rather than on the website a second time.
do $$
declare
  left_over int := 0;
  c int;
begin
  select count(*) into c from public.site_content   where value::text like '%sthetician%';
  left_over := left_over + c;
  select count(*) into c from public.site_settings  where coalesce(text_value,'') like '%sthetician%' and is_active;
  left_over := left_over + c;
  select count(*) into c from public.consent_forms  where body like '%sthetician%' and is_active;
  left_over := left_over + c;

  if left_over > 0 then
    raise notice 'STILL PRESENT in % active published row(s) — check consent_forms (065) ran', left_over;
  else
    raise notice 'no active published row still says esthetician';
  end if;
end $$;
