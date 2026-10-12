-- Per-account watches — an account that watches itself. A third routine trigger
-- kind, 'condition', on top of the existing 'clock' and 'before_meeting'. A watch is
-- scoped to one account (entity_id) and carries a condition (jsonb): quiet_for N days,
-- or at_time a date. The scheduler tick evaluates it against the graph and, on the
-- false->true edge, runs the SAME agent on that account to draft the next move into the
-- operator's approval inbox. condition_state holds the edge-trigger bookkeeping
-- (tripped/fired_at) so a deal that stays quiet fires once, not every tick.
alter table public.agent_routines add column if not exists entity_id       uuid;
alter table public.agent_routines add column if not exists condition       jsonb;
alter table public.agent_routines add column if not exists condition_state jsonb not null default '{}'::jsonb;

-- Allow the new trigger kind.
alter table public.agent_routines drop constraint if exists agent_routines_trigger_kind_check;
alter table public.agent_routines add constraint agent_routines_trigger_kind_check
  check (trigger_kind in ('clock', 'before_meeting', 'condition'));

-- Each kind carries its own fields. Reproduce the original clock/before_meeting shapes
-- exactly and add the condition shape: a watch has a condition and an account, and none
-- of the clock/meeting scheduling fields.
alter table public.agent_routines drop constraint if exists routine_shape;
alter table public.agent_routines add constraint routine_shape check (
  (trigger_kind = 'clock' and frequency is not null and at_time is not null and offset_minutes is null)
  or (trigger_kind = 'before_meeting' and offset_minutes is not null and frequency is null)
  or (trigger_kind = 'condition' and condition is not null and entity_id is not null and frequency is null and offset_minutes is null)
);

-- The tick scans enabled condition routines every cycle; keep that lookup cheap.
create index if not exists agent_routines_condition_idx
  on public.agent_routines (trigger_kind, enabled) where trigger_kind = 'condition';
