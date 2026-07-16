<div align="center">
  <img src=".github/assets/nous-icon.svg" alt="Nous" height="120" />
</div>

<div align="center">

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![npm](https://img.shields.io/npm/v/@opennous/mcp)](https://www.npmjs.com/package/@opennous/mcp)
[![Discord](https://img.shields.io/badge/Discord-Join-5865F2?logo=discord&logoColor=white)](https://discord.gg/HrM5TG5F5)

</div>

<div align="center">
  <a href="https://opennous.cloud">Website</a> ·
  <a href="https://docs.opennous.cloud">Docs</a> ·
  <a href="https://docs.opennous.cloud/public-api/introduction">Public API</a> ·
  <a href="https://docs.opennous.cloud/mcp/introduction">MCP Server</a> ·
  <a href="https://discord.gg/HrM5TG5F5">Discord</a>
</div>

# Nous

**The context graph for agentic GTM teams.** Nous centralizes the data scattered across your GTM tools into one context graph, resolving every person and company into a single record your agents read in one call instead of stitching six tools together and guessing. Open source, with a [hosted version](https://opennous.cloud).

---

## Why Nous?

- **Every account in one record.** Nous resolves the emails, profiles, and duplicates scattered across your tools into one person or company, so every agent works from the same complete account.
- **Every fact carries its source.** Each detail comes with where it came from and how fresh it is, so an agent acts on what it can trust and you can trace any answer back.
- **The whole account in one call.** An agent reads the full context in a single request instead of stitching six tools together and rebuilding it every time.
- **Consistent across every agent.** The more agents you run, the more this matters. They all read the same context, so the same account returns the same answer.
- **Trained on your own data.** Every reply, meeting, and closed deal feeds back into the graph, sharpening ICP fit on your own outcomes so it gets more accurate over time.
- **Purpose-built for GTM.** Accounts, buying committees, signals, and ICP fit are modeled out of the box, mapped to how GTM teams actually work.

## The context graph

Nous is built on three layers. Every signal from your tools lands as an **observation**, immutable evidence of something that happened or was said. Observations resolve to **entities**, one canonical record per person and company. From the evidence on each entity, Nous derives **claims**, the current belief about a fact with its confidence and freshness. Store the evidence, derive the truth. Throw the claims away and replaying the observations rebuilds them.

```mermaid
flowchart LR
  OBS[Observations] -->|resolve identity| ENT[Entities]
  ENT -->|derive| CLM[Claims]
  classDef s1 fill:#ffffff,stroke:#6B7280,color:#6B7280;
  classDef s2 fill:#ffffff,stroke:#7C3AED,color:#7C3AED;
  classDef s3 fill:#ffffff,stroke:#F59E0B,color:#F59E0B;
  class OBS s1;
  class ENT s2;
  class CLM s3;
```

→ [The Context Graph](docs/context-graph.md)


## How it works

```mermaid
flowchart TD
  SRC[Your GTM tools: CRM, inbox, calendar, LinkedIn, enrichment, signals] -->|ingest| OBS[Observations: append-only evidence]
  OBS -->|resolve identity| ENT[Entities: one per person and company]
  ENT -->|derive| CLM[Claims: current beliefs with confidence and freshness]
  ENT -->|connect| REL[Relationships: buying group, works_at]
  CLM -->|score| DEC[Decision context: ICP fit, intent, next best action]
  REL --> DEC
  DEC -->|get_context, one call| AG[Your agent acts]
  AG -->|record| OBS
```

Every signal becomes immutable evidence against a resolved entity. Nous derives the current beliefs, scores fit, and serves the whole account in one call. The outcome flows back as new evidence, so the account gets truer over time.


## Core endpoints

| Endpoint | What it returns |
|---|---|
| `get_context(focus, intent)` | the whole account context for a task, token-budgeted and agent-shaped |
| `get_account(id)` | the full record for one person or company, by email or id |
| `query(scope)` | filter activity across people and accounts |

## Quick start

Connect Nous to your agent over MCP:

```bash
claude mcp add nous -- npx -y @opennous/mcp
```

On self-host, point it at your own instance by adding `-e NOUS_API_URL=https://api.yourdomain.com`.

Your agent now has `get_context`, `get_account`, and `query`. The examples below show the REST API and its JSON; over MCP your agent gets the same data as a token-budgeted summary.

### `get_context`

The whole account context for a task, token-budgeted and agent-shaped. `focus` takes a domain, email, LinkedIn URL, or id, and every fact carries its confidence and freshness:

```bash
curl -X POST https://api.opennous.cloud/v2/context \
  -H "Authorization: Bearer $NOUS_API_KEY" \
  -d '{"focus":"acme.com","intent":"account_review"}'
```

```json
{
  "entity": { "id": "ent_acme", "type": "company" },
  "summary": "Acme Corp, ~500 employees. Sarah Chen promoted to VP RevOps 3mo ago, just deployed Salesforce. 12 SDR roles posted in 7 days. Open deal $45k, no economic buyer.",
  "claims": [
    { "property": "signal.hiring", "value": "12 SDR roles in 7 days", "confidence": 0.95, "freshness": "fresh", "epistemic_class": "observed", "last_observed_at": "2026-06-10" },
    { "property": "signal.stack", "value": "Salesforce deployed 45d ago", "confidence": 0.88, "freshness": "aging", "epistemic_class": "observed", "last_observed_at": "2026-04-30" }
  ],
  "stakeholders": [
    { "entity_id": "ent_sarah", "name": "Sarah Chen", "role": "VP RevOps" }
  ],
  "timeline": [
    { "when": "2026-06-05T14:00:00Z", "type": "call", "tier": "brief", "summary": "competitor name-dropped" }
  ],
  "predictions": [ { "kind": "icp_fit", "value": "high", "confidence": 0.82 } ],
  "icp": { "score": 82 },
  "meta": { "token_estimate": 1200, "claims_returned": 12, "claims_total": 47, "timeline_events": 9 }
}
```

### `get_account`

The full record for one person or company, by email or entity id. `claims` is keyed by property, each with confidence, freshness, and how many times it's been observed.

```bash
curl https://api.opennous.cloud/v2/accounts/sarah@acme.com \
  -H "Authorization: Bearer $NOUS_API_KEY"
```

```json
{
  "entity_id": "ent_sarah",
  "type": "person",
  "claims": {
    "title": { "value": "VP RevOps", "confidence": 0.94, "freshness": "fresh", "epistemic_class": "observed", "observation_count": 3, "last_observed_at": "2026-05-30" }
  },
  "recent_observations": [
    { "kind": "event", "property": "interaction.call", "source": "fireflies", "observed_at": "2026-06-05" }
  ],
  "icp": { "score": 82 }
}
```

### `query`

Filter activity across people and accounts with a structured `scope`. Add a `question` for semantic ranking, and set `return: "entities"` to get one row per account:

```bash
curl -X POST https://api.opennous.cloud/v2/query \
  -H "Authorization: Bearer $NOUS_API_KEY" \
  -d '{"scope":{"property":"interaction.email","since_days":30},"return":"entities","question":"accounts that replied positively then went quiet"}'
```

```json
{
  "return": "entities",
  "matched": 128,
  "returned": 25,
  "items": [
    { "entity_id": "ent_acme", "entity_name": "Acme Corp", "matches": 9,
      "most_recent_at": "2026-05-28", "most_recent_type": "email_replied", "most_recent_source": "gmail" }
  ],
  "rollups": { "by_type": {}, "by_source": {} },
  "meta": { "token_estimate": 900 }
}
```

## Run Nous from your agent

Nous is operated by your **agent**, not by clicking through an app. Point any MCP host at it in one step:

- **Claude Code**: `/plugin marketplace add NousC/opennous` then `/plugin install nous@nous-plugins`
- **Codex**: add to `~/.codex/config.toml`:
  ```toml
  [mcp_servers.nous]
  command = "npx"
  args = ["-y", "@opennous/mcp"]
  ```
- **Cursor / any MCP host**: add to `mcp.json`:
  ```json
  { "mcpServers": { "nous": { "command": "npx", "args": ["-y", "@opennous/mcp"] } } }
  ```

Then sign in once. It opens your browser, mints a workspace key, and saves it to `~/.nous/config.json`, so there is no key to paste:

```bash
npx @opennous/cli login    # on self-host, add --url https://api.yourdomain.com
```

Now hand your agent the setup itself. Tell it **"Set me up, onboard my workspace and build my playbook,"** and it walks setup in order: profile, connect Gmail / LinkedIn / a note-taker, enrichment, import your CRM contacts.

→ [Full MCP docs](https://docs.opennous.cloud/mcp/introduction)


## Self-host

Run the whole stack (API, worker, MCP server, frontend, Redis, and Caddy for automatic HTTPS) with Docker Compose on your own infrastructure. You bring a [Supabase](https://supabase.com) project (Postgres + auth) and an Anthropic API key.

**Prerequisites**

- A Linux server with Docker + Docker Compose
- A [Supabase](https://supabase.com) project (free tier is fine)
- An [Anthropic API key](https://console.anthropic.com)
- Three DNS records (`app`, `api`, `mcp`) pointing at your server

```bash
# 1. Clone
git clone https://github.com/NousC/opennous.git && cd nous

# 2. Configure
cp nous.env.example nous.env
#    Fill in APP_DOMAIN / API_DOMAIN / MCP_DOMAIN, your Supabase URL + keys,
#    and ANTHROPIC_API_KEY. Generate the encryption key:
openssl rand -hex 32      # paste the output into ENCRYPTION_KEY=
#    SELF_HOSTED=true is already set, it runs the open primitive, unmetered.

# 3. Create the database
#    Open supabase/schema.sql in your Supabase SQL editor and run it once.

# 4. Launch (Caddy provisions TLS automatically once your DNS resolves)
docker compose --env-file nous.env up -d --build
```

Open `https://app.yourdomain.com` and create the first account, and it becomes the **owner**. To close public registration afterward, set `DISABLE_SIGNUPS=true` in `nous.env` and re-run `./update.sh`. Update any time with `./update.sh` (it pulls the latest, rebuilds, and flags new DB migrations).

**Point your agent at your instance.** On self-host the MCP connect command takes your **own API URL**, so pass it as an env var and the agent talks to your server, not the cloud:

```bash
claude mcp add nous -e NOUS_API_URL=https://api.yourdomain.com -- npx -y @opennous/mcp
```

Then sign in against your instance. It mints a workspace key and saves it (plus the URL) to `~/.nous/config.json`, which the MCP reads automatically:

```bash
npx @opennous/cli login --url https://api.yourdomain.com
```

→ Full walkthrough in the **[self-host guide](https://docs.opennous.cloud/installation/docker-compose)**.

For local development against your Supabase project without Docker:

```bash
git clone https://github.com/NousC/opennous.git && cd nous
cp .env.example .env        # fill in Supabase + Anthropic keys
pnpm install && pnpm dev
```

## Tech stack

| Layer | Stack |
|---|---|
| API | Node.js (ESM), Express |
| Frontend | Vite, React, shadcn/ui |
| Database | Supabase (PostgreSQL + pgvector) |
| MCP | `@modelcontextprotocol/sdk` |
| AI | Anthropic Claude |
| Package manager | pnpm workspaces |

## Contributing

We love contributions. See the [Contributing Guide](CONTRIBUTING.md) before opening a PR.

## License

Nous is licensed under the GNU Affero General Public License v3.0 (AGPL-3.0). You are free to use, modify, and self-host it. If you run a modified version as a network service, the AGPL requires you to make your source available to that service's users. Nous Cloud runs this same open core, hosted and managed, with the team layer (CRM sync, lead lists, the ICP model) added on top. See the [LICENSE](LICENSE) file for the full text.

## Compliance

- We do not scrape LinkedIn or any third-party platform.
- Signal ingestion uses only official OAuth flows and approved webhooks.
- No customer data is sent to third parties without explicit configuration.
