-- ============================================================
-- 559 Flawless — 070: the approval names the forms
--
-- Every online booking is held for review (booking_settings.auto_confirm is
-- off), and 049 already tells the client the verdict: "Your appointment is
-- confirmed", linking their appointment page. What the studio asked for next
-- is that the approval also PROMPT the paperwork: tell the client, by name,
-- which consent forms their visit still needs, so the signing happens on the
-- sofa at home and not on the treatment table.
--
-- A second notification, then, sent at the same pending→confirmed moment,
-- only when something is actually outstanding. The reckoning of "outstanding"
-- lives here, beside the rows it reads: an active form whose targeting
-- overlaps the visit's services or their categories, minus every form the
-- client holds a live signature for — live meaning within the form's own
-- revalidation window (or the signature's explicit expiry). The client-side
-- checker reads the same tables the same way; this is the notification-grade
-- copy of that question, and the forms page remains the authority the link
-- lands on.
--
-- Every statement is guarded; running this twice changes nothing.
-- ============================================================

/**
 * On approval, name the forms the visit still needs.
 *
 * Best-effort by design: a notification is a nicety and the approval is not,
 * so the whole body swallows its own failures. No notification at all when
 * nothing is outstanding — an empty reminder is noise pretending to be help.
 */
create or replace function public.appointment_forms_nudge()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  titles text;
begin
  if new.status <> 'confirmed' or old.status <> 'pending' or new.client_id is null then
    return null;
  end if;

  begin
    with visit as (
      select
        coalesce(array_agg(distinct l.service_id), '{}'::bigint[])  as sids,
        coalesce(array_agg(distinct sv.category_id), '{}'::bigint[]) as cids
      from public.appointment_services l
      join public.services sv on sv.id = l.service_id
      where l.appointment_id = new.id and l.service_id is not null
    ),
    needed as (
      select distinct f.slug, min(f.title) as title
      from public.consent_forms f, visit v
      where f.is_active
        and (f.service_ids && v.sids or f.category_ids && v.cids)
        and not exists (
          select 1
          from public.consent_signatures sig
          join public.consent_forms fv
            on fv.id = sig.consent_form_id and fv.slug = f.slug
          where sig.client_id = new.client_id
            and coalesce(
                  sig.expires_at,
                  sig.signed_at + make_interval(days => f.revalidate_after_days)
                ) > now()
        )
      group by f.slug
    )
    select string_agg(title, ', ' order by title) into titles from needed;

    if titles is not null then
      insert into public.notifications (user_id, type, title, body, link, appointment_id)
      values (
        new.client_id,
        'consent_needed',
        'Forms to sign before your visit',
        'Your visit needs: ' || titles || '. Signing takes a minute and saves time on the day.',
        '/account/forms',
        new.id
      );
    end if;
  exception when others then
    -- The approval stands; a missed nudge is a log line, not a failure.
    null;
  end;

  return null;
end;
$$;

drop trigger if exists appointments_forms_nudge on public.appointments;
create trigger appointments_forms_nudge
  after update of status on public.appointments
  for each row execute function public.appointment_forms_nudge();
