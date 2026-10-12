-- 2026-09-08 — People/Accounts view fixes (applied to prod via Supabase on 2026-09-08).
--
-- Three problems seen in a backfill:
--   1. Every account showed "Last activity: Today" — the ICP scorer writes icp.fit / icp.priority
--      as kind:'event' observations (a deliberate append-only history for the win model; they
--      CANNOT be state — see packages/core/src/db/predictions.ts:164), and both views computed
--      last_activity from ALL events. Fix: exclude icp.* from last_activity.
--   2. Company last_activity was then null — interactions are recorded on the PEOPLE, not the
--      company entity. Fix: roll the account's activity up from its people (works_at) + itself.
--   3. People list showed a blank Company though the works_at link existed — the list reads the
--      person's `company` string, which the company-materialization fix moved onto the company
--      entity. Fix: fall back to the linked company's name.
--
-- Whitespace-tolerant regex on the LIVE view def, guarded so a mismatch aborts (transactional).
DO $mig$
DECLARE
  d text;
  p_comp text := '\( SELECT max\(observations\.observed_at\) AS max[\s\S]*?\) AS last_activity_at';
  p_cont_la text := '\( SELECT max\(observations\.observed_at\) AS max[\s\S]*?observations\.observed_at <= now\(\)';
  p_cont_co text := '\( SELECT claims\.value #>> ''\{\}''::text\[\]\s+FROM claims\s+WHERE claims\.entity_id = e\.id AND claims\.property = ''company''::text AND claims\.invalid_at IS NULL\s+LIMIT 1\) AS company,';
BEGIN
  -- (1)+(2) companies.last_activity_at → real interactions across the company AND its people
  d := pg_get_viewdef('public.companies', true);
  IF d !~ p_comp THEN RAISE EXCEPTION 'companies last_activity anchor not found'; END IF;
  d := regexp_replace(d, p_comp,
    '( SELECT max(o.observed_at) AS max FROM observations o WHERE o.kind = ''event''::text AND o.observed_at <= now() AND o.property LIKE ''interaction.%''::text AND (o.entity_id = e.id OR o.entity_id IN ( SELECT r.from_entity_id FROM relationships r WHERE r.to_entity_id = e.id AND r.type = ''works_at''::text AND r.valid_to IS NULL))) AS last_activity_at');
  EXECUTE 'CREATE OR REPLACE VIEW public.companies AS ' || d;

  -- (1) contacts.last_activity_at → exclude icp.* scoring events (interactions live on the person)
  d := pg_get_viewdef('public.contacts', true);
  IF d ~ 'observations\.observed_at <= now\(\) AND \(observations\.property <> ALL' THEN
    d := regexp_replace(d,
      'observations\.observed_at <= now\(\) AND \(observations\.property <> ALL',
      'observations.observed_at <= now() AND observations.property NOT LIKE ''icp.%''::text AND (observations.property <> ALL');
  END IF;
  -- (3) contacts.company → person claim, else linked works_at company's name
  IF d !~ p_cont_co THEN RAISE EXCEPTION 'contacts company anchor not found'; END IF;
  d := regexp_replace(d, p_cont_co,
    'COALESCE(( SELECT claims.value #>> ''{}''::text[] FROM claims WHERE claims.entity_id = e.id AND claims.property = ''company''::text AND claims.invalid_at IS NULL LIMIT 1), ( SELECT cc.value #>> ''{}''::text[] FROM claims cc WHERE cc.entity_id = ( SELECT r.to_entity_id FROM relationships r WHERE r.from_entity_id = e.id AND r.type = ''works_at''::text AND r.valid_to IS NULL LIMIT 1) AND cc.property = ''name''::text AND cc.invalid_at IS NULL LIMIT 1)) AS company,');
  EXECUTE 'CREATE OR REPLACE VIEW public.contacts AS ' || d;
END $mig$;
