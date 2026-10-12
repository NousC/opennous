-- companies.last_activity_at: the same answer, without the OR that defeats every index.
-- Applied to production 2026-09-19.
--
-- The column rolls an account's activity up from the account AND the people who work there
-- (added 2026_09_08_activity_and_company_view_fixes.sql, which was right about the semantics).
-- It expressed that rollup as ONE aggregate with an OR across two different entity sets:
--
--     WHERE ... AND (o.entity_id = e.id OR o.entity_id IN (SELECT ... works_at ...))
--
-- An OR across entity_id cannot be an index condition. EXPLAIN on a single account, measured:
--
--     Index Scan using observations_event_property_entity
--       Filter: (... AND ((entity_id = e.id) OR (ANY (entity_id = (hashed SubPlan 1).col1))))
--       Rows Removed by Filter: (nearly all)    <- examined most of the table to find a few hundred
--     Execution Time: 48377.271 ms
--
-- entity_id sat in the Filter, not the Index Cond, so every account page scanned the whole
-- observations table. PostgREST kills a statement at 8s, so the Accounts list and EVERY
-- account detail page returned a timeout rather than a slow answer -- for every workspace, not
-- just the large one. It also silently disabled the at-risk flags: apps/worker/src/flags/sweep.mjs
-- reads this column and does not check for an error, so `companies` came back undefined and the
-- sweep raised zero flags while logging success.
--
-- max() over (A UNION B) is GREATEST(max over A, max over B), so the rollup splits into two
-- indexed lookups. GREATEST ignores NULLs and is NULL only when both sides are, which matches
-- max() over an empty set. Every filter is preserved verbatim: kind='event', observed_at <= now(),
-- property LIKE 'interaction.%', and works_at with valid_to IS NULL (an ex-employee's activity
-- must not count, or a dormant account looks alive and never gets flagged).
--
-- After, same account, same data:
--
--     Index Cond: ((entity_id = e.id) AND (observed_at <= now()))   <- back in the index
--     Buffers: shared hit=111 read=97
--     Execution Time: 61.017 ms                                     <- 793x
--
-- Verified on a sample of accounts against entity_list_rows, which computes the same rollup
-- independently as greatest(own, staff): nearly all identical, a few where the VIEW is later and
-- none where it is earlier. Those few are the projection lagging (some had activity after the row's
-- refreshed_at; the rest are the documented account-rolls-up-person sweep order). Nothing lost
-- activity, which is the direction that would matter.
--
-- Written as a guarded in-place edit of the LIVE definition rather than a re-typed view, because
-- supabase/schema.sql is stale for this view -- the 2026_09_08 migration edited production
-- through pg_get_viewdef and the file was never regenerated.
DO $mig$
DECLARE
  d        text;
  old_expr text;
  new_expr text;
  s int;
  e int;
BEGIN
  d := pg_get_viewdef('public.companies', true);

  IF position('GREATEST(( SELECT max(o.observed_at)' in d) > 0 THEN
    RAISE NOTICE 'companies.last_activity_at already rewritten - nothing to do';
    RETURN;
  END IF;

  s := position('( SELECT max(o.observed_at) AS max' in d);
  IF s = 0 THEN
    RAISE EXCEPTION 'companies.last_activity_at anchor not found - aborting rather than guessing';
  END IF;

  e := position(') AS last_activity_at,' in substring(d from s));
  IF e = 0 THEN
    RAISE EXCEPTION 'companies.last_activity_at terminator not found - aborting';
  END IF;
  e := s + e - 1;

  old_expr := substring(d from s for e - s + 1);

  new_expr :=
    'GREATEST(( SELECT max(o.observed_at) AS max
           FROM observations o
          WHERE o.entity_id = e.id AND o.kind = ''event''::text AND o.observed_at <= now() AND o.property ~~ ''interaction.%''::text), ( SELECT max(o2.observed_at) AS max
           FROM observations o2
          WHERE (o2.entity_id IN ( SELECT r.from_entity_id
                   FROM relationships r
                  WHERE r.to_entity_id = e.id AND r.type = ''works_at''::text AND r.valid_to IS NULL)) AND o2.kind = ''event''::text AND o2.observed_at <= now() AND o2.property ~~ ''interaction.%''::text))';

  d := replace(d, old_expr, new_expr);
  EXECUTE 'CREATE OR REPLACE VIEW public.companies AS ' || d;

  -- CREATE OR REPLACE VIEW without a WITH clause STRIPS reloptions, and security_invoker
  -- lives there. The August security fix set it on all four substrate views so that RLS on
  -- the underlying tables is evaluated as the CALLING role rather than the view owner; losing
  -- it silently turns the view into a definer-rights read. Nothing is granted to anon or
  -- authenticated on public.companies today, so this was not exploitable -- but a documented
  -- tenant-isolation control must not depend on that staying true. Re-set it unconditionally:
  -- it is idempotent and costs nothing if already present.
  EXECUTE 'ALTER VIEW public.companies SET (security_invoker = true)';
END $mig$;

-- ---------------------------------------------------------------------------
-- ROLLBACK. A view stores nothing, so there is no data to un-migrate: putting the
-- old expression back is the whole reversal. Swap the two literals in the block
-- above (new_expr becomes the anchor, old_expr becomes the replacement):
--
--   ( SELECT max(o.observed_at) AS max
--            FROM observations o
--           WHERE o.kind = 'event'::text AND o.observed_at <= now() AND o.property ~~ 'interaction.%'::text AND (o.entity_id = e.id OR (o.entity_id IN ( SELECT r.from_entity_id
--                    FROM relationships r
--                   WHERE r.to_entity_id = e.id AND r.type = 'works_at'::text AND r.valid_to IS NULL))))
--
-- Verified equivalent before rollback would ever be needed: on two accounts where the
-- view and the projection disagreed, the OR expression and this one returned the same
-- timestamp to the microsecond (2026-09-17 15:21:00.358+00 and 2026-09-17 20:55:32+00),
-- the OR taking 48.9s and 46.7s to say it.
