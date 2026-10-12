# The Nous Revenue Plugin

The canonical overview of the revenue plugin: what it is, its **one** MCP server and 17-tool
surface, the skills (built + planned), and the roadmap. Pairs with
[`claim-contract.md`](./claim-contract.md) (the write contract) and the plugin's own
[`CLAUDE.md`](https://github.com/NousC/revenue-plugin/blob/main/plugins/opennous/CLAUDE.md) (agent house
rules). `schema_version: 1`.

---

## 1. What it is

Nous is the **revenue layer that runs inside the operator's own coding agent** — Claude Code first,
then Codex / Cursor. "Claudeforce for teams who don't live in Salesforce." The division of labor is
the whole idea:

- **The agent does the work on _its own_ tokens + _the user's_ git.** It reads LinkedIn profiles,
  meeting transcripts, and emails, extracts the facts, and calls Nous.
- **The Nous engine (hosted) resolves, scores, and stores.** It resolves every person/company into
  one identity-resolved, ICP-scored **Account Record**, keeps each fact's confidence + freshness,
  and derives deal health and the AI overview — the agent never writes those.
- **Raw stays in the operator's git; Nous holds only structure.** Transcripts and prose briefs live
  in the repo (`raw/`, `briefs/`); observations carry a `source_ref: git://…` pointer + a
  `content_hash`. Nous stores no documents.

