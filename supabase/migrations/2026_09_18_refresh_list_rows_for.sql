-- Rebuild the flattened rows for named entities (GET-347).
--
-- entity_list_rows is what every list reads, and until now it was maintained ONLY by a cursor
-- crawling entities in id order. Ids are random uuids, so a row's freshness depended on where it
-- happened to sit relative to the cursor — and on a customer workspace the account cycle never completed at
-- all (GET-336: 21 hours in, last_completed_at still null, ~260 accounts with no row).
--
-- A projection maintained by a crawler has unbounded lag by construction. That is why 363 call
-- sites still read the `contacts`/`companies` views, which run 72 and 25 correlated subqueries per
-- row, and why every field we extract makes every page slower. The fix is to rebuild a row when
-- the claim under it settles, leaving the crawl as a safety net.
--
-- This deliberately does NOT re-implement the projection. refresh_list_chunk already knows how to
-- build a row and has been hardened over several incidents; it selects `id > p_after ORDER BY id
-- LIMIT n`, so passing the greatest id BELOW the target with a limit of 1 rebuilds exactly that
-- target. One RPC now refreshes a batch instead of one round trip per row.
--
-- The existence check matters: if the id is not an active entity of this kind, the aimed chunk
-- would rebuild whichever entity comes next instead, quietly refreshing the wrong row.
create or replace function public.refresh_list_rows_for(
  ws uuid,
  p_kind text,
  p_ids uuid[]
)
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  i uuid;
  prev uuid;
  n integer := 0;
  etype text := case p_kind when 'account' then 'company' when 'person' then 'person' else 'deal' end;
begin
  foreach i in array coalesce(p_ids, '{}'::uuid[]) loop
    if not exists (
      select 1 from entities e
       where e.id = i and e.workspace_id = ws and e.type = etype and e.status = 'active'
    ) then
      continue;
    end if;

    select e.id into prev
      from entities e
     where e.workspace_id = ws and e.type = etype and e.status = 'active' and e.id < i
     order by e.id desc
     limit 1;

    perform refresh_list_chunk(ws, p_kind, coalesce(prev, '00000000-0000-0000-0000-000000000000'::uuid), 1);
    n := n + 1;
  end loop;
  return n;
end $$;

grant execute on function public.refresh_list_rows_for(uuid, text, uuid[]) to service_role;
