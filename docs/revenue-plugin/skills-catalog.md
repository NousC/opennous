# The Nous Revenue Plugin — Skill Catalog (locked)

The canonical skill set the plugin ships. Not a mirror of Claudeforce's ~37 seller skills —
a set built from what **Nous** uniquely does. Pairs with [`README.md`](./README.md) (surface +
architecture) and [`claim-contract.md`](./claim-contract.md) (the write contract).
`schema_version: 1`.

## The test every skill passes

A skill earns a place only if it exists **because of what Nous is** — it builds the record from
raw, resolves identity, scores against the live ICP, or closes the loop back to our own GTM. If a
skill is just a CRM chore reskinned (logging activity, updating a field, keeping SFDC tidy), we
don't ship it. Recording is *native* here (`nous-sync`), so we never reskin it as five skills.

Every skill runs extraction on the agent's own tokens, keeps raw in the operator's git, and touches
only the **7 primitives** — the six data tools (`get_context`, `get_account`, `query`, `score`,
`record`, `record_insight`) plus **`whoami`** (workspace · scope admin/member · GTM role[s]).
`reach-out` and `follow-up` draft text only; sending, scheduling, and inbox reads delegate to the
user's own tools.

Naming is our own verb lexicon — deliberately distinct from Claudeforce's catalog so the plugin
never reads as a clone. Legend: **✅ built** · **▢ build** · ⭐ = a skill a CRM-attached AI
structurally cannot ship.

---

## Setup & Ingestion (4, built — the on-ramp)

`nous-onboard` · `nous-status` · `nous-sync` · `nous-backfill`. These are the on-ramp, not
revenue plays. `nous-sync` already absorbs everything Claudeforce splits into `log-activity`,
`summarize-transcript`, and `update-opportunity` — because recording is native, not a chore.

---

## The 15 revenue skills

### 1 · Build the record — what no CRM-attached AI can do

| Skill | Was | What it does | Primitives | Status |
|---|---|---|---|---|
| `build-record` ⭐ | research-prospect | Agent researches a net-new person/account from scratch (LinkedIn, site, news) on *its own* tokens, extracts the facts, and records them — creating the record where no CRM exists | `get_account`, `record`, `score` | ✅ |

### 2 · Work an account — act on the engineered record

