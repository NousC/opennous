# Slack bot — @Nous in your channels

`@Nous` lives in a customer's Slack channels and answers cited questions about
their accounts, pulling from their Nous graph. Same brain as the in-app Threads
agent (`runPlaygroundTurn`), reached from Slack instead of the web app.

```
@mention  →  POST /slack/events  →  resolve team_id → workspace + bot token
          →  plan gate (inAppAgent / Custom)  →  resolve channel→account + asker
          →  runPlaygroundTurn (Sonnet, cited)  →  chat.postMessage in-thread
```

Multi-tenant: one app, one Events URL. Every request carries a `team_id`;
`findWorkspaceByTeam` maps it to the right workspace and that team's bot token.

## Architecture

| Concern | Where |
|---|---|
| Install (OAuth, bot token) | `apps/api/src/routes/api/oauthSlack.mjs` |
| Inbound events + `/nous` command | `apps/api/src/routes/slackEvents.mjs` |
| Helpers (sig verify, tenant lookup, plan gate, post, mrkdwn) | `apps/api/src/lib/slack.mjs` |
| Channel↔account mapping REST (for Settings UI) | `apps/api/src/routes/api/slackChannels.mjs` |
| `slack_channel_map` table | `supabase/migrations/2026_07_15_slack_channel_map.sql` |
| Route mounting (raw body before `express.json`) | `apps/api/src/index.mjs` |
| Distribution manifest | `apps/api/src/routes/slack-app-manifest.yaml` |

The bot token lives on the existing Slack row in `workflow_provider_connections`
(`encrypted_credentials.bot_token`, encrypted); `slack_team_id` and `bot_user_id`
stay plaintext so the Events endpoint can look the connection up by team.

## Setup (once, as Nous)

1. **Create the app** at https://api.slack.com/apps → *From a manifest* → paste
   `apps/api/src/routes/slack-app-manifest.yaml`. Adjust the URLs if your API
   isn't at `api.opennous.cloud`.
2. **Env vars** on the API service:
   ```
   SLACK_CLIENT_ID=...
   SLACK_CLIENT_SECRET=...
   SLACK_SIGNING_SECRET=...      # REQUIRED in prod — unsigned requests are rejected
   # SLACK_REDIRECT_URI=...      # optional; defaults to $API_URL/api/oauth/slack/callback
   ```
3. **Migrate**: apply `2026_07_15_slack_channel_map.sql` (adds `slack_channel_map`
   + the team-lookup index).

## How a customer turns it on

1. Nous → **Settings → Integrations → Slack → Add to Slack** (hits the existing
   `/api/oauth/slack/authorize`, now requesting bot scopes). They approve; Nous
   stores their bot token keyed to their `team_id`.
2. In Slack, invite the bot: `/invite @Nous`.
3. Bind a channel to an account: `/nous link acme.com`
   (or leave it — the bot infers the account from the channel name + question).
4. Ask: `@Nous when did we last talk to their ops lead?`

`/nous` commands: `link <company>`, `unlink`, `status`.

## Plan gate

The answer runs Sonnet, so it gates on `inAppAgent` — the **Custom** plan, same
as the in-app agent (Slack is already in `CUSTOM_ONLY_INTEGRATIONS`). A workspace
without it gets a friendly "part of the Custom plan" reply, not silence.

## Deliberately deferred (v1 scope)

- **"Add to Slack" button** in the frontend integrations page (the OAuth endpoint
  is ready; this is a small frontend wire-up).
- **Settings UI** for channel↔account mapping (the REST API at
  `/api/slack/channels` is built; the UI is a drop-in).
- **Deep per-member content scoping** — v1 attributes the asker correctly; the
  "share the map, scope the mailbox" raw-content read-layer is the separate
  privacy-model task.
- **Answering via slash command** (`/nous <question>` with a delayed
  `response_url`) — for now, questions go through `@mention`.
