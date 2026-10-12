-- Lead Lists — Adaptive Lead Scoring, Phase 4a.
--
-- A lead list is the cold outreach universe: people reached out to before any
-- back-and-forth. Leads are kept in their own table, separate from `contacts`
-- (People), so a 10k-name cold list never bloats People and a lead can carry
-- outreach fields — which list, which send, which copy variant — that have no
-- place on a contact record.
--
-- The `leads` table is also the evidence set for the learning loop: each row
-- carries a prediction (`scorecard_score`) and, once a reply lands, a label
-- (`reply_outcome`). `workspaces.icp_text` holds the plain-English ICP the
-- Scorecard is seeded from.
--
-- No RLS: like `webhook_inbox` and `mind_episodes`, these are service-role
-- tables — the API enforces workspace scope on every read.
--
-- See docs/adaptive-lead-scoring.md. Safe to re-run.

-- Lead lists — one row per list / campaign.
CREATE TABLE IF NOT EXISTS lead_lists (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         TEXT        NOT NULL,
  source       TEXT        NOT NULL DEFAULT 'csv',   -- 'linkedin'|'instantly'|'csv'|'apollo'|…
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS lead_lists_workspace
  ON lead_lists(workspace_id, created_at DESC);

-- Leads — one row per lead. NOT a contacts row. Prediction + label live here.
CREATE TABLE IF NOT EXISTS leads (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_list_id  UUID        NOT NULL REFERENCES lead_lists(id) ON DELETE CASCADE,
  workspace_id  UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,

  -- Identity
  email         TEXT,
  name          TEXT,
  company       TEXT,
  linkedin_url  TEXT,

  -- Outreach record
  sent_at            TIMESTAMPTZ,
  send_variant       TEXT,
  is_repeat_contact  BOOLEAN     NOT NULL DEFAULT false,

  -- The prediction
  features         JSONB       NOT NULL DEFAULT '{}',   -- point-in-time feature snapshot
  scorecard_score  INT,

  -- The label (filled in when a reply lands)
  reply_outcome  TEXT,                   -- 'interested'|'objection'|'wrong_fit'|'unsubscribe'
  replied_at     TIMESTAMPTZ,

  status      TEXT        NOT NULL DEFAULT 'pending',   -- 'pending'|'sent'|'replied'|'bounced'
  contact_id  UUID        REFERENCES contacts(id) ON DELETE SET NULL,  -- set on graduation

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS leads_list      ON leads(lead_list_id, created_at DESC);
CREATE INDEX IF NOT EXISTS leads_workspace ON leads(workspace_id, created_at DESC);

-- Identity match when an inbound reply arrives.
CREATE INDEX IF NOT EXISTS leads_email
  ON leads(workspace_id, lower(email)) WHERE email IS NOT NULL;

-- Evidence-set scan: leads with a known reply outcome.
CREATE INDEX IF NOT EXISTS leads_resolved
  ON leads(workspace_id, replied_at) WHERE reply_outcome IS NOT NULL;

-- Graduated leads (linked to a contact).
CREATE INDEX IF NOT EXISTS leads_contact
  ON leads(contact_id) WHERE contact_id IS NOT NULL;

-- Suppression list — addresses that asked not to be contacted again.
CREATE TABLE IF NOT EXISTS lead_suppressions (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        TEXT        NOT NULL,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email)
);

-- updated_at maintenance.
DROP TRIGGER IF EXISTS lead_lists_updated_at ON lead_lists;
CREATE TRIGGER lead_lists_updated_at
  BEFORE UPDATE ON lead_lists
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS leads_updated_at ON leads;
CREATE TRIGGER leads_updated_at
  BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- The plain-English ICP — the seed the Scorecard is translated from.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS icp_text TEXT;
