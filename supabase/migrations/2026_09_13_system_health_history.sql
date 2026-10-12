-- System health history (GET-201): measure the system over weeks and months.
--
-- The nightly invariants job already kept one number per check per night in
-- invariant_checks. Everything else about how the system was doing lived in worker
-- log lines, which every deploy wipes — on 2026-09-13 two deploys erased the only
-- record of 90 model fallbacks and 8 credit failures. And nothing read any of it as a
-- trend, so a regression was recorded but found only if someone went looking.
--
-- Three writes and three reads:
--   pipeline_events   one row per thing that went wrong in a model call (fallback,
--                     outage, unparseable answer). Written by the worker as it happens.
--   system_metrics    a daily snapshot per workspace (coverage, facts, queue), written
--                     by the nightly job right after the invariants.
--   system_snapshot() computes that snapshot, here beside the data, like run_invariants.
--   system_health_daily / _weekly / _monthly
--                     one time series over all of it: invariants, snapshots, pipeline
--                     events, model calls and cost, facts written.
--
-- Idempotent. Apply in the Supabase SQL editor.

-- ── security ─────────────────────────────────────────────────────────────────
-- invariant_checks' own migration never enabled RLS. Production already has it on
-- (checked 2026-09-13), so this is a no-op there; it makes a fresh database match.
-- Its samples hold entity ids and claim text, and anon/authenticated carry blanket DML
-- grants in this project. Deny-all (no policy), like the 2026-08-17 sweep; the worker
-- writes as service_role, which is unaffected.
ALTER TABLE public.invariant_checks ENABLE ROW LEVEL SECURITY;

