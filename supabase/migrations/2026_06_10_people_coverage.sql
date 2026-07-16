-- people_coverage — attribute-based coverage estimate with enrichment freshness.
--
-- Answers "how many <agency founders> do we already have, and how fresh?" WITHOUT
-- pasting identifiers — the planning question you ask before building a list in
-- Apollo/DeepSearch/Clay. Matches existing person entities by job_title (and an
-- optional keyword across title/company/department), then buckets them by
-- enrichment freshness (never enriched / stale beyond p_stale_days / fresh+verified).
--
-- It's a rough estimate by design: title is precise, but "industry" lives on the
-- linked company, so keyword matches person-level claims (title/company/department).
-- Called via the service-role client (RLS bypassed); scoped by p_workspace.

CREATE OR REPLACE FUNCTION people_coverage(
  p_workspace  UUID,
  p_title      TEXT DEFAULT NULL,
  p_keyword    TEXT DEFAULT NULL,
  p_stale_days INT  DEFAULT 90,
  p_limit      INT  DEFAULT 25
) RETURNS JSONB
LANGUAGE sql STABLE AS $$
  WITH matched AS (
    SELECT e.id
    FROM entities e
    WHERE e.workspace_id = p_workspace
      AND e.type = 'person' AND e.status = 'active'
      AND (p_title IS NULL OR EXISTS (
        SELECT 1 FROM claims c
        WHERE c.entity_id = e.id AND c.property = 'job_title'
          AND c.invalid_at IS NULL AND (c.value #>> '{}') ILIKE '%'||p_title||'%'))
      AND (p_keyword IS NULL OR EXISTS (
        SELECT 1 FROM claims c
        WHERE c.entity_id = e.id AND c.property IN ('job_title','company','department')
          AND c.invalid_at IS NULL AND (c.value #>> '{}') ILIKE '%'||p_keyword||'%'))
  ),
  enr AS (
    SELECT m.id,
      (SELECT max(o.observed_at) FROM observations o
         WHERE o.entity_id = m.id AND o.method = 'enrichment') AS enriched_at,
      (SELECT c.value #>> '{}' FROM claims c
         WHERE c.entity_id = m.id AND c.property = 'reachability_status'
           AND c.invalid_at IS NULL LIMIT 1) AS email_status,
      (SELECT c.value #>> '{}' FROM claims c
         WHERE c.entity_id = m.id AND c.property = 'job_title'
           AND c.invalid_at IS NULL LIMIT 1) AS job_title,
      (SELECT c.value #>> '{}' FROM claims c
         WHERE c.entity_id = m.id AND c.property = 'company'
           AND c.invalid_at IS NULL LIMIT 1) AS company
    FROM matched m
  )
  SELECT jsonb_build_object(
    'total',           (SELECT count(*) FROM enr),
    'never_enriched',  (SELECT count(*) FROM enr WHERE enriched_at IS NULL),
    'stale',           (SELECT count(*) FROM enr WHERE enriched_at IS NOT NULL
                          AND enriched_at < now() - make_interval(days => p_stale_days)),
    'fresh_verified',  (SELECT count(*) FROM enr WHERE enriched_at >= now() - make_interval(days => p_stale_days)
                          AND email_status IS NOT NULL),
    'needs_enrichment',(SELECT count(*) FROM enr WHERE enriched_at IS NULL
                          OR enriched_at < now() - make_interval(days => p_stale_days)),
    'sample', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'entity_id',   s.id,
        'job_title',   s.job_title,
        'company',     s.company,
        'enriched_at', s.enriched_at,
        'email_status', s.email_status))
      FROM (SELECT * FROM enr ORDER BY enriched_at ASC NULLS FIRST LIMIT p_limit) s
    ), '[]'::jsonb)
  );
$$;
