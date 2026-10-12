-- Make the flattened lists cheap enough to keep current (GET-297).
--
-- Applied to production 2026-09-17 while diagnosing why a large workspace's Accounts and People pages
-- showed "no accounts" after a big import. The read model (entity_list_rows, GET-296)
-- was the right idea, but the code that filled it could not finish inside PostgREST's eight-second
-- statement limit, so it was killed every time and the lists it fed stayed empty.
--
-- Four separate costs, each found by measuring rather than guessing, on a 1,000-account chunk:
--
--   1. FULL OUTER JOIN of the claim and observation lookups         6.1s  ->  0.13s   (47x)
--      Each side measured 39ms and 252ms alone. The planner could not hold the merge ordering
--      across a full outer join of two DISTINCT ON subqueries, so it re-sorted and re-probed both.
--      A UNION ALL with a `pri` column saying "claim outranks observation" is one sort.
--
--   2. Rewriting every row whether or not it changed                12.5s ->  2.6s    (per 2,000)
--      Every rewrite re-indexed the row, including the GIN trigram index behind list search. A
--      sweep over settled data changes almost nothing, so DO UPDATE now carries an IS DISTINCT
--      FROM guard and a no-op chunk writes no rows at all.
--
--   3. Recomputing what was already computed                        14.6s ->  1.0s    (accounts)
--      The account rollup re-scanned observations per employee and re-read claims per deal, when
--      the person and deal rows already held exactly those numbers. It now reads them.
--
--   4. A cursor scan with no index to walk                          the whole workspace per chunk
--      `where workspace_id=? and type=? and id > cursor order by id` stopped at (workspace_id,
--      type), so every chunk fetched the whole workspace and threw away all but its limit.
--
-- Net: a full sweep of a large workspace now costs about a minute, and
-- every individual call finishes inside the budget. Two consequences are deliberate and worth
-- knowing before changing this file:
--
--   * KIND ORDER IS LOAD-BEARING. An account rolls up its person and deal rows, so the worker
--     sweeps deal -> person -> account. Reverse it and accounts are a sweep behind.
--   * refreshed_at now means "last CHANGED", not "last looked at", because unchanged rows are
--     skipped. Sweep coverage is a worker-log fact, not a per-row one.

-- ---------------------------------------------------------------------------
-- 1. The cursor the chunked rebuild walks.
-- ---------------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS entities_workspace_type_id
  ON public.entities (workspace_id, type, id)
  WHERE (status = 'active');

-- An account's money is the sum of its deal rows; this is how it finds them.
CREATE INDEX IF NOT EXISTS entity_list_deal_company
  ON public.entity_list_rows (workspace_id, company_id)
  WHERE (kind = 'deal');

-- ---------------------------------------------------------------------------
-- 2. Stop queueing claim work that can never produce a claim.
-- ---------------------------------------------------------------------------
-- An `interaction.*` observation is an EVENT on a timeline ("we emailed them on the 3rd"), not a
-- statement about the entity that a claim could resolve. The engine has never produced one: zero
-- `interaction.%` claims exist in this database across every workspace, for its whole history. Yet
-- the trigger enqueued one job per interaction, so one large import alone queued a huge number of
-- guaranteed no-ops — a large share of the entire queue — and the engine burned its concurrency on them
-- while real claims waited behind.
--
-- If a claim rule is ever written FOR an interaction property, this filter has to come off at the
-- same time, or that rule will silently never fire.
CREATE OR REPLACE FUNCTION public.enqueue_claim_recompute()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW.property LIKE 'interaction.%' THEN
    RETURN NEW;
  END IF;
  INSERT INTO claim_jobs (workspace_id, entity_id, property)
  VALUES (NEW.workspace_id, NEW.entity_id, NEW.property);
  RETURN NEW;
END; $function$;

-- The already-queued no-ops. Safe to re-run; safe to interrupt.
DELETE FROM claim_jobs WHERE property LIKE 'interaction.%';

