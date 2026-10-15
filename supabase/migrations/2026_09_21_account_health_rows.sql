-- The CRM's own account-health fields, on the row the lists already read.
--
-- WHY A COLUMN AND NOT A CLAIMS READ
--
-- The Customer Success page needs about twenty facts per customer: account status, MRR, product
-- usage, the customer's churn flag, the priced upgrade. They all arrive as `cs.*` claims from the
-- sync (packages/core/src/integrations/crm/accountHealth.ts). Reading them back out of `claims` at
-- request time was tried and measured on the first customer's workspace, and it does not work:
--
--   claims, 100 entity ids, invalid_at is null           -> statement timeout
--   claims, 100 entity ids, property range 'cs.'         -> 12.4s for ZERO rows
--   observations, property = 'lifecycle_stage', 1 page   -> 7.4s, and no stable pagination
--
-- `claims` on this workspace is large and its indexes do not serve a property scan. That is the
-- same wall `entity_list_rows` was built to get past, so health goes where the rest of the list's
-- facts already live.
--
-- ONE jsonb COLUMN, NOT TWENTY TYPED ONES
--
-- The health vocabulary is open: it grows every time a customer's ops team adds a field worth
-- reading, and the next CRM will map different properties onto the same ideas. Twenty columns
-- would mean a migration per idea and a wide table that is mostly NULL - about nine in ten of this
-- workspace's accounts are not customers and carry nothing. One `cs` bag costs those rows
-- a NULL and lets a new fact ship without touching the schema again.
--
-- READ THIS BEFORE YOU EDIT refresh_list_chunk AGAIN
--
-- This migration and 2026_09_21_last_inbound_at.sql were written on the same day, against the
-- same base, and BOTH do `create or replace function refresh_list_chunk`. Whichever runs second
-- replaces the whole body and silently drops the other's work - no error, the column simply
-- stays NULL forever. That very nearly shipped: last_inbound_at went in first, and the earlier
-- draft of this file had been patched from the function as it existed BEFORE it, so applying it
-- would have wiped last_inbound_at out of the projection.
--
-- The body below is therefore the LIVE function as `pg_get_functiondef` returned it AFTER
-- last_inbound_at was applied, with only the `cs` changes layered on. If you write another
-- migration that touches this function, re-read the live definition first. Do not patch an older
-- copy from the repo.
--
-- SAFE TO RUN TWICE. Adds a nullable column, replaces one function. Drops nothing.

-- ---- 1. the column ------------------------------------------------------------------------
alter table entity_list_rows add column if not exists cs jsonb;

comment on column entity_list_rows.cs is
  'Account-health facts as the CRM keeps them, keyed without the cs. prefix (status, mrr, '
  'active_users_30d, upgrade_value, owner_email, ...). Projected from cs.* claims by '
  'refresh_list_chunk. NULL for any account that is not a customer. Never written by Nous: every '
  'key here is a field in the customer''s own CRM.';

-- Only customers have a bag, so the index only indexes customers.
create index if not exists entity_list_rows_cs_idx
  on entity_list_rows (workspace_id, kind)
  where cs is not null;

-- ---- 2. the projection --------------------------------------------------------------------
--
-- The diff against the live body, in full:
--   * _cs added to the drop list
--   * _cs temp table built inside the account branch
--   * cs added to the account insert's column list, select list, join, and DO UPDATE
--   * cs added to BOTH sides of the is-distinct-from guard - without it a row whose only change
--     is its health bag counts as unchanged and is never rewritten

