-- Webhook delivery retry queue.
--
-- Background: inbound webhook handlers (Calendly, Cal.com, Fireflies, Fathom,
-- Instantly, LinkedIn, RB2B, Stripe) used to process events synchronously.
-- If the DB hiccups, the signal-extraction LLM call times out, or any other
-- transient failure occurs mid-processing, the event was silently lost.
--
-- This table records every inbound delivery verbatim before processing. A
-- worker poller picks up `pending` rows, runs the matching handler, and
-- flips them to `processed` or back to `pending` with an attempt count
-- (and `failed` after max retries). On worker restart, in-flight rows
-- automatically resume.
--
-- Safe to re-run.

CREATE TABLE IF NOT EXISTS webhook_inbox (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source        TEXT        NOT NULL,   -- 'calendly' | 'cal_com' | 'fireflies' | 'fathom' | 'instantly' | 'linkedin' | 'rb2b' | 'stripe'
  payload       JSONB       NOT NULL,   -- raw request body
  headers       JSONB,                  -- signature headers we may need to re-verify on retry
  status        TEXT        NOT NULL DEFAULT 'pending', -- 'pending' | 'processed' | 'failed'
  attempts      INTEGER     NOT NULL DEFAULT 0,
  last_error    TEXT,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ
);

-- Worker scan index: find pending rows whose retry time has arrived.
CREATE INDEX IF NOT EXISTS webhook_inbox_pending
  ON webhook_inbox(next_attempt_at)
  WHERE status = 'pending';

-- Workspace scope for any admin/debug view.
CREATE INDEX IF NOT EXISTS webhook_inbox_workspace
  ON webhook_inbox(workspace_id, received_at DESC);
