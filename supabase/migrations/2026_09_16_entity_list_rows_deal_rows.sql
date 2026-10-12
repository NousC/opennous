-- Deal rows and the refresh entry point for entity_list_rows (GET-757). Written 2026-10-07,
-- dated 2026-09-16 so it sorts straight after 2026_09_16_entity_list_rows.sql and before the
-- migrations that need it.
--
-- Why it exists. The table was created with kind IN ('account','person') and none of the deal
-- columns, but every later version of refresh_list_chunk (2026_09_17_focus_country onwards)
-- writes kind = 'deal' rows with status, close_date, owner_name and pipeline_ref, and the API
-- (apps/api/src/lib/listRows.mjs) and backfillAccountHealth.mjs call refresh_entity_list_rows(ws),
-- which no file in this repo defines. Production got these by hand. A database built from the repo
-- alone could not apply 2026_09_17_focus_country, 2026_09_17_person_country or
-- 2026_09_20_ownership_and_pipeline_rows (column "close_date" / "country" / "owner_name" does not
-- exist), and refresh_list_chunk failed on every call.
--
-- Column types, the check constraint and the function are read from production's catalog
-- (read-only, 2026-10-07), so on prod, where all of them exist, this file changes nothing.

ALTER TABLE public.entity_list_rows ADD COLUMN IF NOT EXISTS status       text;
ALTER TABLE public.entity_list_rows ADD COLUMN IF NOT EXISTS close_date   timestamptz;
ALTER TABLE public.entity_list_rows ADD COLUMN IF NOT EXISTS owner_name   text;
ALTER TABLE public.entity_list_rows ADD COLUMN IF NOT EXISTS pipeline_ref text;

-- Swap the check only when it does not allow 'deal' yet, so re-running this never takes the
-- table lock or leaves the table without a check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.entity_list_rows'::regclass
      AND conname = 'entity_list_rows_kind_check'
      AND pg_get_constraintdef(oid) LIKE '%''deal''%'
  ) THEN
    ALTER TABLE public.entity_list_rows DROP CONSTRAINT IF EXISTS entity_list_rows_kind_check;
    ALTER TABLE public.entity_list_rows
      ADD CONSTRAINT entity_list_rows_kind_check CHECK (kind IN ('account', 'person', 'deal'));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS entity_list_deal_company
  ON public.entity_list_rows (workspace_id, company_id) WHERE kind = 'deal';

