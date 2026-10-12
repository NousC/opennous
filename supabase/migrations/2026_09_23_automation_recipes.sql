-- Automations become WHEN · MAKE · SEND (GET-426).
--
-- agent_routines already held the custom kind — a prompt plus a trigger — so the presets
-- extend it rather than arriving in a table of their own. A preset and a custom automation
-- are the same object with a different middle: one names an artifact we know how to write,
-- the other carries the prompt you wrote. Splitting them would have meant two lists, two
-- limits and two answers to "what runs on this workspace".
--
-- Additive and idempotent. Everything already in the table is a clock or before_meeting
-- routine with a prompt, and every column below is nullable or defaulted, so existing rows
-- stay valid without a backfill.

-- 1. MAKE — the artifact. NULL means custom: the prompt is the instruction.
alter table public.agent_routines add column if not exists artifact text;
alter table public.agent_routines drop constraint if exists agent_routines_artifact_check;
alter table public.agent_routines add constraint agent_routines_artifact_check
  check (artifact is null or artifact in ('account_summary', 'call_summary', 'call_score'));

-- 2. SEND — where the finished artifact goes BESIDES the Home feed, which always gets it.
--    'none' is the default and is not a degraded state: the feed is a destination.
alter table public.agent_routines add column if not exists destination text not null default 'none';
alter table public.agent_routines drop constraint if exists agent_routines_destination_check;
alter table public.agent_routines add constraint agent_routines_destination_check
  check (destination in ('none', 'email', 'slack', 'webhook'));
alter table public.agent_routines add column if not exists destination_target text;

-- 3. WHEN — the event triggers join the clock. An event automation has no frequency and no
--    offset; it fires when the thing happens.
alter table public.agent_routines drop constraint if exists agent_routines_trigger_kind_check;
alter table public.agent_routines add constraint agent_routines_trigger_kind_check
  check (trigger_kind in ('clock', 'before_meeting', 'deal_closed_won', 'call_ended', 'call_scored'));

-- 4. A preset carries no prompt, so `prompt` stops being required — but a row must still say
--    what it makes, one way or the other. An automation that names neither is a row that can
--    never run, and the place to refuse it is here rather than in whichever writer forgot.
alter table public.agent_routines alter column prompt drop not null;
alter table public.agent_routines drop constraint if exists agent_routines_makes_something;
alter table public.agent_routines add constraint agent_routines_makes_something
  check (artifact is not null or (prompt is not null and length(btrim(prompt)) > 0));

-- 5. The schedule constraint needs a branch for the event kinds. Rebuilt whole, because the
--    original is a single OR over the two it knew about.
alter table public.agent_routines drop constraint if exists agent_routines_schedule_shape;
alter table public.agent_routines drop constraint if exists routine_shape;
alter table public.agent_routines add constraint agent_routines_schedule_shape check (
  (trigger_kind = 'clock'          and frequency is not null and at_time is not null and offset_minutes is null)
  or (trigger_kind = 'before_meeting' and offset_minutes is not null and frequency is null)
  or (trigger_kind in ('deal_closed_won', 'call_ended', 'call_scored')
      and frequency is null and offset_minutes is null)
);

-- Enabled automations per workspace is what the plan limit counts, so it gets an index.
create index if not exists agent_routines_ws_enabled
  on public.agent_routines (workspace_id) where enabled;

-- 6. Which tools an automation may use (GET-426). A call summary can be built from whichever
--    meeting recorder the workspace actually has, and an account summary can be pushed into
--    the CRM it actually runs. NULL means "whatever is connected", which is the right default
--    and the only honest one before anything is connected.
alter table public.agent_routines add column if not exists tools text[];

-- 7. More triggers (GET-426). A deal that is LOST is as worth writing up as one that is won,
--    a stage change is the moment a forecast moves, and a thread going quiet is the one
--    signal nobody is watching. Rebuilt whole, as before.
alter table public.agent_routines drop constraint if exists agent_routines_trigger_kind_check;
alter table public.agent_routines add constraint agent_routines_trigger_kind_check
  check (trigger_kind in (
    'clock', 'before_meeting', 'condition',
    'deal_closed_won', 'deal_closed_lost', 'deal_stage_changed', 'thread_quiet',
    'call_ended', 'call_scored'
  ));

alter table public.agent_routines drop constraint if exists agent_routines_schedule_shape;
alter table public.agent_routines add constraint agent_routines_schedule_shape check (
  (trigger_kind = 'clock'             and frequency is not null and at_time is not null and offset_minutes is null)
  or (trigger_kind = 'before_meeting' and offset_minutes is not null and frequency is null)
  or (trigger_kind not in ('clock', 'before_meeting')
      and frequency is null and offset_minutes is null)
);

-- 8. What a run produced (GET-426). A history that says "ok" and nothing else asks you to
--    take its word for it — the document is the evidence and belongs on the row.
alter table public.agent_routine_runs add column if not exists document_id uuid;
