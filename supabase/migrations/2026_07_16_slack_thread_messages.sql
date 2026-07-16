-- Slack bot: per-thread conversation memory.
--
-- Each @mention exchange (the question + the bot's answer) is stored keyed by the
-- Slack thread, so the next mention in that thread replays the back-and-forth as
-- history — the in-thread agent becomes conversational, like the in-app Threads
-- surface. We store our OWN turns rather than reading the whole Slack thread, so
-- it needs no channels:history scope (no re-auth) and captures exactly the
-- conversation the bot is part of.

CREATE TABLE IF NOT EXISTS slack_thread_messages (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  slack_channel_id TEXT NOT NULL,
  slack_thread_ts  TEXT NOT NULL,
  role             TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content          TEXT NOT NULL,
  slack_user_id    TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stm_thread
  ON slack_thread_messages(workspace_id, slack_channel_id, slack_thread_ts, created_at);

ALTER TABLE slack_thread_messages ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'slack_thread_messages' AND policyname = 'stm_all') THEN
    CREATE POLICY stm_all ON slack_thread_messages FOR ALL USING (is_workspace_member(workspace_id));
  END IF;
END $$;
