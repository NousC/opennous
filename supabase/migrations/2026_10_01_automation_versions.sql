-- Automation versions (GET-584).
--
-- An automation is edited in a draft and published as a numbered version. Every publish keeps a
-- snapshot, every run records the version that was live, and any version can be restored (as a
-- new version — nothing is overwritten).
--
-- VERSIONED IN THE DATABASE, NOT IN EACH WRITER. agent_routines is written by the editor API,
-- /v2/workflows, the in-app agent's tools and the older routines API. A trigger here versions all
-- of them: any write that changes what an automation IS (its name, trigger, steps, agent, where it
-- sends) bumps `version` and keeps a snapshot. Bookkeeping — enabled, last_run_at, next_run_at,
-- condition_state, the draft itself — changes nothing.
--
-- Safe to run more than once.

ALTER TABLE public.agent_routines ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
-- The editor's unpublished changes: the same body a save sends, held until Publish. Null = none.
ALTER TABLE public.agent_routines ADD COLUMN IF NOT EXISTS draft jsonb;
-- Who made the last content change, carried onto that version's snapshot.
ALTER TABLE public.agent_routines ADD COLUMN IF NOT EXISTS edited_by uuid;
-- The version that was live when this run started.
ALTER TABLE public.agent_routine_runs ADD COLUMN IF NOT EXISTS version integer;

CREATE TABLE IF NOT EXISTS public.automation_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  routine_id    uuid NOT NULL REFERENCES public.agent_routines(id) ON DELETE CASCADE,
  version       integer NOT NULL,
  snapshot      jsonb NOT NULL,
  published_by  uuid,
  published_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (routine_id, version)
);
CREATE INDEX IF NOT EXISTS automation_versions_routine ON public.automation_versions (routine_id, version DESC);
ALTER TABLE public.automation_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS automation_versions_select ON public.automation_versions;
CREATE POLICY automation_versions_select ON public.automation_versions
  FOR SELECT USING (is_workspace_member(workspace_id));

-- What an automation IS, as one object. Built from a whitelist of keys so a column added later
-- is a deliberate choice, and a key missing on some install is simply absent.
CREATE OR REPLACE FUNCTION public.agent_routine_snapshot(r jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(jsonb_object_agg(k, r -> k), '{}'::jsonb)
  FROM unnest(ARRAY[
    'name', 'prompt', 'trigger_kind', 'frequency', 'at_time', 'day_of_week', 'day_of_month',
    'timezone', 'offset_minutes', 'entity_id', 'condition', 'action', 'artifact',
    'destination', 'destination_target', 'tools', 'steps', 'trigger_config'
  ]) AS k
  WHERE r ? k
$$;

-- Before a write: a content change takes the next version number.
CREATE OR REPLACE FUNCTION public.agent_routines_version_bump() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW.version := coalesce(NEW.version, 1);
  ELSIF public.agent_routine_snapshot(to_jsonb(NEW)) IS DISTINCT FROM public.agent_routine_snapshot(to_jsonb(OLD)) THEN
    NEW.version := coalesce(OLD.version, 0) + 1;
  ELSE
    NEW.version := OLD.version;
  END IF;
  RETURN NEW;
END $$;

-- After a write: a new version gets its snapshot.
CREATE OR REPLACE FUNCTION public.agent_routines_version_keep() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.version IS DISTINCT FROM OLD.version THEN
    INSERT INTO public.automation_versions (workspace_id, routine_id, version, snapshot, published_by)
    VALUES (NEW.workspace_id, NEW.id, NEW.version, public.agent_routine_snapshot(to_jsonb(NEW)), NEW.edited_by)
    ON CONFLICT (routine_id, version) DO NOTHING;
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS agent_routines_version_bump ON public.agent_routines;
CREATE TRIGGER agent_routines_version_bump BEFORE INSERT OR UPDATE ON public.agent_routines
  FOR EACH ROW EXECUTE FUNCTION public.agent_routines_version_bump();
DROP TRIGGER IF EXISTS agent_routines_version_keep ON public.agent_routines;
CREATE TRIGGER agent_routines_version_keep AFTER INSERT OR UPDATE ON public.agent_routines
  FOR EACH ROW EXECUTE FUNCTION public.agent_routines_version_keep();

-- A run is stamped with the version that was live when it started, whoever inserts it.
CREATE OR REPLACE FUNCTION public.agent_routine_runs_stamp_version() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.version IS NULL AND NEW.routine_id IS NOT NULL THEN
    SELECT r.version INTO NEW.version FROM public.agent_routines r WHERE r.id = NEW.routine_id;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_routine_runs_stamp_version ON public.agent_routine_runs;
CREATE TRIGGER agent_routine_runs_stamp_version BEFORE INSERT ON public.agent_routine_runs
  FOR EACH ROW EXECUTE FUNCTION public.agent_routine_runs_stamp_version();

-- Every automation that exists today is its own v1, as it is now.
INSERT INTO public.automation_versions (workspace_id, routine_id, version, snapshot, published_at)
SELECT r.workspace_id, r.id, r.version, public.agent_routine_snapshot(to_jsonb(r)), coalesce(r.updated_at, r.created_at, now())
FROM public.agent_routines r
ON CONFLICT (routine_id, version) DO NOTHING;
