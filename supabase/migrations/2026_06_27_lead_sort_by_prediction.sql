-- Sort lead lists by the live ICP MODEL score, not the stale build-time seed.
--
-- The leads view carries fields->>'icp_score' = the seed stamped at import time.
-- The real, evolving score is the latest icp_fit prediction for the lead's
-- entity (lead.id IS the entity id). The list display already overlays the
-- prediction at read time; this makes the ICP sort agree, by ordering on
-- coalesce(prediction score, seed) so unscored leads still fall back cleanly.
--
-- Idempotent. CREATE OR REPLACE only — no data change.

CREATE OR REPLACE FUNCTION lead_list_leads(
  p_ws UUID, p_list UUID, p_lim INT DEFAULT 50, p_off INT DEFAULT 0,
  p_icp TEXT DEFAULT NULL, p_sort TEXT DEFAULT 'recent'
) RETURNS SETOF leads LANGUAGE sql STABLE AS $$
  SELECT l.* FROM leads l
  LEFT JOIN LATERAL (
    SELECT (p.predicted_value->>'score')::numeric AS score
    FROM predictions p
    WHERE p.workspace_id = p_ws AND p.entity_id = l.id AND p.kind = 'icp_fit'
    ORDER BY p.predicted_at DESC
    LIMIT 1
  ) pred ON TRUE
  WHERE l.workspace_id = p_ws AND l.lead_list_id = p_list
    AND (p_icp IS NULL OR (l.fields->>'icp') = p_icp)
  ORDER BY
    CASE WHEN p_sort = 'icp_score_desc'
      THEN COALESCE(pred.score, (l.fields->>'icp_score')::numeric) END DESC NULLS LAST,
    CASE WHEN p_sort = 'icp_score_asc'
      THEN COALESCE(pred.score, (l.fields->>'icp_score')::numeric) END ASC  NULLS LAST,
    l.created_at DESC
  LIMIT GREATEST(p_lim, 1) OFFSET GREATEST(p_off, 0)
$$;
