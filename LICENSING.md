# Licensing

OpenNous is licensed in two parts.

## The server — AGPL-3.0

Everything in this repository, unless a subdirectory says otherwise, is licensed
under the GNU Affero General Public License v3.0. See [LICENSE](./LICENSE).

You may run it, modify it, and self-host it, for free, forever. If you modify it
and offer it to others over a network, the AGPL requires you to publish your
modifications under the same license.

## The client libraries — Apache-2.0

These are the packages you install into your own agent stack, so they carry a
permissive license and impose no obligations on your code.

| Package | Path | License |
| --- | --- | --- |
| `@opennous/mcp` | [`apps/mcp`](./apps/mcp) | Apache-2.0 |
| `@opennous/cli` | [`apps/cli`](./apps/cli) | Apache-2.0 |

Installing `@opennous/mcp` or `@opennous/cli` does not place your project under
the AGPL.

## OpenNous Cloud

OpenNous Cloud is the hosted service we run at
[app.opennous.cloud](https://app.opennous.cloud). It runs this same code, plus a
private layer that is not part of this repository. In the Cloud codebase that layer
lives in `src/cloud/` folders (`apps/api/src/cloud`, `apps/frontend/src/cloud`), and
this repository is that codebase with those folders removed. The layer contains:

- the in-app agent (chat, routines, skills and the sandbox)
- Tasks
- Reports
- the Insights page (insights themselves are read and written over MCP and REST here)
- the Slack connector and agent
- managed LinkedIn
- billing
- the learned ICP scorer
- Clerk sign-in

A self-hosted workspace scores its accounts with its own scorer and posts the
results to `POST /v2/scores`. Sign-in on a self-hosted instance is Supabase Auth.

A self-hosted instance (`SELF_HOSTED=true`) is unmetered and has no plan limits.
Endpoints for Cloud-only features return `403 cloud_only_feature`. The list
lives in `CLOUD_ONLY_FEATURES` in
[`apps/api/src/lib/access.mjs`](./apps/api/src/lib/access.mjs).

These are product boundaries, not security boundaries. Nothing secret sits behind
them.

## Trademark

"OpenNous", "Nous" and the OpenNous logo are trademarks and are not licensed under the AGPL or
Apache-2.0. You may run and modify the software. You may not use the name or the
logo to market a competing service without written permission.

## Contributing

Contributions are accepted under the license of the directory you are changing.
