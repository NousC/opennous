-- The lifecycle, as a team's own thing rather than ours.
--
-- Until now the phases an account travels after it is won — handoff, activation, active
-- customer, expansion — were five constants in a frontend file, with fixed labels, fixed
-- order, fixed department ownership, and exactly ONE automatic transition (closed_won →
-- handoff). Everything else was a human clicking a button, and nothing detected "this is an
-- upsell opportunity". A revenue motion that is genuinely customised to a team cannot have
-- its second axis hardcoded.
create table if not exists public.workspace_pipelines (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null references public.workspaces(id) on delete cascade,

  key           text not null,            -- stable slug: 'handoff', 'activation'
  label         text not null,            -- what the team calls it
  sort_order    int  not null default 0,

  -- Crossing a phase boundary MOVES the account into another team's book, which is why this
  -- column exists and why an entry rule may never advance one on its own.
  owner_dept    text not null default 'sales' check (owner_dept in ('sales', 'customer_success')),

  -- How an account ENTERS this phase. Three shapes, and which one is right depends on the
  -- boundary:
  --   { mode: 'derived',  from_stage_kind: 'won' }   structural — a win is a win
  --   { mode: 'rule', all: [ { feature, op, value }, … ] }   measurable trigger
  --   { mode: 'manual' }                              a person decides, which is the default
  -- A rule PROPOSES: it writes a lifecycle_event that is unacknowledged. Nothing here moves
  -- an account by itself. See lib/lifecycleRules.mjs.
  entry_rule    jsonb,

  -- Terminal phases end the journey (churned); the rest continue it.
  is_terminal   boolean not null default false,
  source        text not null default 'default' check (source in ('default', 'manual')),

  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (workspace_id, key)
);

create index if not exists workspace_pipelines_ws_idx on public.workspace_pipelines (workspace_id, sort_order);

-- Which phase a stage belongs to. A sales ladder is the stages of the 'sales_pipeline' phase;
-- a handoff checklist is the stages of the 'handoff' phase. Defaulting every existing row to
-- the sales pipeline is exactly right — that is what they all were.
alter table public.workspace_stages
  add column if not exists pipeline text not null default 'sales_pipeline';

create index if not exists workspace_stages_pipeline_idx on public.workspace_stages (workspace_id, pipeline, sort_order);

comment on table public.workspace_pipelines is
  'The revenue lifecycle phases a workspace defines for itself. Each owns a department, so entering one reassigns the account.';
comment on column public.workspace_pipelines.entry_rule is
  'derived | rule | manual. A rule PROPOSES via an unacknowledged lifecycle_event; it never advances an account itself.';
