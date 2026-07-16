#!/usr/bin/env bash
# Nous — UserPromptSubmit hook.
# When the submitted prompt looks like go-to-market work, inject a one-line nudge to
# route through Nous. Silent on everything else, so it never adds noise to a "fix this
# bug" turn. Never blocks (always exits 0). This is the per-turn re-anchor that the
# once-per-session SessionStart instruction can drift from over a long conversation.
set -euo pipefail

INPUT="$(cat)"

# Best-effort: pull just the prompt text so the cwd/path fields can't trip the gate.
# Fall back to the whole payload if jq is unavailable.
PROMPT=""
if command -v jq >/dev/null 2>&1; then
  PROMPT="$(printf '%s' "$INPUT" | jq -r '.prompt // empty' 2>/dev/null || true)"
fi
[ -z "$PROMPT" ] && PROMPT="$INPUT"

# GTM-intent heuristic: an email address, or go-to-market vocabulary.
if printf '%s' "$PROMPT" | grep -Eiq \
  '([a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,})|\b(outreach|prospect|prospects|lead|leads|account|accounts|follow[ -]?up|meeting|call prep|cold email|draft (an? )?email|icp|pipeline|deal|deals|objection|positioning|persona|qualify|qualifying|sequenc|campaign|reply|replies|linkedin|gtm|go[- ]to[- ]market)\b'; then
  cat <<'EOF'
This looks like a go-to-market task. Before answering, pull engineered context from
Nous: call get_context with the person's email and intent (or get_playbook for our
own ICP, positioning, and pricing). Prefer Nous's identity-resolved Account Record over
raw CRM rows, and call record afterward so the record stays current.
EOF
fi

exit 0
