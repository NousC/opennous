-- The pipeline-stage vocabulary layer. Each workspace names its own stages; each maps to a
-- canonical rank on the pipeline ladder (identified…closed_won + terminals). No default set —
-- rows are captured at onboarding (pulled from the CRM when connected, or co-defined with the
-- agent). See packages/core/src/db/workspaceStages.ts. Idempotent.
CREATE TABLE IF NOT EXISTS public.workspace_stages (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  key               text NOT NULL,
  label             text NOT NULL,
  canonical         text NOT NULL,
  sort_order        integer NOT NULL DEFAULT 0,
  kind              text NOT NULL DEFAULT 'active',
  is_signup_default boolean NOT NULL DEFAULT false,
  source            text NOT NULL DEFAULT 'manual',
  external_ref      text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_stages_workspace_key_unique UNIQUE (workspace_id, key),
  CONSTRAINT workspace_stages_kind_check CHECK (kind = ANY (ARRAY['active','won','lost','churned'])),
  CONSTRAINT workspace_stages_canonical_check CHECK (canonical = ANY (ARRAY[
    'identified','connected','interested','meeting_booked','discovery','demo','negotiation','closed_won',
    'closed_lost','disqualified','churned'
  ]))
);
CREATE INDEX IF NOT EXISTS idx_workspace_stages_ws_order ON public.workspace_stages USING btree (workspace_id, sort_order);
