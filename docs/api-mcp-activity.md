# API & MCP activity

Settings → Workspace → **API & MCP activity** (`/settings?section=activity-log`, GET-898) shows
when, how often and about what the workspace's API and MCP were called. Workspace owners and
admins only, on the API and Workspace plans. Self-host does not show it. The old
`?section=access-log` link lands here.

## What it shows

Pick a window: 24 hours (hourly bars, UTC), 7, 30 or 90 days (daily bars, UTC days, today included).

- **Header:** total calls with the MCP / REST split, error rate (status 400 and up), p50 and p95
  latency, how many keys and clients made calls.
- **Calls over time:** stacked MCP and REST bars per hour or day.
- **Top tools and routes:** an MCP call shows its tool name (`get_account`); a REST call shows the
  route pattern (`/v2/accounts/:id`), never the filled-in path. Calls, error rate, p95. Click a row
  to filter the call list to it.
- **Most asked about:** the `target` of each call (an entity id, a domain or an email, when the
  request carried one cheaply). Ids, domains and emails that belong to this workspace's companies
  and people show the name and link to the account or person page. Anything else (a document id,
  a name) shows raw.
- **By key:** the key's name (never its secret or hash), calls, errors, last call. A revoked key
  that made calls in the window is marked. Click to filter.
- **By client:** the calling agent (Claude Code, Cursor, n8n, curl, …) from the MCP client name or
  the User-Agent. "Unknown" when the request said nothing.
- **Calls:** newest first. Time, surface, tool or route, about, status, latency, key, client.
  Filter by surface, tool or route, status (OK or errors), key, and a search over the target.
  Paged with a cursor ("Load more"). IP prefixes are stored but never shown.

## Where the numbers come from

`api_request_log` (supabase/migrations/2026_10_03_api_request_log.sql): one row per API-key call,
written by `verifyApiKey` through `apps/api/src/lib/apiRequestLog.mjs` after the response has gone
out. A browser (session) call is never logged. An MCP tool call reaches the API as one or more
`/v2` calls carrying `X-Nous-Client: mcp` and `X-Nous-Tool: <tool>`, so one tool call can be more
than one row. The MCP session handshake (initialize, tools/list) and the OAuth token check never
reach `/v2` and are not counted. Rows are kept 90 days (`apiRequestLogRetention` in the worker).

| Read | Endpoint | Source |
|---|---|---|
| Header, chart, top lists | `GET /api/usage/activity?window=24h\|7d\|30d\|90d` | `api_request_log_activity()` (supabase/migrations/2026_10_15_api_request_log_activity.sql), one jsonb aggregate |
| Call list | `GET /api/usage/activity/calls?window=&surface=&route=&status=ok\|error&key=&q=&limit=&before=` | `api_request_log`, keyset-paged on `(at, id)` |

Both are session-authed (`?workspaceId=`), scoped to the viewer's workspace, and answer 403 to a
member. Code: `apps/api/src/lib/apiActivity.mjs`, `apps/api/src/routes/api/apiActivity.mjs`;
the page is `apps/frontend/src/components/settings/ApiActivity.tsx`.

The aggregate runs in SQL because PostgREST returns at most 1000 rows with no error past that.
Until the migration is applied, `/api/usage/activity` answers 503 `activity_unavailable` and the
page says the summary needs a database update; the call list works without it.

## Known gap: older stdio MCP packages

`@opennous/mcp` on npm is 0.75.0 (2026-09-25). It sends `X-Nous-Client: mcp` but not the tool name
or the client name, which arrived in the repo on 2026-10-03. Calls from it show the `/v2` route
instead of the tool, and the client as `node`. Hosted MCP (`mcp.opennous.cloud`) is current. A new
npm release of `apps/mcp` fixes it for stdio users.

## Preview

`node apps/frontend/preview/server.mjs` serves a seeded 90-day call log
(`apps/frontend/preview/fixtures/api-activity.mjs`), so `/settings?section=activity-log` on :8080
shows the page with data on every preview plan.
