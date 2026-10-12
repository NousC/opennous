-- Nous deal health on the deal rows (2026-10-02).
--
-- Every open deal gets Nous's own health score (0-100) and a one-line reason, STORED, so the lists
-- that show many deals at once (the Pipeline board, Home's "deals at risk", /api/companies/deals)
-- read it off the row instead of computing it per request. Until now a per-deal score existed only
-- when one deal was opened (accountDeals.mjs -> computeDealHealth), and a board is hundreds of
-- deals: computing them on read is the wall GET-296 already hit for accounts.
--
-- WHO WRITES THESE: only apps/worker/src/workers/dealHealthRefresh.mjs, twice a day, with the same
-- slice-and-score the deal page runs (packages/core/src/services/dealHealthSlice.mjs). They are a
-- derived projection, like every other column here. Nothing is written to claims: a claim is
-- derived from observations, and a score is derived from claims.
--
-- WHY THE REFRESH LEAVES THEM ALONE (checked against the LIVE body of refresh_list_chunk on
-- 2026-10-02, which matches 2026_09_21_account_health_rows.sql / 2026_09_21_last_inbound_at.sql):
--   - the deal branch is an INSERT ... ON CONFLICT (workspace_id, entity_id) DO UPDATE SET with an
--     explicit column list (name, company_id, company_name, country, stage, status, pipeline_value,
--     close_date, owner_name, pipeline_ref, pipeline, last_activity_at, refreshed_at). A column it
--     does not name keeps its value through every sweep.
--   - the only DELETE in it is for ACCOUNT rows that turned internal. Deal rows are never deleted
--     and re-inserted.
--   So this migration does NOT touch refresh_list_chunk, and a future rewrite of it does not need
--   to know these columns exist.
--
-- ONE EXCEPTION, KNOWN: the legacy whole-workspace rebuild refresh_entity_list_rows(ws) starts
-- with DELETE FROM entity_list_rows WHERE workspace_id = ws. Nothing schedules it (the hourly sweep
-- replaced it in GET-297); one hand-run script still calls it (apps/worker/scripts/
-- backfillAccountHealth.mjs). Run that, and these columns empty along with country, cs, owner_email
-- and the rest that function never learned to write. The job refills the empty ones FIRST on its
-- next run (it orders never-scored deals ahead of stale ones), so the cost is a half-day of blank
-- health, not a permanent hole.
--
-- Additive and re-runnable. Three nullable columns with no default are a catalog change, not a
-- table rewrite. lock_timeout: the ALTER needs a brief exclusive lock, and queueing behind an hourly
-- sweep would block every list read behind IT; better to fail fast and re-run.

set lock_timeout = '5s';

alter table public.entity_list_rows add column if not exists deal_health_score integer;
alter table public.entity_list_rows add column if not exists deal_health_reason text;
alter table public.entity_list_rows add column if not exists deal_health_at timestamptz;

comment on column public.entity_list_rows.deal_health_score is
  'Deal rows only: Nous deal health 0-100 for an OPEN deal, the same number the deal page computes. '
  'Written by the worker (dealHealthRefresh.mjs), never by refresh_list_chunk. NULL until scored, '
  'and for any deal the deal page does not read as open.';
comment on column public.entity_list_rows.deal_health_reason is
  'Deal rows only: the one line behind deal_health_score (its two strongest drivers). NULL with it.';
comment on column public.entity_list_rows.deal_health_at is
  'Deal rows only: when the worker last scored this deal. Set even when the score is NULL (a deal the '
  'page reads as closed), so the job moves on to staler deals instead of retrying it first.';

notify pgrst, 'reload schema';
