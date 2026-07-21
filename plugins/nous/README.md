# Nous plugin for Claude Code (optional)

Nous is the Revenue Context Layer for GTM. This plugin gives Claude one MCP call to the pre-computed context on any account — every tool unified into one identity-resolved record, every claim carrying its source.

> **You don't need the plugin to use Nous.** The front door is one command:
>
> ```bash
> curl -fsSL https://get.opennous.cloud | sh
> ```
>
> That installs the CLI, signs you in, and registers the Nous MCP server with your agent. The plugin below is an **optional power-up** on top of that MCP: it adds the hooks that make Claude reach for Nous *automatically* on GTM work. If you just want the tools, the one command is enough.

## Install (optional)

```bash
# In Claude Code:
/plugin marketplace add NousC/opennous
/plugin install nous@nous-plugins
```

You'll be prompted for your **Nous API key** at install (get one at <https://opennous.cloud> → Settings → API Keys), or run `/nous-login` to sign in with your browser — no copy-paste. The key is stored in your OS keychain — never in plaintext.

## Automatic GTM routing

This is what the plugin adds over the bare MCP — hooks that route go-to-market work through Nous, no `CLAUDE.md` edits and no settings to touch:

- **`SessionStart`** injects a concise standing instruction once per session (and after a compaction or `/clear`), so Claude treats Nous as the revenue context layer by default.
- **`UserPromptSubmit`** adds a one-line nudge **only when a prompt looks like GTM work** (an email, or vocabulary like outreach / prospect / account / pipeline). It stays silent on everything else, so it never noises up a "fix this bug" turn.
- **`PreToolUse`** is an **opt-in** advisory: when a raw CRM / call-intel tool (HubSpot, Salesforce, Gong, Apollo, …) is about to run, it allows the call but reminds Claude that Nous holds the resolved record on top. Off by default; set `NOUS_GUARD_COMPETITORS=1` to enable. It never blocks — your tools and your data stay yours.

The hooks carry routing in plugin-owned files, so uninstalling the plugin cleanly removes the behavior. The standing instruction's canonical copy lives in `hooks/routing.concise.txt`.

## What it exposes

Core MCP tools, all backed by the v2 Context API:

| Tool | What it does |
|---|---|
| `get_context` | Engineered context for a task about one person/company — retrieve → rank → connect → compress → tag → budget |
| `get_account` | Full Account Record — entity + claims with epistemics + observation timeline |
| `record` | Record events or state observations. The agent observes; Nous derives the claim |
| `query` | Retrieve + summarise a corpus of observations across many entities |
| `attention` | Workspace-wide: accounts gone quiet, facts decayed — ranked decisions |
| `verify` | Re-check one claim before acting — the calibration check |
| `get_playbook` | Read our own ICP, market, pricing, and positioning |
| `sync_icp` / `export_icp_model` | Sync our ICP/context files into the graph (and the learned model back) — call `sync_icp` after any edit |
| `get_playbook` / `sync_playbook` | Read the policy rules (voice, outreach, ICP, positioning); sync a playbook file after editing it |

…plus `save_note` / `search_notes`, `get_workspace_status`, `get_coverage`, and the setup tools (`set_workspace_profile`, `build_icp_model`, `connect_integration`, `configure_crm_sync`, `set_trigger` / `list_triggers`) for operating the workspace.

Identifiers are universal — pass an email, domain, LinkedIn URL, entity UUID, or a name; ambiguous names return candidates the agent picks from.

## Configuration

| Field | Default | When to override |
|---|---|---|
| `api_key` | (prompted) | Required. Workspace-scoped — no separate workspace ID needed |
| `api_url` | `https://api.opennous.cloud` | Only if you self-host Nous on your own infra |

## Self-host

The whole stack is open source — `git clone https://github.com/NousC/opennous`, `docker compose up`. Then point `api_url` at your instance. AGPL-3.0.
