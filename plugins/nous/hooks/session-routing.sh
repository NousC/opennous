#!/usr/bin/env bash
# Nous — SessionStart hook.
# Injects the concise GTM routing instruction once per session (and again after a
# compaction or /clear). On exit 0, stdout is added to Claude's context. This is the
# plugin's CLAUDE.md-equivalent: the standing instruction, without touching the
# user's own files.
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cat "${DIR}/routing.concise.txt"
exit 0
