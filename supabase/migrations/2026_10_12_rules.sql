-- Rules: what a rep said their deals must do, said once (GET-846).
--
-- The sibling of ri_preferences (how they want things written) and ri_constraints (what they do
-- not do). A GUIDANCE rule only reaches the agent. A CHECKED rule names one check from the
-- catalogue in packages/core/src/services/ruleChecks.ts; the worker evaluates it in the
-- background and a broken one becomes a flag (flag_type 'rule:<id>') and a task
-- (action_item.rule_*) on the account.
--
-- Personal for now: scope is always 'person' and user_id is required. The column is here so team
-- rules (GET-847) are a value, not a migration.

create table if not exists public.ri_rules (
  id            uuid primary key default gen_random_uuid(),
  workspace_id  uuid not null,
  scope         text not null default 'person',     -- person (team rules: GET-847)
  user_id       uuid,                               -- required when scope = 'person'
  -- The rule in the rep's own words, as the agent should read it.
  statement     text not null,
  kind          text not null default 'guidance',   -- guidance | checked
  check_type    text,                               -- a key of RULE_CHECKS when checked
  params        jsonb not null default '{}'::jsonb, -- { hours } | { days }
  weight        text not null default 'normal',     -- low | normal | high
  status        text not null default 'active',     -- active | paused
  source        text not null default 'stated',     -- stated | proposed (the agent suggested it)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  removed_at    timestamptz,
  unique (workspace_id, scope, user_id, statement)
);
create index if not exists ri_rules_lookup_idx
  on public.ri_rules (workspace_id, user_id) where removed_at is null;
create index if not exists ri_rules_checked_idx
  on public.ri_rules (workspace_id) where removed_at is null and kind = 'checked' and status = 'active';

alter table public.ri_rules enable row level security;

notify pgrst, 'reload schema';