| Skill | Was | What it does | Primitives | Status |
|---|---|---|---|---|
| `plan-account` | account-plan | Strategic plan for one account: committee, objections, competitors, deal health, ICP fit, next moves | `get_account`, `get_context`, `score` | ✅ |
| `brief` | meeting-prep | Brief me before any call/meeting — the whole account + the right next move. "Reach for Nous first," made literal | `get_context`, `get_account` | ✅ |
| `reach-out` | draft-outreach | Personalized first-touch / follow-up grounded in the record (drafts text; the send stays in the user's own email tool) | `get_context`, `record` | ✅ |

### 3 · Work the deal — plans to win

| Skill | Was | What it does | Primitives | Status |
|---|---|---|---|---|
| `map-committee` | stakeholder-map | The buying committee: who's in, their role/stance, who's missing, coverage gaps | `get_account`, `query` | ✅ |
| `objection-prep` | handle-objection | The objections you'll hear on this deal + the answer to each, drawn from recorded Intel | `get_account`, `get_context` | ✅ |
| `forecast` | forecast-narrative | Commit / best-case roll-up narrated from stage + deal-health, with the risk on each number | `query`, `score` | ✅ |

### 4 · Work the pipeline — patterns across accounts

| Skill | Was | What it does | Primitives | Status |
|---|---|---|---|---|
| `focus` | daily-briefing | **The morning driver — mirrors the Studio homepage** (`Focus.tsx`, `/studio`): upcoming meetings, accounts to focus on, who to follow up on, open action items — the engine-curated worklist, scoped to the caller's book via `whoami`. Reads the engine's follow-up logic, never reinvents it | `whoami`, `query`, `get_context` | ✅ |
| `review-pipeline` | pipeline-review | Whole-portfolio review: stage mix, health, what's slipping, competitive risk, re-engage list | `query`, `score` | ✅ |
| `whats-changed` | — (ours) | Delta since a time — new meetings/replies, fresh signals, stage moves, who went quiet | `query` | ✅ |
| `triage-leads` | lead-triage | Scores a list against the live ICP, tiers with reason + next action | `score`, `query` | ✅ |
| `ask-nous` ⭐ | ask-pipeline | Ask the graph anything in plain language — "who mentioned budget", "every deal touching a competitor" | `query`, `get_account` | ✅ |

### 5 · Close the loop & report — learning flows back to our own GTM, routed to who needs it

Two distinct reporting surfaces, mirroring the app exactly (`Insights.tsx` = company, `RoleReporting.tsx` = per-seat):

| Skill | Was | What it does | Primitives | Status |
|---|---|---|---|---|
| `win-loss` | win-loss-review | Patterns across closed-won/lost: recurring signals, objections, competitors + what to do | `query` | ✅ |
| `market-read` ⭐ | customer-voice | **Founder / admin only.** Company-wide voice-of-market — the distilled Product / Positioning / Market / Buyer themes with mention counts. The closed loop no CRM has. Gated on `whoami` scope | `whoami`, `query`, `record_insight` | ✅ |
| `role-report` ⭐ | (RoleReporting) | **Per seat.** The insights routed to the caller's GTM role(s) — deal blockers for an AE, early objections for an SDR, feature asks for Eng — reframed per role, union'd across a person's multiple roles. Scoped by `whoami` | `whoami`, `query`, `get_account` | ✅ |

**The two reporting surfaces (from the app, now mirrored in skills):**

| Surface | App page | Audience | Data | Skill |
|---|---|---|---|---|
| Company | `Insights.tsx` (`/company`) | Founder / admin only | external **themes** by category (product · positioning · market · buyer), with counts + evidence | `market-read` |
| Per-seat | `RoleReporting.tsx` (`/reporting`) | Each member, by their role(s) | **handlers** (deal-blockers/objections) + role-relevant themes, routed + reframed per role | `role-report` |

**Roles model:** `whoami` returns the caller's assigned GTM roles (plural — the `member_roles` /
`job_roles` array). Valid roles: `founder · sales · sdr · account_executive · revops · marketing ·
customer_success · agency · engineer · other`. One person may hold several; `role-report` shows all
of them. `scope` (admin/member) gates the company surface.

---

## Rename map (existing dirs → locked names)