-- ---------------------------------------------------------------------------
-- 3. The chunk itself.
-- ---------------------------------------------------------------------------
-- Cursor-based (`id > p_after`, `order by id`) so a caller can walk a workspace in pieces, and an
-- UPSERT so a chunk that fails leaves its rows STALE rather than missing. A list is allowed to be
-- a few minutes behind. It is not allowed to be blank — that was the original bug, a rebuild that
-- deleted before it inserted and was killed in between.
CREATE OR REPLACE FUNCTION public.refresh_list_chunk(ws uuid, p_kind text, p_after uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid, p_limit integer DEFAULT 400)
 RETURNS TABLE(processed integer, last_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  n integer := 0;
  last uuid;
  own_domain text;
  entity_type text := case p_kind when 'account' then 'company' when 'person' then 'person' else 'deal' end;
  props text[] := array['name','first_name','last_name','job_title','industry','icp_score',
                        'deal_health_score','pipeline_stage','status','value','stage',
                        'close_date','owner_name','pipeline_id','is_internal'];
begin
  select nullif(split_part(regexp_replace(lower(coalesce(w.website,'')), '^https?://(www\.)?', ''), '/', 1), '')
    into own_domain from workspaces w where w.id = ws;

  -- ON COMMIT DROP only fires at commit, so a second call inside one transaction — a loop in a DO
  -- block, or anything that batches chunks — used to fail with "relation _ids already exists".
  -- Each call starts from a clean slate instead.
  drop table if exists _ids, _v, _act, _staff, _deals;

  create temp table _ids on commit drop as
  select e.id from entities e
   where e.workspace_id = ws and e.type = entity_type and e.status = 'active' and e.id > p_after
   order by e.id limit p_limit;
  create unique index on _ids (id);
  analyze _ids;
  -- uuid has no max(); the chunk is ordered by id, so the last one is the cursor.
  select count(*) into n from _ids;
  select id into last from _ids order by id desc limit 1;
  if n = 0 then return query select 0, p_after; return; end if;

  -- Claim first, observation second: pri 0 outranks pri 1, then newest wins. A list must never
  -- wait on the claim queue to show a name it already has an observation for.
  create temp table _v on commit drop as
  select distinct on (u.entity_id, u.prop) u.entity_id, u.prop, u.val
    from (
      select cl.entity_id, cl.property as prop,
             coalesce(cl.value->>'value', cl.value#>>'{}') as val, 0 as pri, cl.computed_at as at
        from claims cl join _ids i on i.id = cl.entity_id
       where cl.invalid_at is null and cl.property = any(props)
      union all
      select ob.entity_id, ob.property,
             coalesce(ob.value->>'value', ob.value#>>'{}'), 1, ob.observed_at
        from observations ob join _ids i on i.id = ob.entity_id
       where ob.property = any(props)
    ) u
   order by u.entity_id, u.prop, u.pri, u.at desc nulls last;
  create index on _v (entity_id, prop);
  analyze _v;

  create temp table _act on commit drop as
  select ob.entity_id, max(ob.observed_at) as at
    from observations ob join _ids i on i.id = ob.entity_id
   where ob.property like 'interaction.%'
   group by ob.entity_id;
  create unique index on _act (entity_id);
  analyze _act;

  if p_kind = 'account' then
    -- Who works here and when they were last touched: read the person rows, not observations.
    create temp table _staff on commit drop as
    select r.to_entity_id as account_id, count(*) as people_count, max(pl.last_activity_at) as at
      from relationships r
      join _ids i on i.id = r.to_entity_id
      left join entity_list_rows pl
        on pl.workspace_id = ws and pl.entity_id = r.from_entity_id and pl.kind = 'person'
     where r.workspace_id = ws and r.type = 'works_at' and r.valid_to is null
     group by r.to_entity_id;
    create unique index on _staff (account_id);
    analyze _staff;

    -- The money: read the deal rows, not claims.
    create temp table _deals on commit drop as
    select dl.company_id as account_id,
           count(*) filter (where dl.status = 'open') as open_deals,
           sum(dl.pipeline_value) filter (where dl.status = 'open') as pipeline_value,
           sum(dl.pipeline_value) filter (where dl.status = 'won') as won_value
      from entity_list_rows dl
      join _ids i on i.id = dl.company_id
     where dl.workspace_id = ws and dl.kind = 'deal'
     group by dl.company_id;
    create unique index on _deals (account_id);
    analyze _deals;

    insert into entity_list_rows (workspace_id, entity_id, kind, name, domain, industry, icp_score, deal_health, people_count, open_deals, pipeline_value, won_value, last_activity_at, refreshed_at)
    select ws, i.id, 'account',
           v.name, ident.value, v.industry,
           nullif(v.icp_score,'')::numeric::integer,
           nullif(v.deal_health_score,'')::numeric::integer,
           coalesce(s.people_count, 0),
           coalesce(d.open_deals, 0), d.pipeline_value, d.won_value,
           greatest(a.at, s.at),
           now()
      from _ids i
      left join lateral (select
             max(val) filter (where prop='name') as name,
             max(val) filter (where prop='industry') as industry,
             max(val) filter (where prop='icp_score') as icp_score,
             max(val) filter (where prop='deal_health_score') as deal_health_score,
             max(val) filter (where prop='is_internal') as is_internal
           from _v where entity_id = i.id) v on true
      left join _act a on a.entity_id = i.id
      left join _staff s on s.account_id = i.id
      left join _deals d on d.account_id = i.id
      left join lateral (select ei.value from entity_identifiers ei
             where ei.entity_id=i.id and ei.kind='domain' and ei.status='active' limit 1) ident on true
     where lower(coalesce(v.is_internal,'')) not in ('true','t','1')
       and not (own_domain is not null and lower(coalesce(ident.value,'')) = own_domain)
    on conflict (workspace_id, entity_id) do update set
      name=excluded.name, domain=excluded.domain, industry=excluded.industry, icp_score=excluded.icp_score,
      deal_health=excluded.deal_health, people_count=excluded.people_count, open_deals=excluded.open_deals,
      pipeline_value=excluded.pipeline_value, won_value=excluded.won_value,
      last_activity_at=excluded.last_activity_at, refreshed_at=now()
    where (entity_list_rows.name, entity_list_rows.domain, entity_list_rows.industry, entity_list_rows.icp_score,
           entity_list_rows.deal_health, entity_list_rows.people_count, entity_list_rows.open_deals,
           entity_list_rows.pipeline_value, entity_list_rows.won_value, entity_list_rows.last_activity_at)
       is distinct from
          (excluded.name, excluded.domain, excluded.industry, excluded.icp_score,
           excluded.deal_health, excluded.people_count, excluded.open_deals,
           excluded.pipeline_value, excluded.won_value, excluded.last_activity_at);

  elsif p_kind = 'person' then
    insert into entity_list_rows (workspace_id, entity_id, kind, name, email, job_title, company_id, company_name, stage, icp_score, last_activity_at, refreshed_at)
    select ws, i.id, 'person',
           nullif(trim(coalesce(v.first_name,'') || ' ' || coalesce(v.last_name,'')), ''),
           ident.value, v.job_title, r.to_entity_id,
           (select l.name from entity_list_rows l where l.workspace_id=ws and l.entity_id=r.to_entity_id and l.kind='account'),
           v.pipeline_stage,
           nullif(v.icp_score,'')::numeric::integer,
           a.at, now()
      from _ids i
      left join lateral (select
             max(val) filter (where prop='first_name') as first_name,
             max(val) filter (where prop='last_name') as last_name,
             max(val) filter (where prop='job_title') as job_title,
             max(val) filter (where prop='pipeline_stage') as pipeline_stage,
             max(val) filter (where prop='icp_score') as icp_score,
             max(val) filter (where prop='is_internal') as is_internal
           from _v where entity_id = i.id) v on true
      left join _act a on a.entity_id = i.id
      left join lateral (select r2.to_entity_id from relationships r2
             where r2.workspace_id=ws and r2.type='works_at' and r2.from_entity_id=i.id and r2.valid_to is null limit 1) r on true
      left join lateral (select ei.value from entity_identifiers ei
             where ei.entity_id=i.id and ei.kind='email' and ei.status='active' limit 1) ident on true
     where lower(coalesce(v.is_internal,'')) not in ('true','t','1')
    on conflict (workspace_id, entity_id) do update set
      name=excluded.name, email=excluded.email, job_title=excluded.job_title, company_id=excluded.company_id,
      company_name=excluded.company_name, stage=excluded.stage, icp_score=excluded.icp_score,
      last_activity_at=excluded.last_activity_at, refreshed_at=now()
    where (entity_list_rows.name, entity_list_rows.email, entity_list_rows.job_title, entity_list_rows.company_id,
           entity_list_rows.company_name, entity_list_rows.stage, entity_list_rows.icp_score, entity_list_rows.last_activity_at)
       is distinct from
          (excluded.name, excluded.email, excluded.job_title, excluded.company_id,
           excluded.company_name, excluded.stage, excluded.icp_score, excluded.last_activity_at);

  else
    insert into entity_list_rows (workspace_id, entity_id, kind, name, company_id, company_name, stage, status, pipeline_value, close_date, owner_name, pipeline_ref, last_activity_at, refreshed_at)
    select ws, i.id, 'deal',
           v.name, b.to_entity_id,
           (select l.name from entity_list_rows l where l.workspace_id=ws and l.entity_id=b.to_entity_id and l.kind='account'),
           v.stage, v.status,
           nullif(v.value,'')::numeric,
           case when v.close_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then v.close_date::timestamptz end,
           v.owner_name, v.pipeline_id, a.at, now()
      from _ids i
      left join lateral (select
             max(val) filter (where prop='name') as name,
             max(val) filter (where prop='stage') as stage,
             max(val) filter (where prop='status') as status,
             max(val) filter (where prop='value') as value,
             max(val) filter (where prop='close_date') as close_date,
             max(val) filter (where prop='owner_name') as owner_name,
             max(val) filter (where prop='pipeline_id') as pipeline_id
           from _v where entity_id = i.id) v on true
      left join _act a on a.entity_id = i.id
      left join lateral (select b2.to_entity_id from relationships b2
             where b2.workspace_id=ws and b2.type='belongs_to' and b2.from_entity_id=i.id limit 1) b on true
    on conflict (workspace_id, entity_id) do update set
      name=excluded.name, company_id=excluded.company_id, company_name=excluded.company_name,
      stage=excluded.stage, status=excluded.status, pipeline_value=excluded.pipeline_value,
      close_date=excluded.close_date, owner_name=excluded.owner_name, pipeline_ref=excluded.pipeline_ref,
      last_activity_at=excluded.last_activity_at, refreshed_at=now()
    where (entity_list_rows.name, entity_list_rows.company_id, entity_list_rows.company_name,
           entity_list_rows.stage, entity_list_rows.status, entity_list_rows.pipeline_value,
           entity_list_rows.close_date, entity_list_rows.owner_name, entity_list_rows.pipeline_ref,
           entity_list_rows.last_activity_at)
       is distinct from
          (excluded.name, excluded.company_id, excluded.company_name,
           excluded.stage, excluded.status, excluded.pipeline_value,
           excluded.close_date, excluded.owner_name, excluded.pipeline_ref,
           excluded.last_activity_at);
  end if;

  return query select n, last;
end; $function$;

-- ---------------------------------------------------------------------------
-- 4. Where the rolling sweep got to.
-- ---------------------------------------------------------------------------
-- A sweep is interrupted often and by design: it runs to a time budget, this database has windows
-- where a chunk that normally takes 2 seconds takes 60, and the worker restarts on every deploy.
-- Without a remembered cursor each tick starts at the first entity again — so on a workspace too
-- big to finish in one tick, the first few thousand rows get refreshed over and over and THE TAIL
-- IS NEVER REFRESHED AT ALL. That is worse than slow: it is quietly, permanently wrong, and it
-- looks fine from the top of the list.
CREATE TABLE IF NOT EXISTS public.list_refresh_cursor (
  workspace_id uuid NOT NULL,
  kind text NOT NULL,
  after_id uuid NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  -- When the current pass began, and when the last one finished. Together they say how stale the
  -- oldest row in a list can be, which is the number worth alerting on.
  cycle_started_at timestamptz NOT NULL DEFAULT now(),
  last_completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind)
);

ALTER TABLE public.list_refresh_cursor ENABLE ROW LEVEL SECURITY;
