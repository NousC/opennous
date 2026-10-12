-- Nous Billing v2
-- ============================================================================
-- Pricing model: monthly subscription (Free/Pro/Scale) + included ops + one-time
-- top-up packs. Idempotent — safe to run on fresh or existing installs.
--
-- Ops metering: there is NO separate ledger table. The live op log
-- (workspace_system_log) is the single source of truth. Each row carries a
-- `billable_ops` weight; "ops used this period" is SUM(billable_ops) over the
-- subscription period. Empty scans never write a row (poller-side), so every
-- row in the log is a real op.
--
-- Plan IDs: 'free' | 'pro' | 'scale'. Enterprise is marketing-only.
-- Self-hosted bypasses metering entirely (enforced in application code).
-- ============================================================================

-- ── teams ──────────────────────────────────────────────────────────────────
-- The teams table predates this migration in production. Created here for
-- fresh installs; patched additively otherwise. Only billing columns it needs:
-- the Stripe customer link and the top-up balance. Monthly usage is NOT stored
-- here — it is computed from workspace_system_log.
-- teams↔user membership is resolved through workspace_members → workspaces,
-- so teams has no owner column of its own.
CREATE TABLE IF NOT EXISTS teams (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE teams ADD COLUMN IF NOT EXISTS stripe_customer_id text;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS stripe_payment_method_id text;
ALTER TABLE teams ADD COLUMN IF NOT EXISTS ops_topup_balance bigint NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS teams_stripe_customer_idx
  ON teams (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;

-- ── workspace_system_log.billable_ops ──────────────────────────────────────
-- The live op log is the ops meter. Every row counts for `billable_ops` ops
-- (default 1). Scans that logged N items set billable_ops = N. Non-billable
-- internal events can set it to 0.
ALTER TABLE workspace_system_log
  ADD COLUMN IF NOT EXISTS billable_ops integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS wsl_billing_idx
  ON workspace_system_log (workspace_id, occurred_at DESC)
  WHERE billable_ops > 0;

-- ── subscriptions ──────────────────────────────────────────────────────────
-- One row per team. plan_id is canonical; plan_name mirrors it via trigger.
-- NOTE: this table already exists in the hosted DB with an OLDER shape, so
-- every column is also patched in with ALTER ... ADD COLUMN IF NOT EXISTS and
-- plan_id is backfilled from plan_name before the sync trigger is installed.
CREATE TABLE IF NOT EXISTS subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  plan_id text,
  plan_name text,
  status text NOT NULL DEFAULT 'active',
  stripe_subscription_id text,
  stripe_price_id text,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  trial_ends_at timestamptz,
  is_comp boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id)
);

ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS plan_name text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS stripe_price_id text;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS is_comp boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS cancel_at_period_end boolean NOT NULL DEFAULT false;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_ends_at timestamptz;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Comp / open-ended subscriptions (and free-plan users) legitimately have no
-- Stripe period. Older tables created these columns NOT NULL — relax them so
-- the comp backfill below and the Stripe webhook can write NULLs.
ALTER TABLE subscriptions ALTER COLUMN current_period_start DROP NOT NULL;
ALTER TABLE subscriptions ALTER COLUMN current_period_end   DROP NOT NULL;
ALTER TABLE subscriptions ALTER COLUMN stripe_subscription_id DROP NOT NULL;
ALTER TABLE subscriptions ALTER COLUMN stripe_price_id      DROP NOT NULL;

-- Backfill plan_id for EVERY existing row from whatever plan_name is present.
UPDATE subscriptions SET plan_id =
  CASE lower(coalesce(plan_id, plan_name, 'free'))
    WHEN 'free' THEN 'free'  WHEN 'dev' THEN 'free'  WHEN 'trial' THEN 'free'
    WHEN 'pro' THEN 'pro'  WHEN 'starter' THEN 'pro'  WHEN 'build' THEN 'pro'
    WHEN 'professional' THEN 'pro'  WHEN 'standard' THEN 'pro'
    WHEN 'scale' THEN 'scale'  WHEN 'unlimited' THEN 'scale'  WHEN 'lifetime' THEN 'scale'
    WHEN 'consultancies' THEN 'scale'  WHEN 'agencies' THEN 'scale'  WHEN 'enterprise' THEN 'scale'
    ELSE 'free'
  END
WHERE plan_id IS NULL OR plan_id NOT IN ('free', 'pro', 'scale');

-- Mark unlimited/lifetime/beta-tester plans as comp (open-ended Scale access),
-- while plan_name still holds the ORIGINAL value.
UPDATE subscriptions
   SET is_comp = true, current_period_end = NULL, status = 'active'
 WHERE lower(coalesce(plan_name, '')) IN
       ('lifetime', 'unlimited', 'consultancies', 'agencies');

