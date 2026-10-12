-- Phase 4.3 — multi-hop graph traversal.
--
-- Traversal today is fixed 1-hop (buying committee, war-room). A question that spans 2+
-- edges ("which champion at an account KNOWS someone at a target account") can't be
-- expressed. This adds a bounded, cycle-guarded recursive walk over the resolved edges in
-- workspace_graph_edges, returning typed paths. Directed (subject -> object); depth-capped.
--
-- Read-only, STABLE, workspace-scoped by argument. Node-level audience filtering (which
-- accounts a member may see) is applied by the caller at the API layer — this returns the
-- raw reachable paths within a workspace.

create or replace function public.traverse_graph(
  p_workspace_id uuid,
  p_start_entity uuid,
  p_max_depth int default 3,
  p_edge_types text[] default null   -- null = any relationship verb
)
returns table (
  depth int,
  end_entity uuid,
  end_label text,
  path_entities uuid[],
  path_relationships text[]
)
language sql
stable
as $$
  with recursive walk as (
    -- Seed: depth 0, sitting on the start node.
    select
      0 as depth,
      p_start_entity as end_entity,
      null::text as end_label,
      array[p_start_entity] as path_entities,
      array[]::text[] as path_relationships
    union all
    select
      w.depth + 1,
      e.object_id,
      e.object_label,
      w.path_entities || e.object_id,
      w.path_relationships || e.relationship
    from walk w
    join public.workspace_graph_edges e
      on e.workspace_id = p_workspace_id
     and e.subject_id = w.end_entity
     and e.object_id is not null
     and (p_edge_types is null or e.relationship = any(p_edge_types))
    where w.depth < greatest(1, least(coalesce(p_max_depth, 3), 5))   -- clamp 1..5
      and not (e.object_id = any(w.path_entities))                    -- cycle guard
  )
  select depth, end_entity, end_label, path_entities, path_relationships
  from walk
  where depth > 0;
$$;