-- ── pipeline_events ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.pipeline_events (
  id            bigserial PRIMARY KEY,
  workspace_id  uuid,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  -- fallback     the primary model failed and the fallback answered (a doubled call)
  -- unavailable  no model answered: outage, credits, timeout on both (nothing written)
  -- unparseable  a model answered with no usable JSON (nothing written from that part)
  kind          text NOT NULL CHECK (kind IN ('fallback', 'unavailable', 'unparseable')),
  feature       text,
  model         text,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS pipeline_events_ws_time ON public.pipeline_events (workspace_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS pipeline_events_kind_time ON public.pipeline_events (kind, occurred_at DESC);
ALTER TABLE public.pipeline_events ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.pipeline_events IS
  'Model-call trouble in the extraction pipeline, one row per event. Read it as a rate against llm_usage calls: a jump in fallback means a bad host, a jump in unavailable means credits or an outage.';

-- ── system_metrics ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.system_metrics (
  measured_on   date        NOT NULL,
  workspace_id  uuid        NOT NULL,
  metric        text        NOT NULL,
  value         numeric     NOT NULL,
  detail        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (measured_on, workspace_id, metric)
);
CREATE INDEX IF NOT EXISTS system_metrics_metric_day ON public.system_metrics (metric, measured_on DESC);
ALTER TABLE public.system_metrics ENABLE ROW LEVEL SECURITY;
COMMENT ON TABLE public.system_metrics IS
  'Daily snapshot per workspace, one row per metric per day (re-running a day overwrites it). These are LEVELS that cannot be recomputed for a past date later — claims get retired, people get merged — which is why they are stored rather than derived.';

-- ── system_snapshot ──────────────────────────────────────────────────────────
-- inbound_types is passed by the worker (SIGNAL_WORTHY_TYPES), so "what counts as an
-- extractable conversation" has one definition, in code, instead of a second copy here.
CREATE OR REPLACE FUNCTION public.system_snapshot(ws uuid, inbound_types text[])
RETURNS TABLE (metric text, value numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
WITH
inbound AS (
  SELECT o.id
    FROM observations o
   WHERE o.workspace_id = ws
     AND o.property = ANY (SELECT 'interaction.' || t FROM unnest(inbound_types) t)
     AND coalesce(o.raw->>'is_outbound', 'false') <> 'true'
     AND coalesce(o.value->>'summary', '') NOT LIKE 'You:%'
),
facts AS (
  SELECT c.value->'metadata'->>'source_activity_id' AS source_id
    FROM claims c
   WHERE c.workspace_id = ws
     AND c.property LIKE 'note.%' AND c.invalid_at IS NULL
     AND c.value->>'source' = 'signal_extraction'
),
cited AS (
  SELECT DISTINCT source_id FROM facts WHERE source_id IS NOT NULL
)
SELECT 'people.active', count(*)::numeric FROM entities
 WHERE workspace_id = ws AND type = 'person' AND status = 'active'
UNION ALL
SELECT 'companies.active', count(*)::numeric FROM entities
 WHERE workspace_id = ws AND type = 'company' AND status = 'active'
UNION ALL
SELECT 'extraction.inbound_sources', count(*)::numeric FROM inbound
UNION ALL
SELECT 'extraction.inbound_sources_with_claims', count(*)::numeric
  FROM inbound i JOIN cited c ON c.source_id = i.id::text
UNION ALL
SELECT 'extraction.facts_active', count(*)::numeric FROM facts
UNION ALL
SELECT 'identity.unresolved_pending', count(*)::numeric FROM unresolved_ingest
 WHERE workspace_id = ws AND status = 'pending'
$$;
GRANT EXECUTE ON FUNCTION public.system_snapshot(uuid, text[]) TO service_role;

-- ── the time series ──────────────────────────────────────────────────────────
-- kind: 'level' is a state on a day (keep the latest when rolling up);
--       'flow' is an amount during a day (sum when rolling up).
-- security_invoker so these views never read past the RLS on the tables beneath them.
CREATE OR REPLACE VIEW public.system_health_daily
WITH (security_invoker = true) AS
SELECT day, workspace_id, metric, kind, value FROM (
  -- invariant counts: the last run of each day
  SELECT DISTINCT ON (ran_at::date, workspace_id, name)
         ran_at::date AS day, workspace_id, 'invariant.' || name AS metric,
         'level'::text AS kind, violations::numeric AS value
    FROM invariant_checks
   ORDER BY ran_at::date, workspace_id, name, ran_at DESC
) inv
UNION ALL
SELECT measured_on, workspace_id, metric, 'level', value
  FROM system_metrics
UNION ALL
SELECT occurred_at::date, workspace_id, 'llm.' || kind, 'flow', count(*)::numeric
  FROM pipeline_events
 GROUP BY 1, 2, pipeline_events.kind
UNION ALL
SELECT occurred_at::date, workspace_id, 'llm.calls', 'flow', count(*)::numeric
  FROM llm_usage GROUP BY 1, 2
UNION ALL
SELECT occurred_at::date, workspace_id, 'llm.cost_usd', 'flow', round(sum(cost_usd)::numeric, 4)
  FROM llm_usage GROUP BY 1, 2
UNION ALL
SELECT occurred_at::date, workspace_id, 'llm.cost_usd.' || model, 'flow', round(sum(cost_usd)::numeric, 4)
  FROM llm_usage GROUP BY 1, 2, model
UNION ALL
-- every extracted fact by the day it was written, including ones retired since
SELECT computed_at::date, workspace_id, 'extraction.facts_written', 'flow', count(*)::numeric
  FROM claims
 WHERE property LIKE 'note.%' AND value->>'source' = 'signal_extraction'
 GROUP BY 1, 2;

CREATE OR REPLACE VIEW public.system_health_weekly
WITH (security_invoker = true) AS
SELECT date_trunc('week', day)::date AS period, workspace_id, metric, kind,
       CASE WHEN kind = 'flow' THEN sum(value)
            ELSE (array_agg(value ORDER BY day DESC))[1] END AS value
  FROM public.system_health_daily
 GROUP BY 1, 2, 3, 4;

CREATE OR REPLACE VIEW public.system_health_monthly
WITH (security_invoker = true) AS
SELECT date_trunc('month', day)::date AS period, workspace_id, metric, kind,
       CASE WHEN kind = 'flow' THEN sum(value)
            ELSE (array_agg(value ORDER BY day DESC))[1] END AS value
  FROM public.system_health_daily
 GROUP BY 1, 2, 3, 4;

COMMENT ON VIEW public.system_health_weekly IS
  'The system, week by week. Example: select period, metric, value from system_health_weekly where workspace_id = ''<ws>'' and metric in (''extraction.inbound_sources'', ''extraction.inbound_sources_with_claims'', ''invariant.claim_does_not_name_its_subject'', ''llm.fallback'', ''llm.cost_usd'') order by period, metric;';
