-- Tables that exist on prod but were created by hand, so no migration in the repo made them.
-- Read from prod's catalog on 2026-10-07 (read-only), so a database built from the repo matches prod.
-- RLS is on and none of them has a policy: only the service role reads them, as on prod.
-- Every block runs only when its table is missing, so on prod this file changes nothing.
-- workspace_skills.egress_hosts (text[]) is the one prod-only column.

-- campaign_briefs
do $$ begin
  if to_regclass('public.campaign_briefs') is null then
    execute $sql$create table if not exists public.campaign_briefs (
  workspace_id uuid not null,
  campaign_id text not null,
  brief text not null,
  meta jsonb,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
)$sql$;
    execute $sql$alter table public.campaign_briefs enable row level security$sql$;
    execute $sql$alter table public.campaign_briefs add constraint campaign_briefs_pkey PRIMARY KEY (workspace_id, campaign_id)$sql$;
  end if;
end $$;

-- coaching_notes
do $$ begin
  if to_regclass('public.coaching_notes') is null then
    execute $sql$create table if not exists public.coaching_notes (
  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  objection_id text not null,
  note text,
  updated_by uuid,
  updated_at timestamp with time zone default now() not null
)$sql$;
    execute $sql$alter table public.coaching_notes enable row level security$sql$;
    execute $sql$alter table public.coaching_notes add constraint coaching_notes_workspace_id_objection_id_key UNIQUE (workspace_id, objection_id)$sql$;
    execute $sql$alter table public.coaching_notes add constraint coaching_notes_pkey PRIMARY KEY (id)$sql$;
    execute $sql$alter table public.coaching_notes add constraint coaching_notes_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE$sql$;
    execute $sql$CREATE INDEX IF NOT EXISTS coaching_notes_ws_idx ON public.coaching_notes USING btree (workspace_id)$sql$;
  end if;
end $$;

-- credit_grants
do $$ begin
  if to_regclass('public.credit_grants') is null then
    execute $sql$create table if not exists public.credit_grants (
  id bigint generated always as identity not null,
  team_id uuid not null,
  credits integer not null,
  kind text default 'grant'::text not null,
  note text,
  stripe_session_id text,
  created_at timestamp with time zone default now() not null
)$sql$;
    execute $sql$alter table public.credit_grants enable row level security$sql$;
    execute $sql$alter table public.credit_grants add constraint credit_grants_stripe_session_id_key UNIQUE (stripe_session_id)$sql$;
    execute $sql$alter table public.credit_grants add constraint credit_grants_pkey PRIMARY KEY (id)$sql$;
    execute $sql$CREATE UNIQUE INDEX credit_grants_stripe_session_uniq ON public.credit_grants USING btree (stripe_session_id) WHERE (stripe_session_id IS NOT NULL)$sql$;
    execute $sql$CREATE INDEX IF NOT EXISTS credit_grants_team_idx ON public.credit_grants USING btree (team_id)$sql$;
  end if;
end $$;

-- lifecycle_events
do $$ begin
  if to_regclass('public.lifecycle_events') is null then
    execute $sql$create table if not exists public.lifecycle_events (
  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  company_id uuid not null,
  from_stage text,
  to_stage text not null,
  from_dept text,
  to_dept text,
  reason text,
  note text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  acknowledged_at timestamp with time zone,
  from_owner text,
  to_owner text,
  dedupe_key text
)$sql$;
    execute $sql$alter table public.lifecycle_events enable row level security$sql$;
    execute $sql$alter table public.lifecycle_events add constraint lifecycle_events_pkey PRIMARY KEY (id)$sql$;
    execute $sql$alter table public.lifecycle_events add constraint lifecycle_events_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE$sql$;
    execute $sql$CREATE UNIQUE INDEX lifecycle_events_dedupe ON public.lifecycle_events USING btree (workspace_id, company_id, dedupe_key)$sql$;
    execute $sql$CREATE INDEX IF NOT EXISTS lifecycle_events_ws_idx ON public.lifecycle_events USING btree (workspace_id, created_at DESC)$sql$;
    execute $sql$CREATE INDEX IF NOT EXISTS lifecycle_events_company_idx ON public.lifecycle_events USING btree (company_id, created_at DESC)$sql$;
  end if;
