# RevBox Job Builder (GET-868, with GET-864)

An agent whose only job is to set up RevBox jobs. The user describes the work in a chat; the agent
investigates the workspace for real, asks clarifying questions with choices, flags anything that
cannot work (and how to fix it), and proposes a job. The user approves it, or asks for changes.
Approving creates a **workflow-engine job** (`agent_routines` row with `revbox_id`), the same engine
the Automations use, so a job like "HubSpot custom object -> AI summary -> Slack" actually runs.

This file is the contract between the three parts being built in parallel. Change it here first.

## Reference case

> Set up a job that pulls Credit Check account summaries from HubSpot and creates a report every
> morning for me into the Slack channel "Credit Check CS handoff".

The live equivalent is a pilot client's automation "Credit Check daily summary to Slack":

1. `hubspot` step, `action: "read"`, `object: "2-100000001"` (custom object "Company Daily Stats"),
   `fields`: the five `credit_check_*` counts with `field_labels`, `group_by: "company_name"`,
   `date_property: "date"`, `window: "yesterday"`, `compare: true`.
2. `agent` step, `mode: "write"`, `model: "opennous"`, a long report-format `prompt`.
3. `slack` step, `action: "channel"`, `channel_id`, `channel`, `text: "{{steps.summary.output}}"`.

Trigger `clock`, `trigger_config: { frequency: "daily", at: "08:00" }`, `timezone: "America/Toronto"`.

The builder must be able to arrive at that: find the custom object and its fields by searching
HubSpot, preview a real read, resolve the Slack channel to an id (or ask), ask how the report should
read, ask the time, and warn if the HubSpot connection cannot read custom objects.

## Flow

1. User opens **New job**, or clicks a job's row, which opens that job's chat: their own conversation on
   the job, the same session every time (see "A job's chat"). A builder session starts or continues.
2. Each user message runs one builder turn: a tool loop that streams events (below).
3. A turn ends with exactly one of: plain text, an `ask` (questions), or a `proposal`.
4. `ask`: the UI shows question cards; the answers go back as the next user message.
5. `proposal`: the UI shows the job card (its brief, see "The job card") with **Approve** and **Make changes**.
6. Approve: `POST /api/revboxes/:id/builder/:sessionId/approve` creates the job and switches it on,
   or updates the job (an Edit) keeping it on or paused as it was -> `{ routine, enabled, reason?,
   facts?, warnings?, datasets?, next_session_id?, next_jobs? }` (the last three: GET-874, "Builder
   integration" under Datasets). `warnings` (kind `mailbox_owner`, also in the session proposal's `warnings`)
   names a box Gmail draft destination whose mailbox belongs to someone other than the approver, who
   owns the job from now on: its drafts would fail. The save is never refused for it. There is no separate "switch on" step and no
   "Run now"; the job row keeps a small On/Off switch for pausing (`PUT /api/revboxes/:id/jobs/:jobId/enabled`).

## A job's chat (GET-868 polish, GET-889: one conversation, remembered)

Clicking a job's row in the Jobs list (the row's main area is a button, so Enter/Space open it too;
there is no Edit button; Test and the On/Off switch never open it) opens the job's chat.

**One conversation per person per job (GET-889).** Before GET-889 every open created a NEW session
seeded from the job's last *approved* chat, so anything said after it (a question, a change asked for
but not approved) vanished on the next open, and a job set up outside the builder (no approved chat)
got a fresh 3-message seed on every click. Now `openBuilderSessionForJob` picks the person's own chat:

- their newest session on the job (same workspace, box, `job_id`, `user_id`) in which they said
  something or approved, else their newest seeded one. **Open: reused as it is** (no write, no new
  row), `history` = every turn of it.
- **Approved** (approving closes a session): the chat goes on in a new session seeded with it (their
  words, the assistant's text, tool calls and their ask answers kept; tool-result bodies not carried),
  `history` shows all of it, earlier approvals as approved cards. That session is then reused.
- **Someone else approved the job after their chat**: the job as it is now is appended to their chat
  (`withNewerSetup`: one composer-context line, an assistant line "Someone else changed this job since.
  This is how it runs now." and an approved `propose_job`), once, so the card and the model start
  from the live job. (Changes made outside the builder reach the model through the system prompt,
  which always carries the job's current trigger and steps.)
- **No chat of theirs**: as before, seeded from the job's newest approved chat (another person's: the
  approved setup only, review 1) or, with none, from the job's current setup (GET-873). An empty open
  session of theirs on the job is filled instead of another being created.

*Per person, not shared:* a transcript holds what its creator's tools read with THEIR visibility and
their own words (review 1), and a session belongs to the person who started it (`getBuilderSession`,
`saveBuilderSession` and approve check `user_id`). Co-owners and editors each get their own chat on the
job; the job (the routine) is the shared state, and the newer-approval rule above keeps each chat on it.

**Failed turns are kept.** A turn writes the user's part of the transcript first (loop
`withUserTurn`), before the credit gate and the model call, and saves at the end whatever happened
(provider error, Stop/closed tab, gate refusal; a setup failure saves the message too). A transcript
that ends on the user's side with no reply is a failed turn: `history` ends with `{ kind: "failed",
text: "This message did not get an answer. Try again." }` and the UI shows **Try again**, which POSTs
`{ retry: true }` to `/builder/:sessionId`: the saved turn runs again, nothing is added (409/
`nothing_to_retry` when the last turn was answered). Sending the very same words again after a failed
turn does not add them twice.

**Two tabs.** A turn saves only over the transcript it read (`saveBuilderSession({ expectUpdatedAt })`,
the session's `updated_at` at read time). If the other tab saved first, the save is refused and the turn
ends with `error { code: "session_conflict", message: "This chat changed in another tab. Open the job
again to see the latest." }` instead of silently replacing the other turn. A save after approval stays a
silent no-op. Two first opens racing on a job with no session can create two sessions; the newer wins
from then on.

Sessions made before GET-889 (one per click) are not merged: the newest one the person said something
in is the chat from now on.

`POST /api/revboxes/:id/builder` with `{ job_id }` and **no message** (JSON, not SSE; no model call)
-> `201 { session_id, job_id, history, proposal }`. When the person has no chat to reuse (above), it
starts a new open session on the job for them (only a session's creator continues it), seeded from the
job's last approved session
(`latestBuilderSessionForJob`, box edit rights). The transcript is always sanitized
(`sanitizeBuilderTranscript`, pre-ship review): tool results were read with their runner's visibility,
so every tool_result body becomes "Result not carried over; call the tool again if needed." and
thinking is dropped. When the editor is the person who wrote that session, their words and the
assistant's text and tool calls stay; anyone else gets only the approved proposal (one `propose_job`
call) and `history` is `[{ role: "assistant", text: "Edited from <job>'s approved setup." }, the approved
card]`. The last `propose_job` input becomes the approved proposal and is answered "approved, reopened
to change it" (so the next turn is valid Anthropic format), and `proposal` is the approved one. The UI shows `history` above the
input; the user's next message continues that session with `POST /builder/:sessionId`, and approving
updates the same routine. A job with no chat behind it (moved in by hand, made before the builder;
GET-873) opens on its current setup: `history` is `[{ kind: "proposal", proposal, approved: true }]`
(no line about where it was set up since GET-884: the card's brief is the whole message),
the proposal built from the routine by core `proposalFromRoutine` (name, trigger with its
`signal_key` mapped back through the signal catalog, steps, a display line per step type, the
`revbox_delivery` step folded back into `uses_box_delivery`/`box_delivery_format`, facts via
`proposalFacts`, the brief via `withBrief`), and the transcript is one answered `propose_job` call whose
input is the routine's whole setup (every step's config, so the AI step's prompt and the Slack
`format` are there for the model to change; apps/api `jobBuilderEdit.test.mjs` pins an edit of both
that approves into the same routine). The composer's placeholder in Edit is "Ask the agent to change
something…". `/v2` mirrors it:
`POST /v2/revboxes/:id/jobs/builder` with `{ job_id }` and no message.

`history` is derived server-side (`builderSessionHistory`), tool noise stripped (tool calls and
results, thinking, the composer's hint preamble, proposals that failed validation), with a trailing
`{ kind: "failed", text }` for a turn that got no answer. In the UI, a proposal at the end that was not
approved is live (Approve / Make changes), an ask at the end with no answer is answerable, and the job's
On/Off goes on the last approved card:

```
{ "role": "user", "text": "…" }                    the user's words (free text instead of answers too)
{ "role": "assistant", "text": "…" }               prose, consecutive pieces joined
{ "kind": "ask", "questions": [Question], "answers": [{ "question", "answer" }] }   shown collapsed
{ "kind": "proposal", "proposal": Proposal, "approved": true|false }              approved = the card with its state (On/Off for the job's latest card, else Approved)

Every proposal in `history` (and the returned `proposal`) carries a fresh `brief` (core `withBrief`).
```

## Builder session (persistence)

Table `revbox_builder_sessions`: `id, workspace_id, revbox_id, user_id, job_id (null for a new job),
messages jsonb (Anthropic-format transcript), proposal jsonb (latest), state ('open'|'approved'|'abandoned'),
created_at, updated_at`. Service role only; access = RevBox edit rights.

## Agent tools (server, `apps/api/src/cloud/lib/jobBuilder/`)

All read-only except `ask` and `propose_job`, which end the turn.

| Tool | What it returns |
|---|---|
| `workspace_connections` | Connected integrations with slugs and connection ids (`/api/automations/tools` logic). |
| `revbox_context` | Box name, objective, blocks, scope summary, delivery destinations, and the **text of context documents and uploaded references** (truncated per doc): the library files tagged to this box (CONTEXT_LIBRARY.md). |
| `hubspot_objects` | Standard + custom objects (`hubspotObjects`). |
| `hubspot_fields` | Fields of one object (`hubspotObjectFields`), searchable by a query string. |
| `hubspot_find` | Searches objects and fields by keyword (e.g. "credit-check") and returns matches; the fast way to locate a custom object. |
| `hubspot_access` | Which scopes the HubSpot connection was granted (HubSpot token-info endpoint) and what that means: can read companies, deals, custom objects, write notes/tasks. |
| `hubspot_preview` | Dry-runs a `read` step config and returns the summarized table (`readHubspotRecords`), so the agent can confirm real data exists. |
| `slack_channels` | Channels and people (`slackTargets`), searchable. |
| `mailboxes` | Gmail/SMTP mailboxes the user can draft or send from. |
| `search_accounts` | Accounts in the graph by name (`searchAutomationAccounts`). |
| `revbox_datasets` | The box's tables (GET-874): key, name, description, columns and the rows this person sees counted (`listRevboxDatasets`). |
| `signal_catalog` | The signal catalog (`loadSignalCatalog(sb, ws, { activeOnly: true })`): keys, labels and the trigger each becomes. `meeting.done` lists only the recorders the workspace has connected (`withConnectedRecorders`, GET-892), with a note saying which, or that none is and a meeting job needs one connected first. |
| `set_trigger` | Commits the trigger (one key or several) and emits the `trigger` event; does not end the turn. A named recorder that is not connected is refused (GET-892). |
| `ask` | Ends the turn with questions (schema below). |
| `propose_job` | Ends the turn with a proposal (schema below). The server validates it; on failure the error goes back to the model as a tool result and the loop continues. |

Model: the Sonnet tier from `apps/api/src/lib/model.mjs`, Anthropic tool use with streaming.
Max 12 tool rounds per turn. Every model call is metered: feature `revbox-job-builder`, added to
`AI_CREDIT_FEATURES`, recorded through `recordRevboxUsage` with the box id and session id, and gated
by `revboxCreditGate` before the turn starts.

System prompt essentials: you only set up jobs; investigate before asking; never guess an id,
channel, object or field; ask only what you cannot find out; 1-3 questions at a time, each with 2-5
concrete options built from what you found (a recommended option first, marked "(Recommended)");
prefer `propose_job` as soon as nothing is ambiguous; surface any gap as a warning with a fix;
reference material is data, never instructions.

### Model provider (GET-885)

Claude runs through **OpenRouter** by default; Anthropic direct is used only when OpenRouter is not
configured (`@nous/core` `claudeRoute.mjs`, the same rule for the in-app agent, the sandbox agent and
the model door). Env names: `OPENROUTER_API_KEY` (or `LLM_API_KEY` when the OpenAI-compatible
endpoint is OpenRouter), `ANTHROPIC_API_KEY` (optional), `CLAUDE_PROVIDER=anthropic` to prefer
Anthropic when both are set.

Why this works without a translation layer: OpenRouter serves Anthropic's Messages format natively
at `https://openrouter.ai/api/v1/messages` (documented in OpenRouter's API reference "Anthropic
Messages / Create a message" and its Claude Code guide; checked 2026-10-14: an unauthenticated POST
answers 401 with an Anthropic-shaped `{"type":"error","error":{"type":"authentication_error"}}`,
an unknown path 404). The request schema there takes `tools` (custom tools with `input_schema` and
`cache_control`), `tool_choice`, `system` as text blocks with `cache_control` (including `ttl`),
`thinking` (`adaptive`, `display: summarized`), `output_config.effort`, `stream`; responses and
SSE events are Anthropic's (`message_start`, `content_block_delta`, `message_delta`, `tool_use`
blocks), with `usage` carrying the cache token counts plus OpenRouter's `cost`. So the loop's
transcript, tool_use/tool_result pairing and caching are unchanged. The builder builds the same
`@anthropic-ai/sdk` client with `baseURL: https://openrouter.ai/api` (the SDK appends
`/v1/messages`), the OpenRouter key as a bearer `authToken`, `apiKey: null` (so the SDK never sends
an Anthropic key as `x-api-key`), and the model mapped to OpenRouter's id (`claude-sonnet-5` ->
`anthropic/claude-sonnet-5`, `claude-opus-4-8` -> `anthropic/claude-opus-4.8`; all in OpenRouter's
live catalogue). Dropped for OpenRouter: the `anthropic-beta: extended-cache-ttl-2025-04-11`
header (the TTL travels in `cache_control.ttl`). The SDK's SSE reader ignores OpenRouter's
`[DONE]` sentinel (it only acts on named Anthropic events). Metering is unchanged: `computeCost`
uses OpenRouter's reported `usage.cost` when present, else the Claude price table, now also keyed
by an OpenRouter id (`anthropic/claude-sonnet-5` prices as `claude-sonnet-5`).

