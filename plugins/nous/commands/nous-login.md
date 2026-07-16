---
description: Sign in to Nous in your browser and save your API key (no copy-paste)
---

Sign the user in to Nous using the browser device-login flow, then confirm the tools work.

Run this command in the shell:

```bash
npx -y @opennous/cli login
```

It prints a URL and opens the browser. The user approves in the browser (they sign in if needed), a fresh workspace-scoped API key is minted and saved to `~/.nous/config.json`, and the command prints `Signed in`.

The Nous MCP server reads that key on its next call — no restart needed. Once login succeeds, confirm it worked by calling the `get_workspace_status` tool and telling the user what's set up and what to do next (usually onboarding the workspace and building the GTM playbook).

If the command reports it timed out or was denied, run it again. If `npx` isn't available, tell the user to paste a key from https://opennous.cloud → Settings → API Keys into the plugin's "Nous API key" config instead.
