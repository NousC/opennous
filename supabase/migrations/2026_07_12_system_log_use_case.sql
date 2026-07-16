-- What was this op FOR?
--
-- The log records which tool ran (`v2.context`) but not what the person was
-- trying to get done. Nobody asks how many times the context endpoint was hit;
-- they ask whether the team is getting anything out of the product. Those are
-- different questions, and only the second one is worth showing a buyer.
--
-- Agent traffic is classified deterministically from the op (an agent calling
-- v2.leads is building a list — the verb IS the intent). Web chats are classified
-- from the question the person actually typed, since "brief me on my meeting with
-- Vik" and "catch me up on Kabir" hit the same tool with entirely different
-- intent.
--
-- Nullable: an unclassifiable op stays null rather than being forced into a
-- bucket. A usage chart built on guesses is worse than one with gaps in it.

ALTER TABLE workspace_system_log
  ADD COLUMN IF NOT EXISTS use_case TEXT;

COMMENT ON COLUMN workspace_system_log.use_case IS
  'The job this op served (meeting_prep, account_research, follow_up, …). Derived from the op for agent traffic, from the question for web chats. Null when it cannot be told.';

-- The usage page asks "which jobs, over time, by whom".
CREATE INDEX IF NOT EXISTS wsl_use_case_time
  ON workspace_system_log (workspace_id, use_case, occurred_at DESC);
