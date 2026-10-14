-- RevBoxes on the API plan (GET-858, GET-860, GET-861): the box, its members, context and jobs;
-- runs, deliveries and inbound events; the credit ledger; webhook keys; the Accounts overview read.
-- Folds the eleven 2026-10-13 drafts into one ordered migration. One transaction: it applies whole or
-- not at all. Every table is service-role only; access is checked by the server per box.
BEGIN;

CREATE TABLE public.revboxes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES public.users(id),
  name text NOT NULL DEFAULT 'Untitled RevBox' CHECK (length(name) BETWEEN 1 AND 120),
  objective text NOT NULL DEFAULT '' CHECK (length(objective) <= 4000),
  shared boolean NOT NULL DEFAULT false,
  scope jsonb NOT NULL DEFAULT '{"mode":"selected","account_ids":[],"min_icp":70}'::jsonb,
  blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  delivery jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id)
);
CREATE TABLE public.revbox_members (
  revbox_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES public.users(id),
  role text NOT NULL DEFAULT 'editor' CHECK (role IN ('editor', 'viewer')),
  PRIMARY KEY (revbox_id, user_id),
  FOREIGN KEY (revbox_id, workspace_id) REFERENCES public.revboxes(id, workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, user_id) REFERENCES public.workspace_members(workspace_id, user_id) ON DELETE CASCADE
);
CREATE TABLE public.revbox_context (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revbox_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body text NOT NULL DEFAULT '' CHECK (octet_length(body) <= 262144),
  document_id uuid REFERENCES public.documents(id) ON DELETE CASCADE,
  created_by uuid NOT NULL REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (revbox_id, workspace_id) REFERENCES public.revboxes(id, workspace_id) ON DELETE CASCADE
);
CREATE TABLE public.revbox_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  revbox_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  created_by uuid NOT NULL REFERENCES public.users(id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
  prompt text NOT NULL CHECK (length(prompt) BETWEEN 1 AND 12000),
  plan jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'reviewed')),
  reviewed_at timestamptz,
  reviewed_by uuid REFERENCES public.users(id),
  snapshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  enabled boolean NOT NULL DEFAULT false,
  next_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, workspace_id),
  FOREIGN KEY (revbox_id, workspace_id) REFERENCES public.revboxes(id, workspace_id) ON DELETE CASCADE
);
CREATE INDEX revboxes_workspace_updated ON public.revboxes(workspace_id, updated_at DESC);
CREATE INDEX revbox_context_box ON public.revbox_context(revbox_id, workspace_id);
CREATE INDEX revbox_jobs_box ON public.revbox_jobs(revbox_id, workspace_id);
ALTER TABLE public.revboxes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revbox_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revbox_context ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revbox_jobs ENABLE ROW LEVEL SECURITY;
-- All reads go through the authenticated server's fresh workspace and box checks.
REVOKE ALL ON public.revboxes, public.revbox_members, public.revbox_context, public.revbox_jobs FROM anon, authenticated;
GRANT ALL ON public.revboxes, public.revbox_members, public.revbox_context, public.revbox_jobs TO service_role;

CREATE TABLE public.revbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  type text NOT NULL,
  account_id uuid,
  owner_user_id uuid,
  data jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL,
  dedupe_key text NOT NULL,
  processed_at timestamptz,
  error text,
  UNIQUE(workspace_id,type,dedupe_key)
);
ALTER TABLE public.revbox_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.revbox_events FROM anon,authenticated;
GRANT ALL ON public.revbox_events TO service_role;
CREATE INDEX revbox_events_pending ON public.revbox_events(occurred_at) WHERE processed_at IS NULL;