UPDATE subscriptions SET plan_name = plan_id WHERE plan_name IS DISTINCT FROM plan_id;

ALTER TABLE subscriptions ALTER COLUMN plan_id SET NOT NULL;
ALTER TABLE subscriptions ALTER COLUMN plan_name SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_stripe_idx
  ON subscriptions (stripe_subscription_id) WHERE stripe_subscription_id IS NOT NULL;
-- The Stripe webhook upserts on team_id, so it MUST be unique. If this fails
-- you have duplicate team_id rows: delete the older dupes, then re-run.
CREATE UNIQUE INDEX IF NOT EXISTS subscriptions_team_unique
  ON subscriptions (team_id);

CREATE OR REPLACE FUNCTION sync_subscription_plan_name() RETURNS trigger AS $$
BEGIN
  NEW.plan_name := NEW.plan_id;
  NEW.updated_at := now();
  RETURN NEW;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS subscriptions_sync_name ON subscriptions;
CREATE TRIGGER subscriptions_sync_name
  BEFORE INSERT OR UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION sync_subscription_plan_name();

ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS subscriptions_member_read ON subscriptions;
CREATE POLICY subscriptions_member_read ON subscriptions
  FOR SELECT TO authenticated
  USING (team_id IN (
    SELECT w.team_id FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = auth.uid()
  ));

-- ── op_pack_purchases ──────────────────────────────────────────────────────
-- Audit log of top-up pack purchases. The live balance is teams.ops_topup_balance;
-- this is the immutable history.
CREATE TABLE IF NOT EXISTS op_pack_purchases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  pack_id text NOT NULL,
  ops_granted integer NOT NULL CHECK (ops_granted > 0),
  amount_usd_cents integer NOT NULL CHECK (amount_usd_cents >= 0),
  stripe_payment_intent_id text,
  stripe_checkout_session_id text,
  is_auto_topup boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS op_pack_purchases_team_idx
  ON op_pack_purchases (team_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS op_pack_purchases_stripe_idx
  ON op_pack_purchases (stripe_payment_intent_id) WHERE stripe_payment_intent_id IS NOT NULL;

ALTER TABLE op_pack_purchases ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS op_pack_purchases_member_read ON op_pack_purchases;
CREATE POLICY op_pack_purchases_member_read ON op_pack_purchases
  FOR SELECT TO authenticated
  USING (team_id IN (
    SELECT w.team_id FROM workspaces w
      JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = auth.uid()
  ));

-- ── team_ops_used() ────────────────────────────────────────────────────────
-- Sum of billable_ops across all of a team's workspaces since `p_since`.
-- This IS the ops meter — called by /api/usage, /api/billing/state, and the
-- ops-balance gate. p_since is normally the subscription period start.
CREATE OR REPLACE FUNCTION team_ops_used(p_team_id uuid, p_since timestamptz)
RETURNS bigint
LANGUAGE sql STABLE
AS $$
  SELECT COALESCE(SUM(wsl.billable_ops), 0)::bigint
  FROM workspace_system_log wsl
  JOIN workspaces w ON w.id = wsl.workspace_id
  WHERE w.team_id = p_team_id
    AND wsl.billable_ops > 0
    AND wsl.occurred_at >= p_since;
$$;

-- ── Backfill: legacy ops_balance → ops_topup_balance ───────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'teams' AND column_name = 'ops_balance') THEN
    EXECUTE $sql$
      UPDATE teams SET ops_topup_balance = ops_topup_balance + COALESCE(ops_balance, 0)
       WHERE COALESCE(ops_balance, 0) > 0 AND COALESCE(ops_topup_balance, 0) = 0
    $sql$;
  END IF;
END $$;

-- ── Notes for future cleanup ───────────────────────────────────────────────
-- Once stable, a follow-up migration may DROP the now-unused legacy columns:
--   ALTER TABLE teams DROP COLUMN IF EXISTS ops_balance;
--   ALTER TABLE teams DROP COLUMN IF EXISTS ops_total_purchased;
--   ALTER TABLE teams DROP COLUMN IF EXISTS ops_accounts_limit;
--   ALTER TABLE teams DROP COLUMN IF EXISTS ops_monthly_used;
--   ALTER TABLE teams DROP COLUMN IF EXISTS ops_period_start;
--   ALTER TABLE teams DROP COLUMN IF EXISTS auto_topup_enabled;
--   ALTER TABLE teams DROP COLUMN IF EXISTS auto_topup_threshold;
--   ALTER TABLE teams DROP COLUMN IF EXISTS auto_topup_pack_id;
--   DROP TABLE IF EXISTS memory_ops_log;
-- Left in place here to avoid nuking data before the cutover is verified.
