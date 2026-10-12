-- playground_messages: keep the turn's TRACE, not just its answer.
--
-- The agent already streams its real reasoning (summarized extended thinking) and every
-- tool call it makes. The client watched both go by and then threw them away: reopen the
-- thread and all that was left was the answer. So the one thing that proves the answer —
-- what it actually thought and read to get there — survived exactly as long as the tab.
--
--   trace        ordered blocks, [{ kind:'thinking', text } | { kind:'tool', name, input,
--                status, duration_ms, sources, rows }], in the order they happened
--   duration_ms  wall time of the whole turn, so the collapsed line can say how long it took
--
-- Both nullable: every message written before this has neither, and an older row must keep
-- rendering (answer only, no trace) rather than break the thread.

ALTER TABLE playground_messages ADD COLUMN IF NOT EXISTS trace       jsonb;
ALTER TABLE playground_messages ADD COLUMN IF NOT EXISTS duration_ms integer;
