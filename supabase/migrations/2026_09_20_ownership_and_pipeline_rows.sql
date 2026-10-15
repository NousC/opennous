-- Ownership and pipeline identity on the flattened rows.
--
-- Three surfaces need facts the projection does not carry, and all three are one pass over the
-- same function, so they land together rather than as three hand-applied migrations.
--
-- 1. WHO OWNS AN ACCOUNT. The sync has written `owner_name`/`owner_email` observations for every
--    company since the CRM integration shipped: every one of one customer's customer accounts carries
--    one, and HubSpot itself has an owner on nearly all of its companies. The claim was
--    always there; the account ROW never carried it, so no list could filter on it. Scoping a
--    rep to their own book was never a sync problem, only a projection one.
--
-- 2. WHETHER AN ACCOUNT HAS A DEAL WORTH SHOWING. `open_deals` already answers "open". Won had
--    only `won_value`, which is null for the accounts whose won deal carries no amount, and a
--    loss had no date at all. `won_deals` counts rows instead of summing money, and
--    `last_lost_at` lets the 12-month list window (apps/api/src/lib/dealListWindow.mjs) be
--    applied to an ACCOUNT without a correlated subquery per row.
--
-- 3. WHICH PIPELINE A DEAL IS IN, BY NAME. The sync writes `pipeline` (the display name) beside
--    `pipeline_id`, but only the id was projected, so the name came back null and the board's
--    pipeline badge could never render on exactly the workspaces that have more than one
--    pipeline. The id is what a reader filters on; the name is what a person reads.
--
-- There is deliberately ONE ownership edge. A second one named after a role (`cs_owner`, fed by
-- a portal's custom CSM-owner property) would put a job title back into the schema and would
-- exist for one customer's field. What separates sales work from customer-success work is the
-- PIPELINE a deal is in, not a second owner: the same rep commonly holds deals in both the sales
-- and the expansion pipeline. Ownership answers "whose", the pipeline answers "which motion". A customer who records ownership in a custom property is served by mapping that
-- property onto `owner_name`, not by a new column.
--
-- THE FUNCTION BELOW IS THE LIVE DEFINITION, read out of the database on 2026-09-20, with
-- fourteen additions and nothing else changed. It is deliberately NOT reconstructed from the
-- migration files: refresh_list_chunk has been replaced five times in three days and does not
-- appear in schema.sql, so rebuilding it from those would silently revert whatever landed last.
-- Validated by running this whole file inside a transaction that was rolled back.

alter table public.entity_list_rows add column if not exists owner_email  text;
alter table public.entity_list_rows add column if not exists won_deals    integer;
alter table public.entity_list_rows add column if not exists last_lost_at timestamptz;
alter table public.entity_list_rows add column if not exists pipeline     text;
alter table public.entity_list_rows add column if not exists child_deals  integer;

-- Owner scoping reads (workspace, owner) on every list. Separate partial indexes per kind: the
-- account list and the deal board never share a scan.
create index if not exists entity_list_owner_accounts
  on public.entity_list_rows (workspace_id, owner_name) where kind = 'account';
create index if not exists entity_list_owner_deals
  on public.entity_list_rows (workspace_id, owner_name) where kind = 'deal';

-- Backfill what the new columns mean for rows that already exist.
--
-- Adding a column does not fill it, and the reader switches its account filter on the moment the
-- columns are THERE. Without this, every account whose only deals are won ones would have
-- won_deals NULL, fail the has-a-deal test and disappear from the workspace until the projection
-- next rebuilt that row — which, on the first customer, is a crawl that has never completed a
-- cycle. Hundreds of customer accounts, gone, with no error anywhere.
--
-- All three are derivable from rows already in this table plus the subsidiary edges, so it is one
-- pass and no claim reads. owner_name / owner_email / pipeline are deliberately NOT backfilled
-- here: they come from claims, the projection fills them as rows refresh, and a NULL owner simply
-- means "unscoped", which fails open. A NULL deal count would have failed closed.

update public.entity_list_rows a
   set won_deals    = coalesce(d.won_deals, 0),
       last_lost_at = d.last_lost_at
  from (select company_id,
               count(*) filter (where status = 'won')  as won_deals,
               max(close_date) filter (where status = 'lost') as last_lost_at
          from public.entity_list_rows
         where kind = 'deal' and company_id is not null
         group by company_id) d
 where a.kind = 'account' and a.entity_id = d.company_id;

update public.entity_list_rows a
   set won_deals = 0
 where a.kind = 'account' and a.won_deals is null;

update public.entity_list_rows a
   set child_deals = coalesce(c.n, 0)
  from (select r.to_entity_id as account_id, count(*) as n
          from public.relationships r
          join public.entity_list_rows dl
            on dl.workspace_id = r.workspace_id and dl.kind = 'deal' and dl.company_id = r.from_entity_id
         where r.type = 'subsidiary_of' and r.valid_to is null
         group by r.to_entity_id) c
 where a.kind = 'account' and a.entity_id = c.account_id;

update public.entity_list_rows a
   set child_deals = 0
 where a.kind = 'account' and a.child_deals is null;

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
                        'close_date','owner_name','owner_email','pipeline','pipeline_id','is_internal','location'];
