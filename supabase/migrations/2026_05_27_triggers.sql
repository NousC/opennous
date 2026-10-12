-- Triggers (outbound webhooks).
--
-- Two tables: subscriptions hold the user's signup ("call this URL when X
-- happens"); outbound_events is the per-(event, subscription) delivery ledger
-- — the outbox pattern. Fan-out happens at enqueue time so delivery state is
-- naturally per-subscription (one bad URL doesn't block the others).

CREATE TABLE trigger_subscriptions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  url           TEXT NOT NULL,
  events        TEXT[] NOT NULL,            -- ['interaction.email_received', ...]
  signing_secret TEXT NOT NULL,             -- plaintext HMAC secret. Shown ONCE in the create response;
                                            -- stored here because the delivery worker needs to sign each POST.
  active        BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trigger_subs_workspace ON trigger_subscriptions(workspace_id) WHERE active;
CREATE INDEX trigger_subs_events    ON trigger_subscriptions USING GIN (events) WHERE active;
ALTER TABLE trigger_subscriptions ENABLE ROW LEVEL SECURITY;
CREATE POLICY trs_select ON trigger_subscriptions FOR SELECT USING (is_workspace_member(workspace_id));

CREATE TABLE outbound_events (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  subscription_id   UUID NOT NULL REFERENCES trigger_subscriptions(id) ON DELETE CASCADE,
  entity_id         UUID REFERENCES entities(id) ON DELETE SET NULL,
  event_type        TEXT NOT NULL,
  payload           JSONB NOT NULL,           -- the signed POST body
  occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- delivery state
  delivered_at      TIMESTAMPTZ,
  attempts          INT NOT NULL DEFAULT 0,
  next_attempt_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_status_code  INT,
  last_error        TEXT,
  dead_lettered_at  TIMESTAMPTZ
);
-- The drain query: pending, ready-to-send rows.
CREATE INDEX outbound_pending
  ON outbound_events(next_attempt_at)
  WHERE delivered_at IS NULL AND dead_lettered_at IS NULL;
-- Workspace timeline / debug view.
CREATE INDEX outbound_workspace
  ON outbound_events(workspace_id, occurred_at DESC);
ALTER TABLE outbound_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY oe_select ON outbound_events FOR SELECT USING (is_workspace_member(workspace_id));
