# Nous — AI Agent Guide

This file helps AI coding assistants understand the architecture before making changes.

## What this project is

Nous is the context graph for GTM agents. It resolves every person, conversation, and touchpoint across the GTM tool stack (Apollo, HubSpot, Smartlead, Gmail, LinkedIn) into one account record, ingests signals from email, LinkedIn, and calendar, and exposes that context via an MCP server and REST API so agents always have the full account in a single call.

## Monorepo structure

```
apps/
  api/       — Node.js/Express REST API (the /v2 Context API is the public surface)
  mcp/       — MCP server (@opennous/mcp, 24 tools — stdio bin + hosted HTTP variant)
  frontend/  — Vite + React + shadcn/ui (People, Companies, GTM Context, Lead Lists pages)
  worker/    — Background workers (CalendarPoller, signal ingestion, webhooks)
packages/
  core/      — Shared DB logic, Supabase client, the entity/claim/observation substrate
```

## Layer rules

- `packages/core` is the single source of truth for DB queries and substrate types. All apps import from here — never duplicate DB logic in an app.
- `apps/api` and `apps/mcp` are thin shells: they handle transport (HTTP / MCP protocol) and delegate all business logic to `packages/core`.
- `apps/worker` imports from `packages/core` for DB writes but owns its own polling/scheduling logic.
- `apps/frontend` never calls the DB directly — only calls `apps/api` endpoints.

## Key concepts

**The substrate** — everything reduces to three primitives. Agents never overwrite; they observe, and Nous derives:
- `entities` — canonical, durable anchors (a person or a company). The same person-entity survives a job change or a new email.
- `observations` — append-only log of what happened or was learned (an interaction, or a stated fact). The single write verb.
- `claims` — the current facts Nous *derives* from observations, each carrying a confidence and a freshness.

**Scopes** — a claim is attached to a contact entity, a company entity, or the workspace entity:
- contact — facts about one person (communication style, authority level)
- company — org-level facts shared across contacts at that company (budget cycles, deal history)
- workspace — the user's own GTM profile (ICP, market, pricing, positioning) — see the GTM Context page

**Signals** — email, LinkedIn messages, calendar meetings, calls, plus public signals (job postings, funding, tech-stack changes via webhooks) all land as observations against the resolved entity.

**Focus resolution** — an agent passes whatever it has. A hard identifier (entity UUID, email, LinkedIn URL, or domain) resolves to exactly one entity. A bare name is searched: zero hits → not found, one hit → resolved, several → the caller gets candidates to disambiguate (never auto-merge on name alone). Logic lives in `resolveFocus` in `packages/core/src/db/entities.ts`. Inbound signal matching adds a corroboration step that attaches a known contact's new email only when domain/company corroborates — see `apps/worker/src/utils/identityMatch.mjs`.

## Database

Supabase (PostgreSQL). Key tables (the v2 substrate):
- `entities` — canonical person/company anchors
- `entity_identifiers` — the emails, domains, LinkedIn URLs and external ids that resolve to an entity
- `observations` — append-only log of events and stated facts
- `claims` — the current derived facts per entity (with confidence + freshness)
- `predictions` — derived forecasts, including the latest `icp_fit` score per entity
- `relationships` — entity-to-entity edges (e.g. `works_at`, buying-group ties)
- `contacts` / `companies` — **views** over the v2 substrate (one flat profile row per entity, assembled from `entity_identifiers` + `claims` + `predictions`), with `INSTEAD OF` triggers so legacy writes still work. They are no longer real tables. Changing a column means editing the view in `supabase/schema.sql` (canonical) plus a dated migration, keeping the column list/order identical so the triggers keep matching.

**People vs leads & the pipeline.** The `contacts` view is also the People page, and it does NOT show every person — only ones you've actually engaged: an inbound reply (received LinkedIn message, email reply/received), a meeting/deal, a CRM record, a manual add, or `pipeline_stage` past the top of funnel. Cold/scraped leads and people you only messaged outbound stay out (they live as leads, queryable by the agent, not on People). Pipeline stages, low→high: `identified → aware → connected → interested → evaluating → client`. `connected` = an accepted LinkedIn connection with no conversation yet — kept OUT of People on purpose. An inbound reply advances to `interested`. Stage logic lives in `packages/core/src/db/activities.ts` (`advancePipelineStage`, real-time, direction-aware) and `apps/worker/src/workers/stageDerivation.mjs` (cron). Read pipeline state from `claims`, never from the `contacts` view (the view filters rows out, so a not-yet-graduated entity simply won't be there).

