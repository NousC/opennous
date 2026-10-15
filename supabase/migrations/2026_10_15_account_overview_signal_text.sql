-- The Accounts table's Latest signal says what was said (GET-894).
--
-- revbox_account_overview (2026_10_14_revboxes.sql) returned the latest account signal's kind and
-- title only. The title is the extraction's short tag ("Trade", "Monthly Cost Need") or, for a
-- next step, the task itself, so the column showed a tag or a to-do instead of the signal. It now
-- also returns the fact's content and quote (the API turns them into the line the table shows), and
-- a next step (an action item: a task, not something the buyer said) is the latest signal only
-- when the account has no other signal.
--
-- Same signature and return type: CREATE OR REPLACE, safe to run more than once. Until it runs,
-- the API falls back to the title.

BEGIN;

CREATE OR REPLACE FUNCTION public.revbox_account_overview(p_workspace_id uuid, p_ids uuid[])
RETURNS TABLE(id uuid, deal_count bigint, won_deals bigint, lost_deals bigint, latest_signal jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT a.entity_id,
    (SELECT count(*) FROM entity_list_rows d WHERE d.workspace_id = p_workspace_id AND d.kind = 'deal' AND d.company_id = a.entity_id),
    (SELECT count(*) FROM deal_outcomes o WHERE o.workspace_id = p_workspace_id AND o.entity_id = a.entity_id AND o.outcome = 'won'),
    (SELECT count(*) FROM deal_outcomes o WHERE o.workspace_id = p_workspace_id AND o.entity_id = a.entity_id AND o.outcome = 'lost'),
    (SELECT jsonb_build_object('kind', s.kind, 'title', s.title, 'content', left(s.content, 500), 'quote', left(s.quote, 500),
                               'at', s.occurred_at, 'entity_id', s.entity_id, 'claim_property', s.claim_property)
     FROM account_signals s WHERE s.workspace_id = p_workspace_id AND s.account_id = a.entity_id AND s.team_readable IS TRUE
     ORDER BY (s.kind = 'next_step'), s.occurred_at DESC NULLS LAST, s.detected_at DESC LIMIT 1)
  FROM entity_list_rows a WHERE a.workspace_id = p_workspace_id AND a.kind = 'account' AND a.entity_id = ANY(p_ids);
$$;
REVOKE ALL ON FUNCTION public.revbox_account_overview(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revbox_account_overview(uuid, uuid[]) TO service_role;

COMMIT;