begin
  select nullif(split_part(regexp_replace(lower(coalesce(w.website,'')), '^https?://(www\.)?', ''), '/', 1), '')
    into own_domain from workspaces w where w.id = ws;

  -- ON COMMIT DROP only fires at commit, so a second call inside one transaction fails with
  -- "relation _ids already exists". Each call starts from a clean slate instead.
  drop table if exists _ids, _v, _act, _staff, _deals, _childdeals;

  create temp table _ids on commit drop as
  select e.id from entities e
   where e.workspace_id = ws and e.type = entity_type and e.status = 'active' and e.id > p_after
   order by e.id limit p_limit;
  create unique index on _ids (id);
  analyze _ids;
  select count(*) into n from _ids;
  select id into last from _ids order by id desc limit 1;
  if n = 0 then return query select 0, p_after; return; end if;

  -- Claim first, observation second: pri 0 outranks pri 1, then newest wins.
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

  -- LAST activity, so only what has already happened. A booked meeting is stored as an
  -- interaction at its start time, and plenty of them sit in the future (some months ahead),
  -- which sorted those accounts to the top of a list ordered by "last activity" and printed a date
  -- that had not arrived yet. Upcoming meetings belong to a next-meeting field, not this one.
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

    create temp table _deals on commit drop as
    select dl.company_id as account_id,
           count(*) filter (where dl.status = 'open') as open_deals,
           sum(dl.pipeline_value) filter (where dl.status = 'open') as pipeline_value,
           sum(dl.pipeline_value) filter (where dl.status = 'won') as won_value,
           count(*) filter (where dl.status = 'won') as won_deals,
           max(dl.close_date) filter (where dl.status = 'lost') as last_lost_at
      from entity_list_rows dl
      join _ids i on i.id = dl.company_id
     where dl.workspace_id = ws and dl.kind = 'deal'
     group by dl.company_id;
    create unique index on _deals (account_id);
    analyze _deals;

    -- A company group holds no deals of its own; its locations do. Quillmere Holdings
    -- (quillmere-holdings.example) has five, and about a third of one customer's group parents are in that
    -- shape. Without this the has-a-deal rule would hide exactly the record a rep needs in
    -- order to see the group at all.
    create temp table _childdeals on commit drop as
    select r.to_entity_id as account_id, count(*) as child_deals
      from relationships r
      join entity_list_rows dl
        on dl.workspace_id = ws and dl.kind = 'deal' and dl.company_id = r.from_entity_id
      join _ids i on i.id = r.to_entity_id
     where r.workspace_id = ws and r.type = 'subsidiary_of' and r.valid_to is null
     group by r.to_entity_id;
    create unique index on _childdeals (account_id);
    analyze _childdeals;

    insert into entity_list_rows (workspace_id, entity_id, kind, name, domain, industry, country, icp_score, deal_health, people_count, open_deals, pipeline_value, won_value, owner_name, owner_email, won_deals, last_lost_at, child_deals, last_activity_at, refreshed_at)
    select ws, i.id, 'account',
           v.name, ident.value, v.industry,
           normalize_country(nullif(trim(split_part(v.location, ',', array_length(string_to_array(v.location, ','), 1))), '')),
           nullif(v.icp_score,'')::numeric::integer,
           nullif(v.deal_health_score,'')::numeric::integer,
           coalesce(s.people_count, 0),
           coalesce(d.open_deals, 0), d.pipeline_value, d.won_value,
           v.owner_name, v.owner_email,
           coalesce(d.won_deals, 0), d.last_lost_at, coalesce(c.child_deals, 0),
           greatest(a.at, s.at),
           now()
      from _ids i
      left join lateral (select
             max(val) filter (where prop='name') as name,
             max(val) filter (where prop='industry') as industry,
             max(val) filter (where prop='icp_score') as icp_score,
             max(val) filter (where prop='deal_health_score') as deal_health_score,
             max(val) filter (where prop='owner_name') as owner_name,
             max(val) filter (where prop='owner_email') as owner_email,
             max(val) filter (where prop='is_internal') as is_internal,
             max(val) filter (where prop='location') as location
           from _v where entity_id = i.id) v on true
      left join _act a on a.entity_id = i.id
      left join _staff s on s.account_id = i.id
      left join _deals d on d.account_id = i.id
      left join _childdeals c on c.account_id = i.id
      left join lateral (select ei.value from entity_identifiers ei
             where ei.entity_id=i.id and ei.kind='domain' and ei.status='active' limit 1) ident on true
     where lower(coalesce(v.is_internal,'')) not in ('true','t','1')
       and not (own_domain is not null and lower(coalesce(ident.value,'')) = own_domain)
    on conflict (workspace_id, entity_id) do update set
      name=excluded.name, domain=excluded.domain, industry=excluded.industry, country=excluded.country, icp_score=excluded.icp_score,
      deal_health=excluded.deal_health, people_count=excluded.people_count, open_deals=excluded.open_deals,
      pipeline_value=excluded.pipeline_value, won_value=excluded.won_value,
      owner_name=excluded.owner_name, owner_email=excluded.owner_email,
      won_deals=excluded.won_deals, last_lost_at=excluded.last_lost_at, child_deals=excluded.child_deals,
      last_activity_at=excluded.last_activity_at, refreshed_at=now()
    where (entity_list_rows.name, entity_list_rows.domain, entity_list_rows.industry, entity_list_rows.country, entity_list_rows.icp_score,
           entity_list_rows.deal_health, entity_list_rows.people_count, entity_list_rows.open_deals,
           entity_list_rows.pipeline_value, entity_list_rows.won_value,
           entity_list_rows.owner_name, entity_list_rows.owner_email,
           entity_list_rows.won_deals, entity_list_rows.last_lost_at, entity_list_rows.child_deals,
           entity_list_rows.last_activity_at)
       is distinct from
          (excluded.name, excluded.domain, excluded.industry, excluded.country, excluded.icp_score,
           excluded.deal_health, excluded.people_count, excluded.open_deals,
           excluded.pipeline_value, excluded.won_value,
           excluded.owner_name, excluded.owner_email,
           excluded.won_deals, excluded.last_lost_at, excluded.child_deals,
           excluded.last_activity_at);

    -- An account that no longer belongs in the list must LEAVE it. The insert skips the
    -- workspace's own company and anything flagged internal, but skipping only means "do not
    -- write": the row written before the rule existed stayed, so one customer's own company sat in
    -- their account list with a stale date long after the rule was added. Exclusion has to delete.
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
    insert into entity_list_rows (workspace_id, entity_id, kind, name, company_id, company_name, country, stage, status, pipeline_value, close_date, owner_name, pipeline_ref, pipeline, last_activity_at, refreshed_at)
    select ws, i.id, 'deal',
           v.name, b.to_entity_id,
           (select l.name from entity_list_rows l where l.workspace_id=ws and l.entity_id=b.to_entity_id and l.kind='account'),
           (select l.country from entity_list_rows l where l.workspace_id=ws and l.entity_id=b.to_entity_id and l.kind='account'),
           v.stage, v.status,
           nullif(v.value,'')::numeric,
           case when v.close_date ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then v.close_date::timestamptz end,
           v.owner_name, v.pipeline_id, v.pipeline, greatest(a.at, da.at), now()
      from _ids i
      left join lateral (select
             max(val) filter (where prop='name') as name,
             max(val) filter (where prop='stage') as stage,
             max(val) filter (where prop='status') as status,
             max(val) filter (where prop='value') as value,
             max(val) filter (where prop='close_date') as close_date,
             max(val) filter (where prop='owner_name') as owner_name,
             max(val) filter (where prop='pipeline_id') as pipeline_id,
             max(val) filter (where prop='pipeline') as pipeline
           from _v where entity_id = i.id) v on true
      left join _act a on a.entity_id = i.id
      left join _dact da on da.deal_id = i.id
      left join lateral (select b2.to_entity_id from relationships b2
             where b2.workspace_id=ws and b2.type='belongs_to' and b2.from_entity_id=i.id limit 1) b on true
    on conflict (workspace_id, entity_id) do update set
      name=excluded.name, company_id=excluded.company_id, company_name=excluded.company_name, country=excluded.country,
      stage=excluded.stage, status=excluded.status, pipeline_value=excluded.pipeline_value,
      close_date=excluded.close_date, owner_name=excluded.owner_name, pipeline_ref=excluded.pipeline_ref,
      pipeline=excluded.pipeline,
      last_activity_at=excluded.last_activity_at, refreshed_at=now()
    where (entity_list_rows.name, entity_list_rows.company_id, entity_list_rows.company_name, entity_list_rows.country,
           entity_list_rows.stage, entity_list_rows.status, entity_list_rows.pipeline_value,
           entity_list_rows.close_date, entity_list_rows.owner_name, entity_list_rows.pipeline_ref,
           entity_list_rows.pipeline, entity_list_rows.last_activity_at)
       is distinct from
          (excluded.name, excluded.company_id, excluded.company_name, excluded.country,
           excluded.stage, excluded.status, excluded.pipeline_value,
           excluded.close_date, excluded.owner_name, excluded.pipeline_ref,
           excluded.pipeline, excluded.last_activity_at);
  end if;

  return query select n, last;
end; $function$;
