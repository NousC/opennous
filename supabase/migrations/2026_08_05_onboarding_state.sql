-- Explicit onboarding state for the in-platform (agent-led) onboarding flow.
--
-- Replaces the implicit "has an ICP" gate. The app now unlocks when the user finishes
-- the connect wizard (data source + >=3 sources) and clicks Get Started
-- (onboarding_activated_at) — which happens BEFORE the ICP exists, because the in-app
-- agent writes the ICP after entry. onboarding_completed_at is stamped by the agent when
-- setup (ICP + model + stage mapping) is actually done; it gates nothing, it's for
-- next-steps / reporting. Idempotent.
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS onboarding_activated_at timestamptz;
ALTER TABLE public.workspaces ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

-- Backfill: any workspace already past onboarding must not be re-gated by the new wizard.
-- Treat "has an ICP foundation" OR "business_type set" as already activated and completed,
-- dated to workspace creation.
UPDATE public.workspaces w
SET onboarding_activated_at = COALESCE(w.onboarding_activated_at, w.created_at, now()),
    onboarding_completed_at = COALESCE(w.onboarding_completed_at, w.created_at, now())
WHERE w.onboarding_activated_at IS NULL
  AND (
    w.business_type IS NOT NULL
    OR EXISTS (
      SELECT 1 FROM public.foundations f
      WHERE f.workspace_id = w.id
        AND f.kind = 'icp'
        AND f.body_md IS NOT NULL
        AND btrim(f.body_md) <> ''
    )
  );
