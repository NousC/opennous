# Nous Claim Contract v1 (the write contract for the revenue plugin)

The single, versioned contract every skill emits and the engine consumes. Grounded in the
existing `/v2/observations` spine + `@nous/core` `recordObservation` — this documents what is
real today and the (small, additive) fields the plugin needs exposed.

`schema_version: 1`

---

## 1. Write doors — structured only (NO document storage)

| Door | Route | Carries |
|---|---|---|
| `record` | `POST /v2/observations` | structured observations — attributes, interactions, signals, deal state |
| `record_insight` | `POST /v2/insights` | workspace-level insights about US (product/positioning/market/buyer) |

Nous stores ONLY structured, distilled data. It does **NOT** store documents — no transcripts, no
prose briefs. Both the raw transcript AND the prose meeting brief live in the operator's **git**;
observations carry a `source_ref: git://…` pointer. The **AI Overview summary + Key Concerns** and
**Deal Health** are DERIVED server-side from these observations — the agent never writes them.

Categorized **Intel facts** (Preference / Objection / Competitors / General) are short *structured*
facts (not documents) and belong in Nous — see §4. `save_note` (document storage) is intentionally
NOT part of the plugin surface. If the app wants a one-line account summary, the agent records it
as a `state` fact via `record` — never as a stored document.

---

## 2. `record` payload

```jsonc
{
  "focus": "<entity UUID | email | linkedin_url | domain>",   // precise identifier — never a bare name
  "schema_version": 1,
  "observations": [
    {
      "kind": "event" | "state",        // event = an interaction happened; state = a fact is true
      "property": "interaction.meeting_held",   // from the vocabulary below
      "value": { /* event detail | fact value */ },  // null = the fact ended
      "source": "fireflies",            // provider slug: fireflies|gmail|granola|linkedin|hubspot|agent|…
      "method": "extraction",           // api|webhook|extraction|inference|user_input
      "observed_at": "2026-03-14T15:00:00Z",  // WHEN it happened — REQUIRED for backfill (else stamped now)
      "external_id": "ff_txn_9182:interaction.meeting_held",  // idempotency key (see §5)
      "source_ref": "git://acme-revops/raw/acme-corp/2026-03-14-fireflies-9182.md",  // pointer to raw in their git
      "content_hash": "<sha256 of the raw file>"   // for later untampered verification
    }
  ]
}
```

### 2.1 Raw storage layout (locked — one folder per account)
Raw lives in the operator's git, filed **one folder per account** so a human can open an account and
read its whole history. Both writers — the agent (backfill/sync) and the app's ongoing server push —
use the same layout, so `source_ref` always resolves:
```
raw/<account-slug>/<YYYY-MM-DD>-<source>-<externalId>.md   ← raw transcripts / emails
briefs/<account-slug>/<...>.md                              ← prose briefs
.nous/raw.json                                              ← marker { workspace_id, convention, repo }
```
- `<account-slug>` = the account the item belongs to (the `focus`), slugified.
- The path is deterministic from `(account, source, externalId)`, so a re-run overwrites in place —
  never a duplicate; **audit-first** (skip if the file already exists).
- `source_ref` = `git://<repo>/raw/<account-slug>/<file>.md`; `resolveRaw` follows it (see §9).
- The plugin's canonical spec: `revenue-plugin` → `skills/sync/references/raw-storage.md` — keep in sync.
- **Ongoing push** to the same repo is the optional last step, connected at
  `https://app.opennous.cloud/settings?section=repo`. Onboarding + backfill work fully without it.

- **Resolution:** `focus` must be a precise identifier. The engine resolves it to an entity, or
  creates one. For a person, include `first_name` / `last_name` as `state` observations in the
  same call — the resolver uses them for its name-fallback tier (attaches to an existing record
  instead of forking a duplicate). The agent NEVER merges/creates entities itself.
- **Never overwrite:** you only ever append observations; the engine derives the current claim
  (freshest × highest-confidence), keeps conflicts, and heals on retract.
- `raw` is intentionally omitted (or `null`) — raw stays in git; `source_ref` + `content_hash`
  preserve provenance. `resolveRaw` follows the `git://` scheme to fetch + verify on demand.

---

## 3. `record_insight` payload (insights about US)

```jsonc
{
  "insights": [
    { "category": "product" | "positioning" | "market" | "buyer",
      "content": "They want native Salesforce write-back, not Zapier",   // one sentence, OUR perspective
      "quote": "we'd buy tomorrow if it wrote back to SFDC",              // verbatim, optional
      "speaker": "VP RevOps" }                                             // name or role, optional
  ],
  "source_label": "Acme discovery call",
  "occurred_at": "2026-03-14T15:00:00Z"
}
```

Workspace-level — no `focus` (insights are about us, not an account). The engine normalizes the
category, skips near-duplicates already present, and writes both the Vault-editable markdown doc
and the structured `insight_items` store (`source: 'external'`) that the Insights page + theme
clustering read. Idempotency is content-based dedup today (skip if the leading clause already
appears); an `external_id` can be added later.

---

## 4. Property vocabulary (the ontology)