The 5 built skills keep their behavior; only the directory + trigger names change, to our verb
lexicon (three of the old names collided with Claudeforce's verbatim). Mechanical follow-up:

| Current dir | New name |
|---|---|
| `account-plan` | `plan-account` |
| `pipeline-review` | `review-pipeline` |
| `lead-triage` | `triage-leads` |
| `win-loss-review` | `win-loss` |
| `whats-changed` | `whats-changed` (unchanged — already ours) |

## Deliberately not built (off-thesis, not just CRM-chores)

`summarize-transcript`, `inbox-sweep`, `log-activity`, `update-opportunity`, `sfdc-hygiene-check`
(chores — recording is native to `nous-sync`); `schedule-meeting`, `calendar-events` (calendar
actions live in the user's own tool, not our surface); `team-pipeline`, `assign-target-to-sdr`
(manager / multi-rep — a later "Manager Pack" once single-operator coverage is complete).

## MCP dependencies (server work — outside the plugin repo)

The reporting skills need two things exposed on the hosted server (the plugin just calls them):

1. **`whoami`** (the 7th primitive) — returns `{ workspace, scope: "admin"|"member", roles: string[] }`
   where `roles` is the caller's assigned GTM roles (`member_roles` / `job_roles`). `market-read`
   gates on `scope: "admin"`; `role-report` routes on `roles`.
2. **`query` reporting scope** — `query({ scope: { reporting: "company" | "role", role? } })`
   returns the already-distilled insights the app shows (`company` → external themes by category;
   `role` → handlers + role-relevant themes, routed + reframed **server-side** using the caller's
   role). Keeping the routing on the server means the app (`Insights.tsx` / `RoleReporting.tsx`) and
   the plugin never drift. No 8th primitive — this rides on `query`. **Shipped** (opennous `cb941e5`).
3. **`query` Studio worklist scope** — `query({ scope: { attention: "mine" } })` returns the
   engine-curated daily worklist the Studio homepage (`Focus.tsx`, `/studio`) shows: upcoming
   meetings, accounts-to-focus-on (flags + recommendations), follow-ups + replies due, and open
   action items — scoped to the caller (`mine`). The engine owns the "when to follow up" logic
   (`/api/flags`, `/api/tasks`, `/api/recommendations`); this scope exposes that same worklist to
   `focus` so the skill and the app never drift — same pattern as the reporting scope, no 8th
   primitive. Until it lands, `focus` degrades to assembling from raw `query` and says so.

Until the `query` reporting scope lands, `market-read` / `role-report` can only approximate from raw
Intel (`query({ facts: true })`), which loses the curated counts, evidence, and per-role framing.

### How ingestion feeds the two reporting surfaces

Both reporting surfaces are fed by what `nous-sync` / `nous-backfill` already extract — no
role-specific extraction is needed, because **routing to roles happens server-side** (the agent
records objections + insights untagged; `RoleReporting.tsx`'s routing map assigns each to the right
seat). The data flows:

```
role-report (deal-blockers per seat)
  record(Intel, category: objection|pain|friction)  →  claims (note.%)
    →  objectionMatcher / buildObjectionHandlers  →  objection_handlers
    →  query(reporting: role)  →  role-report

market-read (company Product/Positioning/Market/Buyer)
  record_insight(product|positioning|market|buyer)  →  insight_items (source=external)
    →  synthesizeThemes (LLM clustering)  →  insight themes
    →  query(reporting: company)  →  market-read
```

**Distillation triggers differ** — the one operational nuance:

| Layer | Trigger | After a backfill |
|---|---|---|
| Themes (market-read) | Lazy on read — `GET /themes` checks a `build_key`, re-clusters if stale | Materializes on first `market-read` read. No action. |
| Handlers (role-report) | `objectionMatcher`, cadence **weekly** | Won't appear for up to a week unless triggered |

So after a bulk `nous-backfill`, the server should run `runIntelligenceOnce(workspaceId)` (already
designed for backfill — "not on a cron") so `role-report` handlers materialize immediately. The
`nous-backfill` skill's completion step asks for this trigger.

**By design, reporting needs volume:** the objection matcher needs ≥5 objections; theme synthesis
drops tiny 1–3-item themes. A thin backfill won't populate reporting until enough recurs
("pattern, not anecdote"). Handler *answers* also draw on the workspace's ICP/positioning
foundations (set at onboarding).

## Count

- **Built: 19 — the full catalog** — 4 setup + 15 revenue. All skills in this doc are built.
  - Setup: `nous-onboard`, `nous-status`, `nous-sync`, `nous-backfill`.
  - Revenue: `build-record`, `plan-account`, `brief`, `reach-out`, `map-committee`, `objection-prep`,
    `forecast`, `focus`, `review-pipeline`, `whats-changed`, `triage-leads`, `ask-nous`, `win-loss`,
    `market-read`, `role-report`.
- **Server-side to finish** (not plugin skills): the `query` **Studio worklist scope**
  (`attention: "mine"`, for `focus`) and the post-backfill `runIntelligenceOnce` trigger (for
  `role-report`). The `query` reporting scope already shipped (`cb941e5`). Until the worklist scope
  lands, `focus` assembles from raw `query` and says so. See MCP dependencies above.
- **Total: 19** (4 setup + 15 revenue). Leaner than their ~37 by design; the gap is the CRM-chore
  and manager/multi-rep skills we deliberately drop. We add ones they structurally can't:
  `build-record`, `ask-nous`, `market-read`, `role-report`.
