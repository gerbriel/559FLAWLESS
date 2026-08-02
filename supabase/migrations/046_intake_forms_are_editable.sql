-- ============================================================
-- 559 Flawless — 046: intake forms get the protections consent forms have
--
-- 026 opened `intake_forms` to managers so staff could maintain the health
-- questionnaire without an admin. It gave them the policy and stopped there —
-- consent forms got a versioning function and two guard triggers, intake got
-- nothing, and there has never been a screen for it either. So the table has
-- been writable-but-unreachable for twenty migrations.
--
-- The screen arrives with this migration. These are the invariants it needs,
-- and they are the same two consent forms have, for the same reason:
--
--   * `intake_submissions.answers` is a jsonb object keyed by question id.
--     Change or remove a question on a form that has answers and every stored
--     submission becomes partly unreadable — the answers survive, but nothing
--     records what was asked. That is worse than losing them, because it looks
--     fine.
--
--   * Deleting a form orphans its submissions outright.
--
-- Both are handled the way 026 handled them: mutate nothing that has been
-- answered, supersede it instead, and refuse the delete.
-- ============================================================

/**
 * Refuse a change to the QUESTIONS of a form somebody has already answered.
 *
 * Everything else about a live form stays editable — the title, which services
 * it applies to, whether it is in use. It is only the questions that carry the
 * meaning of stored answers.
 */
create or replace function public.intake_form_guard_answered()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.questions is distinct from old.questions and exists (
    select 1 from public.intake_submissions where intake_form_id = old.id
  ) then
    raise exception
      'Clients have answered this form. Publish a new version rather than changing the questions.';
  end if;
  return new;
end;
$$;

drop trigger if exists intake_forms_guard_answered on public.intake_forms;
create trigger intake_forms_guard_answered
  before update on public.intake_forms
  for each row execute function public.intake_form_guard_answered();

create or replace function public.intake_form_block_answered_delete()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.intake_submissions where intake_form_id = old.id) then
    raise exception
      'Clients have filled this form in. Switch it off instead of deleting it.';
  end if;
  return old;
end;
$$;

drop trigger if exists intake_forms_block_answered_delete on public.intake_forms;
create trigger intake_forms_block_answered_delete
  before delete on public.intake_forms
  for each row execute function public.intake_form_block_answered_delete();

/**
 * Publish a new version of an intake form.
 *
 * Mirrors publish_consent_version(). The old row stays exactly as it was and
 * stays linked to every submission that used it, so an answer sheet from two
 * years ago can still be read against the questions that produced it.
 */
create or replace function public.publish_intake_version(
  p_form_id      bigint,
  p_title        text,
  p_questions    jsonb,
  p_service_ids  bigint[] default null,
  p_category_ids bigint[] default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  old_form public.intake_forms;
  new_id   bigint;
  next_version int;
begin
  if not public.is_manager() and auth.uid() is not null then
    raise exception 'Only a manager can publish an intake form';
  end if;

  select * into old_form from public.intake_forms where id = p_form_id;
  -- `record is null` is only true when every field is null, so test a column.
  if old_form.id is null then
    raise exception 'No such intake form';
  end if;

  if jsonb_typeof(p_questions) is distinct from 'array' then
    raise exception 'Questions must be a JSON array';
  end if;

  select coalesce(max(version), 0) + 1 into next_version
  from public.intake_forms where slug = old_form.slug;

  insert into public.intake_forms
    (slug, version, title, questions, service_ids, category_ids, is_active)
  values
    (old_form.slug, next_version, p_title, p_questions,
     coalesce(p_service_ids, old_form.service_ids),
     coalesce(p_category_ids, old_form.category_ids),
     true)
  returning id into new_id;

  -- Retire the previous version. It keeps its submissions and stays readable.
  update public.intake_forms set is_active = false where id = p_form_id;

  return new_id;
end;
$$;

revoke all on function public.publish_intake_version(bigint, text, jsonb, bigint[], bigint[])
  from public, anon;
grant execute on function public.publish_intake_version(bigint, text, jsonb, bigint[], bigint[])
  to authenticated, service_role;

comment on function public.publish_intake_version(bigint, text, jsonb, bigint[], bigint[]) is
  'Supersede an intake form with a new version, leaving the old one and its '
  'submissions intact. Used when the questions change and answers already exist.';
