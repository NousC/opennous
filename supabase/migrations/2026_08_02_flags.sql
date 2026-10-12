-- Flags — the change-detection / re-engagement worklist primitive.
-- One typed, deduped, snooze-able record per (workspace, entity, flag_type). See
-- docs/accounts-flagging-brief.md. Additive; safe to re-run.

create table if not exists flags (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  entity_id      uuid not null,            -- company or person entity
  flag_type      text not null,            -- fit_cold | buying_signal | went_dark | ...
  reason         text,                     -- human string: what to say
  evidence       jsonb default '{}'::jsonb,-- { claim_ids[], observation_ids[], activity_ids[] }
  fit_score      int,                      -- icp_score snapshot
  momentum_score int,                      -- intent/recency snapshot
  priority       int default 0,            -- rank key (higher = more urgent)
  status         text not null default 'open', -- open | snoozed | dismissed | acted
  owner_user_id  uuid,
  source         text default 'sweep',     -- sweep | event | internal_call
  created_at     timestamptz not null default now(),
  last_fired_at  timestamptz not null default now(),
  snoozed_until  timestamptz,
  resolved_at    timestamptz,
  -- One live flag per account per type — the dedup that keeps the worklist from re-nagging.
  unique (workspace_id, entity_id, flag_type)
);

create index if not exists flags_ws_status_idx on flags (workspace_id, status, priority desc);
create index if not exists flags_entity_idx on flags (workspace_id, entity_id);
