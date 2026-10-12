-- A deal's last activity is the conversation about it (GET-318).
--
-- Every deal showed a blank Last activity, because the rollup read
-- `interaction.*` observations on the deal entity and deals have none: the conversation is filed
-- against the PERSON and the ACCOUNT, and linked to the deal through observation_deals.
--
-- After this, every deal with a linked conversation carries a real date, none in the future, all
-- inside the imported window. The rest genuinely have no conversation linked to them yet.

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
                        'close_date','owner_name','pipeline_id','is_internal','location'];
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

  -- LAST activity, so only what has already happened. A booked meeting is stored as an interaction
  -- at its start time, and plenty of them sit in the future (some months ahead), which
  -- sorted those accounts to the top of a list ordered by "last activity" and printed a date that
  -- had not arrived. Upcoming meetings belong in a next-meeting field, not this one.
  create temp table _act on commit drop as
  select ob.entity_id, max(ob.observed_at) as at
    from observations ob join _ids i on i.id = ob.entity_id
   where ob.property like 'interaction.%' and ob.observed_at <= now()
   group by ob.entity_id;
  create unique index on _act (entity_id);
  analyze _act;

  -- A deal's activity is the conversation ABOUT it. Deals carry no interaction observations of
  -- their own, so every deal row had a blank last-activity column; the link lives in
  -- observation_deals.
  if p_kind = 'deal' then
    create temp table _dact on commit drop as
    select od.deal_entity_id as deal_id, max(ob.observed_at) as at
      from observation_deals od
      join _ids i on i.id = od.deal_entity_id
      join observations ob on ob.id = od.observation_id
     where od.workspace_id = ws and ob.observed_at <= now()
     group by od.deal_entity_id;
    create unique index on _dact (deal_id);
    analyze _dact;
  end if;

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

    insert into entity_list_rows (workspace_id, entity_id, kind, name, domain, industry, country, icp_score, deal_health, people_count, open_deals, pipeline_value, won_value, last_activity_at, refreshed_at)
    select ws, i.id, 'account',
           v.name, ident.value, v.industry,
           -- The CRM stores one string, "Brindlemoor, Northland". The country is what a team focusing on a
           -- market filters by, so it is split out here rather than by every reader.
           nullif(trim(split_part(v.location, ',', array_length(string_to_array(v.location, ','), 1))), ''),
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
             max(val) filter (where prop='is_internal') as is_internal,
             max(val) filter (where prop='location') as location
           from _v where entity_id = i.id) v on true
      left join _act a on a.entity_id = i.id
      left join _staff s on s.account_id = i.id
      left join _deals d on d.account_id = i.id
      left join lateral (select ei.value from entity_identifiers ei
             where ei.entity_id=i.id and ei.kind='domain' and ei.status='active' limit 1) ident on true
     where lower(coalesce(v.is_internal,'')) not in ('true','t','1')
       and not (own_domain is not null and lower(coalesce(ident.value,'')) = own_domain)
    on conflict (workspace_id, entity_id) do update set
      name=excluded.name, domain=excluded.domain, industry=excluded.industry, country=excluded.country,
      icp_score=excluded.icp_score,
      deal_health=excluded.deal_health, people_count=excluded.people_count, open_deals=excluded.open_deals,
      pipeline_value=excluded.pipeline_value, won_value=excluded.won_value,
      last_activity_at=excluded.last_activity_at, refreshed_at=now()
    where (entity_list_rows.name, entity_list_rows.domain, entity_list_rows.industry, entity_list_rows.country, entity_list_rows.icp_score,
           entity_list_rows.deal_health, entity_list_rows.people_count, entity_list_rows.open_deals,
           entity_list_rows.pipeline_value, entity_list_rows.won_value, entity_list_rows.last_activity_at)
       is distinct from
          (excluded.name, excluded.domain, excluded.industry, excluded.country, excluded.icp_score,
           excluded.deal_health, excluded.people_count, excluded.open_deals,
           excluded.pipeline_value, excluded.won_value, excluded.last_activity_at);

    -- An account that no longer belongs in the list must LEAVE it. The insert skips the workspace's
    -- own company and anything flagged internal, but skipping only means "do not write": the row
    -- written before the rule existed stayed, so one customer's own company sat in their account list
    -- with a stale date long after the rule was added. Exclusion has to delete.
    delete from entity_list_rows r using _ids i
     where r.workspace_id = ws and r.entity_id = i.id and r.kind = 'account'
       and (exists (select 1 from _v x where x.entity_id = i.id and x.prop = 'is_internal' and lower(x.val) in ('true','t','1'))
            or (own_domain is not null and exists (
                  select 1 from entity_identifiers ei
                   where ei.entity_id = i.id and ei.kind = 'domain' and ei.status = 'active'
                     and lower(ei.value) = own_domain)));

  elsif p_kind = 'person' then
    insert into entity_list_rows (workspace_id, entity_id, kind, name, email, job_title, company_id, company_name, country, stage, icp_score, last_activity_at, refreshed_at)
    select ws, i.id, 'person',
           nullif(trim(coalesce(v.first_name,'') || ' ' || coalesce(v.last_name,'')), ''),
           ident.value, v.job_title, r.to_entity_id,
           (select l.name from entity_list_rows l where l.workspace_id=ws and l.entity_id=r.to_entity_id and l.kind='account'),
           -- A person is in the market their employer is in, so People filters by the same country
           -- the account list does. Someone with no employer has no country and stays in the focus.
           (select l.country from entity_list_rows l where l.workspace_id=ws and l.entity_id=r.to_entity_id and l.kind='account'),
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
      company_name=excluded.company_name, country=excluded.country, stage=excluded.stage, icp_score=excluded.icp_score,
      last_activity_at=excluded.last_activity_at, refreshed_at=now()
    where (entity_list_rows.name, entity_list_rows.email, entity_list_rows.job_title, entity_list_rows.company_id,
           entity_list_rows.company_name, entity_list_rows.country, entity_list_rows.stage, entity_list_rows.icp_score, entity_list_rows.last_activity_at)
       is distinct from
          (excluded.name, excluded.email, excluded.job_title, excluded.company_id,
           excluded.company_name, excluded.country, excluded.stage, excluded.icp_score, excluded.last_activity_at);

  else
    insert into entity_list_rows (workspace_id, entity_id, kind, name, company_id, company_name, country, stage, status, pipeline_value, close_date, owner_name, pipeline_ref, last_activity_at, refreshed_at)
    select ws, i.id, 'deal',
           v.name, b.to_entity_id,
           (select l.name from entity_list_rows l where l.workspace_id=ws and l.entity_id=b.to_entity_id and l.kind='account'),
           -- A deal is sold into its account's market, so it filters by the account's country.
           (select l.country from entity_list_rows l where l.workspace_id=ws and l.entity_id=b.to_entity_id and l.kind='account'),
           v.stage, v.status,
           nullif(v.value,'')::numeric,
           case when v.close_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then v.close_date::timestamptz end,
           v.owner_name, v.pipeline_id, greatest(a.at, da.at), now()
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
      left join _dact da on da.deal_id = i.id
      left join lateral (select b2.to_entity_id from relationships b2
             where b2.workspace_id=ws and b2.type='belongs_to' and b2.from_entity_id=i.id limit 1) b on true
    on conflict (workspace_id, entity_id) do update set
      name=excluded.name, company_id=excluded.company_id, company_name=excluded.company_name,
      country=excluded.country,
      stage=excluded.stage, status=excluded.status, pipeline_value=excluded.pipeline_value,
      close_date=excluded.close_date, owner_name=excluded.owner_name, pipeline_ref=excluded.pipeline_ref,
      last_activity_at=excluded.last_activity_at, refreshed_at=now()
    where (entity_list_rows.name, entity_list_rows.company_id, entity_list_rows.company_name,
           entity_list_rows.country,
           entity_list_rows.stage, entity_list_rows.status, entity_list_rows.pipeline_value,
           entity_list_rows.close_date, entity_list_rows.owner_name, entity_list_rows.pipeline_ref,
           entity_list_rows.last_activity_at)
       is distinct from
          (excluded.name, excluded.company_id, excluded.company_name,
           excluded.country,
           excluded.stage, excluded.status, excluded.pipeline_value,
           excluded.close_date, excluded.owner_name, excluded.pipeline_ref,
           excluded.last_activity_at);
  end if;

  return query select n, last;
end; $function$;



