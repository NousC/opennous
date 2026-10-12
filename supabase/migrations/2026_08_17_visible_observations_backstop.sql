-- Phase 4.1 — RLS permission backstop (defense-in-depth) for the raw observation layer.
--
-- Per-member privacy is enforced in application code today: every leak-critical reader adds
-- `.or(owner_user_id.is.null, owner_user_id.eq.<viewer>)`. It works, but a reader that FORGETS
-- the filter leaks — the app reads through service_role, which bypasses RLS, so there is no DB
-- backstop. This function is that backstop: the rawVisible predicate baked into the database,
-- so anything routed through it cannot return another member's rows regardless of what the
-- caller does. getObservations() routes its member-scope branch through this (admin/system
-- reads are unchanged and still read the table directly).
--
-- Note on the service_role + RLS trap: a plain RLS policy would do nothing for our traffic.
-- The guarantee here comes from the predicate living INSIDE the function body, not from RLS.
-- SECURITY DEFINER + a pinned search_path so it stays safe if base-table grants are tightened
-- later (the eventual "revoke direct select, force reads through the function" step).

create or replace function public.visible_observations(
  p_workspace_id uuid,
  p_entity_id uuid,
  p_viewer_user_id uuid,          -- the member reading; ignored when p_viewer_is_admin
  p_viewer_is_admin boolean,      -- true = owner/admin/system, sees all rows
  p_property text default null,
  p_kind text default null,
  p_as_of timestamptz default null,
  p_limit int default 200
)
returns table (
  id uuid,
  entity_id uuid,
  kind text,
  property text,
  value jsonb,
  source text,
  method text,
  source_confidence double precision,
  observed_at timestamptz,
  ingested_at timestamptz,
  owner_user_id uuid
)
language sql
stable
security definer
set search_path = public
as $$
  select o.id, o.entity_id, o.kind, o.property, o.value, o.source, o.method,
         o.source_confidence, o.observed_at, o.ingested_at, o.owner_user_id
  from public.observations o
  where o.workspace_id = p_workspace_id
    and o.entity_id = p_entity_id
    and (p_property is null or o.property = p_property)
    and (p_kind is null or o.kind = p_kind)
    and (p_as_of is null or o.observed_at <= p_as_of)
    -- THE BACKSTOP — the exact rawVisible predicate, enforced here, not by the caller:
    --   admin sees all · a null-owner row is shared · otherwise only the viewer's own rows.
    and (p_viewer_is_admin or o.owner_user_id is null or o.owner_user_id = p_viewer_user_id)
  order by o.observed_at desc
  limit least(coalesce(p_limit, 200), 5000);
$$;
