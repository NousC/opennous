# The decision loop

How a recommendation becomes a labelled outcome — and why it works the same whether the
advice came from a coding agent, from our own app, or from a runtime that does not exist yet.
Pairs with [`README.md`](./README.md) (the plugin overview) and
[`claim-contract.md`](./claim-contract.md) (the write contract). `schema_version: 1`.

---

## 1. What it is for

The engine already learns **behaviour → outcome**: `ri_observations` holds effects with a
sample size and a confidence, and `recEffectiveness` writes a learned priority back onto the
worklist. What it could not learn was **advice → outcome**, because two columns were missing
the moment work moved into a coding agent:

- **What was recommended.** A plugin recommendation is produced by the *user's own agent*
  inside a skill. It lived in chat scrollback and was never written down.
- **What the human did with it.** Accepted, edited, or rejected — the highest-signal label we
  can collect, and the one only we can: a system that sits *between the draft and the send*
  sees both versions. A CRM only ever receives the sent one.

With those two columns the dataset answers questions no CRM can:

- Which of our recommendations do experienced operators consistently correct?
- Which follow-ups actually create responses, and which only create activity?
- What separates a healthy deal from CRM theatre?

That last one is only computable **because the CRM stage is not the ground truth here.**
Stages are human-maintained, lagging, and gamed. We treat a stage as a *claim about* state (a
feature); the labels come from money movement and from mailbox/calendar events, which nobody
can fake. Scoring the claim against the labels is what makes "CRM theatre" measurable instead
of rhetorical.

## 2. Three lanes of evidence, ranked by trust

The schema keeps these distinct on purpose. Collapsing them would mean an agent's claim about
a send and a provider's confirmation of one carried equal weight, which is exactly wrong.

| Tier | Source | Sees | Trust |
|---|---|---|---|
| **1** | The provider's webhook (`inbound/<source>/<ws>`) | Replies, meetings, bounces, opt-outs, payments | Unfakeable. Arrives whether or not any agent was running. |
| **2** | A `PostToolUse` hook that saw the send tool return | That the action executed, plus the provider's message id | Deterministic. Cannot be forgotten or embellished by a skill. |
| **3** | The agent's own `record` call | The recommendation and the human's verdict | Unverified — but the **only** lane that can see the conversation. |

Tier 3 is the only source for what was recommended, so it cannot be dropped; it is treated as
a *proposal* and reconciled against tiers 1 and 2 rather than believed.

## 3. The shape: propose → verdict → confirm → outcome

```
  agent/app recommends        human answers            action fires             the world answers
  ──────────────────────  →  ─────────────────  →  ────────────────────  →  ──────────────────────
  decision.proposed          decision.accepted       PostToolUse hook          reply / meeting /
  (decision_id, recipient)   decision.edited         or our own send lane      bounce / opt-out /
                             decision.rejected       → provider_message_id     silence
        │                          │                        │                         │
        └──────────────── ri_decisions ────────────────────┘                         │
                                   │                                                  │
                                   └──────────── ri_decision_traces ──────────────────┘
```

The join key is the **provider's own message id**. The hook captures it from the send tool's
response; the reply webhook carries the same id (`instantly.mjs` already keys idempotency on
it). Attribution therefore never depends on anybody's narration.

### A draft is consent, not action

The flow people actually use is not "agent sends the email". It is: the agent drafts, the
human reads it in their own mail client, edits a line, and sends it themselves — often hours
later, sometimes never. Those are **two separate facts** and the loop records them separately:

| What happened | What it means | What the loop writes |
|---|---|---|
| A draft is created | The human said yes to the recommendation | `verdict: accepted` — and nothing else |
| The message is sent | The action actually occurred | `status: confirmed` + provider message id |
| The draft is never sent | Advice accepted, then quietly dropped | matures to `unconfirmed` |

Counting a draft as a send would put email in the dataset that never left the building, and
would hide the third row — which is one of the more interesting things this system can see.

The send in that flow happens **outside the agent session entirely**, so no hook can witness
it. The Gmail ingest is the confirmation lane there (`composio.mjs`), and it is also where the
edit label comes from for free: the human's rewritten body hashes differently from the drafted
one, so the verdict upgrades `accepted → edited` without anybody reporting anything.

One guard worth knowing about: the ingest sends a body hash **only when it has the real body**.
The payload's body field falls back to a snippet, and hashing a truncated body would differ
from the draft every single time — labelling the entire corpus `edited`. No hash is strictly
better than a wrong hash; the confirmation still lands and the verdict keeps what it had.

### The row that matters most

A decision that was **accepted but never confirmed** matures to `status='unconfirmed'` after
three days (`matureUnconfirmedDecisions`). That is not a bug in the pipeline — it is the
**intent-to-action gap**: either the agent claimed a send that never happened, or the person
said "yes, do it" and never did. Left as `proposed` it would read as "still pending" and
quietly inflate our acceptance rate. No CRM records this state at all.

