-- API & MCP activity (GET-898): one read for the Settings > Workspace > API & MCP activity page.
--
-- The page shows, for a window (24h / 7d / 30d / 90d), how often the workspace's API and MCP were
-- called, what about, by which key and from which client. Aggregation has to happen here:
-- PostgREST returns at most 1000 rows and no error past that, so counting a busy workspace's calls
-- in the API would be silently wrong. One function, one round trip, one jsonb answer:
--
--   totals     calls, mcp, rest, errors, p50_ms, p95_ms, keys (distinct), clients (distinct),
--              targets (distinct)
--   series     [{ bucket, calls, mcp, rest, errors }] per UTC hour (p_bucket 'hour') or day ('day');
--              buckets with no calls are absent, the API fills them in
--   by_route   top p_limit [{ surface, route, calls, errors, p95_ms, last_at }]
--   by_target  top p_limit [{ target, calls, errors, last_at }], rows with a target only
--   by_key     [{ api_key_id, calls, errors, last_at }] (every key with a call in the window)
--   by_client  top p_limit [{ client, calls, errors, last_at }], client null as ''
--
-- Never returns ip_prefix. Reads only api_request_log (the ws_at index covers the filter).
--
-- Additive: one new function, nothing existing altered. Safe to re-run. Applied by hand, like the
-- other 2026_10 migrations. Until it is applied, GET /api/usage/activity answers 503
-- { error: 'activity_unavailable' } and the page says so; the call list works without it.

create or replace function public.api_request_log_activity(
  p_workspace_id uuid, p_since timestamptz, p_bucket text default 'day', p_limit int default 10
) returns jsonb
language sql stable as $$
  with r as (
    select surface, route, target, status, latency_ms, client, api_key_id, at
      from public.api_request_log
     where workspace_id = p_workspace_id
       and at >= p_since
  ),
  lim as (select greatest(1, least(coalesce(p_limit, 10), 100)) as n)
  select jsonb_build_object(
    'totals', (
      select jsonb_build_object(
        'calls',    count(*),
        'mcp',      count(*) filter (where surface = 'mcp'),
        'rest',     count(*) filter (where surface = 'rest'),
        'errors',   count(*) filter (where status >= 400),
        'p50_ms',   percentile_disc(0.5)  within group (order by latency_ms),
        'p95_ms',   percentile_disc(0.95) within group (order by latency_ms),
        'keys',     count(distinct api_key_id),
        'clients',  count(distinct client),
        'targets',  count(distinct target)
      ) from r
    ),
    'series', coalesce((
      select jsonb_agg(jsonb_build_object(
               'bucket', s.bucket, 'calls', s.calls, 'mcp', s.mcp, 'rest', s.rest, 'errors', s.errors
             ) order by s.bucket)
        from (
          select case when p_bucket = 'hour'
                      then to_char(date_trunc('hour', at at time zone 'UTC'), 'YYYY-MM-DD"T"HH24":00:00Z"')
                      else to_char((at at time zone 'UTC')::date, 'YYYY-MM-DD') end as bucket,
                 count(*)                                  as calls,
                 count(*) filter (where surface = 'mcp')   as mcp,
                 count(*) filter (where surface = 'rest')  as rest,
                 count(*) filter (where status >= 400)     as errors
            from r group by 1
        ) s
    ), '[]'::jsonb),
    'by_route', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.calls desc, x.route)
        from (
          select surface, route, count(*) as calls,
                 count(*) filter (where status >= 400) as errors,
                 percentile_disc(0.95) within group (order by latency_ms) as p95_ms,
                 max(at) as last_at
            from r group by surface, route
           order by calls desc, route
           limit (select n from lim)
        ) x
    ), '[]'::jsonb),
    'by_target', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.calls desc, x.target)
        from (
          select target, count(*) as calls,
                 count(*) filter (where status >= 400) as errors,
                 max(at) as last_at
            from r where target is not null group by target
           order by calls desc, target
           limit (select n from lim)
        ) x
    ), '[]'::jsonb),
    'by_key', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.calls desc)
        from (
          select api_key_id, count(*) as calls,
                 count(*) filter (where status >= 400) as errors,
                 max(at) as last_at
            from r group by api_key_id
        ) x
    ), '[]'::jsonb),
    'by_client', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.calls desc, x.client)
        from (
          select coalesce(client, '') as client, count(*) as calls,
                 count(*) filter (where status >= 400) as errors,
                 max(at) as last_at
            from r group by 1
           order by calls desc, client
           limit (select n from lim)
        ) x
    ), '[]'::jsonb)
  );
$$;

comment on function public.api_request_log_activity(uuid, timestamptz, text, int) is
  'Settings > API & MCP activity (GET-898): totals, series, top routes/targets/clients and per-key counts for one workspace since p_since.';

revoke all on function public.api_request_log_activity(uuid, timestamptz, text, int) from public, anon, authenticated;
grant execute on function public.api_request_log_activity(uuid, timestamptz, text, int) to service_role;
