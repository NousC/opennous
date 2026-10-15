# Agent activity

Settings → Workspace → **Agent activity** (`/settings?section=activity-log`; GET-898, renamed
from "API & MCP activity" in GET-900) shows when, how often and about what the workspace's agents
and scripts called the API and MCP with its API keys. Workspace owners and admins only, on the API
and Workspace plans. Self-host does not show it. The old `?section=access-log` link lands here.

## What it shows

Pick a window on the top right: 24 hours (hourly bars, UTC), 7, 30 or 90 days (daily bars, UTC
days, today included). Rows are kept 90 days.

- **Header:** Activity (total calls, with the MCP / REST split), error rate (status 400 and up),
  p50 and p95 latency, how many keys and clients made calls.
- **Activity over time:** stacked MCP and REST bars per hour or day.
- **Activity:** every call, newest first. Time, surface, tool or route, about, status, latency,
  key, client. An MCP call shows its tool name (`get_account`); a REST call shows the route pattern
  (`/v2/accounts/:id`), never the filled-in path. "About" is the call's `target` (an entity id, a
  domain or an email, when the request carried one cheaply); ids, domains and emails that belong
  to this workspace's companies and people show the name and link to the account or person page.
  A key is its name (never its secret or hash). The client is the calling agent (Claude Code,
  Cursor, n8n, curl, …) from the MCP client name or the User-Agent, "Unknown" when the request
  said nothing. Paged with a cursor ("Load more"). IP prefixes are stored but never shown.
- **Filters** on the list: MCP or REST, tool or route, status (OK or errors), key, client, and a
  search over what the call was about. The tool/route, key and client menus are filled from the
  window's summary (its top routes, keys and clients). GET-900 removed the four tables (top tools
  and routes, most asked about, by key, by client); filtering the list answers the same questions.

If a read fails the page says which one, shows the HTTP status and error code in a muted line
(`401 · sign in again`, `500 · internal_error`) and offers Retry; on a 401 also "Sign in again".

### Session tokens (GET-900)

Every request mints its token at the moment of the call (`activityGet` in
`apps/frontend/src/lib/apiActivity.ts`, through `freshAccessToken()`), and a 401 forces a new token
and retries once. Before GET-900 the page sent `session.access_token`, a React mirror of the Clerk
token refreshed every 30 seconds by a timer that a background tab throttles. A Clerk token lives
about a minute, so switching to 30 or 90 days after the tab had sat (a new query key, a new
request) sent a rotated-out token; the API answered 401 `invalid_token` (not logged), and the page
showed "Could not load the activity" while the 7-day numbers it already had stayed on screen.

## Where the numbers come from

`api_request_log` (supabase/migrations/2026_10_03_api_request_log.sql): one row per API-key call,
written by `verifyApiKey` through `apps/api/src/lib/apiRequestLog.mjs` after the response has gone
out. A browser (session) call is never logged. An MCP tool call reaches the API as one or more
`/v2` calls carrying `X-Nous-Client: mcp` and `X-Nous-Tool: <tool>`, so one tool call can be more
than one row. The MCP session handshake (initialize, tools/list) and the OAuth token check never
reach `/v2` and are not counted. Rows are kept 90 days (`apiRequestLogRetention` in the worker).

| Read | Endpoint | Source |
|---|---|---|
| Header, chart, filter menus | `GET /api/usage/activity?window=24h\|7d\|30d\|90d` | `api_request_log_activity()` (supabase/migrations/2026_10_15_api_request_log_activity.sql), one jsonb aggregate |
| Activity list | `GET /api/usage/activity/calls?window=&surface=&route=&status=ok\|error&key=&client=&q=&limit=&before=` (`client=(unknown)`: no client named) | `api_request_log`, keyset-paged on `(at, id)` |

Both are session-authed (`?workspaceId=`), scoped to the viewer's workspace, and answer 403 to a
member. Code: `apps/api/src/lib/apiActivity.mjs`, `apps/api/src/routes/api/apiActivity.mjs`;
the page is `apps/frontend/src/components/settings/ApiActivity.tsx`.

The aggregate runs in SQL because PostgREST returns at most 1000 rows with no error past that.
Until the migration is applied, `/api/usage/activity` answers 503 `activity_unavailable` and the
page says the summary needs a database update; the activity list works without it.

## Known gap: older stdio MCP packages

`@opennous/mcp` on npm is 0.75.0 (2026-09-25). It sends `X-Nous-Client: mcp` but not the tool name
or the client name, which arrived in the repo on 2026-10-03. Calls from it show the `/v2` route
instead of the tool, and the client as `node`. Hosted MCP (`mcp.opennous.cloud`) is current. A new
npm release of `apps/mcp` fixes it for stdio users.

## Preview

`node apps/frontend/preview/server.mjs` serves a seeded 90-day call log
(`apps/frontend/preview/fixtures/api-activity.mjs`), so `/settings?section=activity-log` on :8080
shows the page with data on every preview plan (a few REST calls name no client, so the
Unknown client filter has rows).
