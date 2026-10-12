-- Which entities have no row in the flattened list yet (GET-336).
--
-- entity_list_rows is what every list reads, and it is filled by a cursor that walks entities in
-- id order. Entity ids are random uuids, so an account created today lands at a random point in
-- that order — and if it lands BEHIND the cursor it waits for the cycle to wrap.
--
-- On a customer workspace the cycle has never wrapped. Measured 2026-09-18:
--
--   entities of type company (active)   N
--   rows in entity_list_rows            a few percent fewer than N
--   missing                              the rest  <- invisible on the Accounts list
--   cursor.last_completed_at             null      <- 21 hours into one cycle, never finished
--
-- `hasListRows` is true for the workspace, so the read path never falls back: an account with no
-- row is not stale, it is absent. The sweep needs to fill holes BEFORE it resumes crawling, and
-- to do that it must be able to ask which rows are missing. PostgREST cannot express a NOT EXISTS
-- across two tables, hence a function.
--
-- Deliberately additive: refresh_list_chunk is untouched. The worker pairs this with it by asking
-- for a missing id and then refreshing exactly that one entity.
create or replace function public.list_rows_missing_ids(
  ws uuid,
  p_kind text,
  p_limit integer default 500
)
returns table(id uuid)
language sql
stable
security definer
set search_path to 'public'
as $$
  select e.id
    from entities e
   where e.workspace_id = ws
     and e.type = case p_kind when 'account' then 'company' when 'person' then 'person' else 'deal' end
     and e.status = 'active'
     and not exists (
           select 1 from entity_list_rows r
            where r.workspace_id = ws and r.entity_id = e.id and r.kind = p_kind)
     -- An entity the projection deliberately EXCLUDES is not a hole. refresh_list_chunk skips
     -- anything flagged internal and the workspace's own company (and deletes their rows if any
     -- exist), so without the same rule here the sweep chases a row that must never exist, once
     -- per tick, forever. Found immediately: after filling one customer's ~260 holes, one remained —
     -- their own company, whose domain is the workspace's own domain.
     and not exists (
           select 1 from claims c
            where c.entity_id = e.id and c.property = 'is_internal' and c.invalid_at is null
              and lower(coalesce(c.value->>'value', c.value#>>'{}')) in ('true','t','1'))
     and not exists (
           select 1 from entity_identifiers ei, workspaces w
            where ei.entity_id = e.id and ei.kind = 'domain' and ei.status = 'active'
              and w.id = ws
              and lower(ei.value) = nullif(split_part(
                    regexp_replace(lower(coalesce(w.website,'')), '^https?://(www\.)?', ''), '/', 1), ''))
   order by e.id
   limit p_limit;
$$;

grant execute on function public.list_rows_missing_ids(uuid, text, integer) to service_role;
