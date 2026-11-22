-- ============================================================
-- 559 Flawless — 093: the order on the menu
--
-- The studio wants to drag the menu into the order it is read in: services,
-- the categories they sit under, and membership plans. Every list that shows
-- them already orders by `sort_order`; what was missing was a way to write a
-- whole new order at once. The category screen did it with one UPDATE per row
-- and no transaction, so a reorder that half-landed left two rows tied.
--
--   reorder_catalog(p_kind, p_ids)
--
--     p_kind   'services' | 'service_categories' | 'memberships'
--     p_ids    the rows in their new order, first to last
--
-- THE SCHEME. sort_order is written in steps of ten (10, 20, 30, ...), so a
-- number typed by hand in the service editor can still land between two rows
-- without renumbering anything. Only `sort_order` is written, and only on rows
-- whose number actually changes. Ids that do not exist are ignored, not
-- refused (a row deleted in another tab should not stop the rest of the order
-- from saving), and leave no gap. A repeated id keeps its first place.
--
-- SERVICES ARE NUMBERED ACROSS THE WHOLE MENU, NOT PER CATEGORY. The public
-- services pages and the booking flow group by category and sort within it,
-- but the home page (`order('sort_order').limit(6)`), the till and the desk's
-- book-for-client list read `services` by `sort_order` on its own. Numbering
-- per category (10, 20 in every category) would interleave the categories on
-- those screens. So `services.sort_order` is one sequence in menu order:
-- category by category, in category order, each category's services in the
-- order given. Concretely:
--
--   'services'            the services in p_ids take their positions within
--                         their own category in array order, ahead of any
--                         service of that category the array did not name
--                         (the dashboard always sends a whole category, so
--                         there are none). Then every service is renumbered
--                         10, 20, 30 ... by (category sort_order, category id,
--                         that within-category order).
--   'service_categories'  the categories in p_ids are numbered 10, 20, 30 in
--                         array order (the dashboard sends all of them), and
--                         the services are renumbered the same way so the
--                         flat lists follow the new category order too.
--   'memberships'         the plans in p_ids are numbered 10, 20, 30.
--
-- SECURITY DEFINER so a reorder is one transaction whatever the caller's
-- policies, which is why is_manager() is checked first: the write policies on
-- services (022), service_categories (022) and memberships (050) are all
-- is_manager(), and this function grants nothing they do not. It writes no
-- column 022's services_guard_gates() watches, so a manager is not refused by
-- that trigger, and services_touch / memberships_touch bump updated_at only on
-- the rows that moved.
--
-- Every statement is guarded; running this twice changes nothing.
--
-- TYPES: src/types/database.ts Functions gains reorder_catalog.
-- ============================================================

create or replace function public.reorder_catalog(p_kind text, p_ids bigint[])
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_manager() then
    raise exception 'Only a manager can reorder the menu' using errcode = '42501';
  end if;

  if p_kind is null or p_kind not in ('services', 'service_categories', 'memberships') then
    raise exception 'Unknown list to reorder: %', coalesce(p_kind, 'null')
      using errcode = '22023';
  end if;

  if p_ids is null then
    raise exception 'The new order must be a list' using errcode = '22023';
  end if;

  if p_kind = 'memberships' then
    update public.memberships m
       set sort_order = o.rank * 10
      from (
        -- Numbered over the ids that exist, so an unknown id leaves no gap.
        -- The first time an id appears decides its place; a repeat is ignored.
        select q.id, row_number() over (order by q.pos) as rank
          from (
            select t.id, min(t.pos) as pos
              from unnest(p_ids) with ordinality as t(id, pos)
              join public.memberships x on x.id = t.id
             group by t.id
          ) q
      ) o
     where m.id = o.id
       and m.sort_order is distinct from o.rank * 10;
    return;
  end if;

  if p_kind = 'service_categories' then
    update public.service_categories c
       set sort_order = o.rank * 10
      from (
        -- Numbered over the ids that exist, so an unknown id leaves no gap.
        -- The first time an id appears decides its place; a repeat is ignored.
        select q.id, row_number() over (order by q.pos) as rank
          from (
            select t.id, min(t.pos) as pos
              from unnest(p_ids) with ordinality as t(id, pos)
              join public.service_categories x on x.id = t.id
             group by t.id
          ) q
      ) o
     where c.id = o.id
       and c.sort_order is distinct from o.rank * 10;
  end if;

  -- services, and the second half of service_categories: one sequence across
  -- the menu, category by category. For 'service_categories' p_ids are not
  -- service ids, so no service is "named" and each category keeps its
  -- services in the order they already had.
  update public.services s
     set sort_order = n.rank * 10
    from (
      select sv.id,
             row_number() over (
               order by c.sort_order, c.id,
                        (o.pos is null),   -- named services first
                        o.pos,             -- in the order given
                        sv.sort_order,     -- then the rest, as they were
                        sv.id
             ) as rank
        from public.services sv
        join public.service_categories c on c.id = sv.category_id
        left join (
          select id, min(pos) as pos
            from unnest(case when p_kind = 'services' then p_ids else '{}'::bigint[] end)
                 with ordinality as t(id, pos)
           group by id
        ) o on o.id = sv.id
    ) n
   where s.id = n.id
     and s.sort_order is distinct from n.rank * 10;
end;
$$;

revoke all on function public.reorder_catalog(text, bigint[]) from public, anon;
grant execute on function public.reorder_catalog(text, bigint[]) to authenticated;