The window is deliberately generous. Approving a draft on Friday and sending it Monday is not
a broken promise, and mislabelling it would teach the learning layer the wrong lesson.

## 4. It is surface-agnostic by construction

The same row shape is written by every surface, and `surface` + `agent` record which one — so
the learning layer can ask *"does the app's advice get edited more than the agent's?"*.

**Inside Claude Code (the plugin).** Skills write `decision.proposed` and the verdict through
`record`; the `PostToolUse` hook (`hooks/confirm-action.sh`) confirms the send. The hook is
the only Claude-Code-specific piece in the whole feature.

**Inside any other agent.** The substrate is plain HTTP, not MCP — deliberately, because a
hook is a shell script and cannot call an MCP tool. A Codex hook, a CI job, or a bespoke
runtime posts the same four calls. Agents with no hook mechanism at all still close the loop:
`resolveDecisionTraces` confirms a decision off the *observation* when the send is recorded
with its `decision_id`. The hook makes confirmation faster and adds the provider's message id;
it is not load-bearing.

**With no agent involved at all.** The Gmail ingest confirms decisions off the provider's own
webhook, so a recommendation acted on by hand — from a phone, from the Gmail web UI, three days
later — still closes the loop. This lane is not a fallback; for the draft-then-send-yourself
flow it is the *primary* one.

**Inside our app.** `studio.mjs` (Nous Cloud) mirrors every draft into `ri_decisions` as it is created, and
`actions.mjs` closes it on approve or reject. The approve handler is the one place in the
product holding *both* bodies — what we drafted and what the human actually sent — so the
edit distance is measured there rather than guessed.

## 5. The API

The service lives in `@nous/core`, next to `audit.mjs` and for the same reason: both apps need
it and neither can import from the other's directory. A second copy of the body-hash
normalization is exactly how the accept-vs-edit label would silently rot.


All under `/v2/decisions`, `verifyApiKey`, and **not** behind `requireOpsBalance`: a
confirmation arrives after the message has already gone out, and an out-of-credit workspace
dropping it would lose the label permanently while the action stayed real. Same reasoning as
inbound ingest.

| Call | Purpose |
|---|---|
| `POST /v2/decisions` | Write down the proposal. Idempotent on `(workspace_id, decision_id)`. |
| `POST /v2/decisions/:id/verdict` | What the human decided. Pass `drafted_body` + `sent_body` and the edit label is **derived**, not taken on trust. |
| `POST /v2/decisions/:id/confirm` | The action fired, from a caller that knows the decision id. |
| `POST /v2/decisions/confirm-by-action` | An action was observed by a caller that does **not** know the decision id — the hook's and the ingest's endpoint. Matches on `recipient` + recency. `stage: 'drafted'` records only the verdict; `stage: 'sent'` (default) also confirms. |
| `GET /v2/decisions` | Read the loop back (`?entity_id=`, `?status=`, `?verdict=`). |

Agents that prefer the single MCP write door use `record` instead, with
`property: 'decision.proposed' | 'decision.accepted' | 'decision.edited' | 'decision.rejected'
| 'decision.confirmed'`. Both land in the same table. The verdict **is** the property name, so
a skill cannot report one verdict and mean another.

Decision writes are kept out of the observation spine on purpose: a proposal is not something
that happened to the account, it is something we said about it, and mixing the two would
pollute the interaction timeline.

## 6. The ICP score is snapshotted, not looked up

`ri_decisions` carries `prediction_id` and `icp_score_at_decision`, captured when the proposal
is written.

This is a leakage guard, and it is the reason those columns existed before the table had a
single row. When ICP is eventually joined to outcomes — *who converts faster, which deals take
longer* — the score has to be the one that was true **when we acted**. Today's score moved
partly *because* the deal progressed; joining it back to a March decision trains on hindsight
and yields a correlation that predicts nothing. And it cannot be repaired later: a
point-in-time score cannot be reconstructed, so a decision recorded without this is
permanently unlabelable for ICP.

Predictions are append-only (`predictions.ts` — a fresh score stakes a new row), so the latest
row *is* the point-in-time reading. We keep both the pointer and the number: the row's meaning
shifts as model version and resolution move under it, and the analysis needs what the operator
was actually looking at.

**`edit_verified` says whether we were in a position to check.** A verdict of `accepted` means
the human acted on the recommendation; on its own it does not mean they sent it unchanged.
Skills that omit `proposal_body` leave nothing to compare against, and treating those as
verbatim is how a broken input produced a flat 100% sent-as-drafted (GET-68). Rates are
computed over verified rows only, so the honest answer to an unverified workspace is a blank
rather than praise.