All DB access goes through `packages/core/src/db/`. Never write raw Supabase queries in app code.

## MCP tools (apps/mcp)

The server registers ~30 tools (`apps/mcp/src/server.js`; the canonical `createServer()` factory, `index.js` is the stdio bin, `http.js` the hosted variant). The header comment in `server.js` is the authoritative catalog. The tools are thin clients of the `/v2` Context API. The agent observes; Nous derives, there is no "update" verb on the substrate. The public docs split them into Overview tools (daily) and Setup tools (see `docs.opennous.cloud/mcp`); the lead-list tools still ship but are not in the daily docs.

Overview tools (daily):
- `get_context` — engineered, intent-shaped context for a task (draft_email, follow_up, meeting_prep, …): ranked claims with confidence + freshness, timeline, stakeholders, predictions, the ICP fit score
- `get_account` — the full account record: every claim + the activity timeline
- `query` — retrieve and summarise activity across many people (group by entity, subtract sets, value rollups)
- `attention` — what needs attention now (accounts gone quiet, claims decayed)
- `record` — record what happened or what you learned; the single write verb
- `save_note` / `search_notes` — keep / semantically search a doc on a contact
- `get_playbook` — read the user's own rules: the `voice`, `outreach`, `icp`, `positioning` playbooks (backed by `/v2/playbooks`). The "our GTM" read. Replaced and removed `get_gtm_profile`.
- `merge_contacts` — fold two duplicate records into one (lossless, reversible)

Setup tools (agent-driven, the agent runs the workspace):
- `get_workspace_status` — what's set up + a ranked `next_steps` list (call first in a session)
- `set_workspace_profile` — onboarding: name, site, type, ICP
- `build_scoring_model` — build/rebuild the ICP scoring model from recorded context
- `record_closed_deals` — train the ICP model on real closed-won/lost deals (contrastive lift)
- `sync_icp` — sync the user's ICP/context files into the graph (file → graph). Renamed from `get_icp`.
- `export_icp_model` — write the learned ICP model back into the user's file (graph → file). Renamed from `get_icp_model`.
- `sync_playbook` — push an edited playbook file into the graph
- `connect_integration` · `configure_crm_sync` · `sync_crm_now` · `set_trigger` · `list_triggers` · `get_routing_preferences`

Still ship, not in the daily docs: lead-list tools (`lead_list_operations`, `coverage`, `enrich_leads`, `verify_leads`), plus `record_signal`, `get_action_items`, `verify`, `scrape_engagers`.

## REST API routes (apps/api)

The public surface is the `/v2` Context API (key-authed via `verifyApiKey`). The MCP tools are thin clients of exactly these routes (see `apps/mcp/src/server.js`):
- `POST /v2/context` — engineered context for a task (backs `get_context`)
- `GET  /v2/accounts/:id` — the full account record (backs `get_account`)
- `POST /v2/observations` — record observations, the single write path (backs `record`)
- `POST /v2/query` — retrieve/summarise activity across many entities (backs `query`)
- `GET  /v2/attention` — what needs attention (backs `attention`)
- `POST /v2/verify` — re-derive a single fact (backs `verify`)
- `GET /v2/playbooks` / `POST /v2/playbooks/:kind` — read / sync the user's playbooks (back `get_playbook` / `sync_playbook`)
- `POST /v2/workspace/icp/import` / `GET /v2/workspace/icp/model` — sync ICP files in / export the learned model (back `sync_icp` / `export_icp_model`)
- `GET|POST /v2/workspace/facts` — workspace GTM facts; used by the web playground agent (the MCP `get_gtm_profile` tool was removed in favour of `get_playbook`)
- `POST /v2/notes` / `POST /v2/notes/search` — save / semantically search notes (back `save_note` / `search_notes`)

Workspace setup/operate routes (back the operate + status tools): `GET /v2/workspace/status`, `POST /v2/workspace/onboarding`, `POST /v2/workspace/scoring-model`, `POST /v2/workspace/integrations`, `POST /v2/workspace/crm-sync`, `GET|POST /v2/workspace/triggers`.

Cloud-only routes also mounted under `/v2` include `/v2/people`, `/v2/leads`, `/v2/signals`, and `/v2/dedup` (the last two back the `coverage` tool — `/v2/dedup` for the exact identifier check, `/v2/people/coverage` for the attribute estimate). The browser app's own routes live under `/api/*` and are session-authed, not part of the agent-facing surface.

