-- LLM usage — what each workspace actually costs us to serve.
--
-- We had no answer to this. Model spend went to an external dashboard with no
-- workspace_id in the payload, so it could be read as a company total and nothing
-- finer. That is survivable while every workspace is our own, and useless the
-- moment a price has to be attached to one.
--
-- It matters most for the in-app agent. The agent runs Sonnet and the graph runs
-- Haiku, and the gap between them is large: normal graph use is cheap Haiku, while
-- the in-app agent is Sonnet-heavy. The agent is the expensive surface, and it is
-- the one we cannot bill for until we can measure it per workspace.
--
-- So: one row per model call, with the workspace on it.

CREATE TABLE IF NOT EXISTS llm_usage (
  id            BIGSERIAL PRIMARY KEY,
  workspace_id  UUID REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,

  -- 'home-agent-turn', 'claim-extraction', 'website-signals', … Grouping by this
  -- is how we learn which surface is actually burning the money, rather than
  -- reasoning about it from the code.
  feature       TEXT NOT NULL,
  model         TEXT NOT NULL,

  -- Split out because cached input is billed at a tenth of the uncached rate, and
  -- collapsing them into one number would hide whether caching is working at all.
  -- Early on, most of the bill was uncached input and cache reads were near zero.
  input_tokens           INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens      INTEGER NOT NULL DEFAULT 0,
  output_tokens          INTEGER NOT NULL DEFAULT 0,

  -- Computed at write time from the price table in lib/llmUsage.mjs. Stored rather
  -- than derived on read, so a later price change cannot silently rewrite history.
  cost_usd      NUMERIC(12, 6) NOT NULL DEFAULT 0,

  request_id    TEXT,
  occurred_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The two questions this table exists to answer: "what did this workspace cost us
-- last month" and "which feature is burning it".
CREATE INDEX IF NOT EXISTS llm_usage_workspace_time_idx
  ON llm_usage (workspace_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS llm_usage_feature_time_idx
  ON llm_usage (feature, occurred_at DESC);
