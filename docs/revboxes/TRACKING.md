# Linear issue drafts: RevBoxes on the API plan

Team: GET. Markdown is the authorized tracker for this build. These are not created Linear issues. Parent scope: /private/tmp/opennous-revbox-spec.md.

## Parent: Build RevBoxes for the API plan

Give API-plan users a place to configure revenue operations with goals, context, scoped accounts, prompt-defined jobs and reviewable results. Reuse the workflow engine, add workspace-owned custom signals, and meter all platform-paid model work. Keep in-app chat out of API. Workspace rollout, API provisioning and richer agent observability follow later.

Done when the acceptance scenarios in the specification pass, including private access, real triggers, delivery, approvals and credit accounting. Link implementation PRs and record what ships on completion.

## 1. Refresh API navigation and Accounts — implemented locally

Home, Inbox (existing Tasks behavior), Accounts; remove People and the API Workspace group. Keep integrations unchanged. Put API Docs, Graph, Usage and billing at the bottom. Accounts columns: Company, Contacts, Deals, Latest Signal, Last Activity, ICP. Preserve Workspace layout, person drilldown and permissions. Resolve API Inbox routing/access deliberately.

## 2. Add RevBox persistence and access rules — implemented locally

Create RevBox and member tables, role/visibility checks and workflow association. New boxes open immediately in an empty detail page. Enforce access through every existing workflow, results, search, documents and approval endpoint that can expose box data. Implement workspace-consistent references and scoped core database methods. Test private/shared/invited/revoked access and member/admin API keys.

## 3. Build the RevBox shell, context and owners — implemented locally

Header with objective, private/shared, creator and last activity; Jobs/Results tabs; context, accounts, delivery and owners rail. Support accessible document selection, uploads and structured goal/KPI/ICP/voice/format blocks. Snapshot context at execution. Test refresh persistence and inaccessible files.

## 4. Apply one account scope to list and graph — implemented locally

Implement validated explicit account selections and saved filters, including CRM closed-won. Resolve scope server-side and use it for Accounts, graph and every job read. Empty scope remains empty. Test the same IDs across the three views and unauthorized account rejection.

## 5. Compile prompts to reviewable job plans — core flow implemented locally; conversation refinements implemented locally

Turn a user's instructions into a typed draft with trigger, tool bindings, scope, actions, approvals and destinations. Replace the node canvas with a numbered execution outline. Resolve real connections/channel/mailbox IDs and ask about ambiguity. Jobs start disabled, publish after review and version changes. Meter compilation and revision. The composer now uses a Tools dropdown; selected integrations appear as removable logo chips above the prompt. After the user describes a job, the agent responds in the same conversation with a concise proposed plan. The user can ask for changes in the persistent prompt or approve the plan. Test representative prompts and unsupported bindings.

## 6. Run API jobs on schedule, webhook and signals — schedule/webhook and current event dispatch implemented locally; full signal picker remains open

Separate background execution from in-app chat permissions. Reuse existing scheduled flow and event runners with RevBox authorization/context/scope. Add authenticated inbound webhook dispatch and durable occurrence deduplication. Bind provider-specific meeting and deal aliases to actual supported events. Include timezone/DST handling and visible credit-exhaustion states. Campaign completion is wired to the existing campaign refresh. **Remaining:** expose the existing built-in signal/event catalog (25+ entries) in the same picker as custom signals, and make every offered trigger resolve to its corresponding runtime event. The current picker has the small set of RevBox trigger types plus workspace custom signals; users cannot yet select the full existing catalog.

## 7. Store Results and deliver to multiple destinations — implemented locally

Combine reports, drafts, approvals and errors under Results with a job filter. Keep outputs internally and deliver to Slack/webhooks independently. Gmail draft remains unsent until reviewed. Reuse approval continuation with role checks, snapshots and idempotent decisions. Test delivery retries/partial failures and duplicate send prevention.

## 8. Add workspace custom signals to extraction — extraction and review UI implemented locally; workspace-wide ownership remains open

Store versioned signal rules and owners at workspace scope. Let the user select existing signals or review a proposed new rule. Load only that workspace's definitions into extraction, ground detections in evidence, preserve source privacy and emit deduplicated account signals. Test isolation across two workspaces, archived rules and definition revisions. Reprocessing is explicit and metered. The current implementation has versioning, ownership, evidence grounding and reprocessing, and the composer can choose active custom rules. **Remaining:** remove the RevBox-only ownership constraint so a custom signal is genuinely reusable throughout its workspace, then show both that workspace's custom rules and the full built-in signal catalog in the job picker.

## 9. Make RevBox credit accounting durable — implemented locally

Gate every platform-paid compiler, execution and extraction entry point. Record usage durably with box/job/run/step attribution; show credits in Results and Usage. Close existing best-effort metering gaps for these paths. Test concurrency, exhaustion, retry attribution and cost consistency. Deterministic editing/reads have no invented AI charge.

## 10. Validate and document the API release — local checks complete; live provider acceptance pending

Run end-to-end acceptance scenarios, responsive UI checks, targeted permissions/billing/trigger/approval tests and repository checks. Regenerate schema baseline, verify Cloud seams/public export and update applicable docs. Attach validation and PR links to GET issues; mark complete only when shipped.

## Latest implementation notes — 2026-10-13

- The job composer now separates tool discovery from selection: choose connected integrations from a dropdown, then see their logos as removable chips directly above the chat input.
- The composer stays visible after the first prompt. The agent presents a compact in-thread plan with numbered actions, trigger, app logos and explicit **Make changes** / **Approve job** actions. Follow-up instructions recompile the proposal; approval saves the reviewed prompt and plan.
- Context and Signals are separate tabs in one dialog. Reference titles are shown without descriptions; uploads remain available inside Context. Composer attachment buttons were removed.
- Local verification after these UI changes: browser smoke test passes, frontend production build passes, targeted ESLint passes, and typecheck has the same 57 baseline errors with no new errors.
- The latest requested signal-catalog expansion has not been implemented yet: the picker needs the 25+ existing built-in events/signals in addition to workspace custom rules. The workspace-wide custom-signal scope also needs to be corrected before section 8 can be marked complete.

## Follow-up: Expand RevBoxes to Workspace

Reuse the initial RevBox configuration and results. Add selected-job chat at the bottom, scoped to the chosen job/context. Keep API chat disabled. Details follow after API release feedback.

## Follow-up: Provision RevBoxes through API and MCP

Expose versioned public creation/configuration endpoints and corresponding MCP tools with the same membership, role, scope and credit semantics. Do not add a second persistence or execution model.

## Follow-up: Explain agent decisions and execution

Extend the initial step/evidence/status history with decision explanations, tool traces and diagnostics. Retain the run snapshots needed to explain which rules/context were used without exposing hidden source material.
