# @opennous/cli changelog

## 0.12.3

### Fixed: a plain message when the server's certificate isn't trusted

Against a self-hosted install with Caddy's local certificate, the CLI used to crash with
a Node stack trace (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`). It now says to point
`NODE_EXTRA_CA_CERTS` at the root certificate and links the self-host guide (GET-1011).

## 0.10.1

### Changed — new default vault folder structure

`nous link` now scaffolds the vault with **inbox · projects · decisions · accounts ·
people · resources · archive**. `accounts/` and `people/` are where Nous files the raw
of each touch (email, meeting) by resolved account/person. Backward-compatible: the
legacy folders (thoughts/briefs/content/company) are still walked, watched, and searched,
so any files already in them keep syncing — only the folders created on a fresh link
changed.

## 0.10.0

### Added — `nous vault`: on-device retrieval over your linked local vault

Once a folder is paired with `nous link`, an agent running on your own machine
(Claude Code, Hermes, …) can now read and search your private vault **locally** —
with no server round-trip. It's fresher (no sync lag), fuller (whole files, not
snippets), faster (no network), and private (the reads never leave the device).
This is the native counterpart to the `search_my_vault` MCP tool, which stays the
fallback for when you're *not* on the machine.

- `nous vault search <query>` — local keyword search over your vault notes
  (filename-weighted, ranked, with snippets). Options: `--folder`, `--limit`, `--json`.
- `nous vault read <path>` — print a note's full content (e.g. `decisions/pricing`).
- `nous vault list [folder]` — list vault files, optionally within one folder.
- `nous vault path` — print the linked folder, so you can point your own Grep/Read at it.
