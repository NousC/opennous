-- Revenue Intelligence Engine — the substrate (Phase 0).
--
-- Six tables realizing the five contracts: one behavior-agnostic store, versioned
-- evidence-linked observations, an append-only version time series, generic
-- recommendations, curated playbooks, and a separate anonymized cross-workspace
-- priors table. Everything is workspace-scoped except ri_global_priors (which by
-- design carries no ids that resolve to a customer's data). Accessed by the worker
-- + API via the service role, same as llm_usage and flags.
--
-- Tables are `ri_` prefixed (revenue intelligence) to namespace the subsystem.

-- 1. Behaviors — typed, evidence-linked facts on a subject. A new behavior is a new
--    behavior_key, never a new column or table.
create table if not exists public.ri_behaviors (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  subject_type     text not null,                 -- deal | meeting | account | contact | rep | campaign
  subject_id       text not null,
  behavior_key     text not null,                 -- e.g. 'deal.stakeholder_count'
  value_num        double precision,
  value_bool       boolean,
  value_text       text,
  evidence_ids     text[] not null default '{}',
  extractor_version integer not null default 1,
  observed_at      timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  unique (workspace_id, subject_type, subject_id, behavior_key, extractor_version)
);
create index if not exists ri_behaviors_ws_key_idx on public.ri_behaviors (workspace_id, behavior_key);
create index if not exists ri_behaviors_subject_idx on public.ri_behaviors (workspace_id, subject_type, subject_id);

-- 2. Observations — versioned knowledge (behavior -> outcome), segmented via jsonb
--    conditions so segmentation scales without schema changes.
create table if not exists public.ri_observations (
  id                     uuid primary key default gen_random_uuid(),
  workspace_id           uuid not null,
  question_key           text not null,           -- the job key that produced it
  category               text not null,           -- outbound|pipeline|meeting|signals|journey|hygiene|leakage|playbook
  job_type               text not null,           -- correlational|comparative|deterministic|curation
  behavior_key           text,
  outcome_key            text,
  conditions             jsonb not null default '{}',   -- segment, ACV band, motion, industry, window
  sample_size            integer not null default 0,
  effect                 double precision,
  confidence             text not null default 'learning',  -- learning|low|medium|high
  status                 text not null default 'learning',  -- learning|active|retired
  recommendation_template text,
  evidence               jsonb not null default '{}',
  version                integer not null default 1,
  first_seen             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  unique (workspace_id, question_key, conditions)
);
create index if not exists ri_observations_ws_cat_idx on public.ri_observations (workspace_id, category, status);

-- 3. Observation versions — append-only time series. Never mutate history; this is
--    how leadership watches the understanding evolve.
create table if not exists public.ri_observation_versions (
  id             uuid primary key default gen_random_uuid(),
  observation_id uuid not null references public.ri_observations(id) on delete cascade,
  version        integer not null,
  effect         double precision,
  confidence     text,
  sample_size    integer,
  computed_at    timestamptz not null default now(),
  unique (observation_id, version)
);

-- 4. Recommendations — active observations matched to a live subject, with evidence.
--    rec_key identifies the producing rule so re-running upserts instead of duplicating.
create table if not exists public.ri_recommendations (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  category        text not null,
  rec_key         text not null,                  -- the job/rule key
  target_type     text not null,                  -- deal | account | meeting | rep
  target_id       text not null,
  observation_id  uuid references public.ri_observations(id) on delete set null,
  text            text not null,
  impact_estimate double precision,
  evidence        jsonb not null default '{}',
  status          text not null default 'open',   -- open | acted | dismissed | expired
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  decided_at      timestamptz,
  unique (workspace_id, target_type, target_id, rec_key)
);
create index if not exists ri_recommendations_ws_status_idx on public.ri_recommendations (workspace_id, status, category);
create index if not exists ri_recommendations_target_idx on public.ri_recommendations (workspace_id, target_type, target_id);

-- 5. Playbooks — a curated, versioned bundle of high-confidence observations per motion.
create table if not exists public.ri_playbooks (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  motion          text not null,                  -- enterprise_discovery | outbound | discovery_calls | renewals | expansion
  observation_ids uuid[] not null default '{}',
  metrics         jsonb not null default '{}',    -- win_rate, sample, etc.
  version         integer not null default 1,
  updated_at      timestamptz not null default now(),
  unique (workspace_id, motion)
);

-- 6. Global priors — the cross-workspace boundary. Anonymized seed knowledge only.
--    NO workspace_id, no ids that resolve to any customer's accounts or people.
create table if not exists public.ri_global_priors (
  id           uuid primary key default gen_random_uuid(),
  question_key text not null unique,
  category     text not null,
  behavior_key text,
  outcome_key  text,
  effect       double precision,
  confidence   text not null default 'low',
  note         text,
  updated_at   timestamptz not null default now()
);

-- Runner bookkeeping — last run per runner per workspace, for cadence + observability.
create table if not exists public.ri_engine_runs (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid,
  runner_key   text not null,                     -- 'behaviors' | 'learn:nightly' | 'recommendations' | ...
  ran_at       timestamptz not null default now(),
  meta         jsonb not null default '{}'
);
create index if not exists ri_engine_runs_key_idx on public.ri_engine_runs (runner_key, ran_at desc);
