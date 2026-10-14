# RevBoxes roadmap

Status: Stages 1–5 and most of 6–8 are implemented locally. The job composer now supports tool dropdown selection with logo chips and in-thread plan revisions. The full built-in signal catalog and genuinely workspace-wide custom-signal ownership remain open. Local checks are recorded in BUILD.md; live provider acceptance and production rollout have not been performed.

The user authorized Markdown tracking instead of Linear on 2026-10-13. Build specification: /private/tmp/opennous-revbox-spec.md. Issue drafts: /private/tmp/opennous-revbox-linear-drafts.md.

## API-plan release

1. **Navigation and Accounts.** Home, Inbox (Tasks label only), Accounts. Remove People navigation and the API Workspace group. Keep Integrations unchanged. Footer: API Docs, Graph, Usage and billing. Accounts columns: Company, Contacts, Deals, Latest Signal, Last Activity, ICP. List each RevBox directly in the sidebar, with a create plus icon on the section heading. There is no overview page. Preserve Workspace-plan layout.
2. **RevBox foundation.** Persist new boxes and immediately open their empty detail page. Header: inline autosaved name, Private/Shared, creator, last activity. Invite members through the Owners card plus action. Enforce access for configuration, context, jobs, results and approvals, including existing routes.
3. **Context and account scope.** Existing documents and new uploads; blocks for goals, KPIs, ICP, voice, output format and references. Explicit accounts or saved filters. Accounts and Account graph rows open the full Accounts/Graph pages with the RevBox filter applied. Do not embed the account list or graph in the detail rail. Execution will use the same scope. Project ICP context never changes workspace ICP implicitly.
4. **Prompt-defined Jobs.** Multiple Jobs per box. Compile instructions to a draft plan with resolved signals/tools, scope, actions, approvals and delivery. Show a numbered execution outline instead of a node canvas. Resolve ambiguities before publishing. Jobs start disabled; version published plans and snapshot run context.
5. **Execution and credits.** Schedule, Webhook and Signals triggers. Bind provider events to live dispatchers, with timezone handling and occurrence deduplication. Reuse workflow runners with box permissions/scope. API background execution works without chat. Gate and meter compilation, revisions, runs and custom-signal extraction from their first implementation. Show box/job/run attribution in Results and Usage. Remaining: expose all existing built-in signal events in the job picker and verify each selection against runtime dispatch.
6. **Results and Delivery.** Jobs/Results tabs and job filtering. Store reports, drafts, approvals, run status and delivery errors. Results always retains artifacts; additional delivery can reach multiple Slack/webhook destinations. Gmail drafts remain unsent until approved where configured. Independent delivery retries cannot duplicate successful actions.
7. **Custom signals.** Versioned definitions with owner, rules, examples and review before activation. Current implementation still ties each definition to one RevBox. Make definitions workspace-wide, then show all existing built-in signals and custom rules in the job trigger picker. Extraction retains evidence/source privacy; reprocessing is explicit and billed.
8. **Verification and release preparation.** Test meeting-to-Gmail-draft, won-deal-to-CS-Slack, daily metrics reports and quarterly won/lost analysis with Slack/webhooks. Implement and verify a real Instantly completion dispatcher for campaign analysis. Validate access/isolation, account scope, credits, timezones, retries and approvals; run relevant tests and repository export/build checks. Regenerate schema baseline and update tracking/docs. Deployment and live migrations require separate authorization.

Proposed naming: **Jobs** for configured work, **Results** for produced artifacts, **Delivery** for destinations; each execution is a **run**.

## Later releases

- Workspace-plan rollout with bottom chat scoped to the selected Job.
- API/MCP provisioning and configuration of RevBoxes.
- Richer agent decision observability. Initial release still includes status, steps, evidence, approvals, errors and credit cost.

## Approval

User approved stages 1–4 on 2026-10-13, then clarified sidebar-only boxes and a minimal detail layout. Use the isolated checkout at /private/tmp/opennous-revbox-build. The latest supplied reference images guide the minimal detail layout. Stages 5–8 were explicitly approved on 2026-10-13; no further scope confirmation is pending.
