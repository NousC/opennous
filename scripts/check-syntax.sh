#!/usr/bin/env bash
# Syntax-check every API .mjs and FAIL LOUDLY.
#
# Twice in one session a system-prompt line went into a template literal with unescaped
# backticks, closed the literal, and crash-looped the API in production. Both times a
# `node --check` loop printed FAIL and the `&&` chain after it committed anyway, because a
# loop that only echoes still exits 0. This exits non-zero.
set -uo pipefail
fail=0
for f in $(git ls-files 'apps/api/src/**/*.mjs' 'apps/worker/src/**/*.mjs' 2>/dev/null); do
  node --check "$f" >/dev/null 2>&1 || { echo "SYNTAX FAIL: $f"; node --check "$f" 2>&1 | tail -3; fail=1; }
done
[ "$fail" -eq 0 ] && echo "syntax ok" || echo "SYNTAX ERRORS — do not deploy"
exit "$fail"