## Documentation

The public docs are a separate Mintlify repo (`docs.opennous.cloud`). The in-repo `docs/` folder is the deep-dive set, written in one voice (plain, em-dash-free, every diagram validated through the Mermaid-to-Excalidraw converter):
- `docs/context-graph.md` — the overview: the problem (two clocks, fragmentation), why memory and RAG fail, the operational and decision layers, the substrate, the serve layer, and why it is graph-first not RAG. Start here.
- `docs/identity-resolution.md` — the resolution waterfall and the four-table substrate (entities, entity_identifiers, observations, claims).
- `docs/claims.md` — extracted claims (the Intel tab): the controlled GTM claim taxonomy and the extraction pipeline.
- `docs/icp-scoring.md` / `docs/intent-score.md` — the deterministic scorers and the learning loop.

Recent substrate + surface work (2026-06-30):
- **Controlled claim taxonomy** in `packages/core/src/db/claimCategories.ts` (status_quo, goal, pain, objection, authority, budget, timeline, preference, competitor, relationship, general), each tagged `about: person|company`, enforced at extraction (`apps/worker/src/signals/index.mjs`) and the manual write path so claims roll up into cross-account patterns.
- **Structural evidence chain**: each extracted claim now sets `supporting_observation_ids` back to the source observation (`saveNote` in `packages/core/src/db/notes.ts`).
- **MCP surface refactor**: renamed `get_icp → sync_icp` and `get_icp_model → export_icp_model`; removed `get_gtm_profile` (read our GTM via `get_playbook`); docs split into Overview vs Setup. Breaking change to `@opennous/mcp` (needs a version bump + republish).

## Plans & feature gating

**Not every feature is available on every plan — gate before you ship.** A new cloud feature is never just "build the route." It must be added to the plan feature map AND wrapped in a gate, or it leaks to plans that didn't pay for it.

- **Plans** (`apps/api/src/lib/plans.mjs` is the server source of truth; `apps/frontend/src/config/plans.ts` mirrors it for display — keep them in sync). Internal ids `free | starter | pro | growth | scale`; customer-facing names **Free / Start / Pro / Growth / Partner**. Each plan has a `features` map and an `includedOpsPerMonth`.
- **Feature ladder** (current): `contextualization` — all plans. `leadLists`, `linkedinEngagement`, `publicSignalExtraction` — **Pro and up**. `crmSync` — **Growth and up**. Booleans live in each plan's `features` object.
- **Enforce it** via `apps/api/src/lib/access.mjs`:
  - `requireFeature('crmSync')` — Express middleware; returns **402 `feature_not_in_plan`** if the team's plan lacks it. Use on every plan-gated route.
  - `assertFeature(planId, feature)` — the same check inside a handler that already resolved the team (throws).
  - `requireOpsBalance` — **402 `ops_exhausted`** when the month's included ops are used up. Ops = webhooks + MCP/SDK/API calls + scans (the live op log).
  - `requireEnrichmentQuota` — enrichment is **bring-your-own-keys and unmetered** today (`enrichmentsPerMonth: 0` → passes through); the gate exists for when a managed allowance returns.
- **Self-host** (`SELF_HOSTED=true`): all gating + metering is **bypassed** — operators get everything, unmetered — **except** `CLOUD_ONLY_FEATURES` (`crmSync`, `leadLists`), which return **403 `cloud_only_feature`**. Adding a cloud-only feature means adding it to that set in `access.mjs`.
- **Plan resolution**: from the team's `subscriptions` row via `getPlanFromSubscription` — `canceled`/`past_due`/`incomplete_expired` fall back to Free. Plan id comes from checkout metadata (`plan_id`), not the Stripe Price, so legacy subscribers are grandfathered on old prices.

When you add a feature: pick its lowest plan, set the boolean across that plan and every higher one in `plans.mjs` + `plans.ts`, gate the route with `requireFeature`, and if it should be cloud-only add it to `CLOUD_ONLY_FEATURES`.

## Code conventions

- ESM throughout (`"type": "module"` in all package.json files)
- No default exports — use named exports everywhere
- TypeScript in `packages/` and `apps/frontend`; plain `.mjs` is acceptable in `apps/api` and `apps/worker`
- Supabase service role key only in `apps/api` and `apps/worker` — never in frontend or MCP server
- All secrets via environment variables — no hardcoded keys anywhere
