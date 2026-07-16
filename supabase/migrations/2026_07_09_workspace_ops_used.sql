-- Workspace-scoped ops rollups — the per-workspace siblings of team_ops_used.
--
-- team_ops_used sums billable_ops across EVERY workspace on the team, which is
-- correct for billing (the team is the billed entity) but wrong for the Ops
-- page, where each workspace must only ever show its own ops.
--
-- Same semantics as team_ops_used: SUM(billable_ops), not COUNT(*) — a single
-- log row can carry more than one billable op.
--
-- Idempotent. CREATE OR REPLACE only — no data change.

CREATE OR REPLACE FUNCTION workspace_ops_used(p_workspace_id uuid, p_since timestamptz)
RETURNS bigint
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(SUM(wsl.billable_ops), 0)::bigint
  FROM workspace_system_log wsl
  WHERE wsl.workspace_id = p_workspace_id
    AND wsl.billable_ops > 0
    AND wsl.occurred_at >= p_since;
$$;

-- The four Ops-page headline cards, counted in one round-trip for ONE workspace.
--
-- Counted here rather than in PostgREST because the "failed" card needs an OR of
-- ILIKEs across two columns, which is awkward and easy to get subtly wrong as a
-- .or() filter string. The caller passes the retrieval event types and the agent
-- sources so plans.mjs stays the single source of truth for both lists.
--
-- all_time mirrors the old /api/usage number: SUM(billable_ops) since the epoch,
-- plus the legacy pre-Billing-v2 memory_ops_log rows (each = 1 op), so the
-- lifetime figure stays continuous. Display-only; billing never reads this.
CREATE OR REPLACE FUNCTION workspace_ops_stats(
  p_workspace_id  uuid,
  p_since         timestamptz,
  p_retrieval     text[],
  p_agent_sources text[],
  p_billed_only   boolean DEFAULT false
)
RETURNS TABLE (all_time bigint, in_range bigint, failed bigint, agent bigint, "system" bigint)
LANGUAGE sql STABLE
AS $$
  WITH scoped AS (
    SELECT wsl.source, wsl.event_type, wsl.summary
    FROM workspace_system_log wsl
    WHERE wsl.workspace_id = p_workspace_id
      AND (p_since IS NULL OR wsl.occurred_at >= p_since)
      AND (NOT p_billed_only OR wsl.event_type = ANY(p_retrieval))
  )
  SELECT
    workspace_ops_used(p_workspace_id, '1970-01-01'::timestamptz)
      + (SELECT COUNT(*) FROM memory_ops_log m WHERE m.workspace_id = p_workspace_id),
    (SELECT COUNT(*) FROM scoped),
    (SELECT COUNT(*) FROM scoped s
       WHERE s.summary    ~* '(fail|error|denied|rejected|exception|invalid|unauthorized)'
          OR s.event_type ~* '(fail|error|denied|rejected|exception|invalid|unauthorized)'),
    (SELECT COUNT(*) FROM scoped s WHERE s.source = ANY(p_agent_sources)),
    (SELECT COUNT(*) FROM scoped s WHERE NOT (s.source = ANY(p_agent_sources)));
$$;