end $$;

-- objection_handlers
do $$ begin
  if to_regclass('public.objection_handlers') is null then
    execute $sql$create table if not exists public.objection_handlers (
  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  title text not null,
  objection_summary text,
  answer_md text,
  proof text,
  account_count integer default 0 not null,
  evidence jsonb default '{}'::jsonb not null,
  status text default 'open'::text not null,
  dedup_key text not null,
  rank integer default 0 not null,
  version integer default 1 not null,
  updated_at timestamp with time zone default now() not null
)$sql$;
    execute $sql$alter table public.objection_handlers enable row level security$sql$;
    execute $sql$alter table public.objection_handlers add constraint objection_handlers_workspace_id_dedup_key_key UNIQUE (workspace_id, dedup_key)$sql$;
    execute $sql$alter table public.objection_handlers add constraint objection_handlers_pkey PRIMARY KEY (id)$sql$;
    execute $sql$CREATE INDEX IF NOT EXISTS objection_handlers_ws_status_idx ON public.objection_handlers USING btree (workspace_id, status)$sql$;
  end if;
end $$;

-- reporting_insight_state
do $$ begin
  if to_regclass('public.reporting_insight_state') is null then
    execute $sql$create table if not exists public.reporting_insight_state (
  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  insight_id text not null,
  insight_kind text not null,
  role text not null,
  title text,
  status text default 'new'::text not null,
  note text,
  updated_by uuid,
  updated_at timestamp with time zone default now() not null
)$sql$;
    execute $sql$alter table public.reporting_insight_state enable row level security$sql$;
    execute $sql$alter table public.reporting_insight_state add constraint reporting_insight_state_workspace_id_insight_id_role_key UNIQUE (workspace_id, insight_id, role)$sql$;
    execute $sql$alter table public.reporting_insight_state add constraint reporting_insight_state_pkey PRIMARY KEY (id)$sql$;
    execute $sql$alter table public.reporting_insight_state add constraint reporting_insight_state_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE$sql$;
    execute $sql$alter table public.reporting_insight_state add constraint reporting_insight_state_status_check CHECK ((status = ANY (ARRAY['new'::text, 'working'::text, 'done'::text, 'dismissed'::text])))$sql$;
    execute $sql$CREATE INDEX IF NOT EXISTS reporting_insight_state_ws_role_idx ON public.reporting_insight_state USING btree (workspace_id, role)$sql$;
    execute $sql$CREATE INDEX IF NOT EXISTS reporting_insight_state_ws_status_idx ON public.reporting_insight_state USING btree (workspace_id, status)$sql$;
  end if;
end $$;

-- stripe_connections
do $$ begin
  if to_regclass('public.stripe_connections') is null then
    execute $sql$create table if not exists public.stripe_connections (
  workspace_id uuid not null,
  stripe_account_id text not null,
  connected_by uuid,
  livemode boolean default true,
  connected_at timestamp with time zone default now() not null
)$sql$;
    execute $sql$alter table public.stripe_connections enable row level security$sql$;
    execute $sql$alter table public.stripe_connections add constraint stripe_connections_stripe_account_id_key UNIQUE (stripe_account_id)$sql$;
    execute $sql$alter table public.stripe_connections add constraint stripe_connections_pkey PRIMARY KEY (workspace_id)$sql$;
    execute $sql$alter table public.stripe_connections add constraint stripe_connections_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE$sql$;
  end if;
end $$;

-- team_account_usage
do $$ begin
  if to_regclass('public.team_account_usage') is null then
    execute $sql$create table if not exists public.team_account_usage (
  team_id uuid not null,
  used integer default 0 not null,
  computed_at timestamp with time zone default now() not null
)$sql$;
    execute $sql$alter table public.team_account_usage enable row level security$sql$;
    execute $sql$alter table public.team_account_usage add constraint team_account_usage_pkey PRIMARY KEY (team_id)$sql$;
    execute $sql$alter table public.team_account_usage add constraint team_account_usage_team_id_fkey FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE$sql$;
  end if;
end $$;

