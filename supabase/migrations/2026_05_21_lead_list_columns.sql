-- Lists — user-defined columns.
--
-- A lead list is a small table the user shapes themselves. Five columns are
-- fixed (name, email, company, linkedin_url, status); everything else is
-- user-defined. `lead_lists.columns` holds the list's custom column
-- definitions ([{ key, label }]); `leads.fields` holds each lead's values for
-- them ({ key: value }).
--
-- See docs/adaptive-lead-scoring.md for how lead context feeds scoring.
-- Safe to re-run.

ALTER TABLE lead_lists ADD COLUMN IF NOT EXISTS columns JSONB NOT NULL DEFAULT '[]';
ALTER TABLE leads      ADD COLUMN IF NOT EXISTS fields  JSONB NOT NULL DEFAULT '{}';