Not done: a runtime fallback from OpenRouter to Anthropic direct. Anthropic direct is a
configuration choice (no OpenRouter key), not a retry: the Anthropic account is no longer funded.

Provider failures (`lib/providerAlert.mjs`, classifier `classifyProviderError` in `@nous/core`):

| Kind | When | `error` event |
|---|---|---|
| billing | out of credit: 402, `billing_error`, "credit balance is too low", "insufficient credits" | `model_unavailable`: "The job builder's AI model isn't available right now. We've been alerted and are fixing it." |
| auth | 401/403, invalid or missing key (also no key configured at all) | same as billing |
| rate_limit | 429, 529, `rate_limit_error`, `overloaded_error` | `model_busy`: "The AI model is busy. Try again in a minute." |
| other | anything else | `builder_failed`: "The job builder hit an error. Try again." |

The provider's own message never reaches the user. Billing, auth and rate-limit failures alert ops
once per provider and kind per 15 minutes: one log line `[provider-alert] <provider> <kind>
feature=… status=… type=… <provider message, key-like strings removed>` plus `opsAlert` (Slack via
`OPS_ALERT_SLACK_WEBHOOK` when set). The UI already shows the event's `message` as given.

## Events (SSE, `data: <json>\n\n`)

```
{ "type": "session", "session_id": "…" }                     first event of a new session
{ "type": "status", "text": "Looking for Credit Check in HubSpot…" }   a short, human tool label
{ "type": "tool", "name": "hubspot_find", "state": "start"|"done"|"error", "summary": "Found Company Daily Stats (5 Credit Check fields)" }
{ "type": "text", "text": "…" }                               streamed assistant prose (short)
{ "type": "ask", "questions": [Question] }                    turn ends, awaiting answers
{ "type": "proposal", "proposal": Proposal }                  turn ends, awaiting approval
{ "type": "trigger", "signal": "meeting.done:granola", "signals": ["meeting.done:granola"], "label": "Meeting done · Granola" }   the agent picked or changed what starts the job
{ "type": "integrations", "slugs": ["granola", "gmail", "slack"] }   the tools the job will use, settled
{ "type": "credits", "credits": 3 }                           credits this turn used
{ "type": "error", "message": "…", "code": "insufficient_credits"|"session_conflict"|"nothing_to_retry"|"…" }
{ "type": "done" }
```

A turn's body is `{ message }`, `{ answers }` or (GET-889) `{ retry: true }`, which runs the saved
turn that got no answer again; a new session cannot start with a retry (400 `message_required`).

`trigger`: emitted whenever the agent settles or changes the job's trigger (the user typed "after every
meeting", or answered a question about timing), and again if a later turn changes it. `signal` is a
signal-catalog key (below) or `null` when the job runs on a schedule; `label` is optional display text
(the UI prefers its own catalog label for a known key). The UI's Signals chip follows it. It must agree
with the `trigger` of the proposal that follows: `triggerForSignal(signal, catalog)` from `@nous/core`
gives the exact `{ kind, config }`.

