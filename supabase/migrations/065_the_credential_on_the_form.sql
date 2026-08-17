-- ── The credential, as it is actually held ───────────────────
--
-- The studio's licence is a California cosmetology licence, and the storefront
-- now says so everywhere. The consent templates seeded in 010 and 039 did not:
-- five of them still ask the client to agree to something about "my
-- esthetician". A consent form that names the wrong credential is the one place
-- the wording genuinely matters, because it is the sentence the client signed.
--
-- 026 made editing a signed form impossible on purpose, and that rule is right:
-- `body_snapshot` froze what each signature actually agreed to, and rewriting
-- the template would leave the two disagreeing. So this migration does not pick
-- one path for all five forms. It asks each one whether anybody has signed it:
--
--   nobody has  — the template is still just a draft in practice. Correct the
--                 typo in place; there is no history to protect and no reason
--                 to make a studio that has not opened yet carry a v2.
--   somebody has — publish a new version through the function 026 wrote for
--                 exactly this. v1 keeps its wording and keeps its signatures,
--                 which is what makes "what did this person agree to?"
--                 answerable in three years.
--
-- The second branch has a real cost, and it is the intended one: consent is
-- matched by form id (023), so everyone who signed v1 is asked for v2 on their
-- next booking. That is what "the wording changed" is supposed to do.
--
-- Only ACTIVE versions are touched. A superseded row is a historical document —
-- it is what somebody signed, and correcting its spelling would be the same
-- mistake as editing a signed form, one step removed.
--
-- Not touched: "esthetic services are cosmetic, not medical" in
-- general-treatment. That sentence describes the service, not the licence, and
-- it is still true.

do $$
declare
  f           public.consent_forms;
  new_body    text;
  new_id      bigint;
  new_version int;
  signed      boolean;
  bumped      int := 0;
  edited      int := 0;
begin
  for f in
    select * from public.consent_forms
    where is_active and body like '%esthetician%'
    order by slug
  loop
    new_body := replace(f.body, 'esthetician', 'cosmetologist');

    select exists (
      select 1 from public.consent_signatures where consent_form_id = f.id
    ) into signed;

    if signed then
      new_id := public.publish_consent_version(f.id, f.title, new_body);
      select version into new_version from public.consent_forms where id = new_id;
      bumped := bumped + 1;
      raise notice 'consent %: signed at v%, published v%', f.slug, f.version, new_version;
    else
      update public.consent_forms set body = new_body where id = f.id;
      edited := edited + 1;
      raise notice 'consent %: unsigned, corrected v% in place', f.slug, f.version;
    end if;
  end loop;

  raise notice 'consent wording: % corrected in place, % republished', edited, bumped;
end $$;

-- Aftercare is a plain column on the service, not a versioned agreement — the
-- client is told it, they do not sign it. A straight update is the whole fix.
update public.services
   set aftercare = replace(aftercare, 'esthetician', 'cosmetologist')
 where aftercare like '%esthetician%';