**State (facts) — person:** `first_name` · `last_name` · `job_title` · `seniority` ·
`department` · `company` · `linkedin_url` · `email` · `phone` · `city` · `country` ·
`reachability_status`
**State — company:** `domain` · `keywords` · `description`
**State — deal:** `stage` · `deal.value` · `deal.proposal_amount`
**State — scoring features:** `signal.<class>` (class ∈ stack|hiring|momentum|friction|intent|domain),
value `{ detected, implies, score(0-10), approach, angle }` · `exclusion.<x>` (disqualifier)
**State — Intel (atomic memory about the contact):** `intel` with value
`{ category, content, label? }` — category ∈ preference | objection | competitor | buying_signal |
budget | timing | authority | general. Routed server-side to a `note.<uuid>` claim (the Intel tab /
get_account `facts`). One call per fact.

**Event (interactions):** `interaction.meeting_held` · `interaction.meeting_scheduled` ·
`interaction.email_sent` · `interaction.email_received` · `interaction.email_reply` ·
`interaction.call_held` · `interaction.linkedin_message`

New properties are additive; keep to this namespace so scoring/reporting/attention keep reasoning.

---

## 5. Idempotency (the rule that makes backfill + retries safe)

Dedup key = **`(workspace_id, source, external_id)`** (partial unique index; only rows WITH an
`external_id` dedup). Re-recording the same `external_id` is a no-op.

- One raw item (a transcript) produces MANY observations → each needs a **distinct** `external_id`,
  or they collide. Convention: `"<sourceItemId>:<property>"` (add `:<entityId>` when the same
  property is recorded for multiple people from one item).
- Backfill and ongoing MUST derive the SAME `external_id` for the same underlying event, so turning
  on ongoing never duplicates what backfill already filed.
- Observations WITHOUT an `external_id` are plain-appended (by design, e.g. enrichment snapshots) —
  so always set one for anything a re-run could touch.

---

## 6. What M0 shipped (additive, back-compatible, syntax-checked, NOT deployed)

1. **MCP `record` tool** — exposed `observed_at`, `external_id`, `source_ref`, `content_hash`,
   `method` on each observation (previously only `kind/property/value/source`). Unblocks backfill
   (historical timestamps + idempotency + git raw-pointers).
2. **`/v2/observations` route** — forwards `source_ref`/`content_hash` to `recordObservation`
   (it already forwarded `observed_at`/`external_id`/`raw`).
3. **`record_insight` MCP tool + `POST /v2/insights` route** — the insights write door →
   `appendInsights`. Insight extraction now runs on the agent's tokens; the distilled insights land
   here (previously reachable only by the server-side worker).

## 7. The plugin surface (6 primitives)

**Writes (2):** `record` (observations) · `record_insight` (insights). No document storage.
**Reads (4):** `get_context` · `get_account` · `query` (incl. semantic fact search, `facts:true`) · `score`.

`search` folds into `query`; `save_note`/document storage is out; `record_signal` folds into
`record` (a plain `signal.*` observation triggers the same rescore). Legacy tools stay on the
server for the app — the plugin just allowlists these six.

## 8. Intel-fact fidelity — ported vs pending

Intel facts are `note.<uuid>` claims; `record` accepts `kind:'state', property:'intel',
value:{category, content, label?, about?, entity?, stance?, status?, hardness?}` and routes to
`saveNote`. What the `record` route now does (ported from the worker's `persistFacts`):
- ✅ **Pronoun guard** — drops facts that address the subject in 1st/2nd person (garbage on the card).
- ✅ **Context metadata** — competitor `entity`/`stance`, objection `status`/`hardness`, `about`,
  `extraction_source`, `source_ref`, `graph_layer` (what `computeDealHealth` reads).
- ✅ `saveNote` structures the claim + embeds it. One write door, no read-path change.

**Still pending (worker/LLM passes not yet in the `record` route):**
- Merge/supersede across a batch (`decideMergeBatch` → deactivate the superseded note) — a re-run
  can currently duplicate a fact (also: intel has no `external_id` dedup).
- Company-vs-person routing (`about:'company'` should fan the fact to the company entity).
- Graph-edge extraction (REPORTS_TO etc.) + Connections/authority → buying-committee mentions.
- Buying-signal → real-time stage + intent recompute (`recomputeEntityStage`/`runIntentScoring`).
  Cleanest fix: extract `persistFacts`' deterministic core into `@nous/core` and run it from both
  the worker and the `record` route; keep the LLM passes (merge/edges) as an async worker over new
  `note.*` claims. Not blocking `nous-sync`, but needed before we lean on re-runnable backfills.

## 9. Later milestones
- ✅ **The 6-primitive surface — shipped and made the ONLY surface.** `createServer()` registers
  exactly the six; there is no full/legacy 36-tool mode any more (Nous is fully a revenue plugin).
  **One MCP server, six tools — this is all we will have.** See [`README.md`](./README.md) §2.
- Prune the ~30 now-inert `tool(...)` registrations from `apps/mcp/src/server.js` (dead code).
- `git://` fetch branch in `resolveRaw` (read raw back from git).
- `external_id` on insights + intel for stronger backfill idempotency.
