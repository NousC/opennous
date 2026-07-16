# Licensing

Nous is licensed in two parts.

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

## Nous Cloud

Nous Cloud is the hosted service run by us at
[app.opennous.cloud](https://app.opennous.cloud). It runs this same code, plus a
managed layer that is not part of this repository.

A self-hosted instance is complete and unmetered. It does not include the hosted
observability surface (the Ops log), the hosted playground, event triggers, CRM
sync, lead lists, or reports. Those endpoints return `403 cloud_only_feature` when
`SELF_HOSTED=true`.

These are product boundaries, not security boundaries. Nothing secret sits behind
them.

## Trademark

"Nous" and the Nous logo are trademarks and are not licensed under the AGPL or
Apache-2.0. You may run and modify the software. You may not use the name or the
logo to market a competing service without written permission.

## Contributing

Contributions are accepted under the license of the directory you are changing.