CREATE TABLE public.revbox_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  revbox_id uuid NOT NULL,
  job_id uuid NOT NULL,
  actor_id uuid NOT NULL REFERENCES public.users(id),
  job_version integer NOT NULL,
  occurrence text NOT NULL,
  state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','running','needs_review','completed','failed')),
  snapshot jsonb NOT NULL,
  account_ids uuid[] NOT NULL DEFAULT '{}',
  result jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(job_id,occurrence),
  FOREIGN KEY (revbox_id,workspace_id) REFERENCES public.revboxes(id,workspace_id) ON DELETE CASCADE,
  FOREIGN KEY (job_id,workspace_id) REFERENCES public.revbox_jobs(id,workspace_id) ON DELETE CASCADE
);
CREATE TABLE public.revbox_deliveries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.revbox_runs(id) ON DELETE CASCADE,
  destination_id text NOT NULL,
  destination jsonb NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','uncertain')),
  error text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id,destination_id)
);
CREATE INDEX revbox_runs_queued ON public.revbox_runs(created_at) WHERE state='queued';
CREATE INDEX revbox_runs_box ON public.revbox_runs(workspace_id,revbox_id,created_at DESC);
ALTER TABLE public.revbox_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.revbox_deliveries ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.revbox_runs,public.revbox_deliveries FROM anon,authenticated;
GRANT ALL ON public.revbox_runs,public.revbox_deliveries TO service_role;

