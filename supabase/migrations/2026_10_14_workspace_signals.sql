-- Workspace signals (GET-862): custom signal definitions and their extractions.
-- A definition belongs to the WORKSPACE, not a RevBox: `revbox_id` only records the box that
-- proposed it, and survives that box's deletion as null. `key` is the stable, never-repurposed
-- handle a job trigger and an emitted account signal refer to (`custom.<key>`); retiring a signal
-- archives it, so the key is never reused for a different meaning. One transaction.
BEGIN;

CREATE TABLE public.custom_signal_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  key text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  revbox_id uuid,
  owner_id uuid NOT NULL REFERENCES public.users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
  rule text NOT NULL CHECK (length(rule) BETWEEN 1 AND 4000),
  examples text NOT NULL DEFAULT '' CHECK (length(examples) <= 8000),
  sources text[] NOT NULL DEFAULT '{}',
  version integer NOT NULL DEFAULT 1,
  versions jsonb NOT NULL DEFAULT '[]',
  active boolean NOT NULL DEFAULT false,
  archived_at timestamptz,
  cursor_at timestamptz NOT NULL DEFAULT now(),
  cursor_claim_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, key),
  CHECK (archived_at IS NULL OR active = false),
  FOREIGN KEY (revbox_id, workspace_id) REFERENCES public.revboxes(id, workspace_id) ON DELETE SET NULL (revbox_id),
  FOREIGN KEY (workspace_id, owner_id) REFERENCES public.workspace_members(workspace_id, user_id) ON DELETE CASCADE
);
CREATE INDEX custom_signal_definitions_active ON public.custom_signal_definitions(workspace_id) WHERE active;

CREATE TABLE public.custom_signal_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id uuid NOT NULL REFERENCES public.custom_signal_definitions(id) ON DELETE CASCADE,
  version integer NOT NULL,
  claim_id uuid NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  claim_computed_at timestamptz NOT NULL,
  state text NOT NULL DEFAULT 'running' CHECK (state IN ('running','matched','unmatched','failed')),
  quote text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (definition_id, version, claim_id, claim_computed_at)
);

ALTER TABLE public.custom_signal_definitions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.custom_signal_extractions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.custom_signal_definitions, public.custom_signal_extractions FROM anon, authenticated;
GRANT ALL ON public.custom_signal_definitions, public.custom_signal_extractions TO service_role;

COMMIT;
