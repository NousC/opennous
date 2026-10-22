-- GTM insights: our interpretation of an insight, on the insight engine's own row (GET-1006).
--
-- Once 5 or more accounts raise an insight, a model reads what they said against what our company
-- does (its ICP and notes) and writes what it means for us and the direction it points
-- (packages/core/src/db/insightInterpretation.mjs). Rewritten when it reaches 10, 15, 20 accounts,
-- or falls back under one.
-- `interpretation_account_count` is the count it was written from. Cloud's board-based
-- gtm_insight_interpretations is left as it is.
--
-- Safe to run more than once. Nothing here rewrites or drops a row.

alter table public.insight_patterns add column if not exists interpretation_meaning text;
alter table public.insight_patterns add column if not exists interpretation_direction text;
-- The conversations, in the order [n] cites them.
alter table public.insight_patterns add column if not exists interpretation_refs text[] not null default '{}';
alter table public.insight_patterns add column if not exists interpretation_account_count integer;
alter table public.insight_patterns add column if not exists interpreted_at timestamptz;
-- A read that failed: not tried again for a week (INTERPRET_RETRY_DAYS).
alter table public.insight_patterns add column if not exists interpretation_failed_at timestamptz;

notify pgrst, 'reload schema';