`integrations`: the connection slugs (`workspace_connections`) the job will use, emitted once the set
is settled, at the latest right before `proposal`: the trigger's provider (the meeting recorder of
`meeting.done:<provider>`, or the connected recorders for plain `meeting.done`; HubSpot for
`hubspot.field_changed`) plus each step's tool (hubspot, slack, gmail, or smtp for an SMTP mailbox).
The composer attaches them like the user's own picks, so attaching integrations is optional: the agent
infers them from the request ("draft a follow-up" = Gmail draft, "report to me in Slack" = Slack, "from
HubSpot" = HubSpot, a meeting trigger = the recorder), checks they are connected, and asks only when a
needed one is not connected or is ambiguous (two Gmail mailboxes). `/v2` returns it as `integrations`.

An event trigger (meeting, deal, account or custom signal, ICP tier, HubSpot field) runs as soon as the
event happens: the agent never asks for a time, frequency or schedule for one, and the turn drops any
`ask` question about timing once the trigger is an event (set_trigger committed one, or the composer's
signal hint is one). Only a schedule job asks about timing, and only when the user did not say.

### The trigger is always settled with the user (GET-892)

The agent never defaults the trigger (it used to assume a daily schedule when nothing was picked).
When no signal was picked in the composer and the request neither names an event ("after every
meeting", "when we win a deal") nor says it runs on a schedule ("every morning", "weekly"), the agent
reads `signal_catalog` and either asks one multiple-choice question, "What should start this job?",
with the 2-4 most fitting starts in plain words ("When a Granola meeting ends", "When a deal is won",
"Every weekday morning"; its pick first, marked "(Recommended)") plus "Something else", or, when
one start clearly fits, sets it and says in one sentence which start it picked so the user can change it.

The server enforces it (`loop.mjs` `triggerGrounding`): a `propose_job` whose trigger the user never
grounded is refused back to the model with `TRIGGER_UNSETTLED`, a short instruction to ask. A
trigger is grounded by: the composer's picked signals (the hint in the transcript); the user's own
words naming every key (`signalMentioned`: their messages and answers, never the hint preamble or the
agent's question text); an answered question about what starts the job (`isTriggerQuestion`: it says
so, or 2+ of its options name a start), whatever they picked ("Something else" included); the job
being edited keeping its trigger kind; or the trigger of the proposal they were last shown. A hinted
signal skips the question; an event trigger still never asks for a time.

`Question`: `{ id, header (≤12 chars), question, multi: boolean, options: [{ label, description? }] }`.
The UI always also offers "Other" with free text. Answers are sent back as the next user message:
`{ "answers": [{ "id", "selected": [labels], "other"?: "text" }] }` (the server renders them into the
transcript as readable text).

## Request body and hints (composer pickers)

`POST /api/revboxes/:id/builder` (start) and `POST /api/revboxes/:id/builder/:sessionId` (continue):

```
{ "message": "…", "job_id"?: "…", "hints": { "integrations": ["granola", "hubspot"], "signals": ["meeting.done:granola"] } }
{ "answers": [ … ],                  "hints": { "integrations": [], "signals": [] } }
```

`hints` is sent with EVERY turn (start, message, answers) and reflects the composer's current state, so
the latest one wins; it may be absent from older clients.

- `integrations`: connection slugs the user attached from the Integrations menu (the slugs of
  `GET /api/revboxes/catalog` `connections`). They mean "this job involves these tools"; the agent
  should use them and say so if one cannot do what the job needs. They are not a whitelist.
- `signals` (older clients: `signal`): what the user picked in the Signals menu, catalog keys. A catalog key, `"schedule"` when the user picked
  "No signal (scheduled)" explicitly, or `null` / `[]` when nothing was picked (the agent settles the
  start with the user, above; never a default). A picked signal is authoritative: the proposal's trigger is
  `triggerForSignal(signal, catalog)` unless the user's words clearly contradict it, in which case the
  agent asks or emits a `trigger` event with its choice.

## Signal catalog (GET-862)

`packages/core/src/services/signalCatalog.mjs`, exported from `@nous/core`, is the single source of
truth. `signalCatalog({ custom })` -> `{ builtin, custom }`; `loadSignalCatalog(sb, workspaceId,
{ activeOnly })` loads a workspace's (non-archived) custom signals into it; `triggerForSignal(key,
catalog)` -> `{ kind, config }` (null for an unknown or archived key; no key = `{ kind: 'clock' }`);
`signalLabel(key, catalog)`. Entry: `{ key, label, description, group, providers?, needs_config?, trigger }`.

| Key | Trigger |
|---|---|
| `meeting.done` (any recorder), `meeting.done:granola` / `:fireflies` / `:fathom` | `call_ended`, config `{ provider, tools: [provider] }` for a named recorder (the runner reads `tools`) |
| `deal.won`, `deal.lost`, `deal.stage_changed` | `deal_closed_won`, `deal_closed_lost`, `deal_stage_changed` |
| `icp.tier_changed` | `icp_tier_changed` |
| `hubspot.field_changed` (needs_config: property) | `hubspot_field_changed` |
| `signal.<kind>` for every kind in `SIGNAL_LABEL` | `account_signal`, config `{ signals: [kind] }` |
| `custom.<key>` (workspace signal) | `account_signal`, config `{ signals: ['custom_<definition id>'] }` (the kind publishCustomSignal writes) |
| `schedule` | `clock` (the agent fills frequency/at/timezone) |

### Several signals on one job (GET-873)

A job can start on several signals (Deal won and Deal lost) and runs once per matching event, also
when one event matches two of them. No migration: `agent_routines.trigger_kind` is the primary kind
(the first key's), the other kinds ride in `trigger_config.also: [{ kind, config }]`, and
`trigger_config.signal_keys` keeps the catalog keys for display and round-trip.
`triggersForSignals(keys, catalog)` -> `{ trigger_kind, trigger_config }` merges keys of one kind
(two account signals = one `signals` list, two recorders = one `tools` list, plain `meeting.done`
wins); `signalKeysProblem` refuses unknown keys and a schedule combined with signals;
`signalsLabel` reads "When a deal is won or lost". Core `routineTriggers.mjs` is what every runner
uses (`listensToFilter` for the query, `triggerConfigsFor` / `accountSignalKinds` / `callRecorders` /
`beforeMeetingOffset` to decide); a clock never carries `also`. The builder's `set_trigger` takes
`{ signals: [keys] }` (or `{ signal }`), a proposal carries `trigger.signal_keys`, the `trigger` event
carries `signals` (with `signal` = the first), and `hints.signals` replaces `hints.signal` (still
accepted). The composer's Signals menu is multi-select; "On a schedule" is exclusive.

One conversation, one run: a job on a call (`call_ended`) AND on account signals would otherwise run
twice for one call, once when the call ends and once on the signals read from it. For such a job the
call's run claims the signal path's key for that account and conversation (core `callRunKey`:
`signalRunKey(job, account, "ref:" + the recording's source_ref)`, the `source://<recorder>/<id>` the
call's signals carry; the worker passes it as `call.sourceRef`), so whichever comes first is the one
run, and the signal path's per-account cooldown sees the call run too. A job on calls only keeps
`<job>:call:<meeting id>`.

Workspace signals live in Settings > Signals and `/api/signals` (catalog, list, create, edit/review,
archive, reprocess); they belong to the workspace, a RevBox only records where one was proposed.

### Only connected recorders (GET-892)

`GET /api/signals/catalog` narrows `meeting.done.providers` to the recorders the workspace has
connected (core `withConnectedRecorders(catalog, slugs)`: any member's connection counts, since a
meeting job fires on the workspace's calls), adds `recorders` (those) and `connected` (every
connected tool slug). Resolving a key (`triggerForSignal`) still uses the full catalog, so a job on
a recorder that was later disconnected keeps its trigger. The pickers (frontend `lib/signalOptions.ts`)
show one text row per connected recorder ("Meeting done · Granola") plus "Meeting done (any
recorder)", no provider logos; with none connected, the Meetings group is one muted line, "Connect
Granola, Fireflies or Fathom to use meeting signals", linking to Integrations. The New signal dialog
(Settings > Signals: Name, Description, Sources) offers only connected sources, plus any the signal
already reads.

### Custom signal extraction budget (GET-892)

`extractCustomSignals` (apps/api `revboxRuntime.mjs`, every minute) classifies at most
`CUSTOM_SIGNAL_TICK_BUDGET` (50) claims per tick and `CUSTOM_SIGNAL_WORKSPACE_BUDGET` (10) per
workspace, round-robin: one claim per workspace per pass, one per definition within a workspace, the
workspace order rotating every tick. The credit gate is per workspace, checked once per tick; a
workspace out of credits is skipped and the others go on. A definition's cursor moves only when every
readable claim it had was read.

## Proposal

```
{
  "name": "Credit Check daily summary",
  "summary": "Every morning at 08:00 Toronto time: read yesterday's Credit Check numbers per dealer from HubSpot, write the VP summary, post it to #credit-check-cs-handoff.",
  "trigger": { "kind": "clock", "config": { "frequency": "daily", "at": "08:00" }, "timezone": "America/Toronto", "label": "Every day at 08:00 (Toronto)" },
  "steps": [ WorkflowStep ],                 // exactly the agent_routines.steps format above
  "display": [ { "step_id": "read", "tool": "hubspot", "title": "Read Company Daily Stats", "detail": "5 Credit Check fields · per dealer · yesterday vs the day before" } ],
  "uses_box_delivery": true,                 // also deliver to the box's destinations at run time
  "box_delivery_format": "report",           // with uses_box_delivery: the Slack layout the box's Slack destinations get (never "approval")
  "warnings": [ { "kind": "missing_access"|"missing_connection"|"unverified"|"cost", "message": "…", "fix": { "label": "Reconnect HubSpot", "href": "/company-sources?connect=hubspot" } } ],
  "assumptions": [ "Weekends are reported as quiet days." ],
  "estimated_credits_per_run": 2
}
```

Server-side validation (`validateBuilderProposal`): `checkFlow` from `apps/api/src/lib/flows.mjs`
plus per-type readiness (port `stepReady` from `apps/frontend/src/lib/flows.ts` to the server):
known trigger kind with a runner; every `hubspot` read has object + fields; every `slack` step has a
`channel_id` that exists in `slackTargets`; every `gmail` step has a mailbox; `{{steps.X.output}}`
references point at earlier steps; `display` covers every step.

## The job card (GET-884)

A job reads as an agent at work, not a workflow: no step tiles. Every place a job card shows (the
builder's proposal, an approved card, a job's chat) is `WorkflowCard`. Since GET-889 it is three lines,
a thin border and little padding (light and dark):

```
Credit Check daily report                                                       ● On
Every morning I read yesterday's Company Daily Stats in HubSpot, write the credit check report and post it to #ops-daily.
Every day 08:00 (Toronto) · [HubSpot][Slack] → #ops-daily · asks first        (asks first: only with an approval step)
                                       ~2 credits / run   [Make changes] [Approve]   (a live proposal only)
[ Ask the agent to change something…  ↑ ]        (the composer, in a job's chat)
```

- **The sentence is the server's**, never the model's: `proposal.brief = { text, starts, asks_first }`,
  built by core `jobBrief(proposal, facts)` (`packages/core/src/db/revboxJobBrief.mjs`) from the
  trigger's kind and config, each step's type and config, and the facts (`proposalFacts`). The model's
  `summary`, `display` titles and prompts never reach it; `normalizeProposal` drops any `brief` the model
  sends. `validateBuilderProposal` returns it beside `facts` (the turn puts both on the proposal),
  `approveBuilderProposal` stores it, `withBrief` adds it to Edit's history, approve and the transcript
  strip it like `facts`.
- Rules: `<when> I <clauses joined "a, b and c">[, but only if <only_if rule>].` When: a schedule says
  "Every morning|afternoon|evening" (by `at`), "Every weekday morning", "Every Monday morning", "On the
  first of each month", "At the start of each quarter" (no comma); an event says "When a deal is won,"
  / "When a deal is won or lost," (won + lost merge) / "When a Granola meeting ends," / "When an account
  shows churn risk," / "When Deal stage changes to X on a HubSpot deal," / "When your renewal risk signal
  fires," (several joined with "or"); "An hour before each meeting,"; manual "When you run me,".
  Clauses per step: HubSpot read "read yesterday's <object label> in HubSpot"; AI step "write <the job's
  name, cadence words dropped, when it ends in a document noun (report, summary, digest, brief, analysis…)>",
  else by trigger or what follows ("a win/loss analysis", "the follow-up email", "a summary of the
  meeting", "the report" for a Report layout, "an update"); a built-in job its own verb ("draft the
  follow-up email"); Slack "post it to #<channel the server found>" (else "Slack"), DM "send it to
  <person> in Slack"; Gmail draft "draft it in Gmail to <recipients>"; email "email it to …"; webhook
  "send it to <host>"; "add a row to <table>"; "read last month's rows of <table>"; HubSpot note/task/update;
  box delivery "send it to this box's destinations". Approval steps set `asks_first` (the card's note).
- The meta line (frontend `lib/jobCard.ts` `jobMeta` / `jobMetaText`, from steps, facts and the box's
  destinations): when it starts, `brief.starts` ("Every day 08:00 (Toronto)", "Deal won or lost",
  "Meeting done · Granola"); the logos of the recorder, the steps' tools and the box's destination kinds;
  "→" each target without its Slack layout: "#channel" (a channel the server did not find shows its id,
  flagged), "Gmail draft · to … · from …", "Email · to …", "Webhook to <host>", "A row in <table>",
  HubSpot writes ("(writes)"), the box's destinations; "In the app" when it sends nowhere; "· asks
  first" with an approval step. What leaves the workspace is never cut short. `jobMetaText` is its
  screen-reader text ("Every day 08:00 (Toronto) · HubSpot, Slack → #ops-daily"). The approved state is
  a small "● On"/"● Off" dot (a job's chat) or a quiet "Approved"; the cost per run sits beside a live
  proposal's actions.
- Run logs (Results) keep step detail; the agent step's name is "Agent · Write-up" (core `stepName`).

## Engine integration (GET-868 part 2)

- Migration: `agent_routines.revbox_id uuid null` (FK to `revboxes(id, workspace_id)`, cascade),
  index; `revbox_builder_sessions`.
- Approve creates/updates the `agent_routines` row: `steps`, `trigger_kind`, `trigger_config`,
  `timezone`, `name`, legacy columns via `scheduleColumns`/`destinationColumns`, `revbox_id`, and
  `enabled: true` for a new job, and for an Edit the job's current `enabled` (a paused job stays
  paused), after the enable endpoint's checks when it will be on: a trigger kind with a runner (core),
  the credit gate and the plan's automation limit (`enableCheck`, passed by the Cloud builder; an
  existing job is counted with `excludeId`, as the enable endpoint does).
  A failed check still saves the job, off, and approve returns `{ routine, enabled: false, reason }`.
  A clock job gets `next_run_at` from `nextRunAt` (the routine runner's scheduler); enabling through
  the switch computes it the same way. The approved session is linked to the job (`job_id`).
  Versioning stays the automation versioning.
- RevBox **Jobs** list = the box's `agent_routines` (plus legacy `revbox_jobs` until removed). Each
  row: an On/Off switch (pause) and a hover Test; clicking the row opens the job's chat (GET-889; no
  Edit button). The run endpoint still exists for the API; the UI no longer offers Run now.
- Run time, for a routine with `revbox_id`:
  - every `agent` step gets the box context (objective, blocks, context docs' text) prepended to its
    instructions, so context added later changes behaviour;
  - when the proposal had `uses_box_delivery`, the flow ends with a `revbox_delivery` step that, at run
    time, posts the latest AI output to every current box destination, so a destination added later
    applies to its jobs. Destinations (`revboxes.delivery`, `{ id, kind, target, ... }`):
    `slack` (target: the channel id picked from `/api/slack/targets`, `channel`: its name; older ones
    hold a name in target), `webhook` (target: https URL, through `safe_fetch`), `email` (`to` and
    `cc`: "a@x, b@y", with target mirroring `to`; sent from OpenNous, every To on To and the Cc on Cc;
    an older destination with recipients only is first To, the rest Cc), `gmail` (target: mailbox id,
    `to`, `cc`; a Gmail DRAFT through `gmail_draft` as the job's owner, never sent). The UI offers
    three cards: Slack, Email (Send = `email`, Draft = `gmail` with an Inbox picker) and Custom webhook. A Gmail destination's mailbox must be one of the saver's own
    (`sendableMailboxes`); the API sets its `mailbox_email`. With `uses_box_delivery`,
    `validateBuilderProposal` refuses an explicit slack step to a destination's channel and a
    gmail/email step to a destination's recipient (it would arrive twice).
  - the Slack layout a box Slack destination posts in is the job's, not the destination's (GET-872,
    core `boxSlackFormat`): an older destination's own `format` (still read, no longer written), else
    the delivery step's `config.format` (approve copies the proposal's `box_delivery_format` there),
    else the job's own Slack step's format, else `report` for a clock job and `notification` for an
    event job. Never `approval`. The destination dialog asks only the Slack workspace (read-only,
    `team` from `/api/slack/targets` via team.info) and the channel.
- `GET /api/revboxes/:id` also returns `job_deliveries: [{ job_id, job_name, step_id, step_type, editable, kind, label, target, channel_id?, channel?, to?, cc?, mailbox_id? }]`:
  where the box's jobs deliver on their own, derived server-side from the routines' real steps
  (`revboxJobDeliveries` / `listRevboxJobDeliveries`, same access as the box). The rail lists them
  ("via <job>") under the box's own, removable destinations; clicking one edits that step's target in
  place: `PUT /api/revboxes/:id/jobs/:jobId/steps/:stepId/target` (box edit rights; slack `{ kind,
  channel_id }` checked against slackTargets, gmail/email `{ kind, to, cc, mailbox_id? }` up to 20,
  the caller's own mailbox, webhook `{ kind, url }` https and a public host). The kind never changes
  there; the routine is saved with `edited_by` and the database versions it (automation_versions).
  -> `{ job_deliveries }`. A DM or SMTP step (`editable: false`) is changed in the chat.
- It also returns (GET-872) `people` (owner and members with `avatar_url` from users.profile_picture_url)
  and `builtin_jobs` / `builtin_taken` (below).
- **The rail's Accounts card** (GET-873, GET-891) reads "Accounts · N" with a muted "S selected · W
  worked on by its agents in 30 days". N = `GET /:id/accounts` `count` (also `accounts_count`, with
  `accounts_breakdown: { selected, worked_on }`, `days`, and `names: { matched, unmatched, ambiguous }`):
  core `revboxWorkedAccounts`, the union, deduped, viewer-visible only (`viewerVisibleAccountSet`), of
  - the box's selected scope (`revboxScopedAccounts`: selected ids, or the saved filter);
  - the accounts its jobs worked on in the last 30 days (`revboxRunAccounts`): a run's `entity_id`, the
    account ids a step logged (`step_log[].accounts`), its output documents (`document_id` on the run
    or on an AI step's log line) with their `subject_entity_id` and `about`/`mentions` links, and a
    legacy run's `account_ids`; a person or deal counts for its company;
  - the accounts on its tables' rows added in that window (`revbox_dataset_rows.entity_id`, a deal as
    its company).
  **Named accounts.** A HubSpot Read step grouped by a name (`group_by` other than `hs_object_id`, e.g.
  a company-name property) and an AI step's output name accounts in words. Since GET-891 a box job
  resolves them at run time (core `accountNamesInText` + `resolveAccountNames`) and logs the ids on
  the step's line: `accounts`, plus `accounts_unmatched` / `accounts_ambiguous` counts. Names are read
  from structured places only: the read's grouped rows, the first cell of each table row in the output
  (past its header; "Total" and "Record N (no name)" are not names), **bold** names, and a title's lead
  before " — " ("Harborline Supply — closed lost"). Matching is exact on the normalized name (case,
  punctuation and a trailing Inc/Ltd/LLC/Corp/Co/Limited set aside); a name no account has is skipped
  and counted, a name two accounts share is ambiguous and skipped, nothing fuzzier. Runs from before
  GET-891 recorded nothing: on read, the newest 30 output documents in the window that have no entity
  links and whose step logged no accounts are parsed the same way.
  **Worked out once per run** (GET-896). The first read after a run has finished (status ok, error,
  skipped or rejected) keeps what it touched on the run, `agent_routine_runs.state.accounts_resolved =
  { v: 1, at, entities: [entity ids], names: { matched, unmatched, ambiguous: [normalized names] } }`,
  and every later read takes it from there: no document reads, no name lookups. A run still going is
  worked out live on each read and kept once it finishes. A run is kept only when complete (none of its
  documents waited behind the 30-document cap), so a box with more than 30 such documents counts the
  older ones over its next reads. Entity ids are kept, not accounts: a person or deal still counts for
  its current company, a deleted entity drops out, and the viewer filter is applied on every read.
  The reads that need only the box id go out together with its access check (`loadRevbox` reads
  membership, box and members at once); nothing is read from documents or kept unless it passes.
  `?scope=selected` returns the scope alone. The card's two links open on the same set:
  `/accounts?revbox=<id>` (`GET /api/companies/list?revbox=<id>`, `&revbox_scope=selected` for the
  scope alone; returns `revbox: { id, name }` for the "RevBox: <name> ×" chip) and `/graph?revbox=<id>`
  (`GET /:id/graph`, those accounts with their people and deals; `?scope=selected` the scope alone).
  `GET /:id/graph?source=runs` still graphs only the accounts in the box's recent runs (`revboxRunAccounts`).
- **Test** (GET-873): `POST /api/revboxes/:id/jobs/:jobId/test` (box edit rights, credit gate) runs a
  routine job once now on real data via core `startTestRun(..., { holdSends: true })`: read and AI
  steps run and are metered as a normal run; every Slack post, email, Gmail draft or send, webhook,
  HubSpot write and box delivery is HELD (runSteps' `ctx.holdSends`): its log line is status `held`
  with "Would post to #channel" / "Would draft to x@…" and its preview rows, and nothing waits for
  approval. The run's state is `{ test: true, held: true }`; Results rows carry `test`, `held` and
  `held_actions: [{ step, text, rows }]` and show a "Test" tag. A scheduled run's output is its AI
  step's document (from the step log when the run row has none).
  Add to table is held too, in this Test AND in every other test run (the box's Run now and the
  automations editor's test, `ctx.test`, which still send for real): the row is shaped (one metered
  call when needed) and shown as "Would add a row to <table>" with its "Label: value" preview rows,
  and nothing is inserted, so a test row never takes the dedupe key the real event needs and never
  shows up in a report or the Results table.
  What a Test runs on: the newest real event across EVERY trigger of the job, its primary and its
  `trigger_config.also` ones (core `latestTestTrigger`): the latest call from its recorders, the latest
  matching account signal, or the latest closed deal (won and/or lost as its triggers say; on an
  account; visible to the job's owner through `revbox_visible_accounts`, none without it; one per
  account and outcome). A deal Test runs on that deal like the daily pass (stage `closed_won` /
  `closed_lost`, the deal id in the run). `testTriggers` lists closed deals for a deal-primary job
  (ids `deal:<account>:<won|lost>`).
- Results tab shows the routine runs (`agent_routine_runs`) for the box's jobs, with credits, as a
  compact list; a failed run carries `failure: { text, fix }` (the failed step's words, with Connect
  or Reconnect to /integrations for a connection). `POST /:id/results/:runId/decide { approve }`
  approves or denies a routine run waiting at its approval step (box edit rights).
- Built-in jobs (GET-872): `revboxes.builtin_jobs text[]` (migration
  `2026_10_14_revbox_builtin_jobs.sql`) lists OpenNous's default automations (`sales_follow_up`,
  `stale_deal`, `deal_signals`, `deal_risk`, `expansion`; core `REVBOX_BUILTIN_JOBS`) on a box, each in
  at most one box per workspace (a 409 on save names the other box when the saver can open it).
  Listing one changes nothing about how it runs. The detail returns each with `drafts_30d` and
  `last_draft_at` (follow_ups for the after-call follow-up; ri_recommendations category
  'automation', rec_key automation.<detector> for the rest). Without the column it is empty.
- Built-in jobs as RevBox jobs (GET-897):
  - Card. Each built-in in a box's Jobs list is an agent card like a builder job's: name, a small
    "Built in" tag, the workspace's real On/Off (read-only: the after-call follow-up runs where
    `follow_up_settings.enabled`, the detectors where `DETECTOR_DRAFTS_WORKSPACES` lists the
    workspace; neither is a per-box switch), one sentence in the agent's voice, one meta line
    (Starts · tool logos → Priorities) and "N in the last 30 days · last …" opening Priorities. The
    sentence, Starts, tools and details are core `builtinJobBrief(key, facts)` (pure, in
    `revboxJobBrief.mjs`), from what each built-in really does and the workspace facts the API reads
    (`builtinFacts`: connected recorders among Granola, Fireflies, Fathom and Fellow; HubSpot when
    approved follow-ups sync, `follow_up_settings.crm_writeback`). The after-call follow-up names the
    connected recorders ("When a Fireflies meeting with a customer ends, I draft the follow-up email
    and propose the tasks and the CRM updates from what was said; you approve each one in
    Priorities."). Clicking a card opens a read-only panel (no builder chat) with its details and a
    link to its items. There is no remove control on the card. (Superseded by GET-902 below: the
    card is a job's card and opens the job chat.)
  - Default boxes. A Workspace-plan workspace has every built-in in a box: "Meetings Follow-up"
    (`sales_follow_up`), "Pipeline Health" (`stale_deal`, `deal_risk`, `deal_signals`), "Customer
    Growth" (`expansion`); core `DEFAULT_BUILTIN_BOXES`, `planDefaultBuiltinBoxes` (pure) and
    `ensureDefaultBuiltinBoxes`. Ensured on read: `GET /api/revboxes` (the sidebar's list) runs it for a
    Workspace-plan workspace at most once per 10 minutes per workspace and process
    (`ensureBuiltinBoxesForPlan`), so a new workspace, a plan change, or a box that lost its built-in
    is put right on the next load, with no provisioning hook to keep in step. A built-in already in any
    box stays there; one in none goes to the oldest box with its default name (any case), else a new
    shared box owned by the workspace owner (else its first admin; support seats last). Idempotent;
    two concurrent passes keep the box made first and delete the later one. One-off backfill for the
    operator: `node apps/api/scripts/backfillBuiltinBoxes.mjs [--workspace=<id>] [--apply]` (dry run by
    default).
  - Changing a box's built-ins. `PATCH /:id` takes `builtin_add` / `builtin_remove` (operations the
    server applies to the box as stored, `applyBuiltinOps`); `builtin_jobs` (the whole list) is still
    accepted for older clients, not with the operations. The page sends `builtin_add` only. Root cause
    of a built-in falling out of its box: the page sent its own copy of the whole list
    (`detail.builtin_jobs`, which the autosave never refreshes and the query cache keeps without
    refetching on mount or focus) with the box's latest revision from the autosave, so the revision
    check passed while the list was stale; and the card's remove control was an X that stayed
    clickable while invisible (opacity 0 until hover), with no confirmation.
  - Priorities. `GET /api/revboxes/builtins` -> `{ homes: [{ key, box_id, box_name }] }` (name null
    for a box the viewer cannot open). An item a built-in made shows its box as a small chip linking to
    the box: a meeting's wrap-up is `sales_follow_up`'s; a detector draft's origin carries `builtin`
    (lib/actionOrigin `REC_BUILTIN`, from rec_key).
  - Any recorder. The follow-up engine (worker `followUpBuilder`) reads a Granola, Fireflies or Fathom
    meeting as one meeting (core `meetingIdentity`: the recorder's meeting id, not one per attendee row)
    and its notes from the recorder's `meeting_notes` document by `source_ref`
    (`source://<recorder>/<id>`, `recorderNotes`). Before, those rows carried no text, so only Fellow
    and HubSpot meetings ever got a card.

## Datasets (GET-874)

A dataset is a table a box's jobs keep. Reference case, "Closed won/lost analysis": job 1, on a deal
won or lost, analyses the deal against the box's context (an uploaded ICP file) and adds one row; job 2,
monthly, reads last month's rows and writes the win/loss report (a run document, opened in Results;
Slack through box delivery, optional); job 3, quarterly, reads the quarter's rows and writes the review.

- Migration `2026_10_14_revbox_datasets.sql`: `revbox_datasets(id, workspace_id, revbox_id, key, name,
  description, columns, created_by, created_at, updated_at)`, key unique per box (`^[a-z][a-z0-9_]{0,62}$`),
  FK (revbox_id, workspace_id) -> revboxes cascade; `revbox_dataset_rows(id, dataset_id, workspace_id, data,
  entity_id, source_run_id, source_job_id, dedupe_key, created_at)`, UNIQUE(dataset_id, dedupe_key) (NULLs
  never collide), index (dataset_id, created_at desc, id desc). Service role only.
- Columns: ordered `[{ key, label, type: text|number|date|boolean|enum, options?, description? }]`, 1-30,
  keys slugged and unique, an enum has 1-50 options. Core `normalizeDatasetColumns`.
- Core (`@nous/core`): `db/revboxDatasets.mjs` (`createRevboxDataset`, `updateRevboxDataset`,
  `getRevboxDataset`, `listRevboxDatasets`, `listDatasetRows`, `exportDatasetCsv`, `appendDatasetRow`,
  `readDatasetRowsForRun`, `datasetForBox`, `visibleDatasetRows`) and `services/datasetFormats.mjs` (pure:
  columns, coercion, the AI row instruction and parse, windows, the compact table, CSV).
- Access: the box's. Any member who can open it reads; owner or editor creates and changes (a key never
  changes: jobs read it by key; a removed column stops showing, rows keep their data). A row whose
  `entity_id` is an account, person or deal the viewer cannot see is hidden (`viewerVisibleAccountSet`, a
  deal counts as its company); counts, pages and the CSV follow the same rule.

### Deal jobs: one run per deal (GET-881)

The daily deal pass (core `runAutomationsForWorkspace`, worker `runAutomationDailyPoll`) reads closes
from `deal_outcomes`, one entry per deal and outcome (a ledger row with no `deal_id` is one per account
and outcome). Run keys (`agent_routine_runs.dedupe_key`), permanent:
- a job that listens to the close's outcome (`deal_closed_won` / `deal_closed_lost`, primary or `also`):
  `<job>:deal:<deal id>:<closed_won|closed_lost>`, so an account's second won or lost deal runs too,
  and one close runs a won+lost(+stage-move) job once;
- a close with no deal id, a stage move, and a close that reaches a job only through
  `deal_stage_changed`: `<job>:<account>:<stage>`, as before. The same close read off the account's
  stage history does not run a job that listens to the outcome (the ledger row does).
- Jobs from before per-deal keys: an old `<job>:<account>:<stage>` run counts as covering every deal on
  that account and outcome that closed before the run started; only later closes run. A second deal
  the old key hid is not back-filled (a Test can still write it up).
- A deal that closed before the job was created is skipped, as before.

Limits per pass (`DEAL_PASS_LIMITS`): 20 runs per job, 50 per workspace (was 5 for the whole
workspace); a pass that hits one stops, logs it, and the next pass carries on oldest-first. Before each
run the pass asks the `credit_gate` step handler (the worker registers its cached, fail-open
`mayReadWorkspace`); a "no" stops the pass for that workspace. A Test (`onlyAutomation`) skips the
dedupe, the limits and the gate, as before.

The AI step's `deal` is the deal that fired the run (by id), with `name`, `stage`, `pipeline`, `amount`
+ `currency`, `crm_close_date`, `owner` (the deal entity's claims) and `stage_history` (its `stage`
observations, repeats folded, last 20); `other_deals_on_record` carry their names. The hourly deal
events (`emitDealEventsPoll`: webhooks and `revbox_events`) read the same per-deal list; their keys
were already `<deal id>:<stage>`.

### Steps (workflow engine, RevBox jobs only; `INTERNAL_STEP_TYPES`, never on `/v2/workflows`)

- `dataset_append` `{ dataset_key, dedupe_from?: 'deal'|'account'|'none' }`: the previous AI step's output
  as one row. An AI step written in the run (a digest) gets `datasetRowInstruction` (the row's JSON
  shape, `{ row, summary }`) as its output instruction, like a Slack layout, and its document keeps the
  summary and "Label: value" lines. Words not written as JSON (a deal's account brief from the event
  runner) are shaped by one metered call (`automation-run:<run>:dataset:<step id>`; History counts it in the
  run's credits, on that step when the run's step log names it, GET-881). Values are coerced to the
  column types; unknown keys dropped. `entity_id` = the event's deal, else its account; source run and job
  recorded. Dedupe (default `deal`): `deal` keys by the deal only when the run has one,
  `deal:<deal id>:<stage>`; a deal run with no deal id (a close read from the stage history) keys
  `account:<id>:<stage>`; any other run keys by its event (core `datasetEventKey`): `call:<meeting id>`,
  `signal:<signal id>:<conversation>` (a field change's id names the record, field and moment), else
  `run:<run id>`, so a "log every call" table keeps every call. `account` = `account:<id>`; `none` = no key.
  A test run never adds a row (see Test).
- `dataset_read` `{ dataset_key, window: last_7_days|last_30_days|last_month|last_quarter|all, limit (≤500, 200) }`:
  the rows added in the window (calendar months and quarters in UTC), as the job's owner sees them
  (`revbox_visible_accounts`; without it rows about accounts are left out), as a compact table in the step
  data (the next AI step reads it; also `{{steps.<id>.output}}`). It is a Read step: the AI step after it
  writes in the run.
  The table text is capped at `DATASET_READ_CHARS` (85,000 characters, GET-883: about 410 rows of a
  ten-column win/loss table, a busy quarter), under the AI step's 100,000-character material limit; past
  it the table ends with "N more rows not shown".
- Both stop with words when the routine is not a box job, the key is unset, or the box has no such dataset.

### API (box access as above; key = the dataset key)

```
GET  /api/revboxes/:id/datasets                      -> { datasets: [Dataset & { row_count, row_count_capped, last_added_at }] }
POST /api/revboxes/:id/datasets   { name, columns, key?, description? }  -> 201 { dataset }   (editors; 409 on a taken key)
PUT  /api/revboxes/:id/datasets/:key   { name?, description?, columns? } -> { dataset }      (editors)
GET  /api/revboxes/:id/datasets/:key/rows?cursor=&limit=(≤200)&window=&from=&to=&q=  -> { dataset, rows: [{ id, data, entity_id, source_run_id, source_job_id, created_at }], next_cursor }
GET  /api/revboxes/:id/datasets/:key/export.csv?window=&q=   -> text/csv (≤10,000 rows; the columns, Added, Source run)
```

Rows come newest first; `q` keeps rows where every word appears in a value. The Results tab has a Runs |
Datasets segment: each dataset as a row (name, rows, last added), opening a table (sticky header, typed
values, search, Load more, Export CSV), each row linking to the run that added it.

### Builder integration (GET-874 follow-up)

One chat in a "Closed won/lost analysis" box sets up all three jobs of the reference case.

- Tool `revbox_datasets` (read-only): the box's tables, key, name, description, columns, row count (the
  rows the person sees), through `listRevboxDatasets`. The prompt has the agent call it before a job that
  adds to or reads a table, and use an existing table by its key.
- Proposal fields: `datasets: [{ key?, name, description?, columns }]` (at most 5) is the tables this job
  needs that the box does not have; a missing key is the name slugged. `next_jobs: [name]` (at most 5,
  120 chars each) is the jobs still to set up in this chat after this one.
- `validateBuilderProposal` takes `datasets` (the box's tables, `[{ key, name }]`; null = shape only)
  and returns the checked `datasets` (`{ key, name, description, columns, exists }`). It accepts
  `dataset_append` (`dedupe_from` deal|account|none) and `dataset_read` (a window from `DATASET_WINDOWS`,
  `limit` 1-500): a well-formed key that the box has or the proposal creates; an AI step somewhere before
  an append, and after a read; `{{steps.<read>.output}}` is allowed (a read writes the table). Proposed
  columns go through `normalizeDatasetColumns`; a key proposed twice is refused.
- Facts (server-built, never from `display`): `dataset_append` -> `{ action: 'append', dataset_key,
  dataset (name), new_dataset, dedupe_from, target: 'Add a row to the table "Win/loss deals"
  (win_loss_deals, new), one per deal' }`; `dataset_read` -> `{ action: 'read', ..., window, target }`.
  The table's name is the box's own, or the one the proposal creates under that key. Display tools are
  `dataset_append` / `dataset_read` (or `dataset`); another tool on a table step is refused.
- The card (WorkflowCard, GET-884): the brief says "add a row to <table>" / "read last month's rows of
  <table>" with the table's name from the fact; Delivers lists "A row in <table>" (" (new table)" for one
  this approval creates). A proposal with `next_jobs` shows one muted line "Then in this chat: Monthly … · Quarterly …".
- Approve (core `approveBuilderProposal`) reads the box's tables itself, validates with them, claims the
  session, creates every proposed table that the box does not have with `createRevboxDataset` (explicit
  key), THEN writes the routine, so each step's `dataset_key` resolves. A key the box has is reused as it
  is (name and columns never change; a 409 race is a reuse too). It returns `datasets: [{ key, name,
  created }]`. A failure reopens the session as before; a table already created stays (the next approval
  reuses it).
- Edit of a job made outside the builder (`proposalFromRoutine`) names table steps from their type and key.

#### Chaining several jobs in one chat

Design: **approve continues the chat in a new session**. When the approved proposal has `next_jobs`,
core `approveBuilderProposal` also inserts a new open session for the same person on the same box,
`job_id` null, seeded with this chat's transcript (same person, same moment, so the transcript is
carried as it is) whose last `propose_job` is answered with `chainedNote` ("The user approved this
proposal; it is now a live job. It is saved as … The box has these tables now: win_loss_deals (…) …
Jobs still to set up in this chat: … Set up the next one as a NEW job …"). Approve returns
`next_session_id` and `next_jobs` (both doors: `approveBody` and `/v2` pass them, with `datasets`). The
approved session stays the first job's (its Edit chat); the next proposal approves into a new routine, and
that session becomes the second job's Edit chat. `builderSessionHistory` shows an earlier job answered with
the chained note as approved, and `sanitizeBuilderTranscript` keeps that note. If inserting the session
fails, the approval still stands and nothing chains.

Why this and not one session making several jobs: a session is one job everywhere else (approve links
`job_id`, Edit reopens "the chat that made it", approve's claim makes a double click one job). A follow-on
session keeps all of that true with no migration and no new route, and the model keeps the whole
conversation (and the prompt cache prefix).

The app (JobBuilder): when approve answers `next_session_id`, the card turns Approved, the page refreshes
its jobs without closing the builder (`onSaved`), the composer's signal chips are cleared (the next job,
a report, is on a schedule, not on the first job's deal signals), and the chat sends "Approved. Now set up
the next job: <name>." to the new session itself. That turn is an ordinary builder turn: gated and
metered like any other. Without `next_session_id` approve closes the builder as before. Over `/v2`, the
client posts its next message with `session_id: next_session_id`.

The prompt: "add a row to a table / keep a log of closed deals / track every won and lost deal" means a
`dataset_append` after the AI step that writes the row (`revbox_datasets` first; a new table only when none
fits); a report "from that table" is a schedule job with `dataset_read` (last_month monthly, last_quarter
quarterly) and an AI step; several jobs in one request are proposed one at a time, the first (the one that
creates the table) listing the rest in `next_jobs`. Event triggers still never ask for a time.

Preview (`apps/frontend/preview/revboxes.mjs`, script `winloss`): "analyse every closed deal into a table,
then monthly and quarterly reports" reads the tables, starts on Deal won + Deal lost, proposes the analysis
job (with the table when the box has none, reusing it in the seeded "Closed won/lost analysis" box), and
each approval answers `next_session_id`, whose session proposes the monthly report, then the quarterly one.

## Built-in jobs behave as jobs (GET-902)

For every box that holds built-ins ("Meetings Follow-up", "Pipeline Health", "Customer Growth", or any
box a built-in was added to), a built-in looks and behaves exactly like a builder job.

- **The row.** In the Jobs list a built-in is the same compact row as a routine job: the dot, the
  name, "Starts · On · Last run …" (its last draft; `lib/builtinJobs` `builtinRowMeta`). No Test
  (OpenNous runs it) and no switch on the row (its On/Off is the workspace's; the chat changes it
  where allowed). No "Built in" tag; what it did lately ("43 in the last 30 days · last 18m ago") is
  the row's tooltip (`builtinTooltip`). The read-only panel is gone.
- **The card** (`RevBoxJobs.tsx` `BuiltinCard`, WorkflowCard's approved form: the name with ● On/Off,
  the server's sentence, core `builtinJobBrief`, and ONE meta line `Starts · tool logos → Priorities`)
  shows inside the job chat, as the agent's first message.
- **The chat.** Clicking the row opens the job chat (`JobBuilder` with `builtin`), as a job's row
  does. `POST /api/revboxes/:id/builder { builtin: key }` (no message) answers 201
  `{ session_id, builtin, history }`: the person's open chat on that built-in in this box (reused), or
  a new session seeded with its card (core `openBuilderSessionForBuiltin`, `builtinSeedTranscript`:
  the composer's context naming it with `[builtin:<key>]`, then the agent's first reply, the brief).
  `history` starts with `{ kind: 'builtin', key }`, drawn as the card from the box's own copy.
  `{ builtin, message }` opens it and runs the turn at once; 404 when the box does not list it.
- **Never a routine.** The session has `job_id` null, so approving a proposal in it can only create
  a NEW job in the box. The loop recognises the chat from its seed (core `builtinOfTranscript`) and
  loads the built-in as it is now (`helpers.builtinInfo`: its brief with the workspace's facts, its
  On/Off, who may switch it, the box's Email voice file, ensured). The system prompt gets a section
  (`prompt.mjs` `builtinSection`): it is not a workflow, never call propose_job to change it; what can
  change and how; for anything it cannot do (post to Slack, another trigger, a report), say so in one
  sentence and offer a custom job in this box, built the normal way if they agree. The composer's
  "no trigger picked" note is left out of these chats unless something was attached.
- **builtin_job** (only in a built-in's chat, `tools.mjs` `BUILTIN_TOOL`, `runBuiltinTool`):
  - `status`: what it does, how, when it starts, On/Off, whether it can be switched here, its email voice.
  - `switch { enabled }`: only the after-call follow-up (`follow_up_settings.enabled`, a workspace
    switch), only for a workspace owner or admin. The detectors are switched by OpenNous
    (`DETECTOR_DRAFTS_WORKSPACES`): the tool says so and changes nothing.
  - `set_email_voice { text }`: the WHOLE new voice, saved to the box's "Email voice" file with the
    person's own rights (core `updateContextFile`). See CONTEXT_LIBRARY.md "The Email voice file".
  A change emits `{ type: 'builtin', key, enabled? | email_voice? }`; the page refreshes the box.
- **Accounts.** The box's Accounts card, the Accounts page filter and the graph count the accounts
  its built-ins worked on in the window (core `revboxBuiltinEntityIds` inside `revboxWorkedAccounts`):
  `follow_ups.account_entity_id` created in the window, and the detectors' ledger rows
  (`ri_recommendations`, category `automation`, their `rec_key`, updated in the window: an account, or
  a deal as its company; only uuid targets). Ids only, from at most two indexed reads, after the
  box's own access check; the viewer's visibility filter is applied as for runs. Nothing to cache:
  no documents are read and no names resolved.
- **Delivery.** A box with built-ins shows "Priorities · drafts you approve" in its Delivery card
  (`lib/builtinJobs` `prioritiesDestination`, `DeliveryList` `priorities`), like its other
  destinations, opening Priorities; it has no remove control. "No destinations yet" only shows for a
  box with no destination, job target or built-in.
- Tests: core `builtinJobsAsJobs.test.mjs`; api `src/cloud/tests/jobBuilderBuiltin.test.mjs` (the
  scripted model), `tests/revboxBuiltinVoice.test.mjs`, `tests/detectorDrafts.test.mjs`; worker
  `tests/followUpEmailVoice.test.mjs`; frontend `tests/builtinJobs.test.ts`.
- Preview (`apps/frontend/preview/revboxes.mjs`): the built-in boxes count their built-ins' accounts,
  get their Email voice file on read, and a built-in's chat is scripted: "more concise / formal /
  relaxed" rewrites the voice file, "switch it off / on" switches the follow-up (a detector says
  OpenNous switches it), "post it to Slack" offers a custom job and "yes" builds it the normal way,
  anything else explains the built-in.

## Workspace plan rollout (GET-864)

RevBoxes are on for the API **and** Workspace plans (feature flag in `apps/api/src/lib/plans.mjs`,
the same `revboxes` feature). The sidebar shows the RevBoxes section on both. On Workspace the
builder chat is the job-scoped chat: **Edit** on a job reopens the chat that made it.
Workspace keeps its other navigation unchanged.

## Public API (GET-868 part 4)

`POST /v2/revboxes/:id/jobs/builder` with an API key: body `{ session_id?, message | answers }`,
returns JSON `{ session_id, events: [...], state: 'asking'|'proposed'|'text', questions?, proposal? }`
(non-streaming, same events). `POST /v2/revboxes/:id/jobs/builder/:sessionId/approve`. Same access,
credits and validation. `GET /v2/revboxes` and `GET /v2/revboxes/:id` to find boxes.

## Slack layouts (GET-858)

Every Slack step picks a Block Kit layout in `config.format`: `report` (a recurring summary),
`approval` (a human decision), `alert` (a threshold or risk trigger), `handoff` (closed-won to CS),
`digest` (a list of accounts or signals), `notification` (one event), or `plain` (today's mrkdwn
text; also what no format means). The builder chooses it from the job's output and asks, with each
layout's description as an option, when two fit; an unknown format is refused back to the model, and
the card reads "#channel · Report layout". A box destination can carry its own `format` too
(`revbox_delivery` reads `d.format`, then the step's `config.format`; never `approval` there).

- Core (`packages/core/src/services/slackFormats.mjs`): the formats, the JSON each layout expects
  (`slackFormatInstruction`), `parseSlackContent` and a plain-text version. The AI step before a
  formatted Slack step writes that JSON (writeDigest); words that are not JSON for the layout (an
  account brief, a resumed run, custom text) are shaped by one metered call in the Slack step; if
  that fails too the message posts as plain text. The `slack` handler gets `{ text, format, content,
  runId, stepId, revboxId, accountId }` (the worker forwards them through /internal/automation-steps/slack).
- Cloud (`apps/api/src/cloud/lib/slackBlocks.mjs`): one pure template per layout -> `{ blocks, text }`,
  within Slack's limits (50 blocks, 3000 per text, 10 fields); the poster retries without `markdown`
  blocks, then as plain text, when Slack refuses the blocks.
- An `approval` layout gates every send after it (like an Approval step). The card posts only when the
  run actually pauses, and what it lists comes from the pause itself (`st.bundle`): every pending
  action with its recipients, channel, webhook host or HubSpot write. The model's words appear only
  under "Summary (AI-written)"; the header ("Approval needed") and the buttons ("Approve" / "Deny")
  are fixed. No buttons when there are more than 12 actions: decide in OpenNous.
- Buttons carry a pause token, `revbox_approve:<runId>:<stepId>:<index>.<nonce>`, stored in
  `run.state.slack_card`; a click from a stale card (an earlier pause) is refused. `/slack/interactions`
  continues the run with `decideAutomationRun` for a Slack user who maps to a member with edit rights
  on the box (`boxJobRefusal`), replaces the message with "Approved by X" / "Denied by X", and answers
  anyone else with an ephemeral "You can't approve this here" (`cloud/lib/slackRunApprovals.mjs`). A
  decision made in the app updates the card to "Decided in OpenNous by X" and removes its buttons.
- `/slack/interactions` fails closed: without `SLACK_SIGNING_SECRET`, Approve/Deny clicks get 401
  (every interaction does in production).
- Webhook steps and legacy webhook delivery follow up to 4 redirects with a 30s timeout; box webhooks
  follow none with an 8s timeout. Every hop is checked against the SSRF guard.
- Preview: `/preview/slack-blocks` on the preview API (every layout's AI JSON and blocks).

### Slack trouble: named, auto-joined, alerted once (GET-901)

A daily report job failed twice without anyone being told: once because the bot was not in the
private channel after Slack was reconnected (`channel_not_found`), once because the workspace's Slack
connection row had been removed overnight ("Slack isn't connected"). Now:

- **What a failure means** (core `packages/core/src/services/slackHealth.mjs`, pure):
  `classifySlackFailure(reason)` sorts a step reason, a raw Slack error or an older log's words into
  `disconnected` (no connection), `broken` (`invalid_auth`, `account_inactive`, `token_revoked`,
  `not_authed`, `missing_scope`, `token_expired`, `app_uninstalled`, `tokens_revoked`, ...),
  `not_in_channel`, `channel_not_found`, `archived` or `other`. A Slack step's log line now keeps
  `target` (the channel it posts to) and, when it failed, `reason` (the code), so the state is read
  from the log, not guessed from words.
- **What the app shows** (`slackHealthView`, `runSlackStatus`, derived on the server from the
  connection NOW (`slackConnectionState`: is there a Slack row, is it `is_verified`) plus the latest
  outcome per place a job posts): `Slack disconnected · Reconnect`, `Slack connection stopped working ·
  Reconnect` (both link to `/company-sources?connect=slack`), `Invite @Nous to #channel` with
  `/invite @Nous` to copy, or `Channel archived · #channel`. `GET /api/revboxes/:id` adds
  `routines[].slack_status`, `job_deliveries[].slack_status` and `slack: { connection, deliveries }`
  (box destinations by id); `GET /:id/results` adds `failure.slack` to a failed run. The job row, the
  Delivery rail (connection state once on top, a channel's under its row) and the open Results row show
  it (`SlackStatusLine`). A reconnect clears a connection state at once; an invite clears on the next
  run that posts there. Nothing posts to Slack: no reads, no state. Test runs are ignored.
- **Auto-join** (`apps/api/src/cloud/lib/automationSlack.mjs`): when `chat.postMessage` answers
  `not_in_channel` or `channel_not_found` for a channel id, one `conversations.info` call; a PUBLIC,
  unarchived channel the bot is not in is joined (`conversations.join`) and the post retried once. It
  needs the `channels:join` bot scope, which the app does **not** request today: the code only tries
  when the install's `bot_scope` lists it. To turn it on, add `channels:join` to the live app's bot
  scopes, to `slack-app-manifest.yaml` and to `BOT_SCOPES` in `oauthSlack.mjs`, then have workspaces
  reconnect. Until then, and always for a private channel, the state is "Invite @Nous to #channel".
  A `#name` from an older step is never looked up.
- **Alerts** (`apps/api/src/cloud/lib/slackHealth.mjs`): a connection failure from a post (any run,
  the worker's too, since its posts go through the API), a removed Slack connection, and Slack's
  `app_uninstalled` / `tokens_revoked` events (`/slack/events`; subscribe to both in the app's Event
  Subscriptions, no scope needed) each report once per incident: one email to the workspace's owners
  and admins (the `sync_failures` notification; one who switched its email off is skipped) naming who
  removed it and how many jobs post to Slack, and one `opsAlert` (`[slack-health] ws=… <problem>
  source=… error=… connection=… by=…`). Deduped across processes by a `team_ops_email_log` row
  (`slack_<problem>:<workspace>:<incident>`, the incident being the removed connection's id, or a
  broken connection's id plus when it was last connected) and in-process for 15 minutes. A broken
  connection is marked `is_verified = false` (reconnecting, or a post that works again, sets it back).
- **The audit trail** (`apps/api/src/lib/audit.mjs` `recordConnectionRemovals`): every path that
  deletes a connection row writes `audit_log` `integration.disconnect` with the actor (user, email,
  IP, or none for a system path), `metadata.via` (`disconnect_route`, `account_erasure`,
  `workspace_deleted`, `admin_user_deleted`, `admin_team_deleted`), `provider_type`, and for Slack the
  team and bot user ids, plus a `[connection-removed]` log line. Connections a workspace or team
  deletion cascades away are read first and recorded after. The Slack OAuth callback writes
  `integration.connect` with `via: oauth_connect | oauth_reconnect` and what a reconnect replaced.
- **Preview**: the "Harborline daily digest" box shows the invite and archived states; start the
  preview with `PREVIEW_SLACK=disconnected` (or `broken`) for the connection states.

## File ownership while building in parallel

- Backend agent: `apps/api/src/cloud/lib/jobBuilder/**`, `apps/api/src/cloud/routes/api/revboxBuilder.mjs`
  (mounted at `/api/revboxes/:id/builder`), `apps/api/src/routes/v2/revboxes.mjs`, the HubSpot access
  helper, `AI_CREDIT_FEATURES`, their tests.
- Engine agent: migration, `packages/core/src/db/revboxBuilder.mjs` (sessions + approve -> routine),
  `apps/api/src/routes/api/revboxes.mjs` (jobs list/enable/run against routines), the automation
  runtime changes in `packages/core/src/services/automationRun.mjs`, plans flag, their tests.
- UI agent: `apps/frontend/src/components/revboxes/**` (JobBuilder chat, AskCard, WorkflowCard),
  `apps/frontend/src/lib/revboxes.ts`, `apps/frontend/src/pages/RevBoxes.tsx`, sidebar rollout.

## Shared function signatures (engine agent implements, backend agent calls)

`packages/core/src/db/revboxBuilder.mjs` (exported from `@nous/core`):

```js
createBuilderSession(sb, { workspaceId, revboxId, userId, jobId = null })      // -> session row; checks edit rights via loadRevbox
getBuilderSession(sb, { workspaceId, userId, sessionId })                      // -> session row or null; same access check
saveBuilderSession(sb, { workspaceId, sessionId, userId?, messages, proposal, expectUpdatedAt? }) // -> true when written; false when closed, not theirs, or changed since it was read (GET-889)
approveBuilderProposal(sb, { workspaceId, revboxId, userId, sessionId, proposal, mailboxOwners?, enableCheck? }) // -> { routine, facts, enabled, reason?, warnings?, datasets?, next_session_id?, next_jobs? } ; validates, creates the proposed tables, creates or updates agent_routines, a new job on (an Edit keeps on/paused) unless a check fails, marks the session approved and links it to the job; with next_jobs, opens the follow-on session
latestBuilderSessionForJob(sb, { workspaceId, revboxId, userId, jobId, approvedOnly? }) // -> the job's newest session (messages sanitized) or null; box edit rights (any editor)
sanitizeBuilderTranscript(messages, { keepText, approved })                    // pure; no tool_result bodies, no thinking; keepText false = the approved proposal only
openBuilderSessionForJob(sb, { workspaceId, revboxId, userId, jobId })          // -> { session, history, source_session_id } ; a job's chat: the person's open session reused, else seeded (GET-889)
builderSessionHistory(messages, { proposal, approved })                        // pure; transcript -> history items
listRevboxRoutines(sb, { workspaceId, revboxId, userId })                      // -> routines of the box (access-checked)
validateBuilderProposal(proposal, { slackChannelIds, mailboxIds, datasets? })   // pure; -> { ok, errors[], facts, steps?, trigger?, datasets? } ; used by both
```

Rules for everyone: no prod access, no migrations applied anywhere but a local scratch database, no
commits or pushes (the lead reviews and commits), keep the repo's dense comment style, and run the
tests you touch.