-- workspace_features
do $$ begin
  if to_regclass('public.workspace_features') is null then
    execute $sql$create table if not exists public.workspace_features (
  id uuid default gen_random_uuid() not null,
  workspace_id uuid not null,
  title text not null,
  description text,
  shipped_at timestamp with time zone default now() not null,
  embedding jsonb,
  created_at timestamp with time zone default now() not null
)$sql$;
    execute $sql$alter table public.workspace_features enable row level security$sql$;
    execute $sql$alter table public.workspace_features add constraint workspace_features_pkey PRIMARY KEY (id)$sql$;
    execute $sql$CREATE INDEX IF NOT EXISTS workspace_features_ws_idx ON public.workspace_features USING btree (workspace_id, shipped_at DESC)$sql$;
  end if;
end $$;

alter table public.workspace_skills add column if not exists egress_hosts text[];

-- Functions made by hand on prod that this repo calls (refresh_entity_list_rows needs
-- list_row_values; companies, plans, listRowsRefresh and systemLog call the others).
-- Copied verbatim from prod with pg_get_functiondef (read-only, 2026-10-07).
CREATE OR REPLACE FUNCTION public.list_row_values(ws uuid)
 RETURNS TABLE(entity_id uuid, property text, val text)
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  WITH props AS (
    SELECT unnest(ARRAY['name','first_name','last_name','job_title','industry','icp_score',
                        'deal_health_score','pipeline_stage','status','value','stage','close_date',
                        'owner_name','pipeline_id','is_internal']) AS p
  ),
  cl AS (
    SELECT DISTINCT ON (c.entity_id, c.property)
           c.entity_id, c.property, COALESCE(c.value->>'value', c.value#>>'{}') AS val
      FROM claims c JOIN props ON props.p = c.property
     WHERE c.workspace_id = ws AND c.invalid_at IS NULL
     ORDER BY c.entity_id, c.property, c.computed_at DESC NULLS LAST
  ),
  ob AS (
    SELECT DISTINCT ON (o.entity_id, o.property)
           o.entity_id, o.property, COALESCE(o.value->>'value', o.value#>>'{}') AS val
      FROM observations o JOIN props ON props.p = o.property
     WHERE o.workspace_id = ws
     ORDER BY o.entity_id, o.property, o.observed_at DESC NULLS LAST
  )
  SELECT COALESCE(cl.entity_id, ob.entity_id), COALESCE(cl.property, ob.property),
         COALESCE(cl.val, ob.val)
    FROM cl FULL OUTER JOIN ob ON ob.entity_id = cl.entity_id AND ob.property = cl.property;
$function$;
CREATE OR REPLACE FUNCTION public.company_engagement_counts(ws uuid)
 RETURNS TABLE(company_id uuid, activity_count bigint, meeting_count bigint)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select c.company_id,
         count(*)::bigint as activity_count,
         count(*) filter (where o.property = 'interaction.meeting_held')::bigint as meeting_count
  from observations o
  join contacts c on c.id = o.entity_id
  where o.workspace_id = ws
    and o.kind = 'event'
    and o.property like 'interaction.%'
    and c.company_id is not null
  group by c.company_id;
$function$;
CREATE OR REPLACE FUNCTION public.refresh_team_account_usage(t uuid)
 RETURNS integer
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '120s'
AS $function$
  INSERT INTO team_account_usage (team_id, used, computed_at)
  SELECT t, COUNT(*), now()
    FROM entity_list_rows r
    JOIN workspaces w ON w.id = r.workspace_id AND w.team_id = t
   WHERE r.kind = 'account' AND r.last_activity_at IS NOT NULL
  ON CONFLICT (team_id) DO UPDATE SET used = EXCLUDED.used, computed_at = EXCLUDED.computed_at
  RETURNING used;
$function$;
CREATE OR REPLACE FUNCTION public.workspace_daily_ops(p_workspace_id uuid, p_since timestamp with time zone)
 RETURNS TABLE(day date, cnt bigint)
 LANGUAGE sql
 STABLE
AS $function$
  SELECT occurred_at::date AS day, count(*)::bigint AS cnt
  FROM workspace_system_log
  WHERE workspace_id = p_workspace_id
    AND event_type IS DISTINCT FROM 'agent.chat'
    AND occurred_at >= p_since
  GROUP BY 1
$function$;