-- One call that rebuilds a whole workspace. Accounts first so people and deals can copy the
-- account's name and country, then accounts again so they count the people and deals just
-- written. Returns the same shape listRows.mjs reads ({accounts, people}).
-- Definition copied verbatim from prod (pg_get_functiondef, read-only, 2026-10-07), so applying
-- this file anywhere gives the function prod actually runs.
CREATE OR REPLACE FUNCTION public.refresh_entity_list_rows(ws uuid)
 RETURNS TABLE(accounts integer, people integer, deals integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
DECLARE n_accounts integer := 0; n_people integer := 0; n_deals integer := 0; own_domain text;
BEGIN
  SELECT nullif(regexp_replace(lower(coalesce(w.website,'')), '^https?://(www\.)?', ''), '')
    INTO own_domain FROM workspaces w WHERE w.id = ws;
  own_domain := split_part(coalesce(own_domain,''), '/', 1);

  -- Claim where derived, newest observation where not (GET-303).
  CREATE TEMP TABLE _c ON COMMIT DROP AS SELECT * FROM list_row_values(ws);
  CREATE INDEX ON _c (entity_id, property);

  CREATE TEMP TABLE _at ON COMMIT DROP AS
  SELECT r.from_entity_id AS person_id, r.to_entity_id AS company_id FROM relationships r
   WHERE r.workspace_id = ws AND r.type = 'works_at' AND r.valid_to IS NULL;
  CREATE INDEX ON _at (person_id); CREATE INDEX ON _at (company_id);

  CREATE TEMP TABLE _internal ON COMMIT DROP AS
  SELECT ic.entity_id FROM _c ic WHERE ic.property='is_internal' AND lower(ic.val) IN ('true','t','1')
  UNION
  SELECT ei.entity_id FROM entity_identifiers ei
   WHERE ei.kind='domain' AND ei.status='active' AND own_domain <> '' AND lower(ei.value)=own_domain
     AND EXISTS (SELECT 1 FROM entities e WHERE e.id=ei.entity_id AND e.workspace_id=ws);
  INSERT INTO _internal SELECT a.person_id FROM _at a JOIN _internal i ON i.entity_id=a.company_id;
  CREATE INDEX ON _internal (entity_id);

  CREATE TEMP TABLE _act ON COMMIT DROP AS
  SELECT o.entity_id, max(o.observed_at) AS last_at FROM observations o
   WHERE o.workspace_id = ws AND o.property LIKE 'interaction.%' GROUP BY o.entity_id;
  CREATE INDEX ON _act (entity_id);

  CREATE TEMP TABLE _belongs ON COMMIT DROP AS
  SELECT b.from_entity_id AS deal_id, b.to_entity_id AS company_id FROM relationships b
   WHERE b.workspace_id = ws AND b.type='belongs_to';
  CREATE INDEX ON _belongs (deal_id); CREATE INDEX ON _belongs (company_id);

  CREATE TEMP TABLE _deals ON COMMIT DROP AS
  SELECT bl.company_id,
         count(*) FILTER (WHERE ds.val='open') AS open_deals,
         sum(nullif(dv.val,'')::numeric) FILTER (WHERE ds.val='open') AS pipeline_value,
         sum(nullif(dv.val,'')::numeric) FILTER (WHERE ds.val='won') AS won_value
    FROM _belongs bl JOIN entities de ON de.id=bl.deal_id AND de.type='deal'
    LEFT JOIN _c ds ON ds.entity_id=de.id AND ds.property='status'
    LEFT JOIN _c dv ON dv.entity_id=de.id AND dv.property='value'
   GROUP BY bl.company_id;
  CREATE INDEX ON _deals (company_id);

  DELETE FROM entity_list_rows WHERE workspace_id = ws;

  INSERT INTO entity_list_rows (workspace_id, entity_id, kind, name, domain, industry, icp_score,
                                deal_health, people_count, open_deals, pipeline_value, won_value, last_activity_at)
  SELECT ws, e.id, 'account', nm.val,
         (SELECT ei.value FROM entity_identifiers ei WHERE ei.entity_id=e.id AND ei.kind='domain' AND ei.status='active' LIMIT 1),
         ind.val, nullif(icp.val,'')::numeric::integer, nullif(dh.val,'')::numeric::integer,
         coalesce(pc.n,0), coalesce(d.open_deals,0), d.pipeline_value, d.won_value,
         greatest(own.last_at, ppl.last_at)
    FROM entities e
    LEFT JOIN _c nm ON nm.entity_id=e.id AND nm.property='name'
    LEFT JOIN _c ind ON ind.entity_id=e.id AND ind.property='industry'
    LEFT JOIN _c icp ON icp.entity_id=e.id AND icp.property='icp_score'
    LEFT JOIN _c dh ON dh.entity_id=e.id AND dh.property='deal_health_score'
    LEFT JOIN _deals d ON d.company_id=e.id
    LEFT JOIN _act own ON own.entity_id=e.id
    LEFT JOIN LATERAL (SELECT count(*) AS n FROM _at a WHERE a.company_id=e.id) pc ON true
    LEFT JOIN LATERAL (SELECT max(x.last_at) AS last_at FROM _at a JOIN _act x ON x.entity_id=a.person_id WHERE a.company_id=e.id) ppl ON true
   WHERE e.workspace_id=ws AND e.type='company' AND e.status='active'
     AND NOT EXISTS (SELECT 1 FROM _internal i WHERE i.entity_id=e.id);
  GET DIAGNOSTICS n_accounts = ROW_COUNT;

  INSERT INTO entity_list_rows (workspace_id, entity_id, kind, name, email, job_title, company_id,
                                company_name, stage, icp_score, last_activity_at)
  SELECT ws, e.id, 'person',
         nullif(trim(coalesce(fn.val,'') || ' ' || coalesce(ln.val,'')), ''),
         (SELECT ei.value FROM entity_identifiers ei WHERE ei.entity_id=e.id AND ei.kind='email' AND ei.status='active' LIMIT 1),
         jt.val, a.company_id, cn.name, st.val, nullif(icp.val,'')::numeric::integer, act.last_at
    FROM entities e
    LEFT JOIN _c fn ON fn.entity_id=e.id AND fn.property='first_name'
    LEFT JOIN _c ln ON ln.entity_id=e.id AND ln.property='last_name'
    LEFT JOIN _c jt ON jt.entity_id=e.id AND jt.property='job_title'
    LEFT JOIN _c st ON st.entity_id=e.id AND st.property='pipeline_stage'
    LEFT JOIN _c icp ON icp.entity_id=e.id AND icp.property='icp_score'
    LEFT JOIN _at a ON a.person_id=e.id
    LEFT JOIN entity_list_rows cn ON cn.workspace_id=ws AND cn.entity_id=a.company_id AND cn.kind='account'
    LEFT JOIN _act act ON act.entity_id=e.id
   WHERE e.workspace_id=ws AND e.type='person' AND e.status='active'
     AND NOT EXISTS (SELECT 1 FROM _internal i WHERE i.entity_id=e.id);
  GET DIAGNOSTICS n_people = ROW_COUNT;

  INSERT INTO entity_list_rows (workspace_id, entity_id, kind, name, company_id, company_name, stage,
                                status, pipeline_value, close_date, owner_name, pipeline_ref, last_activity_at)
  SELECT ws, e.id, 'deal', nm.val, bl.company_id, cn.name, stg.val, st.val,
         nullif(dv.val,'')::numeric,
         CASE WHEN cd.val ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' THEN cd.val::timestamptz END,
         own.val, pid.val, cn.last_activity_at
    FROM entities e
    LEFT JOIN _c nm ON nm.entity_id=e.id AND nm.property='name'
    LEFT JOIN _c stg ON stg.entity_id=e.id AND stg.property='stage'
    LEFT JOIN _c st ON st.entity_id=e.id AND st.property='status'
    LEFT JOIN _c dv ON dv.entity_id=e.id AND dv.property='value'
    LEFT JOIN _c cd ON cd.entity_id=e.id AND cd.property='close_date'
    LEFT JOIN _c own ON own.entity_id=e.id AND own.property='owner_name'
    LEFT JOIN _c pid ON pid.entity_id=e.id AND pid.property='pipeline_id'
    LEFT JOIN _belongs bl ON bl.deal_id=e.id
    LEFT JOIN entity_list_rows cn ON cn.workspace_id=ws AND cn.entity_id=bl.company_id AND cn.kind='account'
   WHERE e.workspace_id=ws AND e.type='deal' AND e.status='active';
  GET DIAGNOSTICS n_deals = ROW_COUNT;

  RETURN QUERY SELECT n_accounts, n_people, n_deals;
END; $function$;

REVOKE ALL ON FUNCTION public.refresh_entity_list_rows(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_entity_list_rows(uuid) TO service_role;
