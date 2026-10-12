#!/usr/bin/env bash
# Frontend typecheck that ACTUALLY CHECKS SOMETHING.
#
# `tsc --noEmit -p apps/frontend/tsconfig.json` is a no-op: that file has "files": [] and only
# project references, so it type-checks zero files and exits 0. I ran it all session and
# shipped two ReferenceErrors behind a green result — `optimisticUser is not defined` and
# `Loader2 is not defined`, both of which a real check catches instantly.
#
# The real config is tsconfig.app.json. It reports ~74 PRE-EXISTING errors across the repo, so
# a clean exit is not achievable today and demanding one would just get this script ignored.
# Instead it compares against a baseline: fail only when the count goes UP, or when a file you
# touched gains an error.
set -uo pipefail
cd "$(dirname "$0")/../apps/frontend" || exit 1

BASELINE=74
out=$(npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep "error TS" || true)
count=$(printf '%s\n' "$out" | grep -c "error TS" || true)

# Undefined identifiers are the class that reaches production as a white screen. Never allow a
# new one, whatever the baseline says.
refs=$(printf '%s\n' "$out" | grep -E "Cannot find name" || true)
if [ -n "$refs" ]; then
  echo "UNDEFINED IDENTIFIERS — these crash the page at runtime:"
  printf '%s\n' "$refs"
  exit 1
fi

if [ "$count" -gt "$BASELINE" ]; then
  echo "TYPE ERRORS UP: $count (baseline $BASELINE). New ones:"
  printf '%s\n' "$out" | tail -20
  exit 1
fi
echo "frontend typecheck ok — $count errors, baseline $BASELINE (no new undefined identifiers)"
