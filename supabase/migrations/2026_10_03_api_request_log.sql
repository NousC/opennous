-- Per-key request log (API plan C1, GET-623).
--
-- One row per authenticated API-key call, REST (/v2/*) and MCP alike, so Settings can show a
-- dashboard per key: calls per day, which routes and tools it hits, which client is calling, and
-- its recent requests. Written by the API (apps/api/src/lib/apiRequestLog.mjs), batched, after
-- the response has gone out. A session (browser) call is never logged here: no key, no row.
--
-- An MCP tool call reaches the API as one or more /v2 calls carrying X-Nous-Client: mcp and
-- X-Nous-Tool: <tool name>; those rows have surface 'mcp' and the tool name as `route`.
--
-- Privacy: `ip_prefix` is the first two IPv4 octets or the first three IPv6 groups, never the
-- full address. `client` is a known agent name or the raw User-Agent cut to 80 characters.
--
-- Retention: 90 days. prune_api_request_log() deletes older rows in bounded batches; the worker
-- calls it once a day (apps/worker/src/workers/apiRequestLogRetention.mjs).
--
-- Additive: one new table, one nullable column on api_keys, five functions. Nothing existing is
-- altered. Safe to re-run. Applied by hand, like the other 2026_10 migrations.

create table if not exists public.api_request_log (
  id           bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  -- Revoking a key keeps its history (revoked_at is a soft delete); only a hard delete drops it.
  api_key_id   uuid not null references public.api_keys(id) on delete cascade,
  at           timestamptz not null default now(),
  surface      text not null check (surface in ('mcp', 'rest')),
  -- REST: the route pattern ("/v2/accounts/:id"), never the filled-in path. MCP: the tool name.
  route        text not null,
  -- What the call was about when that is cheap to know: an entity id, a domain, an email.
  target       text,
  status       int not null,
  latency_ms   int not null,
  client       text,
  ip_prefix    text,
  -- Credits this call spent, when the handler knows (res.locals.apiCredits). 0 otherwise.
  credits      int not null default 0
);
comment on table public.api_request_log is
  'One row per API-key call (REST /v2 and MCP), for the per-key usage dashboard. 90-day retention.';

create index if not exists api_request_log_key_at on public.api_request_log (api_key_id, at desc);
create index if not exists api_request_log_ws_at  on public.api_request_log (workspace_id, at desc);

-- Same protection as api_keys: the service role (the API) does everything; a signed-in member
-- may read their workspace's rows. Nothing but the service role writes.
alter table public.api_request_log enable row level security;

drop policy if exists "Service role full access to api_request_log" on public.api_request_log;
create policy "Service role full access to api_request_log" on public.api_request_log
  to service_role using (true) with check (true);

drop policy if exists "Members can read workspace api request log" on public.api_request_log;
create policy "Members can read workspace api request log" on public.api_request_log
  for select using (public.is_workspace_member(workspace_id));

-- A short, non-secret handle for a key ("pk_3f9a1c"), so a person can tell keys apart. 6 hex
-- characters of a 48-character secret. Null for keys minted before this column existed.
alter table public.api_keys add column if not exists key_prefix text;

-- ── Aggregations (the dashboard reads these; PostgREST caps a plain select at 1000 rows) ────

-- Calls and errors per UTC day for one key since p_since. Days with no calls are absent; the
-- API fills them in.
create or replace function public.api_request_log_per_day(
  p_workspace_id uuid, p_api_key_id uuid, p_since timestamptz
) returns table (day date, calls bigint, errors bigint)
language sql stable as $$
  select (at at time zone 'UTC')::date as day,
         count(*)                                as calls,
         count(*) filter (where status >= 400)   as errors
    from public.api_request_log
   where workspace_id = p_workspace_id
     and api_key_id   = p_api_key_id
     and at >= p_since
   group by 1
   order by 1;
$$;

-- The routes / tools one key calls most since p_since.
create or replace function public.api_request_log_by_route(
  p_workspace_id uuid, p_api_key_id uuid, p_since timestamptz, p_limit int default 10
) returns table (route text, surface text, calls bigint)
language sql stable as $$
  select route, surface, count(*) as calls
    from public.api_request_log
   where workspace_id = p_workspace_id
     and api_key_id   = p_api_key_id
     and at >= p_since
   group by route, surface
   order by calls desc, route
   limit greatest(1, least(p_limit, 100));
$$;

-- Calls and credits per key across a workspace since p_since.
create or replace function public.api_request_log_by_key(
  p_workspace_id uuid, p_since timestamptz
) returns table (api_key_id uuid, calls bigint, credits bigint)
language sql stable as $$
  select api_key_id, count(*) as calls, coalesce(sum(credits), 0)::bigint as credits
    from public.api_request_log
   where workspace_id = p_workspace_id
     and at >= p_since
   group by api_key_id
   order by calls desc;
$$;

-- Retention. Deletes rows older than p_retain_days, at most p_batch per call, and returns how
-- many it deleted; the worker calls it until it returns less than a full batch.
create or replace function public.prune_api_request_log(
  p_retain_days int default 90, p_batch int default 20000
) returns int
language plpgsql as $$
declare n int;
begin
  delete from public.api_request_log
   where id in (
     select id from public.api_request_log
      where at < now() - make_interval(days => greatest(p_retain_days, 1))
      limit greatest(p_batch, 1)
   );
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke all on function public.api_request_log_per_day(uuid, uuid, timestamptz)        from public, anon, authenticated;
revoke all on function public.api_request_log_by_route(uuid, uuid, timestamptz, int)  from public, anon, authenticated;
revoke all on function public.api_request_log_by_key(uuid, timestamptz)                from public, anon, authenticated;
revoke all on function public.prune_api_request_log(int, int)                          from public, anon, authenticated;
grant execute on function public.api_request_log_per_day(uuid, uuid, timestamptz)       to service_role;
grant execute on function public.api_request_log_by_route(uuid, uuid, timestamptz, int) to service_role;
grant execute on function public.api_request_log_by_key(uuid, timestamptz)               to service_role;
grant execute on function public.prune_api_request_log(int, int)                         to service_role;
