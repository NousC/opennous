-- Revenue-agent credit meter.
--
-- Sums the model cost of the revenue agent's calls for a set of workspaces since
-- a period start. A scalar function (not a row fetch) so a busy team's spend is
-- summed in full — a PostgREST 1000-row cap on the read path would silently
-- under-bill and let usage run past the credit cap.
--
-- p_features is passed in from the API (AI_CREDIT_FEATURES in llmUsage.mjs) so the
-- set of billed features has a single source of truth in code, not two.

create or replace function public.team_agent_credit_cost(
  ws_ids uuid[],
  p_since timestamptz,
  p_features text[]
)
returns numeric
language sql
stable
as $$
  select coalesce(sum(cost_usd), 0)
  from public.llm_usage
  where workspace_id = any(ws_ids)
    and occurred_at >= p_since
    and feature = any(p_features);
$$;