CREATE OR REPLACE FUNCTION public.refresh_list_chunk(ws uuid, p_kind text, p_after uuid DEFAULT '00000000-0000-0000-0000-000000000000'::uuid, p_limit integer DEFAULT 400)
 RETURNS TABLE(processed integer, last_id uuid)
 LANGUAGE plpgsql
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
  drop table if exists _ids, _v, _act, _staff, _deals, _childdeals, _cs;

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
  select ob.entity_id,
         max(ob.observed_at) filter (where ob.observed_at <= now()) as at,
         -- The last time they came to US. Deliberately NOT capped at now(): a meeting booked for
         -- next week is the strongest engagement signal an account can carry, and the cap above
         -- exists to stop a future meeting being printed as "last activity", not to deny it ever
         -- happened. A no-show counts — they agreed to the meeting.
         max(ob.observed_at) filter (where ob.property in (
               'interaction.email_received', 'interaction.call_received',
               'interaction.meeting_held',   'interaction.meeting_no_show',
               'interaction.meeting_scheduled')) as inbound_at
    from observations ob join _ids i on i.id = ob.entity_id
   where ob.property like 'interaction.%'
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
    select r.to_entity_id as account_id, count(*) as people_count,
           max(pl.last_activity_at) as at, max(pl.last_inbound_at) as inbound_at
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

    -- Account health, exactly as the customer's own CRM keeps it (the cs.* claims the sync
    -- writes; see packages/core/src/integrations/crm/accountHealth.ts). Kept as JSONB rather than
    -- flattened to text like _v, because three of these facts are arrays - products, risk_signals,
    -- goals - and #>>'{}' on an array yields the literal string '["a","b"]' for every reader to
    -- re-parse. Claims only, with no observation fallback: a cs.* observation that has not settled
    -- yet is a fact in flight, and a half-written bag reads worse on the CS page than a missing
    -- one (an account showing a status and no MRR looks like a $0 customer, not a loading row).
    create temp table _cs on commit drop as
    select v.entity_id, jsonb_object_agg(v.prop, v.val) as cs
      from (
        select distinct on (cl.entity_id, cl.property)
               cl.entity_id, substr(cl.property, 4) as prop,
               coalesce(cl.value->'value', cl.value) as val
          from claims cl join _ids i on i.id = cl.entity_id
         where cl.invalid_at is null
           and cl.property like 'cs.%' and length(cl.property) > 3
         order by cl.entity_id, cl.property, cl.computed_at desc nulls last
      ) v
     where v.val is not null and v.val <> 'null'::jsonb
     group by v.entity_id;
    create unique index on _cs (entity_id);
    analyze _cs;

    insert into entity_list_rows (workspace_id, entity_id, kind, name, domain, industry, country, icp_score, deal_health, people_count, open_deals, pipeline_value, won_value, owner_name, owner_email, won_deals, last_lost_at, child_deals, cs, last_activity_at, last_inbound_at, refreshed_at)
    select ws, i.id, 'account',
           v.name, ident.value, v.industry,
           normalize_country(nullif(trim(split_part(v.location, ',', array_length(string_to_array(v.location, ','), 1))), '')),
           nullif(v.icp_score,'')::numeric::integer,
           nullif(v.deal_health_score,'')::numeric::integer,
           coalesce(s.people_count, 0),
           coalesce(d.open_deals, 0), d.pipeline_value, d.won_value,
           v.owner_name, v.owner_email,
           coalesce(d.won_deals, 0), d.last_lost_at, coalesce(c.child_deals, 0),
           csb.cs,
           greatest(a.at, s.at),
           greatest(a.inbound_at, s.inbound_at),
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
      left join _cs csb on csb.entity_id = i.id
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
      cs=excluded.cs,
      last_activity_at=excluded.last_activity_at, last_inbound_at=excluded.last_inbound_at, refreshed_at=now()
    where (entity_list_rows.name, entity_list_rows.domain, entity_list_rows.industry, entity_list_rows.country, entity_list_rows.icp_score,
           entity_list_rows.deal_health, entity_list_rows.people_count, entity_list_rows.open_deals,
           entity_list_rows.pipeline_value, entity_list_rows.won_value,
           entity_list_rows.owner_name, entity_list_rows.owner_email,
           entity_list_rows.won_deals, entity_list_rows.last_lost_at, entity_list_rows.child_deals,
           entity_list_rows.cs,
           entity_list_rows.last_activity_at, entity_list_rows.last_inbound_at)
       is distinct from
          (excluded.name, excluded.domain, excluded.industry, excluded.country, excluded.icp_score,
           excluded.deal_health, excluded.people_count, excluded.open_deals,
           excluded.pipeline_value, excluded.won_value,
           excluded.owner_name, excluded.owner_email,
           excluded.won_deals, excluded.last_lost_at, excluded.child_deals,
           excluded.cs,
           excluded.last_activity_at, excluded.last_inbound_at);

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
    insert into entity_list_rows (workspace_id, entity_id, kind, name, email, job_title, company_id, company_name, country, stage, icp_score, last_activity_at, last_inbound_at, refreshed_at)
    select ws, i.id, 'person',
           nullif(trim(coalesce(v.first_name,'') || ' ' || coalesce(v.last_name,'')), ''),
           ident.value, v.job_title, r.to_entity_id,
           (select l.name from entity_list_rows l where l.workspace_id=ws and l.entity_id=r.to_entity_id and l.kind='account'),
           -- A person is in the market their employer is in, so People filters by the same country
           -- the account list does. Someone with no employer has no country and stays in the focus.
           (select l.country from entity_list_rows l where l.workspace_id=ws and l.entity_id=r.to_entity_id and l.kind='account'),
           v.pipeline_stage,
           nullif(v.icp_score,'')::numeric::integer,
           a.at, a.inbound_at, now()
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
      last_activity_at=excluded.last_activity_at, last_inbound_at=excluded.last_inbound_at, refreshed_at=now()
    where (entity_list_rows.name, entity_list_rows.email, entity_list_rows.job_title, entity_list_rows.company_id,
           entity_list_rows.company_name, entity_list_rows.country, entity_list_rows.stage, entity_list_rows.icp_score, entity_list_rows.last_activity_at, entity_list_rows.last_inbound_at)
       is distinct from
          (excluded.name, excluded.email, excluded.job_title, excluded.company_id,
           excluded.company_name, excluded.country, excluded.stage, excluded.icp_score, excluded.last_activity_at,
           excluded.last_inbound_at);

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
end;
$function$;


-- ---- 3. filling it ------------------------------------------------------------------------
--
-- Nothing to do here. Account rows pick the bag up on their next sweep, and `cs` stays NULL until
-- the company sync has actually read the health properties - which is the honest state, and what
-- the page's "from deals only" badge reports. To fill it now for one workspace:
--
--   select refresh_entity_list_rows('<workspace-uuid>'::uuid);
