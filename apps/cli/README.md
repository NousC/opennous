# @opennous/cli

Nous CLI — set Nous up, connect it to your coding agent, and read the Context API from your terminal.

## Get started

One command. It signs you in (creating your account if you don't have one), registers the Nous MCP server with the agent on your machine, and hands off. The same command on macOS, Linux, and Windows (needs [Node 18+](https://nodejs.org)):

```bash
npx @opennous/cli@latest init
```

Then tell your agent *"set up my Nous workspace"* — it reads your project, finds your ICP (or drafts one), and syncs it. On self-host, add `--url https://api.yourdomain.com`.

## Event tracking

`nous track init` detects your stack (Next.js, Node, Python), writes a small `nous.js` (or `nous.py`) module with three helpers, and updates your `.env`:

- **`trackSignup({email, ...})`** — fires `interaction.signed_up` + initial `state.stage`
- **`handleStripeEvent(event, {customerEmail})`** — fires `interaction.subscription_started / updated / canceled` and flips `state.stage` (Customer / Churned)
- **`track(focus, property, value)`** — escape hatch for any other event

The generated module is plain code you own. Read it, edit it, or delete it. (This was `nous install`; that name still works but is deprecated.)

## Other commands

```bash
nous auth login --key <your-key>     # save your API key
nous context <email>                  # engineered context for a person
nous account <email>                  # full record with epistemics + timeline
nous record <email> --property X --value Y
nous query --property stage --value Customer
nous attention                        # surface what changed recently
nous verify <email> <property>        # confirm a claim is current
```

Run `nous --help` for the full list.

## Auth

`NOUS_API_KEY` env var, or `nous auth login --key <key>`. Mint a key at [app.opennous.cloud](https://app.opennous.cloud) → Settings → API Keys.

## Self-hosting

Set `NOUS_API_URL` to your own deployment.

## License

AGPL-3.0