Two rules that are easy to lose:

- **A re-proposed decision keeps the score it was first recorded under.** `proposeDecision` is
  idempotent so a skill can safely re-run, and an upsert that re-read the score would
  reintroduce the same hindsight leak quietly, through the retry path.
- **A proposal never stakes a score.** An unscored lead gets nulls. Writing down a
  recommendation must not change the thing being recommended on.

## 7. Learned instructions — the loop closing

Everything above records and grades. This is what changes what the agent says next.

**The agent never learns. Its context changes.** That follows from the architecture: the agent
is stateless and dumb, the engine is stateful and smart. The skill prompt is byte-identical in
March and September; only the payload it reads differs. No re-prompting, no fine-tuning, no
per-user prompt drift.

Three consumers, one store:

| Consumer | Carries |
|---|---|
| The plugin's SessionStart hook | the durable rules, always present |
| `get_context` | the situational, account-specific |
| The app's drafting prompt | the same rules, so app and agent agree |

`decisionQuality` (worker) turns decisions into `ri_observations` rows carrying a
`recommendation_template` — a sentence written to the next agent rather than a metric. Three
shapes are honestly available today: advice that is consistently **rewritten**, advice that is
**turned down**, and advice that is agreed to and then **never acted on**.

`GET /v2/decisions/instructions` serves them, `?format=text` for a hook to cat directly.

### The guard that matters more than the feature

An instruction injected into context reads as a rule of the house. The agent will follow
"write shorter" from four observations exactly as readily as from four hundred, silently, in
every draft from then on — and nobody would trace a bad quarter back to it.

So: a finding below `medium` confidence is **not emitted at all** rather than emitted with a
hedge, because the hedge is the first thing a model drops. Every rule carries its n and its
segment. The block is capped at six, because context that grows without limit becomes prompt
bloat that degrades everything else the agent does.

## 8. What is never stored

No message body, on any lane. The hook sends a **hash** of what went out; the server compares
it to the hash of what was drafted. That single comparison yields the accepted-vs-edited label
with no content and no cooperation from the agent. The *magnitude* of an edit needs both
bodies, so it is computed only when a caller passes them in-process (our app) or a skill
volunteers them. Raw stays in the operator's git, as everywhere else in the plugin.

## 9. Failure behaviour

Every write in this feature is best-effort and fails open. The message has already gone out by
the time confirmation runs; Nous being down, slow, or unconfigured must never colour a send
that succeeded, and must never fail a draft. The hook caps its call at five seconds, detaches
it, and exits 0 on every path. A confirmation for a decision nobody proposed returns
`status: 'unmatched'` rather than an error — that is a real state (the agent acted without
writing down its recommendation), and it should be visible in the data instead of papered over.

## 10. Open

- **Bulk actions break the 1:1 assumption.** "Add these 40 leads to campaign X" is one decision
  producing 40 sends and weeks of scattered outcomes. `ri_decisions` carries it, but
  `resolveDecisionTraces` still assumes one send per trace — bulk needs a fan-out or a
  cohort-level trace type.
- **Hook tool-name coverage** is a matcher list. A Gmail MCP spelled a way we have not seen
  goes silently unconfirmed (the observation lane still catches it, one worker pass later).
- **Cross-workspace priors.** `ri_global_priors` is the real dataset moat, and per-workspace
  n is small. The consent/licensing posture has to be settled *before* the data accumulates —
  it cannot be applied retroactively.

## 11. Files

| Area | Path |
|---|---|
| Schema | `supabase/migrations/2026_09_08_decision_loop.sql` |
| Tests | `packages/core/test/decisionLoop.test.mjs` |
| Service | `packages/core/src/db/decisions.mjs` (shared: the API writes, the worker confirms) |
| API | `apps/api/src/routes/v2/decisions.mjs` |
| Write door | `apps/api/src/routes/v2/observations.mjs` (`decision.*`, `decision_id`) |
| App lane | `apps/api/src/cloud/routes/api/studio.mjs` (Nous Cloud), `apps/api/src/routes/api/actions.mjs` |
| Ingest confirmation | `apps/worker/src/webhooks/handlers/composio.mjs` (outbound Gmail) |
| Outcome resolver | `apps/worker/src/intelligence/decisionTraces.mjs` |
| Learning job | `apps/worker/src/intelligence/jobs/decisionQuality.mjs` |
| Instruction read | `packages/core/src/db/instructions.mjs` |
| Hook | `revenue-plugin` → `plugins/opennous/hooks/confirm-action.sh`, `hooks.json` |
| Skill guidance | `revenue-plugin` → `plugins/opennous/CLAUDE.md`, `skills/reach-out/references/decision-loop.md` |