-- Attribution and the billing ledger commit together, deduplicated per paid call.
CREATE TABLE public.revbox_usage (
  request_id text PRIMARY KEY,
  workspace_id uuid NOT NULL,
  revbox_id uuid,
  job_id uuid,
  run_id uuid,
  feature text NOT NULL,
  cost_usd numeric(12,6) NOT NULL CHECK (cost_usd >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A custom signal's extraction is billed to the workspace when no box introduced it, and a
  -- deleted box keeps its spend on the ledger.
  FOREIGN KEY (revbox_id, workspace_id) REFERENCES public.revboxes(id, workspace_id) ON DELETE SET NULL (revbox_id)
);
ALTER TABLE public.revbox_usage ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.revbox_usage FROM anon, authenticated;
GRANT ALL ON public.revbox_usage TO service_role;
CREATE FUNCTION public.record_revbox_usage(p_workspace_id uuid, p_user_id uuid, p_revbox_id uuid, p_job_id uuid, p_run_id uuid, p_feature text, p_model text, p_usage jsonb, p_cost_usd numeric, p_request_id text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE inserted_id text;
BEGIN
  IF p_request_id IS NULL OR length(p_request_id) = 0 OR p_cost_usd IS NULL OR p_cost_usd < 0 THEN
    RAISE EXCEPTION 'Invalid usage';
  END IF;
  INSERT INTO revbox_usage(request_id, workspace_id, revbox_id, job_id, run_id, feature, cost_usd)
    VALUES(p_request_id, p_workspace_id, p_revbox_id, p_job_id, p_run_id, p_feature, p_cost_usd)
    ON CONFLICT DO NOTHING RETURNING request_id INTO inserted_id;
  IF inserted_id IS NOT NULL THEN
    INSERT INTO llm_usage(workspace_id,user_id,feature,model,input_tokens,cache_creation_tokens,cache_read_tokens,output_tokens,cost_usd,request_id)
      VALUES(p_workspace_id,p_user_id,p_feature,p_model,COALESCE((p_usage->>'input_tokens')::integer,0),COALESCE((p_usage->>'cache_creation_input_tokens')::integer,0),COALESCE((p_usage->>'cache_read_input_tokens')::integer,0),COALESCE((p_usage->>'output_tokens')::integer,0),p_cost_usd,p_request_id);
  END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.record_revbox_usage(uuid,uuid,uuid,uuid,uuid,text,text,jsonb,numeric,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_revbox_usage(uuid,uuid,uuid,uuid,uuid,text,text,jsonb,numeric,text) TO service_role;

CREATE INDEX revbox_usage_run ON public.revbox_usage(workspace_id,revbox_id,run_id);
CREATE FUNCTION public.revbox_run_costs(p_workspace_id uuid,p_revbox_id uuid,p_run_ids uuid[])
RETURNS TABLE(run_id uuid,cost_usd numeric) LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
  SELECT u.run_id,sum(u.cost_usd) FROM revbox_usage u
  WHERE u.workspace_id=p_workspace_id AND u.revbox_id=p_revbox_id AND u.run_id=ANY(p_run_ids)
  GROUP BY u.run_id;
$$;
REVOKE ALL ON FUNCTION public.revbox_run_costs(uuid,uuid,uuid[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.revbox_run_costs(uuid,uuid,uuid[]) TO service_role;

CREATE TABLE public.revbox_webhook_keys (
  job_id uuid PRIMARY KEY REFERENCES public.revbox_jobs(id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.revbox_webhook_keys ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.revbox_webhook_keys FROM anon,authenticated;
GRANT ALL ON public.revbox_webhook_keys TO service_role;

-- Resolve current claim visibility before returning a latest signal.
CREATE OR REPLACE FUNCTION public.revbox_account_overview(p_workspace_id uuid, p_ids uuid[])
RETURNS TABLE(id uuid, deal_count bigint, won_deals bigint, lost_deals bigint, latest_signal jsonb)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT a.entity_id,
    (SELECT count(*) FROM entity_list_rows d WHERE d.workspace_id = p_workspace_id AND d.kind = 'deal' AND d.company_id = a.entity_id),
    (SELECT count(*) FROM deal_outcomes o WHERE o.workspace_id = p_workspace_id AND o.entity_id = a.entity_id AND o.outcome = 'won'),
    (SELECT count(*) FROM deal_outcomes o WHERE o.workspace_id = p_workspace_id AND o.entity_id = a.entity_id AND o.outcome = 'lost'),
    (SELECT jsonb_build_object('kind', s.kind, 'title', s.title, 'at', s.occurred_at, 'entity_id', s.entity_id, 'claim_property', s.claim_property)
     FROM account_signals s WHERE s.workspace_id = p_workspace_id AND s.account_id = a.entity_id AND s.team_readable IS TRUE
     ORDER BY s.occurred_at DESC NULLS LAST, s.detected_at DESC LIMIT 1)
  FROM entity_list_rows a WHERE a.workspace_id = p_workspace_id AND a.kind = 'account' AND a.entity_id = ANY(p_ids);
$$;
REVOKE ALL ON FUNCTION public.revbox_account_overview(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revbox_account_overview(uuid, uuid[]) TO service_role;

-- A row lock serializes concurrent refreshes. Only the first status transition
-- creates the occurrence; importing already-completed campaigns stays quiet.
CREATE FUNCTION public.queue_revbox_campaign_completion()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  IF NEW.provider='instantly' AND NEW.status=3 AND OLD.status IS DISTINCT FROM 3
     AND EXISTS(SELECT 1 FROM revbox_jobs j WHERE j.workspace_id=NEW.workspace_id AND j.enabled AND j.plan->'trigger'->>'kind'='campaign_completed') THEN
    INSERT INTO revbox_events(workspace_id,type,data,occurred_at,dedupe_key)
    VALUES(NEW.workspace_id,'campaign.completed',jsonb_build_object('source',NEW.provider,'campaign_id',NEW.campaign_id,'campaign_name',NEW.campaign_name,'stats',jsonb_build_object('contacted',NEW.contacted_count,'replies',NEW.reply_count,'opportunities',NEW.opportunity_count,'sent',NEW.sent_count,'bounced',NEW.bounced_count)),NEW.fetched_at,NEW.campaign_id||':'||NEW.fetched_at::text)
    ON CONFLICT DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.queue_revbox_campaign_completion() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER revbox_campaign_completed AFTER UPDATE ON public.campaign_stats FOR EACH ROW EXECUTE FUNCTION public.queue_revbox_campaign_completion();

COMMIT;
