# RevBoxes local build

Implemented the RevBox UI and the stages 5–8 backend layer in an isolated checkout on branch `bennet/revboxes-api`. Markdown tracking replaces Linear for this build, as authorized by the user. Nothing has been deployed or migrated in a live database.

## Current behavior

- API sidebar: Home, Inbox (existing Tasks behavior), Accounts, then individual RevBoxes. The RevBoxes heading has a plus action; creation immediately opens a persisted empty box. There is no overview page or All RevBoxes link.
- API Accounts has Company, Contacts, Deals, Latest Signal, Last Activity, ICP. Prospects/Customers controls and People navigation are removed. Existing person drilldown remains.
- Integrations is unchanged. API Workspace/Automations navigation is removed. Footer order is API Docs, Graph, Usage and billing. Workspace layout remains unchanged.
- RevBox detail uses the supplied reference direction: name and compact metadata, job rows, and separate Context/Accounts/Delivery/Owners cards. Objective is editable inside Context, not a repeated subtitle.
- Context has a working add action and shows titles only in the rail; titles open the block/file. Settings → Context groups instructions and references by RevBox. Context supports structured blocks, accessible linked documents, and Markdown/text/CSV/JSON reference uploads up to 256 KB. Uploaded files stay private to the box instead of entering the broad document library.
- Accounts and Account graph rows navigate to the full pages with `?revbox=<id>`. The server resolves the same stored filter for both. No account graph/list is embedded in the right rail.
- Titles save inline automatically. Delivery has an add picker and removable destinations. Member invitations live in the Owners card. Sharing uses an actual toggle. Sharing grants read access; the creator can invite editors or viewers. Workspace membership, box roles, and optimistic revision checks are enforced server-side.
- New job opens a compact chat composer. Tool discovery is a dropdown; selected integrations appear as removable logo chips above the prompt. Built-in signal catalog selection is still incomplete; active custom-signal rules are selectable beside tools. After submission, the conversation stays visible and the agent responds with a concise numbered job plan, trigger and app logos, with **Make changes** and **Approve job** actions. Follow-up instructions recompile the plan. Existing jobs do not show the chat input.
- The production compiler uses the model door, gates credits before preparation, and persists actual usage before accepting an answer. Configuration changes and approved plans remain separate from enabling execution. Unresolved questions, Gmail recipients/mailboxes and required destinations block execution.
- New job remains visible beside Jobs/Results. Job rows use a compact status dot, job name, latest run state/result and last activity. Results includes job/type filters, run status, reports, drafts, approvals, delivery state and usage attribution.
- Runs capture immutable context, scoped account/deal evidence and source references. Workspace/box/source permissions are checked before compute, delivery, result reads and approvals. Schedule dispatch reuses the existing timezone scheduler; weekday schedules skip weekends. Job changes pause execution and stale queued versions are rejected.
- Incoming webhook jobs have rotatable hashed keys and per-event Idempotency-Key deduplication. Meeting/deal/account-signal events use the existing event pipeline. Instantly completion transitions are emitted by the existing campaign analytics refresh; this covers campaigns that refresh already tracks. Campaign status follows the [official Instantly SDK documentation](https://github.com/Instantly-ai/instantly-starter-kit/blob/main/docs/api/campaigns.md).
- Outputs persist before delivery. Slack/webhook destinations have independent claim/status records. Gmail creates drafts only, from the reviewed mailbox and explicit recipient or customer meeting attendees. Review gates other deliveries. Successful actions cannot be retried by the retry endpoint; uncertain outcomes require checking the external destination. Sending email remains in Gmail.
- Custom-signal definitions have owners, reviewed/versioned rules, activation and explicit paid reprocessing. Active rules are selection criteria in activity/meeting extraction, and a separate billed classifier requires a verbatim quote before emitting a custom signal. Source privacy is checked with the existing derived-evidence policy. Current schema still scopes a definition to one RevBox; workspace-wide reuse remains open.
- Usage and attribution commit together through an idempotent transaction. New RevBox plan/run/custom-signal features use the existing credit denomination and appear in Usage; run cost is also returned with Results.

## Validation

- Browser smoke test passes creation, saving, context, sharing toggle, scoped Accounts and Graph links, delivery configuration, tool selection, prompt/change/approval flow, composer visibility, Results filters, mobile overflow, and Accounts columns.
- Latest composer interaction also passes: tool dropdown, selected app chips, persistent prompt, plan response, change/approval actions and custom-signal selection. Full built-in signal catalog selection is still pending.
- 72 targeted core/API tests pass, including tenant isolation, revocation, roles, stale saves, compiler billing, execution, drafts, schedules/DST and campaign completion. Another 45 extraction/grounding tests and 25 worker/event/schedule checks pass.
- Local PostgreSQL assertions confirm duplicate paid-call records charge once, failed attribution rolls back the billing insert, and repeated completed-campaign refreshes emit one occurrence.
- Frontend typecheck: 57 errors, matching the existing baseline; no new errors.
- Frontend production build passes. Changed/new feature files pass ESLint. Cloud import guard passes.
- Migration replayed in a temporary local PostgreSQL database and the fresh-install schema baseline was regenerated.
- Required public-build check passes without Cloud modules. Changed public files scan clean for forbidden content.
- Full core suite has 9 existing failures out of 1,179 tests; all 9 reproduce in the unchanged original checkout. Full frontend lint has the same 537 problems (324 errors/213 warnings) as the unchanged original checkout. These are not represented as green checks.

## Local review

Run the fixture API with `PREVIEW_PLAN=api PORT=3100 node --watch apps/frontend/preview/server.mjs` and Vite with `VITE_PREVIEW=1 VITE_PROXY_TARGET=http://localhost:3100 node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 8080 --strictPort` from the frontend directory.

The active preview is credential-free and uses fictional accounts. Its box configuration is saved outside the repository in a local JSON file. Browser tests use a separate API on port 3101 and a separate fixture state so they do not add test boxes to the user's preview.

## Release boundary and follow-up

Stages 5–8 were explicitly authorized on 2026-10-13. Their local implementation and adapter-based checks are present. Live provider acceptance has not been performed: this checkout has no production credentials and no live migration was applied. Localhost uses fictional fixture outputs and never calls paid models, Slack, Gmail or customer webhooks.

Campaign completion depends on the existing campaign refresh's coverage/cadence. Custom signals are grounded classifications of extracted evidence; private source messages are not promoted to workspace-wide signals. Email sending is reviewed in Gmail. These limits should be verified with real provider fixtures before release.

Workspace chat, API/MCP box provisioning and richer decision observability remain later releases. Production deployment and live migrations are separate from the authorized local build.
