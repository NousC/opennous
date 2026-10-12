-- Forecast snapshots + the per-workspace win model (forecasting layers 1-3).
--
-- forecast_snapshots: the weekly materialisation of what the forecast SAID, so it can
-- later be graded against what actually happened. The forecast itself is recomputed from
-- raw events on every call and keeps no memory; without these rows there is no way to ever
-- answer "was our forecast any good last quarter" or to calibrate the p10/p90 band --
-- history like this cannot be backfilled, only accumulated. One row per workspace per
-- weekly tick (plus any manual runs that choose to persist).
--
-- win_models: the fitted layer-3 coefficients per workspace. One current row per
-- workspace, overwritten on refit -- the training inputs are reconstructable from the
-- substrate, so the model row is a cache of the fit, not a source of truth.
--
-- Idempotent -- safe to re-run.

create table if not exists public.forecast_snapshots (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,
  period_start  date not null,
  period_end    date not null,
  taken_at      timestamptz not null default now(),
  model_version text not null,
  -- How much of the number rests on priors vs the workspace's own history.
  basis         text not null check (basis in ('prior','blended','learned')),
  expected      numeric not null,
  p10           numeric,
  p50           numeric,
  p90           numeric,
  deal_count    int  not null,
  open_pipeline numeric,
  -- Per-deal contributions at snapshot time: [{entityId, name, amount, stage, pWin,
  -- pClose, contribution, intentBand}]. Capped to the top contributors by the writer so a
  -- 5k-account workspace does not write megabyte rows.
  deals         jsonb not null default '[]'::jsonb
);
create index if not exists forecast_snapshots_ws_taken_idx
  on public.forecast_snapshots(workspace_id, taken_at desc);
create index if not exists forecast_snapshots_ws_period_idx
  on public.forecast_snapshots(workspace_id, period_start, period_end);

create table if not exists public.win_models (
  workspace_id    uuid primary key references public.workspaces(id) on delete cascade,
  -- {featureKey: coefficient} in log-odds units, applied as an offset on the stage-based
  -- P(win). Missing key = feature contributes nothing.
  coefficients    jsonb not null,
  -- 'default' (hand-set nudges, nothing fitted) | 'fitted' (learned from this workspace's
  -- closed deals). runForecast only APPLIES a fitted row when beats_baseline is true.
  basis           text not null check (basis in ('default','fitted')),
  training_wins   int not null default 0,
  training_losses int not null default 0,
  training_rows   int not null default 0,
  -- Did the fitted model beat the stage-only baseline on the time-ordered holdout?
  beats_baseline  boolean not null default false,
  holdout         jsonb,
  -- Signal proposals from contrastive discovery over the same training episodes -- the
  -- "features beyond the twelve" surface. Stored for review, not auto-wired.
  discovered      jsonb not null default '[]'::jsonb,
  feature_version text not null,
  fitted_at       timestamptz not null default now()
);

-- Service-role only (the post-audit-C1 convention: RLS on, no policy — anon/authenticated
-- hold blanket DML grants in this project, so a new table left RLS-off is readable and
-- writable through PostgREST with the anon key; see 2026_08_17_sec_enable_rls_disabled_tables.sql).
-- Every access path (forecastRun.ts, winModelFit.mjs, the /v2 forecast routes) uses the
-- service-role client, which bypasses RLS, so this costs nothing.
alter table public.forecast_snapshots enable row level security;
alter table public.win_models enable row level security;