The result is a closed loop: the agent observes → Nous derives the truth → the next session (or the
app, or a teammate's agent) starts ahead.

## 2. Architecture — one MCP server, and only one

**Decision (locked): one MCP server, and it exposes exactly the tools in `PLUGIN_TOOLS` — nothing else.**
No per-skill servers, no second transport, no companion server, and **no full/legacy 36-tool
surface**. Nous is fully a revenue plugin now; `createServer()` registers only the seven (the six
data primitives + `whoami`).

```
plugins/nous/.mcp.json  →  https://mcp.opennous.cloud/mcp
                           Authorization: Bearer ${NOUS_API_KEY}
```

- **One fixed set, always.** The server has no mode where it serves more than `PLUGIN_TOOLS`. A
  non-primitive registration is dropped rather than exposed. The
  app never consumed the MCP anyway (it calls the API/DB directly), so there is nothing else to serve.
- **Stateless HTTP.** A fresh server + transport is built per request with the caller's key bound
  for the whole call (multi-tenant safe).
- **Install flow.** The user pastes one prompt → the agent reads `opennous.cloud/install.md`, wires
  this `.mcp.json`, and sets `NOUS_API_KEY`. The app's Install page detects the first authenticated
  call ("Agent connected").
- **Live ingest** also arrives via webhooks (`api.opennous.cloud/inbound/<source>/<ws>`), managed on
  the app's Webhooks page — orthogonal to the MCP, same graph.

## 3. The MCP surface

**The set lives in one place: `PLUGIN_TOOLS` in `apps/mcp/src/server.js`.** This section
describes it; where they disagree, the code is right. (They disagreed for weeks — this file said
eight, a comment said ten, the set held thirteen — which is how a "locked" decision quietly stops
being one.)

Deliberately tight (a coding agent handles a small, high-level toolset far better than 30+).
`search` folds into `query` (`facts:true`); `record_signal` folds into `record` (a `signal.*`
observation triggers the same rescore); reporting, the daily worklist and the ICP definition all
ride on `query` scopes rather than earning tools of their own.

**The growth rule.** A new tool requires a capability that cannot fold into an existing
primitive — not a convenience, not symmetry with the app's 64 tools. By that test the app's UI
actions, external lookups, skill machinery and setup config all stay out: the first are
meaningless without our UI, the second belong to the operator's own agent, the third are native
to Claude Code, the fourth happen in the app.

**The documented core (2026-09-30).** The documented surface is now a core set, one tool
per door of the public API: `whoami`, `find`, `get_context`, `query`, `attention`,
`get_insights`, `add_note`, `enrich`, `score`, `set_icp`, and
`webhooks` (2026-10-01, GET-559: subscribe the operator's stack to events), plus `tasks`
(2026-10-11, GET-830: list the task list and close or reopen tasks; closing cannot fold into
`record` or `add_note`, which only append). Nous Cloud adds `read_brain` and `write_brain` for
the GTM brain, which the open-source edition does not have (GET-839). They come
first in `PLUGIN_TOOLS`, so an agent's tool list leads with them. `find` replaces `list_people`
(added on the public-API branch, never released) and covers the accounts and deals lists too.
The legacy tools (`get_account`, `deals`, `pages`, `read_page`, `save_page`, `record`,
`record_insight`, `record_closed_deals`) stay registered because the plugin skills call them;
they come out once the skills migrate to the core set, tracked in GET-536. Until then they work
as before and are described under **Legacy** below.

### Identity

| Tool | Use |
|---|---|
| `whoami` | Who this key acts AS: workspace, person, **scope** (`admin` = whole workspace · `member` = own book), **GTM role(s)**, and the **budget** (plan, ops left, credits left; unlimited when the plan has no cap). Every governance decision hangs off it; skills read it to scope role-specific work. |

### Read

| Tool | Use |
|---|---|
| `find` | The lists: `kind` people \| accounts \| deals (`GET /v2/people`, `/v2/accounts`, `/v2/deals`), with each list's own filters and sorts (stage, ICP fit/score, owner, country, open deal, activity recency, account, deal status, pipeline, closing window, amount, implied). A filter the kind does not support is refused with the supported set, before any call. One line per row. |
| `get_context` | The headline tool — engineered, task-scoped context for a person, company **or deal** (a CRM deal id, or `implied:<account_id>`; the deal block leads). Facts carry confidence, freshness, and their evidence: speaker, quote, source and `source_ref`. |
| `query` | Patterns across many accounts. Also carries the scopes that would otherwise be tools: `reporting`, `attention`, and `foundation:'icp'` — the ICP **as written**, so a skill can explain a score rather than just report it. |
| `attention` | What needs attention now (`GET /v2/attention`): going dark, decayed facts, upcoming meetings, open commitments, hot intent, flags, each with a suggested action. Open commitments carry a task id. |
| `tasks` | The task list (`GET /v2/action-items`) and closing it (`POST /v2/action-items/status`): list by owner, status, account or due date; `done` / `reopen` by task id. The same edit as ticking a task on the Tasks page, HubSpot write-back included. |
| `get_insights` | The Insights board (`GET /v2/insights`): customer insights by lane and subtype, tagged, tied to the account that said them, filterable by account and date. |
| `read_brain` | Cloud only. The GTM brain (`GET /v2/brain`, `/search`, `/page`): no arguments for the Overview and every page path, `search` for the pages that say it, `path` for one page. |

### Write

| Tool | Use |
|---|---|
| `add_note` | Keeps a note or document (note, meeting brief, meeting notes, pre-meeting, research, transcript) on a person or company (`POST /v2/notes`). Not an interaction; that is `record`. |
| `enrich` | Runs the workspace's enrichment waterfall for one person (`POST /v2/people/:id/enrich`; an email or LinkedIn URL is resolved first). Reports provider, fields added, and whether a result under 90 days old was reused. |
| `score` | The ICP fit + intent judgment, written into the graph; inline for cold leads and external lists. |
| `write_brain` | Cloud only. Saves the next version of a GTM brain page (`PUT /v2/brain/page`): Decisions, the playbooks, `Playbooks/Competitors/<Name>`, `Working Documents/<Name>`, `Archive/<Name>`. Internal Meetings, Insights, the Overview and indexes are refused. |
| `set_icp` | Writes the ICP (`PUT /v2/icp`). The scoring model is built from it only when none exists yet; an existing model is kept, and the result says which. Read it back with `query({scope:{foundation:'icp'}})`. |
| `webhooks` | Subscribes the operator's own stack to events (`/v2/webhooks`): `events`, `list`, `create` (the signing secret is returned once), `update`, `delete`, `test` (a `webhook.test` built on a real account), `deliveries`. Record events carry the account, people, deal and evidence. |

### Legacy (retained until the plugin skills migrate, GET-536)

| Tool | Use |
|---|---|
| `get_account` | The full record: facts, Intel, timeline, ICP. |
| `deals` | Deal health and the odds of closing, per account (`GET /v2/accounts/outlook`). |
| `pages` | What has already been written in this workspace — list, or search passages; on Cloud, `brain` reaches the GTM brain. |
| `read_page` | One document: whole, one section, or the passages around a phrase, plus what it cited. |
| `save_page` | File a **finished** document into Pages — brief, plan, report, meeting brief, objection prep. Versioned on its account, cited with the same `source_ref`s the read tools printed. |
| `record` | Everything learned about a **contact**: interactions, facts, buying signals, Intel. Also the loop's own writes — `decision.*` (proposal, verdict, interpretation), `constraint` (what they never do, which we then refuse to generate), and `preference` (how they want things). |
| `record_insight` | What a call taught us about **our own** business. Never contact facts. |
| `record_closed_deals` | Won/lost cohorts, which train the ICP on outcomes rather than on a hypothesis. |

Each observation carries `observed_at`, `external_id` (idempotency), `source`, `method`,
`source_ref` (git pointer), `content_hash`. Full payloads + the property vocabulary live in
[`claim-contract.md`](./claim-contract.md).

## 4. The skills

Skills are the plugin's product surface — prose SOPs (`SKILL.md`) that the agent loads on trigger.
Every skill runs extraction on the agent's tokens and touches only `PLUGIN_TOOLS`.

### Built — Setup & Ingestion (4)

| Skill | What it does | Fires on | Primitives |
|---|---|---|---|
| `nous-onboard` | First-run SOP: detect connected tools, fill gaps, backfill ~6 months, end with a pipeline report | "onboard me", "set up my workspace", first install | all 7 |
| `nous-status` | Health check — who the key acts as (scope + role), and what's in the graph | "is Nous set up?", "who am I?", "what's in my graph?" | `whoami`, `query` |
| `nous-sync` | Turns **one** just-finished call/email into facts, Intel, signals, insights | "file this call", meeting just ended | `record`, `record_insight` |
| `nous-backfill` | Bulk-imports **months** of history; resumable + idempotent | "backfill my history", "import last 6 months" | `record` |

### Built — Revenue Plays (5)

| Skill | What it does | Fires on | Primitives |
|---|---|---|---|
| `account-plan` | Strategic plan/brief for one account: committee, objections, competitors, deal health, ICP fit, next moves | "plan/brief/prep this account or meeting" | `get_account`, `get_context`, `score` |
| `lead-triage` | Scores a list against the live ICP, tiers with reason + next action | "triage/qualify/prioritize these leads" | `score`, `query` |
| `pipeline-review` | Whole-portfolio review: stage mix, health, what's slipping, competitive risk, re-engage list | "review my pipeline", "what should I work on" | `query`, `score` |
| `whats-changed` | Delta since a time — new meetings/replies, fresh signals, stage moves, who went quiet | "what's new", "who went dark" | `query` |
| `win-loss-review` | Patterns across closed-won/lost: recurring signals, objections, competitors + what to do | "why do deals get won/lost" | `query` |

### Planned

- **`dashboards`** — a standing, refreshable portfolio view (vs. the one-shot `pipeline-review`
  briefing). The next thing to build.
- **Action skills** — anything that _acts_ rather than reads/records. These exist as **app**
  capability today but have no plugin skill, and each needs a decision (call an app endpoint, or
  widen the surface — against the point of the trim) before building:
  - `draft-outreach` — personalized first-touch / follow-up grounded in the record
  - `forecast` — commit / best-case roll-up from stage + deal-health
  - `coaching` — per-rep review from their touches
  - `win-back` — re-engagement plays for gone-quiet accounts

## 5. The decision loop — advice in, outcome out

The plugin does not only read the graph; it **writes down its own advice and gets graded on
it**. Every recommendation is recorded before anyone acts, the human's verdict (accepted /
edited / rejected) is captured, the action is confirmed by evidence rather than by the agent's
say-so, and whatever comes back is attributed to the decision that caused it.

Three lanes of evidence, ranked by trust — a provider webhook (unfakeable), a `PostToolUse`
hook that saw the send tool return (deterministic), and the agent's own `record` call (the only
lane that can see the conversation, so treated as a proposal and reconciled against the other
two). The **edit** label is the one nobody else can compute: only a system sitting between the
draft and the send holds both versions.

