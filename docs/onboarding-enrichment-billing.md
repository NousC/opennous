# Onboarding, Enrichment & Billing

Three questions decide whether a new workspace becomes useful: what happens when
someone signs up, what happens when they connect a tool, and what happens when they
push past their plan. They are one continuous lifecycle — sign up produces an ICP,
connecting a tool backfills history against it, and the accounts that history makes
*active* are what the plan meters. This document describes that lifecycle as it is
actually built, and points at the code.

The load-bearing idea, stated once up front: **the billed unit is a conversation, not
a record.** Everything below follows from it. You can import fifty thousand leads on the
free plan; you pay only for the companies you actually talk to.

---

## 1. Onboarding

Onboarding exists to produce one artifact — the workspace's **ICP** — and then to point
a source of interactions at it. A workspace with an ICP and one connected tool is
onboarded; everything else is optional.

### 1.1 One entry point

Setup is a single command:

```
npx @opennous/cli init
```

There is no plugin and no second path (the plugin was removed; onboarding was
consolidated). The CLI authenticates, creates or selects the workspace, and hands off
to the web **ConnectGate** (`apps/frontend/src/pages/ConnectGate.tsx`) for the ICP and
the first integration.

### 1.2 The ICP is drafted, then written to three homes

On the ConnectGate review step, onboarding drafts an ICP from the workspace's website
(`POST /api/onboarding/icp/draft` — Haiku fills the canonical template in
`apps/api/src/lib/icpTemplate.ts`; the sections are *the buyer*, *who is a fit*, *who is
NOT a fit*, *trigger signals*, *anchors*). If the LLM is unreachable the endpoint returns
an honest `503 draft_unavailable`, never a fabricated ICP.

The draft (edited or not) is saved through **one function**, `writeIcp()`
(`apps/api/src/lib/icp.mjs`), which writes it to every home in one call:

| Home | Role |
| --- | --- |
| `foundations` (kind `icp`) | **The authority.** What the Vault renders and what `get_foundation` serves an agent before it acts. |
| `notes` (category `ICP`) | What `seedScorecardFromMemory` reads — and *nothing else*. An ICP that skips this never reaches the scorer. |
| `workspaces.icp_text` | A cache for the legacy `GET /api/mind/icp`. Not authoritative; nothing gates on it. |

This is deliberate. The ICP previously had four homes that disagreed — a user could
finish onboarding, produce an ICP, and have the scorer see nothing. One write path is
the fix. `hasIcp()` (the definition of "onboarded") checks the **foundation row only**.

### 1.3 From ICP to a working model

The ICP file is not the model — it is the model's *input*. Two steps turn it into live
scores:

1. **Seed** — `seedScorecardFromMemory(force)` (`apps/api/src/lib/scorecardSeed.mjs`)
   translates the ICP note into 4–8 weighted **inclusion** signals plus a **disqualifier**
   for each "not a fit" statement (negative weight, hard-caps below Not-ICP). It stays
   faithful to the ICP — a narrow ICP yields narrow signals.
2. **Score** — the worker's `scoreEntities` cron (every 10 min) stakes an `icp_fit`
   prediction on every scoreable person; `scoreIntentCron` (every 6 h) stakes the decaying
   `intent_score`. Neither scores an entity that lacks firmographic claims — an
   unenriched, name-only lead never gets a hollow `0`.

See [ICP Scoring](./icp-scoring.md) and [Intent Score](./intent-score.md) for the model
itself.

---

## 2. Enrichment on connect

### 2.1 The trigger

**Every integration you connect fires exactly one enrichment run.** The trigger is
`enqueueWorkspaceHistoryBackfill()` (`apps/api/src/lib/historyBackfill.mjs`), wired into
the three connect paths:

| Connect path | File | Reason tag |
| --- | --- | --- |
| Generic providers (Fathom, Fireflies, Instantly, …) | `apps/api/src/providers/connect.mjs` | `connect:<name>` |
| Gmail OAuth callback | `apps/api/src/routes/api/oauthGoogle.mjs` | `connect:gmail_oauth` |
| LinkedIn / Unipile upsert | `apps/api/src/services/linkedin.mjs` | `connect:linkedin` |

### 2.2 What it enqueues, and the debounce

The backfill enqueues a `contact_enrichment_jobs` row for the workspace's existing
contacts — but **only those a new source can actually match**: contacts with an email or
a LinkedIn URL (`.or('email.not.is.null,linkedin_url.not.is.null')`). A name-only lead
is skipped, because a freshly-connected email tool has no key to match it on.

It is **debounced**: if a job is already `pending` or `running`, the call logs and
returns null. Connecting three tools back-to-back produces one run, not three.

### 2.3 What the run actually does (the worker)

The API only records the job. The **worker** drains `contact_enrichment_jobs` and runs
`contactHistoryEnricher` (`apps/worker/src/services/contactHistoryEnricher.mjs`), which
scans each connected integration for **past** interactions and folds them onto the
matching accounts. The per-source behaviour:

| Source | What runs |
| --- | --- |
| **Fathom / Fireflies** | The full meeting pipeline (`scanFathomReplay` / `scanFirefliesReplay`): fetch each transcript → `resolveMeetingContacts` (email + speaker-name match, **create-missing**) → save the transcript document → extract **facts (Haiku)** and **insights (GLM)** → intent. The two share `reprocessFathom` / `reprocessFireflies` with the live webhook, so backfill and live ingestion can never drift. |
| **Gmail / SMTP / Calendar** | Bulk scans mapping past emails and calendar meetings onto contacts by address. |
| **Instantly / other sequencers** | Reply history backfilled and enriched. |

Two enrichment axes run against the same accounts:

- **History** (above) — what *already happened* across the connected tools.
- **Data waterfall** — `enrichContact` (Prospeo → Apollo) fills missing emails and
  firmographics. Gated: it runs for email-only + LinkedIn-connected contacts, on the
  workspace's own provider keys (bring-your-own-keys; see §3.3).

The frontend surfaces an **"Enrichment run finished"** summary (imported / now-active /
cold-leads, sources scanned) when the job completes.

### 2.4 The rule, in one line

Connect a tool → it backfills *that tool's* history for your existing accounts, **once,
debounced**, using the shared live-ingestion pipeline. Nothing you connect re-runs a
scan another tool already owns.

---

## 3. Billing: the active-account meter

### 3.1 What is metered

The billed unit is **active accounts** — *companies you have actually had a conversation
with* (a reply, a meeting, a DM), counted by the `team_active_accounts()` SQL function.
Deliberately, this counts the same set the signal extractor fires on, so the meter can
never drift away from the cost it represents.

Everything else is **unlimited on every plan**, because everything else is free to serve:
retrievals (deterministic Postgres reads), records and lead imports (zero model calls),
and seats. See `apps/api/src/lib/plans.mjs` for the plan table.

| Plan | Active-account cap |
| --- | --- |
| Free | 100 |
| Start ($29) | 500 |
| Pro ($99) | 2,500 |
| Custom | unlimited |

### 3.2 The 150-uploads-on-Free case

This is the case that surprises people, and it is the whole point of the model.

**Uploading 150 records on the Free plan does not put you 50 over the 100 cap.** Those
150 are **cold leads** — entities that exist, get enriched, and are searchable, but are
**not active** until a conversation makes them so.

- **The import succeeds.** `requireAccountsBalance`
  (`apps/api/src/lib/access.mjs`) only blocks (`402`) when the team is *already* in the
  `restricted` state; otherwise it **fails open** — a metering bug must never stop a
  customer from working.
- **Nothing counts yet.** If the 150 are cold, the active count is whatever you have
  genuinely engaged, typically far under 100.
- **The meter moves only as accounts go active.** When companies you have conversed with
  cross the cap, the state machine in `getTeamAccountsState()` (`apps/api/src/lib/plans.mjs`)
  engages:

| State | Condition |
| --- | --- |
| `ok` | under the cap |
| `warn` | approaching |
| `grace` | at/over the cap — a **3-day** window opens (`OPS_GRACE_DAYS = 3`; the first-crossing timestamp is recorded in `team_accounts_grace`) |
| `restricted` | 3 days elapsed → write actions return `402 upgrade_required` |

During grace the workspace keeps working and **incoming signal is never dropped**. After
grace, the `402` message points to billing and offers the escape hatch: **archive
accounts you are not working** — archived accounts keep all their history and stop
counting. No forced upgrade, no data loss.

### 3.3 Enrichment is not separately metered

`requireEnrichmentQuota` passes through whenever a plan's `enrichmentsPerMonth` is `0`,
which is every current plan. Enrichment runs on the workspace's **own provider keys**
(bring-your-own-keys), so it costs the platform nothing and is uncapped. Metering only
re-engages if a future plan reintroduces a managed allowance (`> 0`).

### 3.4 Self-host bypasses all of it

`isSelfHosted()` short-circuits every gate. A self-hosted operator brings their own
`ANTHROPIC_API_KEY` and pays their own extraction bill, so there is nothing to meter.

---

## 4. The lifecycle in one pass

```
npx @opennous/cli init
      │
      ▼
ConnectGate ──► draft ICP from website ──► writeIcp() ──► foundation + note + cache
      │                                          │
      │                                          └──► seedScorecardFromMemory ──► scoreEntities / scoreIntentCron
      ▼
connect an integration
      │
      ▼
enqueueWorkspaceHistoryBackfill()  (debounced; email/LinkedIn contacts only)
      │
      ▼
worker: contactHistoryEnricher
      ├─ Fathom/Fireflies ──► transcript → resolve+create → facts (Haiku) + insights (GLM) → intent
      ├─ Gmail/SMTP/Calendar ──► bulk interaction scans
      └─ data waterfall (Prospeo → Apollo) on own keys
      │
      ▼
accounts that conversations make ACTIVE ──► team_active_accounts() ──► the meter
      └─ over cap: warn → grace (3 days) → restricted (402, archive to clear)
```

---

## 5. Where the code lives

| Concern | File |
| --- | --- |
| ICP write path (the one homes-in-sync function) | `apps/api/src/lib/icp.mjs` (`writeIcp`, `hasIcp`) |
| ICP template | `apps/api/src/lib/icpTemplate.ts` |
| Scorecard seed from the ICP | `apps/api/src/lib/scorecardSeed.mjs` |
| Enrichment trigger + debounce | `apps/api/src/lib/historyBackfill.mjs` |
| Connect paths that fire it | `providers/connect.mjs`, `routes/api/oauthGoogle.mjs`, `services/linkedin.mjs` |
| The enrichment worker | `apps/worker/src/services/contactHistoryEnricher.mjs` |
| Meeting pipeline (shared live + backfill) | `apps/worker/src/webhooks/handlers/fathom.mjs`, `fireflies.mjs` |
| Plans, caps, account state machine | `apps/api/src/lib/plans.mjs` (`getTeamAccountsState`, `OPS_GRACE_DAYS`) |
| Request-time gates | `apps/api/src/lib/access.mjs` (`requireAccountsBalance`, `requireEnrichmentQuota`) |

See also: [ICP Scoring](./icp-scoring.md) · [Intent Score](./intent-score.md) ·
[Identity Resolution](./identity-resolution.md) · [Claims (Intel)](./claims.md).
