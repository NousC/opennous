-- Adds business_type, plan_model, and default_signup_stage to workspaces
-- so the CRM terminology (Client vs Customer) and the label for new signups
-- (Free User, Trial, Lead, ...) is per-workspace instead of hardcoded.
-- Plus users.welcome_email_sent_at so the welcome email never double-sends.

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS business_type TEXT,
  ADD COLUMN IF NOT EXISTS plan_model TEXT,
  ADD COLUMN IF NOT EXISTS default_signup_stage TEXT;

DO $$ BEGIN
  ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_business_type_check
    CHECK (business_type IS NULL OR business_type IN ('service', 'software'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE workspaces
    ADD CONSTRAINT workspaces_plan_model_check
    CHECK (plan_model IS NULL OR plan_model IN ('free_plan', 'free_trial', 'both', 'paid_only'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS welcome_email_sent_at TIMESTAMPTZ;
