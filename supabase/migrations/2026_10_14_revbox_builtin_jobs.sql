-- RevBox built-in jobs (GET-872): a box can list OpenNous's built-in jobs (the Workspace plan's
-- default automations, which run as OpenNous detectors and the after-call follow-up, not as
-- agent_routines rows). Listing one changes nothing about how it runs. The keys mirror core
-- REVBOX_BUILTIN_KEYS (packages/core/src/db/revboxes.mjs). "One box per workspace" is checked by the
-- server on save (core patchRevbox, a 409). One transaction: it applies whole or not at all.
BEGIN;

ALTER TABLE public.revboxes
  ADD COLUMN IF NOT EXISTS builtin_jobs text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.revboxes
  DROP CONSTRAINT IF EXISTS revboxes_builtin_jobs_known;
ALTER TABLE public.revboxes
  ADD CONSTRAINT revboxes_builtin_jobs_known CHECK (
    builtin_jobs <@ ARRAY['sales_follow_up', 'stale_deal', 'deal_signals', 'deal_risk', 'expansion']::text[]
  );

COMMENT ON COLUMN public.revboxes.builtin_jobs IS
  'OpenNous built-in jobs this box lists (GET-872): sales_follow_up, stale_deal, deal_signals, deal_risk, expansion. Each in at most one box per workspace (checked by the server).';

COMMIT;
