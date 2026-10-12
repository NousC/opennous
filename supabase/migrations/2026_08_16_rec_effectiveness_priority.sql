-- Close the loop (1.1): let learned outcomes re-rank the recommendation worklist.
--
-- The `outbound.rec_effectiveness` learning job already grades our own advice — it
-- reads the decision traces and learns which rec CATEGORIES actually convert (reply or
-- meeting). Until now that knowledge was reporting-only. This adds the one column the
-- matcher needs to write the learned rank back onto each recommendation so the surfaces
-- (Studio worklist, the agent's recommendations tool, attention) order by what converts,
-- not just by recency.
--
-- `priority` is a pure effectiveness multiplier centered on 1.0:
--   1.0  = neutral (no learned signal yet, or not enough acted-on data for the category)
--   >1.0 = this category has converted ABOVE our overall rate
--   <1.0 = below it
-- It is deliberately independent of `impact_estimate` (which is a deal dollar value on
-- some jobs, a different scale). Decisively low-converting categories are suppressed at
-- generation, not ranked — so they never reach this table.

alter table public.ri_recommendations
  add column if not exists priority double precision not null default 1.0;

-- Ordering index for the worklist reads: open recs, highest learned priority first.
create index if not exists ri_recommendations_ws_status_priority_idx
  on public.ri_recommendations (workspace_id, status, priority desc);
