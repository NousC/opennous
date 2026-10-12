# Contributing to OpenNous

Thanks for your interest in contributing! Before you start, please read this.

## Before submitting a PR

- For changes **under 3 lines** — submit directly.
- For changes **over 3 lines** — open an issue or discuss in [Discord](https://discord.gg/wmbsDeAVm) first. This prevents wasted effort if the approach doesn't fit.
- Installation/setup questions belong in Discord, not GitHub issues.

## Development setup

See the [development environment guide](https://docs.opennous.cloud/installation/development-environment) for full setup instructions.

**Short version:**
```bash
git clone https://github.com/NousC/opennous.git
cd opennous
cp .env.example .env
pnpm install
pnpm dev
```

## PR process

1. Fork the repo and create a feature branch from `main`
2. Make your changes
3. Run `pnpm typecheck`, `pnpm lint` and `pnpm test`, and fix any errors
4. Submit a PR with a clear description of what and why
5. Link any related issues

## Code conventions

- ESM throughout — no CommonJS
- Named exports only — no default exports
- No hardcoded secrets or API keys
- No AI-generated PRs — we want genuine human contributions

## Commit style

```
feat: add stakeholder map to get_context response
fix: identity resolution waterfall missing email-prefix fallback
docs: add MCP tool examples for get_account
```

Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`

## Questions?

[Discord](https://discord.gg/wmbsDeAVm) is the fastest way to get help.