It is surface-agnostic on purpose. The substrate is plain HTTP under `/v2/decisions` — a hook
is a shell script and cannot call an MCP tool — so the Claude Code plugin, any other agent, and
**our own app** (`studio.mjs` drafts, `actions.mjs` approve/reject) all write the same row
shape, tagged with which surface produced it. Agents with no hook mechanism still close the
loop off the recorded observation, one worker pass later.

Full spec, API, and failure behaviour: [`decision-loop.md`](./decision-loop.md).

## 6. Roadmap

| Milestone | Scope | Status |
|---|---|---|
| **M0 — Write contract** | `record` provenance (`observed_at`, `external_id`, `source_ref`, `content_hash`, `method`); `record_insight` + `POST /v2/insights`; intel routing + pronoun guard | ✅ shipped |
| **M1 — Lean surface + ingestion** | 6-primitive allowlist enforced (`?surface=plugin`); extraction skills (`nous-sync`, `nous-backfill`); onboarding SOP (`nous-onboard`, `nous-status`) | ✅ shipped |
| **Revenue plays** | `account-plan`, `pipeline-review`, `lead-triage`, `whats-changed`, `win-loss-review` | ✅ shipped |
| **Decision loop** | `ri_decisions` + `/v2/decisions`; `decision.*` through `record`; `PostToolUse` confirmation hook; app parity in `studio.mjs`/`actions.mjs`; unconfirmed maturation | ✅ shipped |
| **Next — Dashboards** | Standing, refreshable portfolio view | ▢ planned |
| **Later — Actions** | `draft-outreach`, `forecast`, `coaching`, `win-back` (needs surface decision) | ▢ planned |
| **Engine hardening** | `git://` fetch in `resolveRaw`; batch merge/supersede; company-vs-person routing; graph-edge extraction; `external_id` on insights + intel | ▢ ongoing (see claim-contract §8–9) |

## 7. Design rules (non-negotiable)

- **One MCP server, one fixed tool set.** No growth without a capability that cannot fold into an
  existing primitive;
  the whole value of the plugin is that it's lean.
- **Raw stays in git; Nous holds structure.** Never send a transcript to Nous — `source_ref` +
  `content_hash` preserve provenance.
- **You observe; the engine derives.** The agent records against a precise `focus` (email /
  LinkedIn URL / domain / entity id) and never merges or resolves identities itself.
- **Idempotent by construction.** Historical `observed_at` + a distinct `external_id` per
  observation make backfills and retries safe to re-run.

## 8. Related docs

- [`claim-contract.md`](./claim-contract.md) — the write contract (payloads, vocabulary,
  idempotency, intel fidelity).
- [`decision-loop.md`](./decision-loop.md) — recommendation → verdict → action → outcome; the
  three evidence lanes, the API, and how it stays surface-agnostic.
- Plugin repo — [`NousC/revenue-plugin`](https://github.com/NousC/revenue-plugin) (MIT): `CLAUDE.md`
  (house rules), `.mcp.json`, `skills/<name>/SKILL.md`.
- Install doc — `opennous.cloud/install.md`.
