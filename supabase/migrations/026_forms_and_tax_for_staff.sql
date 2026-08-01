-- ============================================================
-- 559 Flawless — 026: staff maintain the forms and the tax rate
--
-- Both were admin-only, which in a one-or-two-person studio means the owner is
-- the bottleneck on her own paperwork. Opening them up, with the one guard that
-- actually matters kept intact.
-- ============================================================

-- ── 1. Consent and intake forms ──────────────────────────────
--
-- The invariant from the start has been that editing a template can never
-- rewrite what somebody already agreed to. `consent_signatures.body_snapshot`
-- holds a verbatim copy of the text that was on screen, so history is safe
-- whatever happens here — but a live form whose wording silently changes under
-- an unchanged version number makes the archive impossible to read back.
--
-- So: a form nobody has signed can be edited freely. A form with signatures is
-- versioned instead — a new row, a new version number, the old one retired and
-- still pointed at by the signatures that used it.

drop policy if exists "admin writes consent forms" on public.consent_forms;
drop policy if exists "admin writes intake forms" on public.intake_forms;

drop policy if exists "manager writes consent forms" on public.consent_forms;
create policy "manager writes consent forms" on public.consent_forms
  for all using (public.is_manager()) with check (public.is_manager());

drop policy if exists "manager writes intake forms" on public.intake_forms;
create policy "manager writes intake forms" on public.intake_forms
  for all using (public.is_manager()) with check (public.is_manager());

/**
 * Refuse a change to the wording of a form that has already been signed.
 *
 * Not because history would be lost — body_snapshot covers that — but because
 * "version 2" has to mean one specific piece of text. Two clients signing
 * different wording under the same version number is exactly the ambiguity the
 * version number exists to remove. The UI calls publish_consent_version()
 * instead, which supersedes rather than mutates.
 */
create or replace function public.consent_form_guard_signed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.body is distinct from old.body and exists (
    select 1 from public.consent_signatures where consent_form_id = old.id
  ) then
    raise exception
      'This form has been signed. Publish a new version rather than editing the wording.';
  end if;
  return new;
end;
$$;

drop trigger if exists consent_forms_guard_signed on public.consent_forms;
create trigger consent_forms_guard_signed
  before update on public.consent_forms
  for each row execute function public.consent_form_guard_signed();

-- A signed form must not be deleted out from under its signatures either.
create or replace function public.consent_form_block_signed_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.consent_signatures where consent_form_id = old.id) then
    raise exception
      'Clients have signed this form. Switch it off instead of deleting it.';
  end if;
  return old;
end;
$$;

drop trigger if exists consent_forms_block_signed_delete on public.consent_forms;
create trigger consent_forms_block_signed_delete
  before delete on public.consent_forms
  for each row execute function public.consent_form_block_signed_delete();

/**
 * Publish a new version of a consent form.
 *
 * The old row stays exactly as it was and stays linked to every signature that
 * used it — which is what makes "what did this person actually agree to?"
 * answerable years later. The new row inherits which services it applies to
 * unless told otherwise, and becomes the one clients are asked to sign.
 */
create or replace function public.publish_consent_version(
  p_form_id     bigint,
  p_title       text,
  p_body        text,
  p_service_ids bigint[] default null,
  p_category_ids bigint[] default null,
  p_revalidate_after_days int default null,
  p_requires_initials boolean default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  old_form public.consent_forms;
  new_id   bigint;
  next_version int;
begin
  if not public.is_manager() and auth.uid() is not null then
    raise exception 'Only a manager can publish a consent form';
  end if;

  select * into old_form from public.consent_forms where id = p_form_id;
  if old_form is null then
    raise exception 'No such consent form';
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.consent_forms where slug = old_form.slug;

  insert into public.consent_forms
    (slug, version, title, body, service_ids, category_ids,
     requires_initials, revalidate_after_days, is_active)
  values
    (old_form.slug, next_version, p_title, p_body,
     coalesce(p_service_ids, old_form.service_ids),
     coalesce(p_category_ids, old_form.category_ids),
     coalesce(p_requires_initials, old_form.requires_initials),
     coalesce(p_revalidate_after_days, old_form.revalidate_after_days),
     true)
  returning id into new_id;

  -- Retire the previous version. It keeps its signatures and stays readable.
  update public.consent_forms set is_active = false where id = p_form_id;

  return new_id;
end;
$$;

-- ── 2. The sales tax rate ────────────────────────────────────
--
-- site_settings is admin-only, and rightly so — it also carries the analytics
-- script injection slots, where a write is effectively arbitrary JavaScript on
-- every page. The tax rate is not that, so it gets its own narrow door rather
-- than the whole table being opened.

/**
 * Read the studio's sales tax rate as a fraction. Falls back to Fresno County's
 * combined 8.35% if it has never been set or the stored value is nonsense.
 */
create or replace function public.sales_tax_rate()
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce(
    (
      select case
        when s.text_value ~ '^0?\.[0-9]+$' and s.text_value::numeric < 1
          then s.text_value::numeric
        else null
      end
      from public.site_settings s
      where s.key = 'sales_tax_rate' and s.is_active
      order by s.version desc
      limit 1
    ),
    0.0835
  );
$$;

/**
 * Set the sales tax rate. Manager and above.
 *
 * Takes a fraction, not a percentage — 0.0835, not 8.35 — and refuses anything
 * outside a sane band. A fat-fingered 8.35 would put 835% tax on every receipt,
 * which is the kind of mistake worth making impossible rather than merely
 * unlikely.
 */
create or replace function public.set_sales_tax_rate(p_rate numeric)
returns numeric language plpgsql security definer set search_path = public as $$
begin
  if not public.is_manager() and auth.uid() is not null then
    raise exception 'Only a manager can change the tax rate';
  end if;

  if p_rate is null or p_rate < 0 or p_rate >= 0.30 then
    raise exception
      'Enter the rate as a decimal between 0 and 0.30 — 0.0835 for 8.35%%, not 8.35';
  end if;

  update public.site_settings
  set text_value = trim(to_char(p_rate, 'FM0.999999')),
      updated_at = now()
  where key = 'sales_tax_rate' and is_active;

  if not found then
    insert into public.site_settings
      (key, type, version, text_value, label, description, is_active)
    values
      ('sales_tax_rate', 'config', 1, trim(to_char(p_rate, 'FM0.999999')),
       'Sales tax rate',
       'Applied to in-store product sales. Enter as a decimal, not a percentage.',
       true);
  end if;

  return p_rate;
end;
$$;

-- Staff need to read config settings to price a sale; they still cannot write
-- the table directly, and the script-injection rows stay admin-only on read.
drop policy if exists "staff reads config settings" on public.site_settings;
create policy "staff reads config settings" on public.site_settings
  for select using (public.is_staff() and type in ('config', 'policy', 'content'));
